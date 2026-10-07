// Provider and model registry.
//
// This is the single source of truth for what a user may pick. Every model id
// was verified against the live catalog; the OpenRouter ones were also verified
// to advertise tool support, which Bob requires - the reply loop is tool-based,
// so a model without tools cannot answer a research question at all.
//
// No key lives here. Keys come from the user (BYOK) or from the deployment's
// environment, never from this file.

export const OPENROUTER_MODELS = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron 3 Ultra (free, slow)",
    tier: "free",
    contextWindow: 1_000_000,
  },
  {
    id: "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B (free)",
    tier: "free",
    contextWindow: 262_144,
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash (cheap, long context)",
    tier: "paid",
    contextWindow: 1_048_576,
  },
  {
    id: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash (fast)",
    tier: "paid",
    contextWindow: 1_048_576,
  },
];

// Role-mirrored against the OpenRouter set: a cheap workhorse, a reasoning
// model, and a long-context model. Tool support is NOT verifiable here because
// opencode go needs a key to call, so the runtime refuses to select a model
// that fails on first use rather than silently answering badly.
export const OPENCODE_GO_MODELS = [
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash (fast)", tier: "paid", contextWindow: 1_048_576 },
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash (reasoning)", tier: "paid", contextWindow: 1_048_576 },
  { id: "qwen3.8-flash", label: "Qwen 3.8 Flash (long context)", tier: "paid", contextWindow: 1_048_576 },
];

export const PROVIDERS = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: OPENROUTER_MODELS,
    // OpenRouter keys have a documented, stable prefix.
    keyPattern: /^sk-or-v1-[A-Za-z0-9._-]{20,}$/,
    keyHint: "starts with sk-or-v1-",
  },
  opencode_go: {
    id: "opencode_go",
    label: "opencode go",
    apiUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    models: OPENCODE_GO_MODELS,
    // Format is not published, so only the clearly-invalid is refused.
    keyPattern: null,
    keyHint: "any non-empty API key",
  },
};

export function listProviders() {
  return Object.values(PROVIDERS);
}

export function getProvider(id) {
  return PROVIDERS[id] ?? null;
}

export function getModel(providerId, modelId) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  return provider.models.find((m) => m.id === modelId) ?? null;
}

// A key that cannot be sent is worse than no key: it fails at the provider with
// an opaque 401. Whitespace and newlines are the two that actually happen (a
// paste that carries a trailing newline, or a token copied with a line break).
export function validateKeyFormat(providerId, key) {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, error: "Unknown provider." };

  if (typeof key !== "string") return { ok: false, error: "That does not look like a key." };
  if (/[\s]/.test(key)) {
    return { ok: false, error: "A key cannot contain spaces or line breaks." };
  }
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "A key is required." };

  if (provider.keyPattern && !provider.keyPattern.test(trimmed)) {
    return { ok: false, error: `That does not look like an OpenRouter key - it ${provider.keyHint}.` };
  }
  return { ok: true, key: trimmed };
}

/**
 * Which provider, model and key a user's reply should use.
 *
 * A user's own config wins; anything incomplete or unknown falls back to the
 * deployment default rather than breaking the bot. `usingOwnKey` is the signal
 * the credit ledger uses: when the user pays the provider directly there is no
 * token cost for us to pass on.
 */
export function resolveUserModel(userConfig, deploymentDefault) {
  const def = {
    provider: deploymentDefault?.provider ?? "openrouter",
    model: deploymentDefault?.model,
    apiKey: deploymentDefault?.apiKey,
    apiUrl: deploymentDefault?.apiUrl,
    usingOwnKey: false,
  };

  if (!userConfig) return def;

  const { provider: pid, model: mid, apiKey } = userConfig;
  if (!pid || !mid || !apiKey) return def;

  const provider = getProvider(pid);
  if (!provider) return def;
  if (!getModel(pid, mid)) return def;

  return {
    provider: pid,
    model: mid,
    apiKey,
    apiUrl: provider.apiUrl,
    usingOwnKey: true,
  };
}
