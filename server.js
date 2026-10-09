import "./env.js"; // must precede every module that reads process.env on load
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import path from "node:path";
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
  getBotSummary,
  updateBotSummary,
  updateBotOwnerMemory,
  getBotOwnerMemory,
  getBotMessageCount,
  getBotMessagesToSummarize,
  deleteBotMessagesByIds,
  getSubscription,
  claimUpdate,
  pruneProcessedUpdates,
  getUserModelConfig,
  setUserModelConfig,
  clearUserModelConfig,
  getCreditBalance,
  addCredits,
  getCreditLedger,
  claimPaymentEvent,
  saveProjectManifest,
  getProjectManifest,
  createBot,
  getBotByName,
  linkBotToChat,
  countBotsForOwner,
  acquireChatLock,
  releaseChatLock,
} from "./db.js";
import { TOOL_SCHEMAS, executeTool, noteToolCall } from "./tools.js";
import { buildReplyPrompt } from "./prompt.js";
import { formatForTelegram, chunkMessage, escapeHtml } from "./formatting.js";
import { routeMessage, stripAddress, isRelay, normalizeBotName } from "./bots.js";
import { modelForBot } from "./model-config.js";
import { planRelay, buildDiscussionContext, createTurnRegistry } from "./relay.js";
import {
  selectWindow,
  orderForCache,
  summariseTriggered,
  tokenTriggered,
  tokenBudgetFor,
  DEFAULT_TURNS,
  TURNS_PER_SUMMARY,
} from "./session-window.js";
import { renderDocumentHtml, safeFileName } from "./document.js";
import {
  PLANS,
  resolvePlan,
  allowedHops,
  withinSearchBudget,
  withinBotQuota,
  quotaMessage,
} from "./quota.js";
import { getFormat, defaultFormat, fileNameFor, buildProjectZip } from "./export.js";
import {
  storageConfigured,
  putProjectFile,
  getProjectFile,
  validateProject,
} from "./storage.js";
import { renderPdfBuffer } from "./pdf.js";
import {
  paymentsConfigured,
  purchasesEnabled,
  verifyStripeSignature,
  parseStripeEvent,
  creditForCheckout,
  createCheckoutSession,
} from "./payment.js";
import {
  parseCommand,
  parseCallback,
  buildProviderKeyboard,
  buildModelKeyboard,
  buildCreditKeyboard,
  buildFormatKeyboard,
  describeModelChoice,
} from "./commands.js";
import {
  listProviders,
  getProvider,
  getModel,
  validateKeyFormat,
  resolveUserModel,
} from "./providers.js";
import {
  CREDIT_PACKS,
  creditsForPack,
  hasBalance,
  costOfCall,
  formatUsd,
  LOW_BALANCE_MICRO,
} from "./credits.js";

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
bot
  .getMe()
  .then((me) => {
    relayTelegramUserId = me?.id ?? null;
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
// The Stripe webhook is excluded from the JSON parser on purpose. Its
// signature is computed over the EXACT bytes Stripe sent, so re-serialising the
// parsed object changes the bytes and every genuine webhook fails
// verification. It installs its own express.raw() instead.
app.use((req, res, next) =>
  req.path === "/stripe-webhook" ? next() : express.json({ limit: "1mb" })(req, res, next)
);

const processStartedAt = Date.now();

function log(chatId, message) {
  console.log(`[chat ${chatId}] ${message}`);
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

// Token usage is logged for every call so running cost is observable (FR-13).
// Reasoning models bill reasoning tokens as completion tokens, so they are
// broken out - otherwise a free model looks like it is spending money.
function logUsage(chatId, label, data, meter) {
  const usage = data?.usage;
  if (!usage) return;
  // Accumulate the turn's real cost. The provider's own reported cost wins when
  // present: it already accounts for cache discounts and routing, so
  // recomputing from list prices would overcharge the user.
  if (meter) {
    const reported = typeof usage.cost === "number" ? usage.cost : undefined;
    meter.micro += costOfCall({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      reportedCostUsd: reported,
      promptPricePerToken: meter.promptPricePerToken,
      completionPricePerToken: meter.completionPricePerToken,
    });
  }
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

// Headers for one provider request. The provider decides what else is required:
// opencode go returns 400 MissingSessionID without its session header, which is
// declared on the provider rather than hardcoded here so the requirement cannot
// be lost by a refactor of this function.
function modelHeaders(route = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${route.apiKey || MODEL_API_KEY}`,
  };
  // OpenRouter uses these to attribute traffic; they are harmless and
  // ignored by any other provider.
  headers["HTTP-Referer"] = "https://keyi.ai";
  headers["X-Title"] = "KeYiCode CLI";
  headers["X-OpenRouter-Categories"] =
    "cli-agent,cloud-agent,programming-app,native-app-builder,personal-agent";

  const provider = getProvider(route.provider);
  if (provider?.requiresSessionHeader && route.sessionId) {
    // Reuses the cache-stickiness id, so one conversation also maps to one
    // provider session rather than two ids that drift apart.
    headers[provider.requiresSessionHeader] = route.sessionId;
  }
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

// OpenRouter's sticky routing uses session_id to pin a conversation to one
// provider, which is what makes prefix reuse land on a warm cache. Without it,
// sticky routing only activates after a cache hit is observed - so the first
// few turns each pay full price. Keyed per bot per chat, so two bots in one
// chat do not thrash the same cache entry.
function sessionIdFor(botId, chatId) {
  return `bob-${botId ?? "relay"}-${chatId}`;
}

async function modelRequest(chatId, label, payload, route = {}, meter = null) {
  const startedAt = Date.now();
  let lastOverload = null;
  // A user who supplied their own key hits their own endpoint; otherwise the
  // deployment default. Resolved per call so a config change takes effect on
  // the next message rather than at restart.
  const apiUrl = route.apiUrl || MODEL_API_URL;
  const apiKey = route.apiKey || MODEL_API_KEY;

  for (let attempt = 0; attempt < OVERLOAD_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: modelHeaders(route),
        // session_id is a top-level body field, not a message. It is only sent
        // when the caller knows the conversation, so a one-off call is not
        // pinned to a provider it has no cache on.
        body: JSON.stringify(
          route.sessionId ? { ...payload, session_id: route.sessionId } : payload
        ),
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
      // The status and body are attached so the caller can distinguish a
      // provider that refuses TOOLS from a genuinely broken request.
      const err = new Error(`Model error: ${res.status} ${bodyText.slice(0, 300)}`);
      err.status = res.status;
      err.bodyText = bodyText;
      throw err;
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

    logUsage(chatId, label, data, meter);
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_CALL_MS) {
      log(chatId, `${label} was slow: ${(elapsed / 1000).toFixed(1)}s`);
    }
    // Move any scratchpad the provider put in `content` back into `reasoning`,
    // so the reply is only ever the answer. Sending it would post the model's
    // internal monologue - and the system prompt - into a group chat.
    const message = data?.choices?.[0]?.message;
    // opencode go reports the scratchpad as reasoning_content; OpenRouter as
    // reasoning. Reading only one leaves the other's in `content`, which is what
    // posts an internal monologue into a group chat.
    // A tool call the model wrote as text is NOT a scratchpad. It must survive
    // to be executed - observed live, where this scrubber matched the markup,
    // nulled `content`, and destroyed the very call that would have answered
    // the question (web_fetch had just been blocked with a 403).
    const isTextToolCall = typeof message?.content === "string" && parseTextToolCall(message.content);
    if (
      message &&
      typeof message.content === "string" &&
      looksLikeReasoningLeak(message.content) &&
      !isTextToolCall
    ) {
      console.error(`${label}: provider put the scratchpad in content; moving it to reasoning`);
      const scratchpad = message.reasoning_content ?? message.reasoning;
      message.reasoning = [scratchpad, message.content].filter(Boolean).join("\n");
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
// Tool-call markup rendered as TEXT, rather than as a real tool call.
//
// OBSERVED live (2026-10-08): the model answered "search is hitting a limit",
// the user pushed back, and the reply posted this verbatim into a group chat:
//
//     <tool_call>
//     <function=web_fetch>
//     <parameter=url>
//     https://www.checkpointsg.com/haze
//     </parameter>
//     </function>
//     </tool_call>
//
// The tags carry a ZERO-WIDTH SPACE (U+200B) so they do not render as markup in
// a chat client - which is exactly why they were missed: the text looks
// plausible, and the previous detector only knew prose-reasoning and
// bulleted-self-audit shapes.
//
// Built from codepoints, never typed literally: an invisible character in this
// source is impossible to review and impossible to reproduce.
const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);

// Every dialect a model may use when it emits a call as prose. The closing tags
// are optional because a truncated generation loses them.
const TOOL_CALL_MARKUP_RE = new RegExp(
  [
    // <tool_call> ... </tool_call>, with or without the zero-width space,
    // or the underscore-free spelling some providers normalise to.
    "<\s*[/\\]?\s*to_?o_?l_?c_?a_?l_?l_?\s*>",
    "<\s*[/\\]?\s*fun_?c_?t_?i_?o_?n_?\s*>",
    "<\s*[/\\]?\s*parameter[a-z_]*\s*>",
    "<\s*[/\\]?\s*argument[a-z_]*\s*>",
  ].join("|"),
  "i"
);

// A fence or brace wrapper around the same idea, for providers that render a
// call as JSON or a code block rather than XML.
const TOOL_CALL_STRUCTURE_RE =
  /(?:\{\s*"?(?:tool_call|function_call|tool_use)"?\s*:)|(?:```\s*(?:tool_call|function_call|tool_use)\b)|(?:\btool_call\s*\(\s*\{)/i;

const REASONING_LEAK_RE =
  /^\s*(?:okay|ok|alright|hmm|so|let me|i need to|i'll|i will|first,?|thinking process|here'?s? (?:a )?thinking)\b[\s\S]{0,4000}?\n\s*(?:1\.|2\.|3\.|step 1|-\s)/i;

// Strips invisible characters, so a zero-width space cannot be used to slip a
// tag past the patterns above.
function visibleOnly(text) {
  return String(text ?? "")
    .replace(new RegExp(ZWSP, "g"), "")
    .replace(new RegExp(ZWNJ, "g"), "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "");
}

// A tool call the model wrote as TEXT instead of emitting it structurally.
//
// OBSERVED live (2026-10-08): web_search failed, the model fell back to
// web_fetch and got real data, then emitted this as its final content:
//
//     <tool_call>
//     <function=web_search>
//     <parameter=max_results>5</parameter>
//     <parameter=query>NEA Singapore PSI current 2025</parameter>
//     </function>
//     </tool_call>
//
// Rejecting it (which the leak detector correctly does) leaves the user with
// nothing - the fallback data was already in hand and thrown away. So the
// markup is PARSED and executed as the call the model meant. A model that
// knows what it wants should get it, rather than being scolded for spelling it
// wrong.
//
// Returns null when the text is not a tool call, so the caller falls through to
// the normal reply path.
function parseTextToolCall(text) {
  if (typeof text !== "string") return null;
  const visible = visibleOnly(text);

  // JSON form, checked FIRST because it needs no tags at all. A model may emit
  // {"name":"web_fetch","arguments":{...}} with no wrapper, and treating that as
  // prose throws away a perfectly clear call.
  const jsonMatch = visible.match(
    /\{\s*"?name"?\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*"?arguments"?\s*:\s*(\{[\s\S]*?\})\s*\}/
  );
  if (jsonMatch) {
    try {
      return { name: jsonMatch[1], args: JSON.parse(jsonMatch[2]) ?? {} };
    } catch {
      return null;
    }
  }

  // Flat form, observed live: the model wrote a whole extra paragraph of
  // preamble and then a bare {"tool":"web_search","query":"..."}. Different key,
  // arguments inline rather than nested, and often preceded by prose.
  const flatMatch = visible.match(
    /\{\s*"(?:tool|tool_name|function)"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,([\s\S]*?)\}/i
  );
  if (flatMatch) {
    const args = {};
    const argRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([^"]*)"/g;
    let am;
    while ((am = argRe.exec(flatMatch[2])) !== null) {
      args[am[1]] = am[2];
    }
    // {"tool":"web_search","max_results":5} - a numeric argument, same coercion.
    const numRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(\d+(?:\.\d+)?)/g;
    let nm;
    while ((nm = numRe.exec(flatMatch[2])) !== null) {
      args[nm[1]] = Number(nm[2]);
    }
    if (Object.keys(args).length) {
      return { name: flatMatch[1], args };
    }
  }

  if (!TOOL_CALL_MARKUP_RE.test(visible)) return null;

  // <function=name> ... <parameter=key>value</parameter> ...
  const nameMatch = visible.match(/<\s*function\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/i);
  const name = nameMatch?.[1];
  if (!name) return null;

  const args = {};
  const paramRe = /<\s*parameter\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
  let m;
  while ((m = paramRe.exec(visible)) !== null) {
    args[m[1]] = m[2].trim();
  }

  // Coerce the obvious types: a model writing <parameter=max_results>5</parameter>
  // means the number 5, not the string "5".
  for (const [k, v] of Object.entries(args)) {
    if (v === "true") args[k] = true;
    else if (v === "false") args[k] = false;
    else if (v !== "" && !Number.isNaN(Number(v))) args[k] = Number(v);
  }
  return { name, args };
}

function looksLikeReasoningLeak(text) {
  if (typeof text !== "string" || !text.trim()) return false;

  // Protocol markup is checked FIRST and on its own: it is unambiguous, and it
  // is the one shape that reaches a user as visibly broken output.
  const visible = visibleOnly(text);
  if (TOOL_CALL_MARKUP_RE.test(visible)) return true;
  if (TOOL_CALL_STRUCTURE_RE.test(visible)) return true;

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

// A provider that does not support tools answers with a 4xx naming tools, and
// that is indistinguishable from a broken request unless it is recognised. It
// matters because opencode go's tool support is NOT verifiable without a key,
// so a user selecting one of its models must get a clear message rather than a
// generic failure.
export function looksLikeToolRejection(status, bodyText) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /tool|function.?call/i.test(bodyText ?? "");
}

// One retry for a degenerate reply. Kept separate from the tool loop so a
// truncation mid-chain is retried with the same message history.
async function callModel(chatId, systemPrompt, userPrompt, maxTokens = REPLY_MAX_TOKENS, label = "call", attempt = 0, model = MODEL_NAME, route = {}) {
  const data = await modelRequest(chatId, label, {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: maxTokens,
  }, route);
  try {
    return contentOf(data, { requireSubstance: true });
  } catch (err) {
    if (attempt >= 1) throw err;
    log(chatId, `${label} truncated, retrying once: ${err.message}`);
    return callModel(chatId, systemPrompt, userPrompt, maxTokens, label, attempt + 1, model, route);
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

async function callModelWithTools(chatId, systemPrompt, userPrompt, model = MODEL_NAME, plan = PLANS.free, route = {}, meter = { micro: 0 }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // The plan bounds the work one message may do. Searches are counted across
  // the whole turn, so a model that searches on every hop cannot exceed its
  // plan by spreading the calls out.
  const hopBudget = allowedHops(plan);
  let searchesUsed = 0;

  // Whether this model accepts tools. opencode go's support cannot be verified
  // without a key, so the first refusal is detected and remembered for the
  // turn - the user still gets an answer, from what the model knows.
  let toolsAllowed = true;
  let data;
  try {
    data = await modelRequest(chatId, "reply", {
      model,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: REPLY_MAX_TOKENS,
    }, route, meter);
  } catch (err) {
    if (!looksLikeToolRejection(err?.status, err?.bodyText)) throw err;
    // Retried without tools rather than failing the reply outright.
    log(chatId, `${model} rejected tools; answering without them`);
    toolsAllowed = false;
    data = await modelRequest(chatId, "reply", {
      model,
      messages,
      temperature: 0.7,
      max_tokens: REPLY_MAX_TOKENS,
    }, route, meter);
  }
  let choice = data.choices[0];
  let hops = 0;
  if (!toolsAllowed) return contentOf(data, { requireSubstance: true });

  // The hop budget is a hard stop. When it runs out with the model still
  // asking for another tool, the remaining calls are forced to "none" so it
  // has to answer from what it already has - otherwise content comes back null
  // and the user gets nothing at all.
  while (choice.message.tool_calls && hops < hopBudget) {
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
      const isSearch = call.function.name === "web_search" || call.function.name === "owl_research";
      if (isSearch && !withinSearchBudget(plan, searchesUsed)) {
        // Refused rather than executed, and told plainly, so the model answers
        // from what it has instead of retrying the same search.
        result = quotaMessage("research", plan);
        log(chatId, `search refused: plan ${plan.id} allows ${plan.searchesPerMessage} per message`);
      } else {
        if (isSearch) searchesUsed++;
        try {
          result = await executeTool(call.function.name, args);
        } catch (err) {
          // The message is an INSTRUCTION, not just a diagnostic. Observed live:
          // web_search failed, the model read the failure as "search is
          // unavailable", told the user it could not look anything up, and never
          // tried web_fetch - which would have answered. It has to be told that
          // a failure in one tool is not a reason to refuse the question.
          result = [
            `Tool failed: ${err.message}`,
            "This tool did not work, but another one may. If you have another tool that " +
              "could answer (for example fetching a specific URL when searching failed), " +
              "try it now. Only tell the user you cannot find something after every " +
              "relevant tool has been tried. Do not describe this failure as being " +
              "'rate limited', 'unavailable', or a general lack of access unless that " +
              "is literally what went wrong - that reads as an excuse not to try.",
          ].join(" ");
          noteFailure("tool", `${call.function.name}: ${err.message}`, err?.stack);
          log(chatId, `tool ${call.function.name} failed: ${err.message}`);
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result).slice(0, 6000),
      });
    }

    const isFinalHop = hops + 1 >= hopBudget;
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
    }, route, meter);
    choice = data.choices[0];
    hops++;
  }

  // The hop budget is spent, but the model may still have written a tool call
  // as TEXT on the last hop - observed live, where web_fetch was blocked (403),
  // the model emitted <tool_call> markup as its content, and the loop exited
  // before anything could act on it. The user got "hit an error" while the
  // model was asking for exactly the page that would have answered.
  //
  // So the text-call path runs AFTER the loop as well as inside it: reaching
  // here with a text tool call is not a reason to give up, it is one more
  // attempt to answer.
  for (let extra = 0; extra < 2; extra++) {
    if (typeof choice?.message?.content !== "string") break;
    const asCall = parseTextToolCall(choice.message.content);
    if (!asCall) break;

    log(chatId, `executing a tool call the model wrote as text: ${asCall.name}`);
    messages.push({ role: "user", content: choice.message.content });
    let result;
    const isSearch = asCall.name === "web_search" || asCall.name === "owl_research";
    if (isSearch && !withinSearchBudget(plan, searchesUsed)) {
      result = quotaMessage("research", plan);
    } else {
      if (isSearch) searchesUsed++;
      try {
        result = await executeTool(asCall.name, asCall.args);
      } catch (err) {
        noteFailure("tool", `${asCall.name}: ${err.message}`, err?.stack);
        result = `Tool failed: ${err.message}`;
      }
    }
    // Bounded: a model that keeps writing new text calls must not loop forever.
    messages.push({
      role: "user",
      content: `Tool ${asCall.name} returned:
${String(result).slice(0, 6000)}`,
    });
    data = await modelRequest(chatId, "reply after text tool call", {
      model,
      messages,
      temperature: 0.7,
      max_tokens: REPLY_MAX_TOKENS,
    }, route, meter);
    choice = data.choices[0];
  }

  try {
    return contentOf(data, { requireSubstance: true });
  } catch (err) {
    // The model ran out of ways to phrase this as prose and kept writing tool
    // calls. We have the tool RESULTS, so summarise them rather than telling the
    // user "hit an error" - the answer is usually sitting in the transcript.
    const lastResult = [...messages].reverse().find((m) => m.role === "tool")?.content;
    if (lastResult && looksLikeReasoningLeak(String(data?.choices?.[0]?.message?.content ?? ""))) {
      noteFailure("text-call-exhausted", "answered from tool results instead", err?.stack);
      return `Here's what I found:

${String(lastResult).slice(0, 1200)}`;
    }
    // Recorded with the REASON, because "hit an error" tells an operator
    // nothing and this is where a rejected reply actually dies.
    noteFailure("content-rejected", err?.message, err?.stack);
    throw err;
  }
}

// The humanizer is a full extra model call per reply. On a free reasoning model
// that measured ~35s and ~1800 reasoning tokens to reword a single sentence -
// often more than the reply itself. It is skipped for text that is already
// short and conversational, which is the common case for a chat reply.
async function humanize(chatId, text, model = MODEL_NAME, route = {}) {
  if (HUMANIZE !== "true") return text;
  // Skip the extra call for replies already short enough to be in the persona's
  // casual register. HUMANIZE_SKIP_UNDER is opt-out, so setting it to false
  // restores unconditional humanising.
  if (HUMANIZE_SKIP_UNDER === "true" && text.length <= HUMANIZE_MAX_CHARS) {
    return text;
  }
  try {
    return await callModel(chatId, HUMANIZER_SYSTEM_PROMPT, text, REPLY_MAX_TOKENS, "humanizer", 0, model, route);
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
async function sendBobReply(chatId, senderId, userPrompt, tagUnsolicited, finalize, model = MODEL_NAME, plan = PLANS.free, route = {}) {
  await bot.sendChatAction(chatId, "typing");
  const typingPing = setInterval(
    () => bot.sendChatAction(chatId, "typing").catch(() => {}),
    4000
  );

  const meter = { micro: 0 };
  let reply;
  try {
    reply = await callModelWithTools(chatId, PERSONA_SYSTEM_PROMPT, userPrompt, model, plan, route, meter);
  } catch (err) {
    // The reason is logged AND carried into the log line the operator reads.
    // A bare "hit an error" to the user with no record of why is the failure
    // mode that cost the most time to diagnose here.
    noteFailure("reply", err?.message, err?.stack);
    console.error(
      "Reply generation failed:",
      err?.message,
      err?.stack ? String.fromCharCode(10) + err.stack.split(String.fromCharCode(10)).slice(1, 4).join(" | ") : ""
    );
    // An overloaded free provider is transient and expected on a busy tier;
    // saying so is more useful than a generic "try asking again", because the
    // user knows the question was fine and should simply retry.
    reply = err?.overloaded ? OVERLOADED_REPLY : FALLBACK_REPLY;
  } finally {
    clearInterval(typingPing);
  }

  const finalText = finalize
    ? finalize(await humanize(chatId, reply, model, route))
    : await humanize(chatId, reply, model, route);
  await sendFormatted(chatId, finalText);

  await insertMessage(chatId, senderId, BOB_NAME, finalText);
  if (tagUnsolicited) await setLastUnsolicitedReply(chatId);
  await meterUsage(route, meter.micro);
}

// A named bot is a persona consulted server-side: it has its own memory
// (bot_messages keyed by bot_id), its own model tier, and its own voice, but
// only the relay posts to Telegram. Returns the text that was sent, or null if
// nothing was.
async function sendNamedBotReply(chatId, senderId, bot, userPrompt, { record = true, plan = PLANS.free, route = {} } = {}) {
  const model = modelForBot(bot);
  const personaName = bot.display_name;

  const meter = { micro: 0 };
  let reply;
  try {
    reply = await callModelWithTools(chatId, PERSONA_SYSTEM_PROMPT, userPrompt, model, plan, route, meter);
  } catch (err) {
    console.error(`Reply from ${personaName} failed:`, err.message);
    reply = err?.overloaded ? OVERLOADED_REPLY : FALLBACK_REPLY;
  }

  // Attributed so a multi-bot group can tell who said what.
  const finalText = `*${personaName}:* ${await humanize(chatId, reply, model, route)}`;
  if (record) {
    await sendFormatted(chatId, finalText);
    // Recorded against THIS bot's memory, never the relay's, so a later message
    // to the same bot continues from what it said. The sender is the persona, so
    // its own transcript reads as a conversation it took part in.
    await insertBotMessage(bot.bot_id, chatId, personaName, finalText);
  }
  await meterUsage(route, meter.micro);
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
  // Read a little more than the window so selectWindow can take the last N in
  // order; every read is keyed on THIS bot's id, so no other bot's or group's
  // conversation can reach this prompt.
  const [summary, ownerMemory, recent] = await Promise.all([
    getBotSummary(bot.bot_id, chatId),
    getBotOwnerMemory(bot.bot_id),
    getRecentBotMessages(bot.bot_id, chatId, DEFAULT_TURNS * 2),
  ]);

  const window = selectWindow(recent, DEFAULT_TURNS);
  const discussionBlock = discussion
    ? `Others have already answered in this round:\n${discussion}\n` +
      `Add your own view as ${bot.display_name} - agree, disagree, or add what ` +
      "they missed. Do not repeat what they said."
    : "";

  // Stable-first: the persona is a constant, the summaries change rarely, and
  // only the turns change per message - so the cacheable prefix stays put.
  return orderForCache({
    persona: PERSONA_SYSTEM_PROMPT,
    ownerSummary: ownerMemory,
    sessionSummary: summary,
    turns: buildTranscript(window),
    latest: [discussionBlock, `${senderName}: ${text}`].filter(Boolean).join("\n\n"),
  });
}

// A relay turn: the addressed bots answer in sequence, each seeing what the
// ones before said. Bounded by planRelay, and abandoned the moment a newer
// message arrives, so a slow free model cannot block someone chiming in.
async function runRelayTurn(chatId, senderId, senderName, text, personas, plan = PLANS.free, route = {}) {
  const ordered = planRelay(personas);
  const token = relayTurns.begin(chatId);
  const replies = [];

  for (const persona of ordered) {
    // Checked before each bot, not just at the start: an interjection during
    // the first bot's generation must stop the rest, not race them.
    if (!relayTurns.isCurrent(chatId, token)) {
      log(chatId, `relay turn superseded after ${replies.length} of ${ordered.length}`);
      return replies;
    }

    // Recorded per persona, so each one's transcript includes what was asked.
    await insertBotMessage(persona.bot_id, chatId, senderName, text);

    const discussion = buildDiscussionContext(replies);
    const prompt = await buildPersonaPrompt(persona, chatId, senderName, text, discussion);
    const spoken = await sendNamedBotReply(chatId, senderId, persona, prompt, { plan, route });
    replies.push({ name: persona.display_name, text: spoken });
  }

  log(chatId, `relay turn complete: ${replies.length} bot(s) answered`);
  return replies;
}

// The plan's rule: min(message count, 15% of the context window).
//
// Two independent triggers, because they catch different failures. The count
// bounds cost deterministically. The token estimate catches a chat of a few
// VERY long messages, which never reaches a row count but still blows the
// context budget. Either can fire.
//
// Returns WHICH one fired, because they lead to different pruning: the size
// trigger has to fold in more aggressively, or a single huge message stays over
// budget after being summarised.
function summariseTrigger({ count, text, batch, contextWindow }) {
  const countFires = summariseTriggered(count, batch);
  const sizeFires = tokenTriggered(text, tokenBudgetFor(contextWindow));
  if (countFires) return "count";
  if (sizeFires) return "size";
  return null;
}

// Shared so both loops cannot drift apart on what "too much" means.
function shouldSummarise(args) {
  return summariseTrigger(args) !== null;
}

// The context window of the model this deployment runs on. Every registered
// model is at least 256k; this is the conservative floor, so the guard fires
// early rather than late.
const DEFAULT_CONTEXT_WINDOW = 262144;

async function summarizeIfNeeded(chatId) {
  const count = await getMessageCount(chatId);

  // Measured over the WHOLE retained history, not just the batch: a chat of a
  // few enormous messages has fewer rows than KEEP_LAST, so measuring only the
  // batch would report zero and the size guard could never fire.
  const retained = await getRecentMessages(chatId, KEEP_LAST);
  const retainedText = retained.map((m) => `${m.sender}: ${m.text}`).join("\n");

  const contextWindow = Number(process.env.CONTEXT_WINDOW_TOKENS ?? DEFAULT_CONTEXT_WINDOW);
  const trigger = summariseTrigger({
    count,
    text: retainedText,
    batch: TRIGGER_AT,
    contextWindow,
  });
  if (!trigger) return;

  // The size guard folds in EVERYTHING but the newest turn. One message at a
  // time does not converge: a single huge message is still over budget after
  // it is summarised, so the loop would re-fire on every subsequent message.
  // The newest turn stays because that is the one being answered.
  const keep = trigger === "size" ? 1 : KEEP_LAST;

  const toSummarize = await getMessagesToSummarize(chatId, keep);
  if (!toSummarize.length) return;

  const batchTranscript = toSummarize
    .map((m) => `${m.sender}: ${m.text}`)
    .join("\n");

  const existingSummary = await getChatSummary(chatId);

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

// The per-bot equivalent of summarizeIfNeeded. Without this, bot_messages
// grows forever and the bot's summary stays empty - so the persona prompt
// silently loses everything older than its window.
//
// Same property as the chat path: write the summary FIRST, delete SECOND, so a
// failure between the two leaves the text recoverable rather than lost.
async function summarizeBotIfNeeded(botId, chatId) {
  const count = await getBotMessageCount(botId, chatId);

  // Measured over the retained history, for the same reason as the chat loop:
  // a bot with fewer rows than DEFAULT_TURNS would report a zero batch, and the
  // size guard could never fire.
  const retained = await getRecentBotMessages(botId, chatId, DEFAULT_TURNS);
  const retainedText = retained.map((m) => `${m.sender}: ${m.text}`).join("\n");

  const trigger = summariseTrigger({
    count,
    text: retainedText,
    batch: TURNS_PER_SUMMARY,
    contextWindow: Number(process.env.CONTEXT_WINDOW_TOKENS ?? DEFAULT_CONTEXT_WINDOW),
  });
  if (!trigger) return;

  // Same aggressive prune as the chat loop: keep only the newest turn.
  const keep = trigger === "size" ? 1 : DEFAULT_TURNS;
  const toSummarize = await getBotMessagesToSummarize(botId, chatId, keep);
  if (!toSummarize.length) return;

  const batch = toSummarize.map((m) => `${m.sender}: ${m.text}`).join("\n");

  const existing = await getBotSummary(botId, chatId);

  const prompt = [
    `Existing summary:\n${existing || "(none yet)"}`,
    `Older messages to fold in:\n${batch}`,
  ].join("\n\n");

  const updated = await callModel(
    chatId,
    SUMMARIZER_SYSTEM_PROMPT,
    prompt,
    SUMMARY_MAX_TOKENS,
    "bot summarizer"
  );

  await updateBotSummary(botId, chatId, updated);
  await deleteBotMessagesByIds(botId, toSummarize.map((m) => Number(m.id)));
  log(chatId, `bot ${botId}: summarised ${toSummarize.length} messages and pruned them`);

  // Tier C travels with the bot across groups, so it is folded from the session
  // summary rather than from raw rows - the rows belong to one chat.
  const ownerMemory = await getBotOwnerMemory(botId);
  const chatTitle = await getChatTitle(chatId);
  const crossPrompt = [
    `Existing summary of everything you know:\n${ownerMemory || "(none yet)"}`,
    `Update from the chat titled "${chatTitle || "untitled"}":\n${updated}`,
  ].join("\n\n");
  const merged = await callModel(
    chatId,
    CROSS_CHAT_SUMMARIZER_PROMPT,
    crossPrompt,
    SUMMARY_MAX_TOKENS,
    "bot owner memory"
  );
  await updateBotOwnerMemory(botId, merged);
  log(chatId, `bot ${botId}: owner memory updated`);
}

// Runs the per-bot pass for every bot in the chat. A failure for one bot must
// not stop the others, so each is caught separately.
async function summarizeBotsSafely(bots, chatId) {
  for (const bot of bots) {
    try {
      await summarizeBotIfNeeded(bot.bot_id, chatId);
    } catch (err) {
      console.error(`Summarisation failed for bot ${bot.bot_id}:`, err.message);
    }
  }
}

// Wrapped so background callers log instead of emitting an unhandled rejection.
async function summarizeSafely(chatId) {
  try {
    await summarizeIfNeeded(chatId);
  } catch (err) {
    noteFailure("summarise", err?.message, err?.stack);
    console.error("Summarization failed:", err.message);
  }
}

// The plan a bot runs under is its OWNER's. A missing row or a billing problem
// resolves to free, never to an error, so a working bot does not go offline
// because of a subscription lookup.
async function planForOwner(ownerUserId) {
  if (ownerUserId == null) return PLANS.free;
  try {
    return resolvePlan(await getSubscription(ownerUserId));
  } catch (err) {
    console.error("Subscription lookup failed, defaulting to free:", err.message);
    return PLANS.free;
  }
}

// Which provider, model and key a given user's reply should use.
//
// A user's own config wins; anything incomplete falls back to the deployment
// default rather than breaking the bot, so a revoked key degrades to the
// default instead of failing every reply.
async function routeForUser(userId, sessionId = null) {
  const deploymentDefault = {
    provider: "openrouter",
    model: MODEL_NAME,
    apiKey: MODEL_API_KEY,
    apiUrl: MODEL_API_URL,
  };
  if (userId == null) {
    return { ...resolveUserModel(null, deploymentDefault), userId: null, sessionId };
  }

  let stored = null;
  try {
    stored = await getUserModelConfig(userId);
  } catch (err) {
    console.error("Model config lookup failed, using the default:", err.message);
  }
  return { ...resolveUserModel(stored, deploymentDefault), userId, sessionId };
}

// Deducts the real cost of a turn from the payer's balance.
//
// BYOK users pay their provider directly, so nothing is deducted - charging
// them would bill twice for the same tokens. A metering failure must never fail
// a reply that was already sent, so it is logged and swallowed.
async function meterUsage(route, costMicro) {
  if (!route?.userId || route.usingOwnKey) return;
  if (!costMicro || costMicro <= 0) return;
  try {
    const balance = await addCredits(route.userId, -costMicro, "model usage");
    if (balance < LOW_BALANCE_MICRO) {
      log(route.userId, `credit low: ${formatUsd(balance)} remaining`);
    }
  } catch (err) {
    console.error("Credit metering failed:", err.message);
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

// `/export [title]` renders the last answer as a document and sends it.
// sendDocument accepts bytes, so no public host is required.
// Renders one export format and sends it as a document. PDF shells out to
// pdf_export.py (ReportLab is pure Python, so it works on Render and Vercel
// where WeasyPrint's GTK chain does not); the rest render in-process.
async function sendExportDocument(chatId, title, body, formatId) {
  const format = getFormat(formatId) ?? getFormat(defaultFormat());
  const source = await getChatTitle(chatId);

  let bytes;
  if (format.id === "pdf") {
    // PDF is the one format that shells out: ReportLab is pure Python, so it
    // works on Render and Vercel where WeasyPrint's GTK chain does not.
    try {
      bytes = await renderPdfBuffer({ title, body, source });
    } catch (err) {
      console.error(`PDF export failed: ${err.message}`);
      if (err?.pythonUnavailable) {
        // A serverless Node runtime ships no Python, so PDF cannot work there.
        // Falling back to HTML - which renders in-process - means the user gets
        // a document rather than a refusal.
        log(chatId, "PDF unavailable here (no Python); falling back to HTML");
        return sendExportDocument(chatId, title, body, "html");
      }
      await sendFormatted(chatId, "Couldn't build the PDF - try text or HTML?");
      return;
    }
  } else if (format.id === "zip") {
    // A project zip needs files, which a chat reply does not carry. Refusing
    // with a reason beats sending an empty archive.
    await sendFormatted(
      chatId,
      "A project zip needs files to archive. Send them and I'll package them."
    );
    return;
  } else if (format.binary) {
    // docx/xlsx render to a Buffer already; wrapping them in a utf8 Buffer
    // would corrupt every byte above 0x7f.
    try {
      bytes = format.render({ title, body, source });
    } catch (err) {
      console.error(`${format.id} export failed: ${err.message}`);
      await sendFormatted(chatId, `Couldn't build the ${format.label} - try PDF or text?`);
      return;
    }
  } else {
    bytes = Buffer.from(format.render({ title, body, source }), "utf8");
  }

  try {
    await bot.sendDocument(
      chatId,
      bytes,
      { caption: `Here's "${title}" as ${format.label}.` },
      { filename: fileNameFor(format, title), contentType: format.mime }
    );
  } catch (err) {
    console.error("Document send failed:", err.message);
    await sendFormatted(chatId, "Couldn't send that document - try again?");
  }
}

// `/export [format] [title]` - the format is optional and defaults to PDF.
async function handleExport(msg, chatId, text, sender) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "export") return false;

  const recent = await getRecentMessages(chatId, 20);
  // The most recent thing Bob said is what a user means by "export this".
  const lastBot = [...recent].reverse().find((m) => m.sender === BOB_NAME);
  if (!lastBot) {
    await sendFormatted(chatId, "Nothing to export yet - ask me something first.");
    return true;
  }

  const args = parsed.args.split(/\s+/).filter(Boolean);
  let formatId = defaultFormat();
  if (args.length && getFormat(args[0].toLowerCase())) {
    formatId = args.shift().toLowerCase();
  }
  const requestedTitle = args.join(" ").trim();
  const title = requestedTitle || `Bob notes - ${(await getChatTitle(chatId)) || "chat"}`;

  await sendExportDocument(chatId, title, lastBot.text, formatId);
  return true;
}

// Shows the format picker, so a user does not have to know the ids.
async function offerExportFormats(chatId) {
  const recent = await getRecentMessages(chatId, 20);
  const lastBot = [...recent].reverse().find((m) => m.sender === BOB_NAME);
  if (!lastBot) {
    await sendFormatted(chatId, "Nothing to export yet - ask me something first.");
    return;
  }
  await bot.sendMessage(chatId, "Pick a format:", {
    reply_markup: buildFormatKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// Commands: /bot_model, /credits, /help
// ---------------------------------------------------------------------------

// Which bot's config a command applies to. A DM has one obvious answer; in a
// group the sender must name a bot they own, so one person cannot reconfigure
// someone else's bot.
async function resolveConfigTarget(chatId, userId, args) {
  const bots = await getBotsForChat(chatId);
  const mine = bots.filter((b) => Number(b.owner_user_id) === Number(userId));
  const candidates = mine.length ? mine : bots;

  if (!candidates.length) return { error: "No bots here yet. Add one first." };

  const named = args.trim();
  if (named) {
    const found = candidates.find(
      (b) => b.display_name.toLowerCase() === named.toLowerCase()
    );
    if (!found) return { error: `You don't have a bot called "${named}" here.` };
    return { bot: found };
  }
  if (candidates.length === 1) return { bot: candidates[0] };
  return {
    error:
      `Which bot? Say /bot_model <name>. Here: ${candidates
        .map((b) => b.display_name)
        .join(", ")}`,
  };
}

async function handleBotModelCommand(msg, chatId, text, sender) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "bot_model") return false;

  const { bot: target, error } = await resolveConfigTarget(chatId, sender.id, parsed.args);
  if (error) {
    await sendFormatted(chatId, error);
    return true;
  }

  const current = await getUserModelConfig(sender.id);
  const currentLine = current
    ? `Currently: ${describeModelChoice(current.provider, current.model) ?? current.model}`
    : "Currently using the default model.";

  await bot.sendMessage(
    chatId,
    `${currentLine}\n\nPick a provider for ${target.display_name}:`,
    { reply_markup: buildProviderKeyboard() }
  );
  return true;
}

// --- Project storage ---------------------------------------------------------
//
// /save_project <name> <path>::<contents> [<path>::<contents> ...]
// /project_zip <name>
//
// Stored in Cloudflare R2, which has no egress fees - the point of project
// storage is that the user downloads their own project back. Everything is inert
// without credentials, and an unconfigured deployment says so rather than
// pretending to save.
//
// The manifest of what was stored lives in Postgres, so /project_zip can rebuild
// the archive without listing R2 (which would need pagination and a permission
// grant beyond a simple prefix read).

async function handleSaveProjectCommand(chatId, text, sender) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "save_project") return false;

  if (!storageConfigured()) {
    await sendFormatted(
      chatId,
      "Project storage isn't configured on this deployment, so I can't save it."
    );
    return true;
  }

  // /save_project myapp README.md::hello::src/index.js::code
  const [name, ...pairs] = parsed.args.split(/\s+/).filter(Boolean);
  if (!name || pairs.length === 0) {
    await sendFormatted(
      chatId,
      "Usage: /save_project <name> <path>::<contents> [<path>::<contents> ...]"
    );
    return true;
  }

  const files = [];
  for (const pair of pairs) {
    const sep = pair.indexOf("::");
    if (sep <= 0) {
      await sendFormatted(chatId, `I could not read "${pair}" - use path::contents.`);
      return true;
    }
    files.push({
      path: pair.slice(0, sep),
      contents: pair.slice(sep + 2),
    });
  }

  const check = validateProject(files);
  if (!check.ok) {
    await sendFormatted(chatId, check.error);
    return true;
  }

  try {
    for (const f of files) {
      await putProjectFile(sender.id, name, f.path, f.contents);
    }
    await saveProjectManifest(sender.id, name, files.map((f) => ({ path: f.path, size: f.contents.length })));
  } catch (err) {
    console.error(`Project save failed: ${err.message}`);
    await sendFormatted(chatId, "Couldn't save that - check the storage settings.");
    return true;
  }

  await sendFormatted(
    chatId,
    `Saved "${name}" - ${check.fileCount} file(s), ${check.totalBytes} bytes. Send /project_zip ${name} to download it.`
  );
  return true;
}

async function handleProjectZipCommand(chatId, text, sender) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "project_zip") return false;

  if (!storageConfigured()) {
    await sendFormatted(
      chatId,
      "Project storage isn't configured on this deployment, so I can't build an archive."
    );
    return true;
  }

  const name = parsed.args.split(/\s+/).filter(Boolean)[0];
  if (!name) {
    await sendFormatted(chatId, "Which project? Send /project_zip <name>.");
    return true;
  }

  const manifest = await getProjectManifest(sender.id, name);
  if (!manifest?.length) {
    await sendFormatted(
      chatId,
      `I have no project called "${name}" saved. Send /save_project ${name} ... first.`
    );
    return true;
  }

  // Refused by the user's own plan before any network call, so an archive that
  // costs nothing to send cannot be used to exhaust the account.
  if (!withinBotQuota(PLANS.free, 1000)) {
    await sendFormatted(chatId, quotaMessage("research", PLANS.free));
    return true;
  }

  try {
    const files = [];
    for (const entry of manifest) {
      const contents = await getProjectFile(sender.id, name, entry.path);
      files.push({ path: entry.path, contents });
    }
    const zip = await buildProjectZip(files);
    await bot.sendDocument(
      chatId,
      zip,
      { caption: `Here's "${name}".` },
      { filename: safeFileName(name, "zip"), contentType: "application/zip" }
    );
  } catch (err) {
    console.error(`Project zip failed: ${err.message}`);
    await sendFormatted(chatId, "Couldn't build that archive - try again?");
  }
  return true;
}

// /addbot <name> - create a named persona and link it to this chat.
//
// This is how a user creates a bot at all. Without it the bots table could only
// be populated by hand, which made the whole named-bot feature unreachable
// from the product.
async function handleAddBotCommand(chatId, text, sender) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "addbot") return false;

  // The bot belongs to the person who made it, not to whoever is in the chat.
  const name = parsed.args.trim();
  const checked = normalizeBotName(name);
  if (!checked.ok) {
    await sendFormatted(chatId, checked.error);
    return true;
  }

  const existing = await getBotByName(chatId, checked.name);
  if (existing && Number(existing.owner_user_id) === Number(sender.id)) {
    await sendFormatted(chatId, `You already have a bot called "${checked.name}" here.`);
    return true;
  }

  // The plan's cap, enforced at the point of creation rather than assumed. A
  // user on the free plan gets one bot; without this the quota is a number in
  // quota.js that nothing checks.
  const plan = await planForOwner(sender.id);
  const owned = await countBotsForOwner(sender.id);
  if (!withinBotQuota(plan, owned)) {
    await sendFormatted(chatId, quotaMessage("bots", plan));
    return true;
  }

  try {
    await upsertUser(sender.id, sender.first_name ?? "Unknown");
    const bot = await createBot({
      ownerUserId: sender.id,
      telegramUserId: null,
      displayName: checked.name,
    });
    // New bots go to the end of the relay order, so adding one never changes
    // who speaks first in an existing discussion.
    const existingBots = await getBotsForChat(chatId);
    await linkBotToChat(bot.bot_id, chatId, {
      relayPosition: existingBots.length,
    });
  } catch (err) {
    console.error("Bot creation failed:", err.message);
    await sendFormatted(chatId, "Couldn't create that bot - try a different name?");
    return true;
  }

  await sendFormatted(
    chatId,
    `Added ${checked.name}. Address it with @${checked.name.replace(/\s+/g, "")} or "${checked.name}: ..."`
  );
  return true;
}

async function handleCreditsCommand(chatId, text, sender) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "credits") return false;

  const balance = await getCreditBalance(sender.id);
  const cfg = await getUserModelConfig(sender.id);
  const usingOwnKey = Boolean(cfg?.apiKey);
  const lines = [`Balance: ${formatUsd(balance)}`];
  if (usingOwnKey) {
    lines.push("You're using your own API key, so nothing is deducted from your balance.");
  } else if (balance <= 0) {
    lines.push("Buy credit to keep going without interruption.");
  } else if (balance < LOW_BALANCE_MICRO) {
    lines.push("Running low - top up to avoid interruptions.");
  }
  await bot.sendMessage(chatId, lines.join("\n"), {
    reply_markup: buildCreditKeyboard(),
  });
  return true;
}

async function handleHelpCommand(chatId, text) {
  const parsed = parseCommand(text);
  if (!parsed || parsed.command !== "help") return false;
  await sendFormatted(
    chatId,
    [
      "Commands:",
      "/bot_model [name] - choose the model this chat's bot uses",
      "/credits - balance and top-up",
      "/addbot <name> - add a named bot to this chat",
      "/export [format] [title] - export the last answer (pdf, html, markdown, text, csv)",
      "/save_project <name> <path>::<contents> ... - store a small project",
      "/project_zip <name> - get a stored project back as a zip",
      "",
      "In a group, name a bot to talk to it: @Alice, or \"Alice: ...\".",
    ].join("\n")
  );
  return true;
}

// Handles a keyed-in API key. The key is stored, never logged, and the message
// carrying it is deleted where Telegram allows it.
async function handleKeySubmission(msg, chatId, text, sender) {
  if (!pendingKeyPrompt.has(sender.id)) return false;
  const pending = pendingKeyPrompt.get(sender.id);
  // Expire the prompt so an unrelated later message is not swallowed.
  if (Date.now() - pending.at > 5 * 60 * 1000) {
    pendingKeyPrompt.delete(sender.id);
    return false;
  }
  pendingKeyPrompt.delete(sender.id);

  const provider = getProvider(pending.provider);
  const model = getModel(pending.provider, pending.model);
  if (!provider || !model) {
    await sendFormatted(chatId, "That model is no longer available - start again with /bot_model.");
    return true;
  }

  const check = validateKeyFormat(pending.provider, text.trim());
  if (!check.ok) {
    await sendFormatted(chatId, check.error);
    return true;
  }

  await setUserModelConfig(sender.id, {
    provider: pending.provider,
    model: pending.model,
    apiKey: check.key,
  });

  // Remove the message carrying the secret where the bot has rights to.
  bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  await sendFormatted(
    chatId,
    `Saved. ${describeModelChoice(pending.provider, pending.model)} You're using your own key now, so calls are billed to you directly.`
  );
  return true;
}

// ---------------------------------------------------------------------------
// Inline callbacks
// ---------------------------------------------------------------------------

// Key prompts are short-lived and per user. A Map is acceptable here because a
// dropped prompt only means the user re-runs /bot_model - the config itself
// lives in Postgres, so nothing is lost on serverless.
const pendingKeyPrompt = new Map();

async function handleCallbackQuery(query) {
  const chatId = query?.message?.chat?.id;
  const userId = query?.from?.id;
  const data = query?.data;
  if (!chatId || !userId) return;

  const cb = parseCallback(data);
  // Always answer, or the client shows a spinner until it times out.
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});

  if (!cb.action) {
    return ack("That button is no longer valid.");
  }

  if (cb.action === "provider") {
    const provider = getProvider(cb.provider);
    await ack(`Provider: ${provider.label}`);
    await bot.sendMessage(chatId, `Pick a model from ${provider.label}:`, {
      reply_markup: buildModelKeyboard(cb.provider),
    });
    return;
  }

  if (cb.action === "model") {
    const model = getModel(cb.provider, cb.model);
    await ack(model.label);

    // A free model needs no key, so it can be applied immediately.
    if (model.tier === "free") {
      // The deployment key is used for free models, so clear any stored one.
      await clearUserModelConfig(userId);
      await sendFormatted(
        chatId,
        `Done - using ${describeModelChoice(cb.provider, cb.model)} No key needed.`
      );
      return;
    }

    pendingKeyPrompt.set(userId, {
      provider: cb.provider,
      model: cb.model,
      at: Date.now(),
    });
    await sendFormatted(
      chatId,
      `Send me your ${getProvider(cb.provider).label} API key as your next message and I'll save it.\n\nI'll delete your message once it's saved. You can cancel with /bot_model.`
    );
    return;
  }

  if (cb.action === "buy") {
    const pack = CREDIT_PACKS.find((p) => p.id === cb.pack);
    await ack(`Selected ${pack.label}`);

    // Free-testing switch. Refused LOUDLY rather than silently ignored: a
    // button that looks live and charges nobody is worse than one that says so.
    if (!purchasesEnabled()) {
      await sendFormatted(
        chatId,
        `Purchases are turned off on this deployment right now, so nothing has been ` +
          `charged and the ${pack.label} pack wasn't started.`
      );
      return;
    }

    if (!paymentsConfigured()) {
      // Saying so is the honest answer; the alternative is a button that
      // appears to work and grants credit nobody paid for.
      await sendFormatted(
        chatId,
        `You picked the ${pack.label} pack (${formatUsd(creditsForPack(pack))} of credit). ` +
          "Card payment isn't configured on this deployment, so nothing has been charged."
      );
      return;
    }

    // The redirect only tells the user to come back. Credit is granted by the
    // signature-verified webhook, never by this URL.
    try {
      const session = await createCheckoutSession({
        packId: pack.id,
        userId,
        successUrl: "https://t.me",
        cancelUrl: "https://t.me",
      });
      await sendFormatted(
        chatId,
        `Tap to pay ${pack.label} for ${formatUsd(creditsForPack(pack))} of credit:\n${session.url}`
      );
    } catch (err) {
      console.error("Checkout session failed:", err.message);
      await sendFormatted(chatId, "Couldn't start the payment - try again in a moment.");
    }
    return;
  }

  if (cb.action === "export") {
    await ack();
    const recent = await getRecentMessages(chatId, 20);
    const lastBot = [...recent].reverse().find((m) => m.sender === BOB_NAME);
    if (!lastBot) {
      await sendFormatted(chatId, "Nothing to export yet.");
      return;
    }
    const title = `Bob notes - ${(await getChatTitle(chatId)) || "chat"}`;
    await sendExportDocument(chatId, title, lastBot.text, cb.format);
    return;
  }

  return ack();
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

  // A command is handled before routing, so "/export" is never mistaken for a
  // message addressed to a bot. A pending key prompt is checked first, because
  // an API key is not a command and must not be treated as chat text.
  if (await handleKeySubmission(msg, chatId, text, sender)) {
    return;
  }
  if (await handleExport(msg, chatId, text, sender)) {
    summarizeSafely(chatId);
    return;
  }
  if (await handleBotModelCommand(msg, chatId, text, sender)) {
    return;
  }
  if (await handleAddBotCommand(chatId, text, sender)) {
    return;
  }
  if (await handleCreditsCommand(chatId, text, sender)) {
    return;
  }
  if (await handleSaveProjectCommand(chatId, text, sender)) {
    return;
  }
  if (await handleProjectZipCommand(chatId, text, sender)) {
    return;
  }
  if (await handleHelpCommand(chatId, text)) {
    return;
  }

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
    // A persona runs on its OWNER's plan, not the sender's: the owner pays for
    // it, and a guest must not be able to spend someone else's quota.
    const personaPlan = await planForOwner(personas[0].owner_user_id);

    // One bot addressed: answer as before. Two or more: it is a relay turn, and
    // the bots answer in sequence seeing each other, rather than posting N
    // unrelated replies.
    if (personas.length === 1) {
      // The human's message is recorded against the persona's own memory, or
      // its transcript would contain only its own replies - it would never see
      // what it was actually asked.
      await insertBotMessage(personas[0].bot_id, chatId, senderName, cleaned);
      const prompt = await buildPersonaPrompt(personas[0], chatId, senderName, cleaned, "");
      await sendNamedBotReply(chatId, sender.id, personas[0], prompt, {
        plan: personaPlan,
        route: await routeForUser(personas[0].owner_user_id, sessionIdFor(personas[0].bot_id, chatId)),
      });
      summarizeSafely(chatId);
      summarizeBotsSafely(personas, chatId);
      return;
    }

    // Deliberately NOT awaited. The webhook runs one job per chat in order, so
    // awaiting the turn here would hold the queue for its whole duration - and
    // the human's interjection would sit behind it, unable to cancel anything.
    // Starting it detached is what makes chiming in work at all.
    runRelayTurn(
      chatId,
      sender.id,
      senderName,
      cleaned,
      personas,
      personaPlan,
      await routeForUser(personas[0].owner_user_id, sessionIdFor(personas[0].bot_id, chatId))
    ).catch((err) =>
      console.error(`Relay turn failed for chat ${chatId}:`, err.message)
    );
    summarizeSafely(chatId);
    summarizeBotsSafely(personas, chatId);
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

    const senderRoute = await routeForUser(sender.id, sessionIdFor(null, chatId));
    try {
      await sendBobReply(
        chatId,
        sender.id,
        userPrompt,
        jumpingIn,
        claimed ? ensureAiDisclosure : undefined,
        senderRoute.model,
        await planForOwner(owner?.user_id),
        senderRoute
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
//
// This lives in Postgres, not in a Set: on serverless an invocation shares no
// memory with the last one, so an in-process Set would let a retry through on a
// different instance. The table's PRIMARY KEY does the arbitration, so two
// concurrent claims cannot both win.
async function isDuplicateUpdate(updateId, chatId) {
  if (updateId === undefined || updateId === null) return false;
  const claimed = await claimUpdate(updateId, chatId ?? 0);
  // Keep the table bounded. Cheap enough to do on every update at this volume,
  // and a failure here must not drop the message.
  pruneProcessedUpdates(SEEN_UPDATE_LIMIT).catch(() => {});
  return !claimed;
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

// A Postgres lease around the in-process queue, so a per-chat serialisation
// guarantee survives serverless, where two invocations share no memory and the
// in-process Map serialises nothing.
//
// The lease BOUNDS the window rather than closing it: if two invocations arrive
// in the same instant both can pass the check. The losing one retries briefly,
// which is what turns a race into a short delay instead of two overlapping
// replies.
//
// A failure to take the lease is NOT fatal. On a long-lived process the
// in-process queue already serialises correctly, so degrading to it is safer
// than refusing the message.
async function withChatLease(chatId, job) {
  const holder = `inv-${crypto.randomUUID()}`;
  const LEASE_TTL_S = 300;
  let held = false;

  try {
    held = await acquireChatLock(chatId, holder, LEASE_TTL_S);
  } catch (err) {
    console.error(`Chat lease unavailable for ${chatId}:`, err.message);
    return enqueueForChat(chatId, job);
  }

  if (!held) {
    // Someone else is mid-turn for this chat. Wait for the in-process queue to
    // drain and retry a bounded number of times; if it never frees, do the work
    // anyway rather than silently dropping the message.
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await acquireChatLock(chatId, holder, LEASE_TTL_S)) {
        held = true;
        break;
      }
    }
    if (!held) {
      console.error(`Proceeding without a lease for chat ${chatId}`);
      return enqueueForChat(chatId, job);
    }
  }

  try {
    return await enqueueForChat(chatId, job);
  } finally {
    if (held) {
      await releaseChatLock(chatId, holder).catch((err) =>
        console.error(`Chat lease release failed for ${chatId}:`, err.message)
      );
    }
  }
}

app.post("/telegram-webhook", async (req, res) => {
  const secret = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== WEBHOOK_SECRET) return res.sendStatus(403); // TC-34

  // Respond before doing any work: Telegram backs off and eventually gives up
  // on a webhook that takes too long to acknowledge.
  res.sendStatus(200);

  const update = req.body;
  const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
  if (await isDuplicateUpdate(update?.update_id, chatId)) return;

  // A button press is its own update type and never carries a message.
  if (update?.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  if (chatId === undefined) {
    await withChatLease("global", () => handleUpdate(update));
    return;
  }
  await withChatLease(chatId, () => handleUpdate(update));
});

// Stripe webhook. Credit is granted ONLY here, and only after the signature
// verifies - the browser redirect is never trusted to grant anything.
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!paymentsConfigured()) {
    // Configured off is not an error the caller can fix; say so plainly rather
    // than accepting an event we cannot verify.
    return res.status(503).send("payments are not configured");
  }

  // The switch covers the WEBHOOK, not just the button. Otherwise a checkout
  // started before the switch was flipped would still deliver credit after it,
  // which is exactly what "off" has to mean.
  if (!purchasesEnabled()) {
    return res.status(503).send("purchases are disabled");
  }

  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const check = verifyStripeSignature(body, req.header("Stripe-Signature"), secret);
  if (!check.ok) {
    console.error(`Stripe webhook rejected: ${check.error}`);
    return res.status(400).send("invalid signature");
  }

  const event = parseStripeEvent(body);
  if (!event?.type) return res.status(400).send("unparseable event");

  // Only this event grants credit. Anything else is acknowledged and ignored,
  // so Stripe stops retrying it.
  if (event.type !== "checkout.session.completed") return res.sendStatus(200);

  // Claim the event id first, so a Stripe retry cannot double-credit.
  const claimed = await claimPaymentEvent(event.id);
  if (!claimed) {
    log("stripe", `duplicate payment event ${event.id} ignored`);
    return res.sendStatus(200);
  }

  const credit = creditForCheckout(event.pack);
  const userId = Number(event.userId);
  if (!credit || !Number.isFinite(userId)) {
    // Acknowledged so Stripe stops retrying, but logged loudly: this is a
    // mismatch between our pack table and the session metadata.
    console.error(`Stripe event ${event.id}: unknown pack "${event.pack}" or user "${event.userId}"`);
    return res.sendStatus(200);
  }

  await addCredits(userId, credit, `purchase:${event.pack}`);
  log("stripe", `credited user ${userId} for pack ${event.pack}`);
  res.sendStatus(200);
});

