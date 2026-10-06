// Phase 3: named bots in a chat.
//
// A group can host several named bots, each with its own memory and model
// tier. Which one answers is decided by name: an explicit @mention wins, then
// a leading name ("Alice, ..."), then a "Name:" prefix. Everything here is
// pure - no database, no globals - so the routing rules can be tested directly
// and any leak between bots can only come from the caller.

export const MAX_BOT_NAME = 32;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
// Control characters are rejected rather than folded: collapsing "Bob\nAlice"
// into "Bob Alice" would silently invent a name the user never typed, and a
// name that could carry a newline could impersonate a second line of a prompt.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// Bots a human can name. Returns { ok, name } or { ok:false, error }.
export function normalizeBotName(raw) {
  const rawName = String(raw ?? "");
  if (CONTROL_RE.test(rawName)) {
    return { ok: false, error: "Names cannot contain line breaks or tabs." };
  }
  const name = rawName.trim().replace(/ {2,}/g, " ");
  if (!name) return { ok: false, error: "A bot needs a name." };
  if (name.length > MAX_BOT_NAME) {
    return { ok: false, error: `That name is too long (max ${MAX_BOT_NAME}).` };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: "Names can use letters, numbers, spaces, - and _ only.",
    };
  }
  return { ok: true, name };
}

// The relay bot is the one whose Telegram token this process holds. Every other
// named bot is consulted server-side. The relay is excluded from "who should
// answer" so one human message does not both route to a named bot and trigger
// the relay's own reply.
export function isRelay(bot, relayTelegramUserId) {
  return (
    relayTelegramUserId != null &&
    Number(bot?.telegram_user_id) === Number(relayTelegramUserId)
  );
}

// Names mentioned anywhere in the text, matched case-insensitively on whole
// words. Returns the matching bot rows in the order they were named.
export function mentionedBots(bots, text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits = [];
  for (const bot of bots) {
    const name = String(bot.display_name ?? "").trim().toLowerCase();
    if (!name) continue;
    // @name and bare name both count. \b on both ends so "Al" does not match
    // "Alice", and a name with a space ("Trip Helper") still works.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\w])@?${escaped}([^\\w]|$)`, "i");
    if (re.test(lower)) hits.push(bot);
  }
  return hits;
}

// A name at the start of a line followed by ", " or one of :-,.  -> addressed.
function leadingName(bots, text) {
  const firstLine = String(text ?? "").trim().split("\n")[0];
  for (const bot of bots) {
    const name = String(bot.display_name ?? "").trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^@?${escaped}\\s*[:,\\-]`, "i").test(firstLine)) return bot;
  }
  return null;
}

// Strips the bot's own name from the front so the model does not see "Alice,
// what do you think?" and answer as if Alice were someone else.
export function stripAddress(text, name) {
  const escaped = String(name ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return String(text ?? "");
  return String(text ?? "")
    .replace(new RegExp(`^\\s*@?${escaped}\\s*[:,\\-]\\s*`, "i"), "")
    .trim();
}

/**
 * Decides who answers a message.
 *
 * @param {object} input
 * @param {Array}  input.bots      named bots linked to this chat (relay included)
 * @param {number} [input.relayTelegramUserId] the relay bot's own telegram id
 * @param {string} [input.text]
 * @param {boolean}[input.isPrivate]
 * @param {boolean}[input.replyToRelay]  the message replies to the relay bot
 * @returns {{ bots: Array, stripName: string|null, relayOnly: boolean }}
 */
export function routeMessage({
  bots = [],
  relayTelegramUserId = null,
  text = "",
  isPrivate = false,
  replyToRelay = false,
}) {
  const named = bots.filter((b) => !isRelay(b, relayTelegramUserId));
  const relay = bots.find((b) => isRelay(b, relayTelegramUserId)) ?? null;

  // A DM is addressed to the relay by definition.
  if (isPrivate) {
    return { bots: relay ? [relay] : [], stripName: relay?.display_name ?? null, relayOnly: true };
  }

  const mentioned = mentionedBots(named, text);
  if (mentioned.length) {
    return {
      bots: mentioned,
      stripName: mentioned.length === 1 ? mentioned[0].display_name : null,
      relayOnly: false,
    };
  }

  const lead = leadingName(named, text);
  if (lead) {
    return { bots: [lead], stripName: lead.display_name, relayOnly: false };
  }

  // Replying directly to the relay is addressing it.
  if (replyToRelay && relay) {
    return { bots: [relay], stripName: null, relayOnly: true };
  }

  return { bots: [], stripName: null, relayOnly: false };
}
