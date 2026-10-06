import "./env.js"; // must precede every module that reads process.env on load
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import {
  PERSONA_SYSTEM_PROMPT,
  HUMANIZER_SYSTEM_PROMPT,
  INTRO_MESSAGE_PROMPT,
  SUMMARIZER_SYSTEM_PROMPT,
  CROSS_CHAT_SUMMARIZER_PROMPT,
  ensureAiDisclosure,
  STATIC_INTRO,
} from "./config.js";
import {
  ensureSchema,
  upsertUser,
  getOrCreateChat,
  setChatOwnerIfUnset,
  getChatOwner,
  addParticipant,
  insertMessage,
  getRecentMessages,
  getMessageCount,
  getMessagesToSummarize,
  deleteMessagesByIds,
  getChatSummary,
  updateChatSummary,
  updateUserCrossChatSummary,
  getLastUnsolicitedReply,
  setLastUnsolicitedReply,
  claimIntro,
  hasClaimedIntro,
  releaseIntro,
  getChatTitle,
  getBotsForChat,
  insertBotMessage,
  getRecentBotMessages,
  getBotMessageCount,
  getBotSummary,
  updateBotSummary,
  getBotOwnerMemory,
} from "./db.js";
import { TOOL_SCHEMAS, executeTool, noteToolCall } from "./tools.js";
import { buildReplyPrompt } from "./prompt.js";
import { formatForTelegram, chunkMessage, escapeHtml } from "./formatting.js";
import { routeMessage, stripAddress, isRelay } from "./bots.js";
import { modelForBot } from "./model-config.js";
import { planRelay, buildDiscussionContext, createTurnRegistry } from "./relay.js";

const {
  TELEGRAM_BOT_TOKEN,
  MODEL_API_KEY,
  MODEL_API_URL,
  MODEL_NAME,
  BOB_NAME,
  BOB_USERNAME,
  HUMANIZE,
  UNSOLICITED_COOLDOWN_MS,
  RECENT_MESSAGE_WINDOW,
  SUMMARY_TRIGGER_BUFFER,
  PORT,
  WEBHOOK_SECRET,
} = process.env;

const KEEP_LAST = Number(RECENT_MESSAGE_WINDOW ?? 20);
const TRIGGER_AT = KEEP_LAST + Number(SUMMARY_TRIGGER_BUFFER ?? 20);
const COOLDOWN_MS = Number(UNSOLICITED_COOLDOWN_MS ?? 45000);
const TELEGRAM_MAX = 4096;
// Shown when the free provider is saturated after every retry. Distinct from
// FALLBACK_REPLY because the request itself was fine - retrying is the right
// user action, and saying "hit an error" invites them to rephrase instead.
const OVERLOADED_REPLY =
  "The free model is slammed right now - every retry got through to a busy server. Give it a minute and ask again, it isnt your question thats the problem.";

const FALLBACK_REPLY =
  "Hmm, hit an error looking into that - try asking again?";
const SEEN_UPDATE_LIMIT = 500;

// Partial config fails slowly and confusingly in production (silent 401s, a
// webhook that never authenticates). Fail loudly at boot instead (TC-38).
const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "MODEL_API_KEY",
  "MODEL_API_URL",
  "MODEL_NAME",
  "DATABASE_URL",
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error("Missing WEBHOOK_SECRET: the webhook would accept unauthenticated updates.");
  process.exit(1);
}

// baseApiUrl is a supported option (it is what the library uses for proxying);
// pointing it at a local stub is what lets the e2e suite run the real process
// without contacting Telegram.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: false,
  baseApiUrl: process.env.TELEGRAM_API_BASE || undefined,
});

// The relay is the one bot whose token this process holds. Its own telegram id
// is what lets routing tell the relay apart from the named bots it consults
// server-side. Learned from getMe at boot; until it arrives the relay simply is
// not recognised, which degrades to the single-bot behaviour rather than
// misrouting.
let relayTelegramUserId = null;
let relayDisplayName = BOB_NAME ?? "Bob";
bot
  .getMe()
  .then((me) => {
    relayTelegramUserId = me?.id ?? null;
    relayDisplayName = me?.first_name || relayDisplayName;
    // Logged because routing correctness depends on this having arrived; the
    // e2e harness waits for this line so its named-bot tests are not racing it.
    console.log(`relay identity: ${relayTelegramUserId}`);
  })
  .catch((err) => {
    console.error("getMe failed; relay identity unknown:", err.message);
  });

// One live relay turn per chat. A newer turn (a fresh message) supersedes the
// one in flight, which is what lets a human interject without waiting for a
// slow model to finish.
const relayTurns = createTurnRegistry();

