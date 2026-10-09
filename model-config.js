// Phase 2: which model generates a given reply.
//
// The deployment default is MODEL_NAME. Each bot may carry its own tier in
// bots.model_tier, so a bot's own choice wins and everything else falls back to
// the default - which means every existing bot and the whole single-bot path
// keep working untouched.

// Read at call time, not import time. db.js taught this the hard way: an env
// read during module evaluation depends on env.js having been imported first,
// and fails with a confusing error when it has not. A lazy read cannot be
// wrong about ordering.
export function defaultModel() {
  return process.env.MODEL_NAME;
}

// A model id with a stray newline or surrounding spaces fails the request, and
// a non-string tier (a number, an object) must never be handed to the API.
export function resolveModel(botTier, fallback = defaultModel()) {
  if (typeof botTier === "string") {
    const trimmed = botTier.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

export function modelForBot(bot, fallback = defaultModel()) {
  return resolveModel(bot?.model_tier, fallback);
}


// Fallback chain, ordered by MEASURED reliability rather than by reputation.
//
// Twelve single calls per model, same prompt a chat message produces:
//   nvidia/nemotron-3.5-lightning:free   ok 6/6  (4/4 then 6/6; used tools 3x)
//   nvidia/nemotron-3-ultra-550b-a55b:free  ok 1/4
//   google/gemma-4-31b-it:free           ok 1/4
//   inclusionai/ling-3.1-flash            ok 0/4
//
// Roughly half of all calls to the default free model fail, which is the
// largest single constraint on what this bot can be. Free-model reliability
// varies by an order of magnitude between models, so exhausting one and moving
// to the next recovers most of that.
//
// Overridable: MODEL_FALLBACKS="a,b,c". Empty disables the chain.
export const FALLBACK_MODELS = String(
  process.env.MODEL_FALLBACKS ??
    "nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const MAX_CHAIN = 4;

/**
 * The models to try for one reply: the configured one first, then fallbacks.
 *
 * The user's choice is always tried first - the chain is recovery, not a
 * silent override - and the result never repeats a model, so a retry is never
 * spent on something already known to be failing.
 */
export function modelChainFor(configuredModel) {
  const first = typeof configuredModel === "string" ? configuredModel.trim() : "";
  const chain = [];
  for (const m of [first, ...FALLBACK_MODELS]) {
    if (m && !chain.includes(m)) chain.push(m);
    if (chain.length >= MAX_CHAIN) break;
  }
  // Nothing configured and no fallbacks: still return something rather than an
  // empty chain, which would mean never calling the model at all.
  return chain.length ? chain : ["openrouter/auto"];
}

/** The next model to try, or null when the chain is exhausted. */
export function nextModelAfter(chain, current) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const i = chain.indexOf(current);
  if (i < 0) return chain[0];
  return i + 1 < chain.length ? chain[i + 1] : null;
}
