// The persona prompt contract: session summary + cross-session summary + the
// last N turns, ordered stable-first so prompt caching can hit.
//
// Two things this pins that are easy to get wrong:
//
//   - the window is the LAST 10 turns, not everything. Feeding the whole
//     history is what makes a bot expensive and slow.
//   - the order is stable-first. Caching only helps when the same bytes appear
//     first on every call, so the changing turns go last.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReplyPrompt } from "../prompt.js";
import { orderForCache, DEFAULT_TURNS } from "../session-window.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the default window is 10 turns", () => {
  assert.equal(DEFAULT_TURNS, 10);
});

test("the prompt carries both summaries and the recent turns", () => {
  const prompt = buildReplyPrompt({
    bobName: "Alice",
    ownerName: "Alice",
    crossChatSummary: "CROSS_SESSION_MARKER",
    summary: "SESSION_MARKER",
    transcript: "Human: recent turn",
    latest: "Human: the new question",
  });
  assert.match(prompt, /CROSS_SESSION_MARKER/, "the cross-session summary must be present");
  assert.match(prompt, /SESSION_MARKER/, "the session summary must be present");
  assert.match(prompt, /recent turn/, "the recent turns must be present");
  assert.match(prompt, /the new question/, "the newest message must be present");
});

test("the order is stable-first, so the cacheable prefix does not move", () => {
  // Persona, then cross-session, then session, then the changing turns.
  const ordered = orderForCache({
    persona: "PERSONA",
    ownerSummary: "CROSS",
    sessionSummary: "SESSION",
    turns: "TURNS",
    latest: "LATEST",
  });
  const idx = (s) => ordered.indexOf(s);
  assert.ok(idx("PERSONA") < idx("CROSS"), "persona must come before the summaries");
  assert.ok(idx("CROSS") < idx("SESSION"), "cross-session before session");
  assert.ok(idx("SESSION") < idx("TURNS"), "session summary before the turns");
  assert.ok(idx("TURNS") < idx("LATEST"), "the newest message must come last");
});

test("the same inputs produce byte-identical prompts, which is what caching needs", () => {
  const args = {
    persona: "P",
    ownerSummary: "C",
    sessionSummary: "S",
    turns: "T",
    latest: "L",
  };
  assert.equal(orderForCache(args), orderForCache({ ...args }));
});

test("an absent summary is omitted rather than leaving a blank gap", () => {
  const prompt = buildReplyPrompt({ bobName: "Bob", transcript: "Human: hi" });
  assert.ok(!prompt.includes("undefined"));
  assert.ok(!/\n\n\n/.test(prompt), "no empty sections");
  assert.ok(!/Summary of this chat/.test(prompt), "no empty summary heading");
});

test("a request carries a session id so the provider keeps the cache warm", async () => {
  // OpenRouter's sticky routing uses session_id to pin a conversation to one
  // provider, which is what makes repeated prefix reuse actually land on a warm
  // cache. Without it, sticky routing only activates after a cache hit is seen.
  const src = (await readFile(path.join(ROOT, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(
    src,
    /session_id:\s*[\w.]*sessionId/i,
    "the model request must carry a session_id for cache stickiness"
  );
});

test("the session id is derived per bot per chat, so two bots do not share a cache", async () => {
  const src = (await readFile(path.join(ROOT, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  assert.match(src, /function sessionIdFor\(/, "a session-id helper must exist");
  // Keyed on both, or two bots in one chat would thrash the same cache entry.
  const i = src.indexOf("function sessionIdFor(");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  assert.match(body, /botId/, "the session id must include the bot");
  assert.match(body, /chatId/, "the session id must include the chat");
});