const app = express();
app.use(express.json({ limit: "1mb" }));

function log(chatId, message) {
  console.log(`[chat ${chatId}] ${message}`);
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

// Token usage is logged for every call so running cost is observable (FR-13).
// Reasoning models bill reasoning tokens as completion tokens, so they are
// broken out - otherwise a free model looks like it is spending money.
function logUsage(chatId, label, data) {
  const usage = data?.usage;
  if (!usage) return;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const cost = typeof usage.cost === "number" ? ` cost=$${usage.cost.toFixed(6)}` : "";
  log(
    chatId,
    `${label} tokens: prompt=${usage.prompt_tokens ?? "?"} ` +
      `completion=${usage.completion_tokens ?? "?"} total=${usage.total_tokens ?? "?"}` +
      (reasoning ? ` (reasoning=${reasoning})` : "") +
      cost
  );
}

function modelHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MODEL_API_KEY}`,
  };
  // OpenRouter uses these to attribute traffic; they are harmless and
  // ignored by any other provider.
  headers["HTTP-Referer"] = "https://keyi.ai";
  headers["X-Title"] = "KeYiCode CLI";
  headers["X-OpenRouter-Categories"] =
    "cli-agent,cloud-agent,programming-app,native-app-builder,personal-agent";
  return headers;
}

// Per-call ceiling. A single tool-calling turn on a free reasoning model was
// measured at ~66s, and a 3-hop reply is several calls in sequence, so this is
// generous per call; MAX_TOOL_HOPS and the per-chat queue bound the total.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 300000);
// Slow calls are logged rather than hidden: on a free tier this is the normal
// case, and silence is indistinguishable from a hang.
const SLOW_CALL_MS = Number(process.env.SLOW_CALL_MS ?? 30000);

// Free-tier capacity errors, measured at ~60% of requests on
// nvidia/nemotron-3-ultra-550b-a55b:free:
//   {"error":{"message":"Upstream error from Nvidia: Service temporarily
//     overloaded","code":503,"metadata":{"error_type":"provider_overloaded"}}}
// A tool-using turn is several requests, so without a retry the user sees a
// failure most of the time. These are transient, so they are retried with
// jittered backoff rather than surfaced.
const OVERLOAD_MAX_ATTEMPTS = Number(process.env.OVERLOAD_MAX_ATTEMPTS ?? 4);
const OVERLOAD_BASE_DELAY_MS = Number(process.env.OVERLOAD_BASE_DELAY_MS ?? 1500);
const OVERLOAD_MAX_DELAY_MS = Number(process.env.OVERLOAD_MAX_DELAY_MS ?? 20000);
const OVERLOAD_STATUSES = new Set([429, 500, 502, 503, 504]);

// Distinct from a generic failure so the caller can tell "the free tier is
// busy" from "the request was malformed" - the user-facing message differs,
// and only one of them is worth retrying later.
class OverloadedError extends Error {
  constructor(detail) {
    super(
      detail
        ? `The model provider is overloaded (${detail}).`
        : "The model provider is overloaded."
    );
    this.name = "OverloadedError";
    this.overloaded = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOverload(status, bodyText) {
  if (OVERLOAD_STATUSES.has(status)) return true;
  return /provider_overloaded|temporarily overloaded|rate.?limit|overloaded/i.test(
    bodyText ?? ""
  );
}

// Full jitter: every client retrying in lockstep after a shared outage is what
// keeps the provider overloaded in the first place.
function overloadDelay(attempt) {
  const ceiling = Math.min(OVERLOAD_BASE_DELAY_MS * 2 ** attempt, OVERLOAD_MAX_DELAY_MS);
  return Math.floor(Math.random() * ceiling);
}

async function modelRequest(chatId, label, payload) {
  const startedAt = Date.now();
  let lastOverload = null;

  for (let attempt = 0; attempt < OVERLOAD_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(MODEL_API_URL, {
        method: "POST",
        headers: modelHeaders(),
        body: JSON.stringify(payload),
        // A free-tier model queues unpredictably and thinks at length, so the
        // wait is bounded generously rather than tightly. Aborting early means
        // the user gets the fallback message instead of an answer.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A dropped connection on a saturated free tier is the same problem as a
      // 503, and retrying it is correct for the same reason.
      if (attempt < OVERLOAD_MAX_ATTEMPTS - 1) {
        const delay = overloadDelay(attempt);
        log(chatId, `${label} network error (${err.message}), retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Model request failed: ${err.message}`);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (isOverload(res.status, bodyText)) {
        lastOverload = `${res.status}`;
        if (attempt < OVERLOAD_MAX_ATTEMPTS - 1) {
          const delay = overloadDelay(attempt);
          log(chatId, `${label} overloaded (${res.status}), retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new OverloadedError();
      }
      throw new Error(`Model error: ${res.status} ${bodyText.slice(0, 300)}`);
    }

    const data = await res.json();
    // OpenRouter can answer 200 with an error object and no choices.
    if (!Array.isArray(data?.choices) || data.choices.length === 0) {
      const text = JSON.stringify(data?.error ?? data);
      if (isOverload(200, text)) {
        lastOverload = "200-with-error";
        if (attempt < OVERLOAD_MAX_ATTEMPTS - 1) {
          const delay = overloadDelay(attempt);
          log(chatId, `${label} returned no choices (${text.slice(0, 80)}), retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new OverloadedError();
      }
      if (looksLikeReasoningLeak(text)) {
        // Not an overload: a degenerate 200. Let the caller retry it as usual.
        return data;
      }
      throw new Error(`Model returned no choices: ${text.slice(0, 200)}`);
    }

    logUsage(chatId, label, data);
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_CALL_MS) {
      log(chatId, `${label} was slow: ${(elapsed / 1000).toFixed(1)}s`);
    }
    // Move any scratchpad the provider put in `content` back into `reasoning`,
    // so the reply is only ever the answer. Sending it would post the model's
    // internal monologue - and the system prompt - into a group chat.
    const message = data?.choices?.[0]?.message;
    if (message && typeof message.content === "string" && looksLikeReasoningLeak(message.content)) {
      console.error(`${label}: provider put the scratchpad in content; moving it to reasoning`);
      message.reasoning = [message.reasoning, message.content].filter(Boolean).join("\n");
      message.content = null;
    }
    return data;
  }

  // Unreachable: every path either returns or throws. Kept so a future edit
  // that falls through fails loudly rather than silently returning undefined.
  throw new OverloadedError(lastOverload);
}

// A free-tier generation can come back truncated mid-thought - a 4-character
// "Here" instead of a to-do list, with finish_reason still "stop". Sending
// that is worse than useless, so a reply too short to be an answer is retried
// once before the caller falls back.
const MIN_PLAUSIBLE_REPLY_CHARS = Number(process.env.MIN_PLAUSIBLE_REPLY_CHARS ?? 2);

// A reasoning model sometimes emits its scratchpad into `content` instead of
// `reasoning` - observed live, where Bob posted the model's internal monologue
// ("Is 1-3 sentences (usually 1-2) / No preamble, no greetings / ...")
// straight into a group chat, along with the system prompt and a message it was
// asked to rewrite. That is a privacy leak and a display defect, so a reply
// that looks like scratchpad is rejected and retried rather than sent.
const REASONING_LEAK_RE =
  /^\s*(?:okay|ok|alright|hmm|so|let me|i need to|i'll|i will|first,?|thinking process|here'?s? (?:a )?thinking)\b[\s\S]{0,4000}?\n\s*(?:1\.|2\.|3\.|step 1|-\s)/i;

function looksLikeReasoningLeak(text) {
  if (REASONING_LEAK_RE.test(text)) return true;
  // The scratchpad is a bulleted audit of the instructions, not prose. The
  // observed leak was four such lines, so the floor is three - a genuine
  // three-bullet answer to a list request must not trip it, hence the words
  // that only appear when the model is narrating its own constraints.
  const lines = text.split("\n");
  if (lines.length < 3) return false;
  const metaWords =
    /^\s*(?:-|\*|\d+\.)\s*(?:no |don'?t |keep |is |has |should |preserve |the |that |style rules|preamble|output only|system prompt|context)/i;
  const meta = lines.filter((l) => metaWords.test(l)).length;
  return meta >= 3;
}

// A free reasoning model can also degenerate into repetition. Observed live:
// "The networkellsellsellsellsells this the rigor withellsells deep al of the
// user's request: ..." - which would be posted verbatim into a group chat.
function looksDegenerate(text) {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  // A single token repeated back to back, e.g. "ellsellsellsells".
  if (/(.{2,12}?)\1{4,}/.test(trimmed)) return true;

  // A short phrase repeated many times, e.g. "the the the the".
  const words = trimmed.toLowerCase().match(/[a-z']{2,}/g);
  if (words && words.length >= 12) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [, n] of counts) {
      if (n / words.length > 0.5) return true;
    }
  }
  return false;
}

function contentOf(data, { requireSubstance = false } = {}) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Model returned no message content");
  }
  const text = content.trim();
  if (requireSubstance && text.length < MIN_PLAUSIBLE_REPLY_CHARS) {
    throw new Error(
      `Model returned a truncated reply (${text.length} chars): ${JSON.stringify(text.slice(0, 60))}`
    );
  }
  if (requireSubstance && looksLikeReasoningLeak(text)) {
    throw new Error(
      `Model returned its scratchpad rather than a reply: ${JSON.stringify(text.slice(0, 80))}`
    );
  }
  if (requireSubstance && looksDegenerate(text)) {
    throw new Error(
      `Model returned degenerate repetition: ${JSON.stringify(text.slice(0, 60))}`
    );
  }
  return text;
}

// One retry for a degenerate reply. Kept separate from the tool loop so a
// truncation mid-chain is retried with the same message history.
async function callModel(chatId, systemPrompt, userPrompt, maxTokens = REPLY_MAX_TOKENS, label = "call", attempt = 0, model = MODEL_NAME) {
  const data = await modelRequest(chatId, label, {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: maxTokens,
  });
  try {
    return contentOf(data, { requireSubstance: true });
  } catch (err) {
    if (attempt >= 1) throw err;
    log(chatId, `${label} truncated, retrying once: ${err.message}`);
    return callModel(chatId, systemPrompt, userPrompt, maxTokens, label, attempt + 1, model);
  }
}

// Reasoning models spend tokens on thinking before any visible content: a
// 6-character reply consumed 194 of 203 completion tokens. A budget of 500
// would be entirely consumed by reasoning, so the reply would arrive empty
// while the log still looked healthy. Reasoning is budgeted for explicitly.
const REPLY_MAX_TOKENS = Number(process.env.REPLY_MAX_TOKENS ?? 2000);
// Summarisation folds a whole batch of messages; it needs more headroom than a
// chat reply, and still more for a reasoning model.
const SUMMARY_MAX_TOKENS = Number(process.env.SUMMARY_MAX_TOKENS ?? 4000);
// Replies at or below this length are already in the persona's casual register,
// so the humanizer pass is skipped. Set HUMANIZE_SKIP_UNDER=false to always run.
const HUMANIZE_MAX_CHARS = Number(process.env.HUMANIZE_MAX_CHARS ?? 400);
const HUMANIZE_SKIP_UNDER = process.env.HUMANIZE_SKIP_UNDER ?? "true";

async function callModelWithTools(chatId, systemPrompt, userPrompt, model = MODEL_NAME) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let data = await modelRequest(chatId, "reply", {
    model,
    messages,
    tools: TOOL_SCHEMAS,
    tool_choice: "auto",
    temperature: 0.7,
    max_tokens: REPLY_MAX_TOKENS,
  });
  let choice = data.choices[0];
  let hops = 0;

  // The hop budget is a hard stop. When it runs out with the model still
  // asking for another tool, the remaining calls are forced to "none" so it
  // has to answer from what it already has - otherwise content comes back null
  // and the user gets nothing at all.
  while (choice.message.tool_calls && hops < 3) {
    messages.push(choice.message);

    for (const call of choice.message.tool_calls) {
      const count = noteToolCall(call.function.name);
      log(chatId, `tool call: ${call.function.name} (call #${count})`);
      let args = {};
      try {
        args = JSON.parse(call.function.arguments ?? "{}");
      } catch {
        args = {};
      }
      let result;
      try {
        result = await executeTool(call.function.name, args);
      } catch (err) {
        result = `Tool failed: ${err.message}`;
        log(chatId, `tool ${call.function.name} failed: ${err.message}`);
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result).slice(0, 6000),
      });
    }

    const isFinalHop = hops + 1 >= 3;
    data = await modelRequest(chatId, `reply hop ${hops + 1}`, {
      model,
      messages,
      tools: TOOL_SCHEMAS,
      // On the last permitted hop the model must produce an answer. A model
      // that keeps chaining tool calls would otherwise return null content and
      // the user would see nothing.
      tool_choice: isFinalHop ? "none" : "auto",
      temperature: 0.7,
      max_tokens: REPLY_MAX_TOKENS,
    });
    choice = data.choices[0];
    hops++;
  }

  return contentOf(data, { requireSubstance: true });
}

