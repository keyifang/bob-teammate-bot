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
} from "./db.js";
import { TOOL_SCHEMAS, executeTool, noteToolCall } from "./tools.js";
import { buildReplyPrompt } from "./prompt.js";
import { formatForTelegram, chunkMessage, escapeHtml } from "./formatting.js";

const {
  TELEGRAM_BOT_TOKEN,
  DEEPSEEK_API_KEY,
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
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
const FALLBACK_REPLY =
  "Hmm, hit an error looking into that - try asking again?";
const SEEN_UPDATE_LIMIT = 500;

// Partial config fails slowly and confusingly in production (silent 401s, a
// webhook that never authenticates). Fail loudly at boot instead (TC-38).
const REQUIRED_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_API_URL",
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
const app = express();
app.use(express.json({ limit: "1mb" }));

function log(chatId, message) {
  console.log(`[chat ${chatId}] ${message}`);
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

// Token usage is logged for every call so running cost is observable (FR-13).
function logUsage(chatId, label, data) {
  const usage = data?.usage;
  if (!usage) return;
  log(
    chatId,
    `${label} tokens: prompt=${usage.prompt_tokens ?? "?"} ` +
      `completion=${usage.completion_tokens ?? "?"} total=${usage.total_tokens ?? "?"}`
  );
}

async function deepSeekRequest(chatId, label, payload) {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  logUsage(chatId, label, data);
  return data;
}

function contentOf(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("DeepSeek returned no message content");
  }
  return content.trim();
}

async function callDeepSeek(chatId, systemPrompt, userPrompt, maxTokens = 400, label = "call") {
  const data = await deepSeekRequest(chatId, label, {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: maxTokens,
  });
  return contentOf(data);
}

async function callDeepSeekWithTools(chatId, systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let data = await deepSeekRequest(chatId, "reply", {
    model: DEEPSEEK_MODEL,
    messages,
    tools: TOOL_SCHEMAS,
    tool_choice: "auto",
    temperature: 0.7,
    max_tokens: 500,
  });
  let choice = data.choices[0];
  let hops = 0;

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

    data = await deepSeekRequest(chatId, `reply hop ${hops + 1}`, {
      model: DEEPSEEK_MODEL,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 500,
    });
    choice = data.choices[0];
    hops++;
  }

  return contentOf(data);
}

async function humanize(chatId, text) {
  if (HUMANIZE !== "true") return text;
  try {
    return await callDeepSeek(chatId, HUMANIZER_SYSTEM_PROMPT, text, 300, "humanizer");
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
async function sendBobReply(chatId, senderId, userPrompt, tagUnsolicited, finalize) {
  await bot.sendChatAction(chatId, "typing");
  const typingPing = setInterval(
    () => bot.sendChatAction(chatId, "typing").catch(() => {}),
    4000
  );

  let reply;
  try {
    reply = await callDeepSeekWithTools(chatId, PERSONA_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    console.error("Reply generation failed:", err.message);
    reply = FALLBACK_REPLY;
  } finally {
    clearInterval(typingPing);
  }

  const finalText = finalize
    ? finalize(await humanize(chatId, reply))
    : await humanize(chatId, reply);
  await sendFormatted(chatId, finalText);

  await insertMessage(chatId, senderId, BOB_NAME, finalText);
  if (tagUnsolicited) await setLastUnsolicitedReply(chatId);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function buildTranscript(messages) {
  return messages.map((m) => `${m.sender}: ${m.text}`).join("\n");
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

  const updatedSummary = await callDeepSeek(
    chatId,
    SUMMARIZER_SYSTEM_PROMPT,
    prompt,
    500,
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
  const merged = await callDeepSeek(
    chatId,
    CROSS_CHAT_SUMMARIZER_PROMPT,
    crossPrompt,
    500,
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
    await upsertUser(inviter.id, inviter.first_name);
    await setChatOwnerIfUnset(chatId, inviter.id); // FR-01: set once, never reassigned
    await addParticipant(chatId, inviter.id);
    log(chatId, `owner set to ${inviter.first_name}`);
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
    const intro = await callDeepSeek(
      chatId,
      PERSONA_SYSTEM_PROMPT,
      INTRO_MESSAGE_PROMPT,
      200,
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

  const text = msg.text;
  if (!text) return;

  await upsertUser(sender.id, sender.first_name);
  await addParticipant(chatId, sender.id);

  const isPrivate = msg.chat.type === "private";

  // A private chat has no invite event, so the first person to message it
  // becomes the owner (FR-01 / TC-03).
  if (isPrivate) {
    await setChatOwnerIfUnset(chatId, sender.id);
  }

  await insertMessage(chatId, sender.id, sender.first_name, text);

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
