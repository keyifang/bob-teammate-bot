// Phase 5: relay orchestration.
//
// A relay turn is our own record, not a Telegram message. When several bots are
// addressed at once they answer in sequence, each seeing what the ones before
// said - so they agree or disagree rather than producing N unrelated replies.
// A turn is capped, and a new human message cancels the one in flight so
// chiming in is never blocked by a slow free model.

export const RELAY_MAX_BOTS = Number(process.env.RELAY_MAX_BOTS ?? 3);

// Order the participants and cap the fan-out. Cost multiplies with N, and a
// slow free model makes the tail the whole UX risk, so the cap is enforced here
// rather than hoped for at the call site.
export function planRelay(personas, max = RELAY_MAX_BOTS) {
  const ordered = [...(personas ?? [])].sort(
    (a, b) => Number(a.relay_position ?? 0) - Number(b.relay_position ?? 0)
  );
  return ordered.slice(0, Math.max(0, Number(max)));
}

// What the next bot in the turn sees of the discussion so far. Empty until at
// least one bot has answered, which is what makes the first bot answer the
// human's question rather than an empty room.
export function buildDiscussionContext(replies) {
  if (!replies?.length) return "";
  return replies
    .map((r) => `${r.name}: ${r.text}`)
    .join("\n\n");
}

/**
 * Per-chat turn tokens. Beginning a turn invalidates any earlier one, and a
 * fresh human message cancels the in-flight turn by beginning a new one. A
 * turn checks its own token before each bot, so an interjection stops the
 * remaining bots instead of racing them to the chat.
 */
export function createTurnRegistry() {
  const current = new Map();
  let seq = 0;

  return {
    begin(chatId) {
      const token = ++seq;
      current.set(chatId, token);
      return token;
    },
    isCurrent(chatId, token) {
      return current.get(chatId) === token;
    },
    // Cancels whatever turn is in flight for this chat without starting a new
    // one. Used when a human message arrives that is not itself a relay turn.
    cancel(chatId) {
      current.set(chatId, ++seq);
    },
  };
}
