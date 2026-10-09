// Guards on generated replies.
//
// Kept separate from server.js so they can be tested directly, and separate
// from config.js because these are ENFORCED rather than prompted: a prompt
// instructs, this decides.

/**
 * True when a reply claims a tool failed, but no tool actually did.
 *
 * OBSERVED live (2026-10-08): asked for Beijing weather, the bot replied
 * "Weather tool and search are both throttled right now - can't get live
 * Beijing data. Check wttr.in/Beijing ... they don't need an API key."
 *
 * The weather tool had never been called, and it works. The model invented a
 * failure AND recommended a workaround, pushing the user to do the bot's job.
 *
 * The persona already forbade calling a tool "rate limited" unless it said so,
 * but that rule sat under "when one tool fails" - so with no failure the model
 * felt licensed. The caller knows whether any tool failed, so this is decidable
 * rather than promptable.
 *
 * Only claims about ACCESS are flagged. "The heat limit is worth watching" is
 * prose about the world and must pass.
 */

// "the tool/search/web is throttled" but NOT "the heat limit", "rate limit
// policy", "the speed limit". Built as strings so the word boundaries are
// unambiguous: in a normal JS string "\b" is a BACKSPACE, not a word boundary.
const SUBJECT = "\\b(?:tool|tools|search|searches|api|source|site|website|weather|news)\\b";
const PROBLEM =
  "\\b(?:throttled|throttling|rate.?limit|rate.?limited|unavailable|blocked|not working|down|deprecated|paywall|api key)\\b";

// Both word orders occur - "the SEARCH is throttled" and "hitting a RATE LIMIT
// on my searches" - so both directions are matched. The gap is 60 characters,
// because "Weather tool and search are both throttled" spans 45.
const ACCESS_CLAIM_RE = new RegExp(
  "(?:" + SUBJECT + "[^.\\n]{0,60}" + PROBLEM + "|" + PROBLEM + "[^.\\n]{0,60}" + SUBJECT + ")",
  "i"
);

export function looksLikeInventedToolFailure(text, { anyToolFailed = false } = {}) {
  if (typeof text !== "string" || !text.trim()) return false;
  // A real failure may legitimately be reported.
  if (anyToolFailed) return false;
  return ACCESS_CLAIM_RE.test(text);
}