// The humanizer is a full extra model call per reply. On a free reasoning model
// that measured ~35s and ~1800 reasoning tokens to reword a single sentence -
// often more than the reply itself. It is skipped for text that is already
// short and conversational, which is the common case for a chat reply.
async function humanize(chatId, text, model = MODEL_NAME) {
  if (HUMANIZE !== "true") return text;
  // Skip the extra call for replies already short enough to be in the persona's
  // casual register. HUMANIZE_SKIP_UNDER is opt-out, so setting it to false
  // restores unconditional humanising.
  if (HUMANIZE_SKIP_UNDER === "true" && text.length <= HUMANIZE_MAX_CHARS) {
    return text;
  }
  try {
    return await callModel(chatId, HUMANIZER_SYSTEM_PROMPT, text, REPLY_MAX_TOKENS, "humanizer", 0, model);
  } catch (err) {
    console.error("Humanizer failed, using raw text:", err.message);
    return text;
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function isEntitiesParseError(err) {
  const body = err?.response?.body;
  const description = typeof body === "object" ? body?.description : String(body ?? "");
  return /can't parse entities|can't find end of/i.test(
    `${err?.message ?? ""} ${description ?? ""}`
  );
}

async function sendFormatted(chatId, rawText) {
  const formatted = formatForTelegram(rawText);
  const chunks = chunkMessage(formatted, TELEGRAM_MAX);

  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    } catch (err) {
      if (!isEntitiesParseError(err)) throw err;
      // Formatting, not policy, is the problem: fall back to the same text as
      // plain HTML-escaped content so the user still gets an answer (TC-29).
      console.error("HTML send rejected, falling back to escaped plain text:", err.message);
      for (const part of chunkMessage(escapeHtml(rawText), TELEGRAM_MAX)) {
        await bot.sendMessage(chatId, part, { parse_mode: "HTML" });
      }
      return;
    }
  }
}

