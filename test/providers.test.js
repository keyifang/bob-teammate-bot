// Phase A: provider registry and per-user model config.
//
// The registry is the single source of truth for what a user may pick. Every
// model id here was verified to exist against the live catalog, and the
// OpenRouter ones verified to support tools - Bob's loop is tool-based, so a
// model without tools cannot answer a research question at all.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDERS,
  OPENROUTER_MODELS,
  OPENCODE_GO_MODELS,
  listProviders,
  getProvider,
  getModel,
  resolveUserModel,
  validateKeyFormat,
} from "../providers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the four OpenRouter models are registered exactly as named", () => {
  assert.deepEqual(
    OPENROUTER_MODELS.map((m) => m.id),
    [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "google/gemma-4-31b-it:free",
      "deepseek/deepseek-v4-flash-0731",
      "z-ai/glm-5.3-flash",
    ]
  );
});

test("the three opencode go models are registered, role-mirroring the OpenRouter set", () => {
  assert.deepEqual(
    OPENCODE_GO_MODELS.map((m) => m.id),
    ["glm-5.3-flash", "deepseek-v4.1-flash", "qwen3.8-flash"]
  );
});

test("every model carries a label and a tier", () => {
  for (const p of listProviders()) {
    for (const m of p.models) {
      assert.ok(m.label, `${p.id}/${m.id} needs a label`);
      assert.ok(["free", "paid"].includes(m.tier), `${p.id}/${m.id} needs a tier`);
    }
  }
});

test("each provider declares an https OpenAI-compatible chat endpoint", () => {
  for (const p of listProviders()) {
    assert.match(p.apiUrl, /^https:\/\//, `${p.id} must use https`);
    assert.match(p.apiUrl, /chat\/completions$/, `${p.id} must be OpenAI-compatible`);
    assert.ok(p.label, `${p.id} needs a label`);
  }
});

test("the default provider has a free model, so a new user can start with no key", () => {
  // opencode go is a paid subscription service and has no free tier - that is
  // fine, because a new user lands on the default provider. What matters is
  // that the DEFAULT can be tried for free without anyone supplying a key.
  const def = getProvider("openrouter");
  assert.ok(
    def.models.some((m) => m.tier === "free"),
    "the default provider must offer a free model, or a new user cannot try Bob"
  );
});

test("getProvider and getModel look up by id and return null when absent", () => {
  assert.equal(getProvider("openrouter").id, "openrouter");
  assert.equal(getProvider("nope"), null);
  assert.ok(getModel("openrouter", "z-ai/glm-5.3-flash").label.length > 0);
  assert.equal(getModel("openrouter", "not-a-model"), null);
  assert.equal(getModel("nope", "x"), null);
});

test("the registry ships no API key of any kind", async () => {
  const src = await readFile(path.join(ROOT, "providers.js"), "utf8");
  assert.ok(!/sk-or-v1-[a-f0-9]{20,}/i.test(src), "no OpenRouter key may be committed");
  assert.ok(!/Bearer\s+[A-Za-z0-9_-]{20,}/.test(src), "no bearer token may be committed");
});

test("validateKeyFormat refuses empty, whitespace and multi-line keys", () => {
  for (const bad of ["", "   ", "sk-or-v1-abc\ndef", null, undefined, "a\tb"]) {
    assert.equal(
      validateKeyFormat("openrouter", bad).ok,
      false,
      `${JSON.stringify(bad)} must be refused`
    );
  }
});

test("validateKeyFormat accepts a plausible OpenRouter key and refuses an obviously wrong one", () => {
  assert.equal(validateKeyFormat("openrouter", "sk-or-v1-" + "a".repeat(40)).ok, true);
  // A Telegram bot token pasted by mistake must not be accepted silently.
  assert.equal(
    validateKeyFormat("openrouter", "9999999999:AAFAKEfakefakefakefakefakefakefakefakefake").ok,
    false
  );
});

test("validateKeyFormat does not over-constrain a provider whose format is undocumented", () => {
  // opencode go's key format is not published, so only the clearly-invalid is
  // refused - guessing a stricter rule would lock users out.
  assert.equal(validateKeyFormat("opencode_go", "some-opaque-token").ok, true);
  assert.equal(validateKeyFormat("opencode_go", "").ok, false);
});

test("resolveUserModel prefers the user's own config over the deployment default", () => {
  const resolved = resolveUserModel(
    { provider: "opencode_go", model: "glm-5.3-flash", apiKey: "user-key" },
    { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", apiKey: "dep-key" }
  );
  assert.equal(resolved.provider, "opencode_go");
  assert.equal(resolved.model, "glm-5.3-flash");
  assert.equal(resolved.apiKey, "user-key");
  assert.equal(resolved.apiUrl, PROVIDERS.opencode_go.apiUrl);
  assert.equal(resolved.usingOwnKey, true);
});

test("resolveUserModel falls back to the deployment default when the user has none", () => {
  const resolved = resolveUserModel(null, {
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    apiKey: "dep-key",
  });
  assert.equal(resolved.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.equal(resolved.usingOwnKey, false);
});

test("resolveUserModel ignores a stored config that is incomplete or unknown", () => {
  const def = {
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    apiKey: "dep-key",
  };
  // Unknown provider, unknown model, or no key -> fall back rather than break.
  assert.equal(resolveUserModel({ provider: "ghost", model: "x", apiKey: "k" }, def).model, def.model);
  assert.equal(
    resolveUserModel({ provider: "openrouter", model: "ghost", apiKey: "k" }, def).model,
    def.model
  );
  assert.equal(
    resolveUserModel({ provider: "openrouter", model: "z-ai/glm-5.3-flash" }, def).model,
    def.model
  );
  assert.equal(resolveUserModel(undefined, def).model, def.model);
});

test("a user's own key marks the request BYOK, so no credit is deducted", () => {
  const own = resolveUserModel(
    { provider: "openrouter", model: "z-ai/glm-5.3-flash", apiKey: "k" },
    { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", apiKey: "dep" }
  );
  assert.equal(own.usingOwnKey, true);

  const ours = resolveUserModel(null, { provider: "openrouter", model: "m", apiKey: "dep" });
  assert.equal(ours.usingOwnKey, false);
});

test("a user may not select a model the provider does not offer", () => {
  // Cross-provider ids must not resolve, or a user could smuggle an
  // opencode-go model into an OpenRouter request.
  assert.equal(getModel("openrouter", "glm-5.3-flash"), null);
  assert.equal(getModel("opencode_go", "z-ai/glm-5.3-flash"), null);
});
