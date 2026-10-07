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

// A rough token count, deliberately an OVER-estimate. Under-estimating is the
// dangerous direction: the request would exceed the model's context and fail,
// rather than summarising early. ~4 characters per token is the usual rule for
// English; 3.5 is used so the estimate errs high.
export function estimateTokens(text) {
  const len = String(text ?? "").length;
  return Math.ceil(len / 3.5);
}

// The second, independent guard. A chat of a few very long messages blows the
// context budget long before the message-count trigger fires, so this catches
// what the count cannot. An unset or nonsense budget disables the guard rather
// than misfiring on every message.
export function tokenTriggered(text, budgetTokens) {
  const budget = Number(budgetTokens);
  if (!Number.isFinite(budget) || budget <= 0) return false;
  return estimateTokens(text) >= budget;
}

// 15% of the model's context window, per the plan: message count bounds cost
// deterministically, and this catches a chat whose rows are individually huge.
export const CONTEXT_TRIGGER_RATIO = 0.15;

export function tokenBudgetFor(contextWindow) {
  const w = Number(contextWindow);
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.floor(w * CONTEXT_TRIGGER_RATIO);
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