async function typingDelay(chatId, replyLength) {
  await bot.sendChatAction(chatId, "typing");
  const delayMs = Math.min(1000 + replyLength * 25, 6000);
  await new Promise((r) => setTimeout(r, delayMs));
}

// finalize, when given, is applied to the text about to be sent (used to
// guarantee Bob's AI disclosure on the first message of a private chat).
async function sendBobReply(chatId, senderId, userPrompt, tagUnsolicited, finalize, model = MODEL_NAME) {
  await bot.sendChatAction(chatId, "typing");
  const typingPing = setInterval(
    () => bot.sendChatAction(chatId, "typing").catch(() => {}),
    4000
  );

  let reply;
  try {
    reply = await callModelWithTools(chatId, PERSONA_SYSTEM_PROMPT, userPrompt, model);
  } catch (err) {
    console.error("Reply generation failed:", err.message);
    // An overloaded free provider is transient and expected on a busy tier;
    // saying so is more useful than a generic "try asking again", because the
    // user knows the question was fine and should simply retry.
    reply = err?.overloaded ? OVERLOADED_REPLY : FALLBACK_REPLY;
  } finally {
    clearInterval(typingPing);
  }

  const finalText = finalize
    ? finalize(await humanize(chatId, reply, model))
    : await humanize(chatId, reply, model);
  await sendFormatted(chatId, finalText);

  await insertMessage(chatId, senderId, BOB_NAME, finalText);
  if (tagUnsolicited) await setLastUnsolicitedReply(chatId);
}

