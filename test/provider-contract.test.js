// Verified against the live providers, because the differences between them
// are not documented anywhere and each one silently breaks a provider:
//
//   - opencode go REQUIRES an x-opencode-session header. Without it every
//     request returns 400 MissingSessionID - so a user selecting one of its
//     models would get nothing at all.
//   - opencode go reports reasoning in `reasoning_content`; OpenRouter uses
//     `reasoning`. A reply that reads the wrong field looks like a reasoning
//     leak into the chat.
//
// These are structural checks on the code that builds the request, so a
// regression fails in CI rather than in front of a user.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Built from char codes so no escaping layer can mangle it.
const CLOSE = String.fromCharCode(10) + "}" + String.fromCharCode(10);

async function serverSource() {
  return (await readFile(path.join(ROOT, "server.js"), "utf8")).replace(/\r\n/g, "\n");
}

// The header name comes from the provider registry rather than being hardcoded,
// so these assert the RESULT of building the headers rather than the source
// text. A source check would pass on a header that is never actually sent.
async function buildHeaders(route) {
  const src = await serverSource();
  const start = src.indexOf("function modelHeaders(");
  // Include the closing brace so the extracted function is complete.
  const body = src.slice(start, src.indexOf(CLOSE, start) + CLOSE.length);
  const { getProvider } = await import("../providers.js");
  const MODEL_API_KEY = "deployment-key";
  return new Function(
    "getProvider",
    "MODEL_API_KEY",
    body + "; return modelHeaders;"
  )(getProvider, MODEL_API_KEY)(route);
}

test("opencode go requests carry the session header it requires", async () => {
  // Verified live: without this header every request returns
  // 400 {"type":"MissingSessionID"} - the user would get nothing at all.
  const headers = await buildHeaders({
    provider: "opencode_go",
    apiKey: "user-key",
    sessionId: "bob-7-12345",
  });
  assert.equal(
    headers["x-opencode-session"],
    "bob-7-12345",
    "opencode go refuses every request without this header"
  );
});

test("the OpenRouter default still gets the attribution headers and no session header", async () => {
  const headers = await buildHeaders({
    provider: "openrouter",
    apiKey: "user-key",
    sessionId: "bob-7-12345",
  });
  assert.equal(headers.Authorization, "Bearer user-key");
  assert.equal(headers["HTTP-Referer"], "https://keyi.ai");
  assert.equal(
    headers["x-opencode-session"],
    undefined,
    "the opencode header must not leak onto OpenRouter requests"
  );
});

test("the session header uses the request's id, so conversations stay separate", async () => {
  const a = await buildHeaders({ provider: "opencode_go", apiKey: "k", sessionId: "bob-1-111" });
  const b = await buildHeaders({ provider: "opencode_go", apiKey: "k", sessionId: "bob-2-222" });
  assert.notEqual(
    a["x-opencode-session"],
    b["x-opencode-session"],
    "a constant id would let one conversation's cache serve another"
  );
});

test("with no session id the header is omitted rather than sent empty", async () => {
  const headers = await buildHeaders({ provider: "opencode_go", apiKey: "k" });
  assert.equal(
    headers["x-opencode-session"],
    undefined,
    "an empty session id would be rejected or, worse, silently collapse conversations"
  );
});

test("the deployment key is the default when a route carries none", async () => {
  const headers = await buildHeaders({});
  assert.match(headers.Authorization, /^Bearer /, "a key must always be sent");
});

test("reasoning is read from both spellings, so neither provider leaks a scratchpad", async () => {
  const src = await serverSource();
  // OpenRouter: reasoning. opencode go: reasoning_content. Reading only one
  // leaves the other's in `content`, which posts an internal monologue into a
  // group chat.
  assert.match(src, /reasoning_content/, "opencode go's field must be handled");
  assert.match(src, /message\.reasoning\s*=/, "OpenRouter's field must be handled");
});

test("a provider that requires extra headers is declared in the registry", async () => {
  const { PROVIDERS } = await import("../providers.js");
  const go = PROVIDERS.opencode_go;
  assert.ok(go, "opencode go must be registered");
  assert.match(
    go.requiresSessionHeader ?? "",
    /opencode-session/i,
    "the header requirement must be declared on the provider, not only in the call"
  );
  assert.match(
    go.reasoningField ?? "",
    /reasoning_content/,
    "the reasoning field name must be declared, not hardcoded at the read site"
  );
});

test("the session id the model request sends is the one cache stickiness uses", async () => {
  // Same conversation, same id: a different one would fragment the cache and
  // defeat sticky routing, which is the whole reason session_id exists.
  const src = await serverSource();
  const idx = src.indexOf("function sessionIdFor(");
  assert.ok(idx > 0, "a session id helper must exist");
  const body = src.slice(idx, src.indexOf(CLOSE, idx));
  assert.match(body, /botId/, "per bot, so two bots do not thrash one cache");
  assert.match(body, /chatId/, "per chat, so two chats do not thrash one cache");
});
