// Task routing: which model answers, and how hard it tries.
//
// WHY THIS EXISTS
//
// Bob does two different jobs. Chatting in a group is latency-sensitive - the
// experience IS the speed - while researching or drafting can wait and wants a
// stronger model. One model for everything means paying reasoning-model latency
// for "ok cool", and paying model fragility for a proposal.
//
// MEASURED, not assumed. Four calls each, same conversational prompt:
//
//   nvidia/nemotron-3.5-lightning:free       5.0s 1.4s 3.0s 4.8s   4/4 ok
//   nvidia/nemotron-3-ultra-550b-a55b:free  6.4s 13.3s 0.4s 2.8s  3/4 ok
//
// Lightning is BOTH more reliable AND faster on the free tier, so it leads for
// chat. The earlier claim that the flagship was "slower" came from a probe that
// read the wrong field of the response and reported empty content as a fast
// success - the opposite of what happened.
//
// WHY NOT A MODEL CALL TO CLASSIFY
//
// Roughly half of all calls to a saturated free tier fail, so an extra
// classification call per message is a reliability cost for a decision a regex
// makes correctly. If this ever needs a model, it must be a cache hit path.

export const TASKS = {
  chat: {
    id: "chat",
    model: process.env.MODEL_CHAT ?? "nvidia/nemotron-3.5-lightning:free",
    fallbacks: [
      process.env.MODEL_CHAT_FALLBACK ?? "nvidia/nemotron-3-ultra-550b-a55b:free",
    ],
  },
  research: {
    id: "research",
    model: process.env.MODEL_RESEARCH ?? "nvidia/nemotron-3.5-lightning:free",
    fallbacks: [process.env.MODEL_RESEARCH_FALLBACK ?? "nvidia/nemotron-3-ultra-550b-a55b:free"],
  },
  draft: {
    id: "draft",
    // The stronger model earns its place here: a proposal is long, structured,
    // and the cost of a bad one is high. Measured 3/4 rather than 4/4, but the
    // fallback covers that.
    model: process.env.MODEL_DRAFT ?? "nvidia/nemotron-3-ultra-550b-a55b:free",
    fallbacks: [process.env.MODEL_DRAFT_FALLBACK ?? "nvidia/nemotron-3.5-lightning:free"],
  },
};

// "Just chat", "don't search" - an explicit instruction from the person beats any
// heuristic. They know what they want; the classifier is guessing.
const EXPLICIT_CHAT_RE =
  /\b(?:no (?:tools?|search|looking)|don'?t (?:search|look|use tools?)|just chat|skip (?:the )?(?:search|tools?)|keep it simple|just be casual|offline)\b/i;

// Needs something that changes: the web, or a calculation the model should not
// do in its head. Air quality is named explicitly because the weather tool now
// serves it - observed live as a real question.
const RESEARCH_RE =
  /\b(?:what(?:'s| is| are)|how much|how many|how about the air|when(?:'s| is)|where(?:'s| is)|who(?:'s| won| is)|latest|current|today|tonight|now|right now|news|score|weather|forecast|air quality|pollution|aqi|haze|smog|pm2\.5|price|stock|exchange rate|release date|outage|status|live)\b/i;

// A written artefact, not conversation. This is the class the persona's old
// length cap was destroying.
const DRAFT_RE =
  /\b(?:draft|write (?:up|a|me)|put together|compose|prepare|create|make|build|produce)\b[^.\n]{0,40}\b(?:proposal|brief|plan|agenda|outline|summary|report|doc(?:ument)?|email|draft|deck|strategy|spec|pitch|contract|scope|rundown|checklist)\b|\b(?:proposal|brief|agenda|outline|report|one-pager|pitch)\b/i;

// Plan-then-answer: multi-step requests get the stronger model.
const PLAN_RE =
  /\b(?:plan|steps?|roadmap|strategy|how do i|how would i|help me (?:plan|figure|decide|think))\b/i;

/**
 * Classifies a message. Pure and synchronous - see WHY NOT A MODEL CALL.
 */
export function classifyTask(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return "chat";
  if (EXPLICIT_CHAT_RE.test(raw)) return "chat";
  if (DRAFT_RE.test(raw)) return "draft";
  if (PLAN_RE.test(raw)) return "draft";
  if (RESEARCH_RE.test(raw)) return "research";
  return "chat";
}

/**
 * The model chain for a message: the task's primary, then its fallbacks, then
 * the shared chain. Never empty, and never repeats a model.
 */
export function routeFor(text) {
  const task = classifyTask(text);
  const spec = TASKS[task] ?? TASKS.chat;
  const chain = [];
  for (const m of [spec.model, ...spec.fallbacks, ...Object.values(TASKS).map((t) => t.model)]) {
    if (m && !chain.includes(m)) chain.push(m);
  }
  return { task, model: chain[0], chain: chain.length ? chain : [TASKS.chat.model] };
}