// A named bot is a persona consulted server-side: it has its own memory
// (bot_messages keyed by bot_id), its own model tier, and its own voice, but
// only the relay posts to Telegram. Returns the text that was sent, or null if
// nothing was.
async function sendNamedBotReply(chatId, senderId, bot, userPrompt, { record = true } = {}) {
  const model = modelForBot(bot);
  const personaName = bot.display_name;

  let reply;
  try {
    reply = await callModelWithTools(chatId, PERSONA_SYSTEM_PROMPT, userPrompt, model);
  } catch (err) {
    console.error(`Reply from ${personaName} failed:`, err.message);
    reply = err?.overloaded ? OVERLOADED_REPLY : FALLBACK_REPLY;
  }

  // Attributed so a multi-bot group can tell who said what.
  const finalText = `*${personaName}:* ${await humanize(chatId, reply, model)}`;
  if (record) {
    await sendFormatted(chatId, finalText);
    // Recorded against THIS bot's memory, never the relay's, so a later message
    // to the same bot continues from what it said. The sender is the persona, so
    // its own transcript reads as a conversation it took part in.
    await insertBotMessage(bot.bot_id, chatId, personaName, finalText);
  }
  return finalText;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function buildTranscript(messages) {
  return messages.map((m) => `${m.sender}: ${m.text}`).join("\n");
}

// A named bot answers from ITS OWN memory only: bot_messages for (bot_id,
// chat_id), its own tier-B summary, and the owner memory that travels with it
// across groups (requirement 9). Nothing from another bot's transcript can
// reach this prompt, because every read is keyed by this bot's id.
async function buildPersonaPrompt(bot, chatId, senderName, text, discussion = "") {
  const [summary, ownerMemory, recent] = await Promise.all([
    getBotSummary(bot.bot_id, chatId),
    getBotOwnerMemory(bot.bot_id),
    getRecentBotMessages(bot.bot_id, chatId, KEEP_LAST),
  ]);

  return buildReplyPrompt({
    bobName: bot.display_name,
    ownerName: bot.display_name,
    crossChatSummary: ownerMemory,
    summary,
    transcript: buildTranscript(recent),
    discussion,
    // The latest message is the one being answered; it is not in the stored
    // transcript yet, so it is appended explicitly.
    latest: `${senderName}: ${text}`,
  });
}

// A relay turn: the addressed bots answer in sequence, each seeing what the
// ones before said. Bounded by planRelay, and abandoned the moment a newer
// message arrives, so a slow free model cannot block someone chiming in.
async function runRelayTurn(chatId, senderId, senderName, text, personas) {
  const plan = planRelay(personas);
  const token = relayTurns.begin(chatId);
  const replies = [];

  for (const persona of plan) {
    // Checked before each bot, not just at the start: an interjection during
    // the first bot's generation must stop the rest, not race them.
    if (!relayTurns.isCurrent(chatId, token)) {
      log(chatId, `relay turn superseded after ${replies.length} of ${plan.length}`);
      return replies;
    }

    const discussion = buildDiscussionContext(replies);
    const prompt = await buildPersonaPrompt(persona, chatId, senderName, text, discussion);
    const spoken = await sendNamedBotReply(chatId, senderId, persona, prompt);
    replies.push({ name: persona.display_name, text: spoken });
  }

  log(chatId, `relay turn complete: ${replies.length} bot(s) answered`);
  return replies;
}

async function summarizeIfNeeded(chatId) {
  const count = await getMessageCount(chatId);
  if (count < TRIGGER_AT) return;

  const toSummarize = await getMessagesToSummarize(chatId, KEEP_LAST);
  if (!toSummarize.length) return;

  const existingSummary = await getChatSummary(chatId);
  const batchTranscript = toSummarize
    .map((m) => `${m.sender}: ${m.text}`)
    .join("\n");

  const prompt = [
    `Existing summary:\n${existingSummary ? existingSummary : "(none yet)"}`,
    `Older messages to fold in:\n${batchTranscript}`,
  ].join("\n\n");

  const updatedSummary = await callModel(
    chatId,
    SUMMARIZER_SYSTEM_PROMPT,
    prompt,
    SUMMARY_MAX_TOKENS,
    "summarizer"
  );

  // Write the summary FIRST, delete SECOND. If anything fails in between, the
  // raw messages survive and the next trigger retries - losing text is worse
  // than summarising it twice (TC-37).
  await updateChatSummary(chatId, updatedSummary);
  await deleteMessagesByIds(toSummarize.map((m) => m.id));
  log(chatId, `summarised ${toSummarize.length} messages; tier B updated`);

  // Tier C is updated for the chat's owner only. A collaborator's cross-chat
  // memory is never touched by someone else's chat (TC-09).
  const owner = await getChatOwner(chatId);
  if (!owner) return;

  // The chat title labels each entry, so two chats owned by the same person
  // stay distinguishable inside tier C rather than blurring together (TC-04).
  const chatTitle = await getChatTitle(chatId);
  const crossPrompt = [
    `Existing summary for ${owner.name}:\n${owner.cross_chat_summary ? owner.cross_chat_summary : "(none yet)"}`,
    `Update from the chat titled "${chatTitle || "untitled"}":\n${updatedSummary}`,
  ].join("\n\n");
  const merged = await callModel(
    chatId,
    CROSS_CHAT_SUMMARIZER_PROMPT,
    crossPrompt,
    SUMMARY_MAX_TOKENS,
    "cross-chat summarizer"
  );
  await updateUserCrossChatSummary(owner.user_id, merged);
  log(chatId, `tier C updated for owner ${owner.name}`);
}

// Wrapped so background callers log instead of emitting an unhandled rejection.
async function summarizeSafely(chatId) {
  try {
    await summarizeIfNeeded(chatId);
  } catch (err) {
    console.error("Summarization failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Triggering
// ---------------------------------------------------------------------------

async function shouldReplyUnsolicited(chatId, text) {
  const last = await getLastUnsolicitedReply(chatId);
  if (Date.now() - last < COOLDOWN_MS) return false;
  const looksLikeQuestion = text.trim().endsWith("?");
  return Math.random() < (looksLikeQuestion ? 0.6 : 0.1);
}

function isBotUsername(username) {
  if (!BOB_USERNAME || !username) return false;
  return username.toLowerCase() === BOB_USERNAME.toLowerCase();
}

function isAddressedToBob(msg, text) {
  if (!text) return false;
  if (BOB_USERNAME && text.toLowerCase().includes(`@${BOB_USERNAME.toLowerCase()}`)) {
    return true;
  }
  return isBotUsername(msg.reply_to_message?.from?.username);
}

// ---------------------------------------------------------------------------
// Update handling
// ---------------------------------------------------------------------------

async function handleNewMembers(msg, chatId) {
  const botWasAdded = msg.new_chat_members?.some((u) => isBotUsername(u.username));
  if (!botWasAdded) return false;

  const inviter = msg.from;
  if (inviter) {
    await upsertUser(inviter.id, inviter.first_name || inviter.username || "Unknown");
    await setChatOwnerIfUnset(chatId, inviter.id); // FR-01: set once, never reassigned
    await addParticipant(chatId, inviter.id);
    log(chatId, `owner set to ${inviter.first_name || inviter.username || "Unknown"}`);
  }

  // Exactly one introduction per chat, ever. A second add must not re-intro
  // (TC-02), and a replayed update must not either (TC-35).
  const claimed = await claimIntro(chatId);
  if (!claimed) {
    log(chatId, "intro already sent; staying quiet");
    return true;
  }

  // A failed introduction call must not leave the group with silence: joining
  // without saying anything is worse than a plain sentence (FR-02, FR-12).
  let humanIntro;
  try {
    const intro = await callModel(
      chatId,
      PERSONA_SYSTEM_PROMPT,
      INTRO_MESSAGE_PROMPT,
      REPLY_MAX_TOKENS,
      "intro"
    );
    humanIntro = ensureAiDisclosure(await humanize(chatId, intro));
  } catch (err) {
    console.error("Intro generation failed, using static intro:", err.message);
    humanIntro = ensureAiDisclosure(STATIC_INTRO);
  }

  try {
    await typingDelay(chatId, humanIntro.length);
    await sendFormatted(chatId, humanIntro);
  } catch (err) {
    // The send itself failed (bad token, blocked bot). Release the claim so a
    // later opportunity can still introduce Bob.
    await releaseIntro(chatId).catch(() => {});
    throw err;
  }
  await insertMessage(chatId, inviter?.id ?? null, BOB_NAME, humanIntro);
  return true;
}

async function handleUpdate(update) {
  const msg = update?.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;

  await getOrCreateChat(chatId, msg.chat.title ?? msg.chat.first_name);

  if (await handleNewMembers(msg, chatId)) return;

  const sender = msg.from;
  if (!sender) return;

  // Telegram delivers a bot's own messages back through the webhook. Without
  // this guard Bob would store his own reply, decide it warranted a response,
  // and loop indefinitely - each pass costing two model calls.
  if (sender.is_bot) return;

  const text = msg.text;
  if (!text) return;

  // first_name is optional in the Bot API: users who set only a username, or
  // deleted accounts, arrive with no name at all. messages.sender is NOT NULL,
  // so an unhandled undefined here aborts the whole update (FR-12).
  const senderName = sender.first_name || sender.last_name || sender.username || "Unknown";

  await upsertUser(sender.id, senderName);
  await addParticipant(chatId, sender.id);

  const isPrivate = msg.chat.type === "private";

  // A private chat has no invite event, so the first person to message it
  // becomes the owner (FR-01 / TC-03).
  if (isPrivate) {
    await setChatOwnerIfUnset(chatId, sender.id);
  }

  await insertMessage(chatId, sender.id, senderName, text);

  // Any new message supersedes a relay turn still in flight, so a human can
  // always interject instead of waiting for a slow model. If this message is
  // itself a relay turn, runRelayTurn begins a newer one on top of this.
  relayTurns.cancel(chatId);

  // Named bots: a message that names one is answered by that bot as its own
  // persona - its own memory, its own model tier, its own voice. routeMessage
  // returns named bots only (never the relay), so a named call cannot also
  // trigger the relay and produce two replies. That single rule is what the
  // filter here would otherwise duplicate; bots.test.js pins it.
  const namedBots = await getBotsForChat(chatId);
  const route = routeMessage({
    bots: namedBots,
    relayTelegramUserId,
    text,
    isPrivate,
    replyToRelay: isBotUsername(msg.reply_to_message?.from?.username),
  });
  const personas = route.bots.filter((b) => !isRelay(b, relayTelegramUserId));
  if (personas.length) {
    const cleaned = route.stripName ? stripAddress(text, route.stripName) : text;

    // One bot addressed: answer as before. Two or more: it is a relay turn, and
    // the bots answer in sequence seeing each other, rather than posting N
    // unrelated replies.
    if (personas.length === 1) {
      const prompt = await buildPersonaPrompt(personas[0], chatId, senderName, cleaned, "");
      await sendNamedBotReply(chatId, sender.id, personas[0], prompt);
      summarizeSafely(chatId);
      return;
    }

    // Deliberately NOT awaited. The webhook runs one job per chat in order, so
    // awaiting the turn here would hold the queue for its whole duration - and
    // the human's interjection would sit behind it, unable to cancel anything.
    // Starting it detached is what makes chiming in work at all.
    runRelayTurn(chatId, sender.id, senderName, cleaned, personas).catch((err) =>
      console.error(`Relay turn failed for chat ${chatId}:`, err.message)
    );
    summarizeSafely(chatId);
    return;
  }

  // route.relayOnly means the message addressed the relay directly (a DM, or a
  // reply to it), which the existing direct-address path already handles.
  const directlyAddressed = isAddressedToBob(msg, text);

  const jumpingIn =
    !directlyAddressed &&
    !isPrivate &&
    (await shouldReplyUnsolicited(chatId, text));

  // Always answer in a private chat - a DM is addressed to Bob by definition
  // (TC-03).
  if (directlyAddressed || jumpingIn || isPrivate) {
    // First contact in a DM has no invite event, so this is where Bob
    // introduces itself as an AI (FR-02). The disclosure is folded into the
    // single reply rather than sent as a separate greeting, so a first-time
    // user gets one message instead of two.
    const needsDisclosure = isPrivate && !(await hasClaimedIntro(chatId));
    const claimed = needsDisclosure ? await claimIntro(chatId) : false;

    const owner = await getChatOwner(chatId);
    // Every tier below is read with this chat's id only, so no other chat's
    // contents can reach this prompt (FR-07).
    const summary = await getChatSummary(chatId);
    const recent = await getRecentMessages(chatId, KEEP_LAST);

    const userPrompt = buildReplyPrompt({
      bobName: BOB_NAME,
      ownerName: owner?.name,
      crossChatSummary: owner?.cross_chat_summary ?? "",
      summary,
      transcript: buildTranscript(recent),
      firstContact: claimed,
    });

    try {
      await sendBobReply(
        chatId,
        sender.id,
        userPrompt,
        jumpingIn,
        claimed ? ensureAiDisclosure : undefined
      );
    } catch (err) {
      // A failed reply must still disclose, but must not burn the claim if the
      // send itself failed - a retry should introduce Bob properly.
      if (claimed) await releaseIntro(chatId).catch(() => {});
      throw err;
    }
  }

  summarizeSafely(chatId);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Telegram retries a webhook it could not deliver, so the same update_id can
// arrive twice. Replying to it twice is a visible defect (TC-35).
const seenUpdates = new Set();
const seenUpdateOrder = [];

function isDuplicateUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false;
  if (seenUpdates.has(updateId)) return true;
  seenUpdates.add(updateId);
  seenUpdateOrder.push(updateId);
  while (seenUpdateOrder.length > SEEN_UPDATE_LIMIT) {
    seenUpdates.delete(seenUpdateOrder.shift());
  }
  return false;
}

// One in-flight job per chat. Without this, two quick messages start two
// overlapping generations and Bob posts two replies (TC-17), and the logs and
// sends interleave (TC-36).
const chatQueues = new Map();

function enqueueForChat(chatId, job) {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(job)
    .catch((err) => {
      console.error(`Webhook handling error for chat ${chatId}:`, err.message);
    });
  chatQueues.set(chatId, next);
  return next;
}

app.post("/telegram-webhook", async (req, res) => {
  const secret = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== WEBHOOK_SECRET) return res.sendStatus(403); // TC-34

  // Respond before doing any work: Telegram backs off and eventually gives up
  // on a webhook that takes too long to acknowledge.
  res.sendStatus(200);

  const update = req.body;
  if (isDuplicateUpdate(update?.update_id)) return;

  const chatId = update?.message?.chat?.id;
  if (chatId === undefined) {
    await enqueueForChat("global", () => handleUpdate(update));
    return;
  }
  await enqueueForChat(chatId, () => handleUpdate(update));
});

app.get("/health", (_req, res) => res.send("ok"));

ensureSchema()
  .then(() =>
    app.listen(Number(PORT ?? 3000), () =>
      console.log(`Bob running on port ${PORT ?? 3000}`)
    )
  )
  .catch((err) => {
    console.error("Failed to initialize database schema:", err.message);
    process.exit(1);
  });