// Recent failures, kept in memory so a deployed instance can be DIAGNOSED
// without log access. Render's REST API exposes no runtime logs, so without
// this the only way to learn why a reply failed is to guess - which is exactly
// what went wrong here.
//
// Bounded ring buffer: the newest N, oldest dropped. Secrets never enter it -
// callers pass a message and a stack, not a payload.
const recentFailures = [];
const MAX_FAILURES = 20;
function noteFailure(kind, message, stack) {
  recentFailures.push({
    at: new Date().toISOString(),
    kind,
    message: String(message ?? "").slice(0, 400),
    where: stack ? String(stack).split(String.fromCharCode(10)).slice(1, 4).join(" | ").slice(0, 400) : "",
  });
  while (recentFailures.length > MAX_FAILURES) recentFailures.shift();
}

// Guarded by the same secret Telegram uses, so it is not a public endpoint.
app.get("/diagnostics", (req, res) => {
  const secret = req.header("X-Telegram-Bot-Api-Secret-Token") ?? req.query.secret;
  if (secret !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.json({
    startedAt: processStartedAt,
    uptimeSeconds: Math.round((Date.now() - processStartedAt) / 1000),
    node: process.version,
    model: MODEL_NAME,
    failures: recentFailures.slice().reverse(),
  });
});

app.get("/health", (_req, res) => res.send("ok"));

// The app is exported so a serverless entry point (api/webhook.js on Vercel)
// can reuse THE SAME routes rather than forking them. A second implementation
// would drift, and the webhook is exactly the code that must not.
export { app };

// Schema bootstrap, run once per process. On serverless this runs on a cold
// start; ensureSchema is idempotent, so a warm instance re-running it is safe.
let schemaReady = null;
export function ensureSchemaReady() {
  if (!schemaReady) {
    schemaReady = ensureSchema().catch((err) => {
      // Reset so a later invocation retries instead of caching the failure.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// Only a long-lived process listens on a port. Importing this module (which is
// what the serverless entry does) must not bind one.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  ensureSchemaReady()
    .then(() =>
      app.listen(Number(PORT ?? 3000), () =>
        console.log(`Bob running on port ${PORT ?? 3000}`)
      )
    )
    .catch((err) => {
      console.error("Failed to initialize database schema:", err.message);
      process.exit(1);
    });
}
