// The memory window: session summary + owner summary + the last N turns.
//
// Two properties this file exists to guarantee:
//
//   1. The window is PER BOT PER SESSION. Pulling the last N turns across all
//      of a bot's sessions would carry group A's verbatim conversation into
//      group B's prompt - a cross-group disclosure, not a feature. The caller
//      must therefore key its query on (bot_id, chat_id); nothing here can
//      widen it.
//
//   2. The prompt order is STABLE-FIRST. Prompt caching only helps when the
//      same bytes appear first on every call, so persona, then owner summary,
//      then session summary, and the changing turns go last.

export const DEFAULT_TURNS = Number(process.env.RECENT_MESSAGE_WINDOW ?? 10);
export const TURNS_PER_SUMMARY = Number(process.env.SUMMARY_TRIGGER_BUFFER ?? 30);

// Takes the newest `limit` and returns them in chronological order, so the
// model reads the conversation the way it happened.
export function selectWindow(messages, limit = DEFAULT_TURNS) {
  const n = Number(limit);
  if (!Array.isArray(messages) || !Number.isFinite(n) || n <= 0) return [];
  return messages.slice(Math.max(0, messages.length - Math.floor(n)));
}

// Fire only once the un-summarised tail exceeds a full batch, so a chat does
// not pay for a summarisation call on every single turn.
export function summariseTriggered(pendingCount, batch = TURNS_PER_SUMMARY) {
  const n = Number(pendingCount);
  const b = Number(batch);
  if (!Number.isFinite(n) || !Number.isFinite(b) || b <= 0) return false;
  return n >= b;
}

// Stable-first ordering. Everything that changes per message goes last, so the
// prefix stays byte-identical between calls and the provider's cache can hit.
export function orderForCache({ persona, ownerSummary, sessionSummary, turns, latest }) {
  const sections = [];
  if (persona) sections.push(persona);
  if (ownerSummary) sections.push(`What you know about this person:\n${ownerSummary}`);
  if (sessionSummary) sections.push(`Summary of this chat so far:\n${sessionSummary}`);
  if (turns) sections.push(`Recent messages:\n${turns}`);
  if (latest) sections.push(`Newest message to answer:\n${latest}`);
  return sections.join("\n\n");
}
