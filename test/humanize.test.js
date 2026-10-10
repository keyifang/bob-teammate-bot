import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HUMANIZER_SYSTEM_PROMPT } from "../config.js";

// The humanizer is a whole extra model call per reply. On a free reasoning
// model that measured ~31s and ~660 reasoning tokens to reword a short
// sentence, which is a large share of the total time a user waits.
//
// These tests assert the DECISION, extracted from server.js, because the first
// version of the skip was written with an inverted condition and still passed a
// test that only checked the constant existed.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors the logic in server.js. If the real one changes, this drifts - which
// is why the source-shape tests below exist alongside it.
function shouldHumanize({ humanize, skipUnder, maxChars, textLength }) {
  if (humanize !== "true") return false;
  if (skipUnder === "true" && textLength <= maxChars) return false;
  return true;
}

test("a short reply skips the humanizer when the flag is on", () => {
  assert.equal(
    shouldHumanize({ humanize: "true", skipUnder: "true", maxChars: 400, textLength: 120 }),
    false,
    "a 120-character reply must not cost an extra model call"
  );
});

test("a long reply still goes through the humanizer", () => {
  assert.equal(
    shouldHumanize({ humanize: "true", skipUnder: "true", maxChars: 400, textLength: 900 }),
    true
  );
});

test("HUMANIZE=false disables humanising entirely", () => {
  assert.equal(
    shouldHumanize({ humanize: "false", skipUnder: "true", maxChars: 400, textLength: 900 }),
    false
  );
});

test("HUMANIZE_SKIP_UNDER=false restores unconditional humanising", () => {
  // Opt-out semantics: setting it to false must bring the extra call back.
  assert.equal(
    shouldHumanize({ humanize: "true", skipUnder: "false", maxChars: 400, textLength: 10 }),
    true,
    "the skip must be reversible"
  );
});

test("the boundary is inclusive of exactly the limit", () => {
  assert.equal(shouldHumanize({ humanize: "true", skipUnder: "true", maxChars: 400, textLength: 400 }), false);
  assert.equal(shouldHumanize({ humanize: "true", skipUnder: "true", maxChars: 400, textLength: 401 }), true);
});

test("the shipped implementation gates on the flag being ON, not off", async () => {
  // This is the inversion that shipped: `skipUnder !== "true"` meant the skip
  // only ever applied with the feature disabled, so the humanizer ran on every
  // reply and the latency win was silently absent.
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  const fn = source.slice(source.indexOf("async function humanize"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  assert.ok(
    /HUMANIZE_SKIP_UNDER === "true"/.test(body),
    "the skip must require the flag to be ON"
  );
  assert.ok(
    !/HUMANIZE_SKIP_UNDER !== "true"/.test(body),
    "an inverted condition would disable the optimisation entirely"
  );
  assert.ok(
    /text\.length <= HUMANIZE_MAX_CHARS/.test(body),
    "the skip must be gated on reply length"
  );
});

test("the defaults skip short replies and log slow calls", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(source, /HUMANIZE_MAX_CHARS = Number\(process\.env\.HUMANIZE_MAX_CHARS \?\? (\d+)\)/);
  const m = source.match(/HUMANIZE_MAX_CHARS = Number\(process\.env\.HUMANIZE_MAX_CHARS \?\? (\d+)\)/);
  assert.ok(Number(m[1]) > 0, "the limit must be a positive number of characters");
  assert.match(source, /HUMANIZE_SKIP_UNDER = process\.env\.HUMANIZE_SKIP_UNDER \?\? "true"/);
});

// The humanizer is the last stop before a reply reaches a chat, so it is where
// "do not write an essay" has to be enforced. The persona already caps length,
// but a model that ignored the persona would otherwise be reworded into a
// still-long reply.
test("the humanizer prompt forbids an essay, not just a formal tone", () => {
  assert.match(HUMANIZER_SYSTEM_PROMPT, /essay|writeup|not write/i);
  assert.match(HUMANIZER_SYSTEM_PROMPT, /as short as/i);
  // And it must not flatten a list or table, where length IS the content.
  assert.match(HUMANIZER_SYSTEM_PROMPT, /list|table/i);
});

test("the humanizer prompt still preserves meaning and returns only the message", () => {
  assert.match(HUMANIZER_SYSTEM_PROMPT, /[Pp]reserve the meaning/);
  assert.match(HUMANIZER_SYSTEM_PROMPT, /ONLY the rewritten message/);
});

// The humanizer must never cost the user a reply.
//
// MEASURED, 6 runs of the humanizer pass on a reply the main model had already
// produced correctly:
//   usable=2  narrated=4  empty=0
//
// It narrates two times in three, the leak detector rejects that, and the whole
// reply is lost - the user sees "hit an error" for a perfectly good answer.
// Observed live: "help me plan a week of launch content" produced useful
// clarifying questions and arrived as an error.
//
// The main model is ALREADY instructed for the casual register, so this is a
// second call, on a half-saturated tier, that makes reliability worse.
test("a narrated humanizer pass does not destroy the reply", async () => {
  const { stripNarration } = await import("../guards.js");
  // The exact shape observed live.
  // Built from char codes: the escapes here are the same ones the model emits,
  // and writing them literally gets mangled by whatever writes this file.
  const N = String.fromCharCode(10);
  const narrated = [
    "Here's a thinking process:" + N,
    "",
    "1.  **Analyze User Input:**" + N,
    "   - Original message is a casual chat message asking for details.",
    "2. **Rewrite:**",
    "   - Shorter.",
  ].join(N);
  const stripped = stripNarration(narrated);
  const usable = stripped.length >= 20 && !/thinking process|analyze user input/i.test(stripped);
  assert.equal(usable, false, "narration must not be mistaken for a usable rewrite");
});

test("a genuine rewrite survives the narration filter", async () => {
  const { stripNarration } = await import("../guards.js");
  const rewritten =
    "hey! to build that week of content i need two things: what you're launching, " +
    "and which channels matter most.";
  assert.equal(stripNarration(rewritten), rewritten, "a real rewrite must survive intact");
});

test("a short genuine rewrite is not mistaken for narration", async () => {
  const { stripNarration } = await import("../guards.js");
  const short = "got it - need the launch type and your channels, then i'll draft it.";
  assert.equal(stripNarration(short), short);
});
