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
// Narration wrappers, used to cut a reply loose from its scratchpad rather than
// discarding the answer inside it.
//
// OBSERVED live (2026-10-08): asked about morning-rush staffing, Bob replied
// "The user is asking about staffing concerns ... This is a follow-up to the
// previous conversation ...". Detecting that and rejecting the whole reply left
// the user with "hit an error" for a perfectly good question - and the useful
// half, "two staff is the usual minimum", was thrown away with it.
//
// Detection alone is half a fix. This keeps the answer.
const NARRATION_LEAD_RE =
  /^\s*(?:the user (?:is asking|wants|asked)|we need to respond|i need to respond (?:as|for)|this is a follow-?up|the style rules say|as per the (?:style )?rules)\b[^.]*\.?\s*/i;

export function stripNarration(text) {
  if (typeof text !== "string") return "";
  let out = text.trim();

  // Drop leading narration sentences, repeatedly: they chain ("The user is
  // asking ... This is a follow-up ... As per the rules ...").
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out.replace(NARRATION_LEAD_RE, "").trim();
    if (out === before) break;
  }

  // A trailing "this is a follow-up to ..." also reads as scratchpad.
  out = out.replace(
    /\s*(?:this is a (?:follow-?up|continuation)[^.]*\.?)\s*$/i,
    ""
  ).trim();

  return out;
}
