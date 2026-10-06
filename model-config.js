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
