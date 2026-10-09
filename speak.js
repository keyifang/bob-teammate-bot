// When Bob speaks in a group.
//
// WHY THIS EXISTS
//
// The old rule was: a question mark, plus a cooldown. So Bob interjected on ANY
// question to ANYONE - "does anyone know if the 3pm moved?" - which is noise,
// not presence. In a group a friend who butts into every conversation is
// tiresome, and one who never does is useless.
//
// The distinction that matters: being ABLE to help is not the same as being
// INVITED. A question about the weather is Bob's business whether or not he was
// mentioned; a question about Maya's weekend is not.
//
// Pure and synchronous by design - see router.js for why an extra model call
// per message is not affordable on a half-saturated free tier.

// Direct address: a mention, or a reply to Bob. Checked first, because being
// named is an unambiguous invitation regardless of the topic.
const ADDRESSED_RE = /@[\w]+|^\s*hey\s+bot\b|\bbot\b\s*[:,]|\bbob\b\s*[:,]/i;

// Subject areas Bob can genuinely serve. Deliberately narrow: each entry is
// something the tools answer, not something Bob can merely chat about.
const DOMAIN_RE =
  /\b(?:weather|forecast|temperature|rain|humidity|wind|snow|storm|forecast|air quality|pollution|aqi|pm2\.5|haze|smog|pollen|uv index)\b/i;

// A question in the group that is plainly not Bob's - it names a person, or is
// social. Asking Maya about her weekend must not recruit a bot.
const SOCIAL_RE =
  /\b(?:maya|dan|priya|sam|alex|guys|everyone|all|you all|any(?:one|body) else|thoughts|feel about|what did you think)\b/i;

// Questions to somebody else: a second person addressed by name, or a
// possessive phrasing that implies someone in the room.
const SOMEONE_ELSE_RE = /\b(?:did you|have you|can you|would you|could you|are you|do you)\b/i;

/**
 * Whether Bob could genuinely help with this message.
 *
 * Addressed always wins: "hey bob, you around?" needs an answer even with no
 * question in it, or Bob reads as broken at the exact moment someone tries him.
 */
export function canHelp({ text, addressed = false }) {
  const raw = typeof text === "string" ? text : "";
  if (addressed) return true;
  if (!raw.trim()) return false;
  if (ADDRESSED_RE.test(raw)) return true;
  // In Bob's domain, even unaddressed: this is where being useful means
  // volunteering.
  if (DOMAIN_RE.test(raw)) return true;
  // Everything else: social, or someone else's conversation.
  return false;
}

/**
 * The full decision, including the cooldown.
 *
 * The cooldown is deliberately NOT a veto when Bob is addressed directly. Someone
 * naming him twice in a minute is waiting for an answer, and silently ignoring
 * the second message reads as broken rather than as busy.
 */
export function shouldSpeak({
  text,
  addressed = false,
  lastSpokeAt = 0,
  cooldownMs = 45000,
  now = Date.now(),
}) {
  const helped = canHelp({ text, addressed });
  if (!helped) return false;
  // Directly addressed: answer regardless of the cooldown.
  if (addressed) return true;
  const last = Number(lastSpokeAt) || 0;
  if (last > 0 && now - last < Number(cooldownMs)) return false;
  return true;
}

// Phrases that are confident about a limitation that does not exist. Observed
// live on a weather question that the weather tool answers in 1.5s.
//
// Both word orders occur and both are covered: "the SEARCH tool is throttled"
// and "my searches ARE throttled" - the subject can be on either side.
export const CONFIDENT_NOISE =
  /\b(?:I (?:do not|don't) have (?:real-?time|any (?:real-?time|live|direct))?\s*(?:data|access|information)|I(?:'m| am) not able to (?:access|browse|look up)|As an AI,? I cannot|my (?:training|knowledge) (?:data )?(?:cutoff|only goes)|(?:the |my )?(?:weather|search|searches|tools?)(?: (?:tool )?is | are )?(?:unavailable|throttled|rate.?limited)|check wttr\.in|weather\.com)\b/i;

// Exported for the tests, and because callers occasionally want the reasoning.
export { DOMAIN_RE, SOCIAL_RE, SOMEONE_ELSE_RE, ADDRESSED_RE };