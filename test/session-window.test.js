// Phase B/D: the memory window.
//
// The new shape is: session summary + owner summary + the last N turns, per
// bot. The "per bot" is load-bearing - pulling recent turns across all of a
// bot's sessions would carry group A's verbatim conversation into group B's
// prompt, which is a cross-group disclosure, not a feature.

import test from "node:test";
import assert from "node:assert/strict";

import {
  selectWindow,
  summariseTriggered,
  orderForCache,
  estimateTokens,
  tokenTriggered,
  DEFAULT_TURNS,
  TURNS_PER_SUMMARY,
} from "../session-window.js";

const turn = (n) => ({ sender: "Alice", text: `turn ${n}`, id: n });

test("the window keeps exactly the last N turns", () => {
  const all = Array.from({ length: 30 }, (_, i) => turn(i + 1));
  const w = selectWindow(all, 10);
  assert.equal(w.length, 10);
  assert.deepEqual(w.map((t) => t.text), [
    "turn 21", "turn 22", "turn 23", "turn 24", "turn 25",
    "turn 26", "turn 27", "turn 28", "turn 29", "turn 30",
  ]);
});

test("the window is chronological, so the model reads it in order", () => {
  const all = Array.from({ length: 20 }, (_, i) => turn(i + 1));
  const w = selectWindow(all, 5);
  assert.deepEqual(w.map((t) => t.text), ["turn 16", "turn 17", "turn 18", "turn 19", "turn 20"]);
});

test("a short history is returned whole, never padded", () => {
  const w = selectWindow([turn(1), turn(2)], 10);
  assert.equal(w.length, 2);
  assert.deepEqual(selectWindow([], 10), []);
  assert.deepEqual(selectWindow(null, 10), []);
});

test("a non-positive or nonsense limit yields nothing rather than everything", () => {
  const all = [turn(1), turn(2), turn(3)];
  assert.deepEqual(selectWindow(all, 0), []);
  assert.deepEqual(selectWindow(all, -5), []);
  assert.deepEqual(selectWindow(all, NaN), []);
});

test("the default window is 10 turns, as specified", () => {
  assert.equal(DEFAULT_TURNS, 10);
});

test("summarisation triggers only once the un-summarised tail exceeds the window", () => {
  assert.equal(summariseTriggered(TURNS_PER_SUMMARY - 1, TURNS_PER_SUMMARY), false);
  assert.equal(summariseTriggered(TURNS_PER_SUMMARY, TURNS_PER_SUMMARY), true);
  assert.equal(summariseTriggered(TURNS_PER_SUMMARY + 5, TURNS_PER_SUMMARY), true);
});

test("summarisation does not re-trigger on every single message", () => {
  // It fires at the threshold, and again only after another full batch - so a
  // chat does not pay for a summarisation call on every turn.
  assert.equal(TURNS_PER_SUMMARY, 30);
  assert.equal(summariseTriggered(29, TURNS_PER_SUMMARY), false);
  assert.equal(summariseTriggered(30, TURNS_PER_SUMMARY), true);
});

test("a token estimate catches the long-message case a count would miss", () => {
  // 40 messages is the count trigger, but a chat of 8 very long messages blows
  // the context budget long before 40 rows exist. The token guard is the second
  // independent signal, so the window stays bounded either way.
  assert.ok(estimateTokens("hello world") > 0);
  const short = Array.from({ length: 8 }, () => "ok");
  const long = Array.from({ length: 8 }, () => "x".repeat(2000));
  assert.ok(
    estimateTokens(long.join("\n")) > estimateTokens(short.join("\n")) * 10,
    "a long body must estimate far more tokens than a short one"
  );
});

test("estimateTokens is a safe over-estimate, never an under-estimate", () => {
  // Under-estimating is the dangerous direction: the request would exceed the
  // model's context and fail, rather than summarising early.
  const text = "a".repeat(100);
  // ~4 chars per token is the usual rule; the estimate must be at least that.
  assert.ok(estimateTokens(text) >= 25, `100 chars estimated at ${estimateTokens(text)} tokens`);
});

test("the token trigger fires on a long body even when the count is low", () => {
  const budget = 1000;
  assert.equal(tokenTriggered("x".repeat(100), budget), false);
  assert.equal(tokenTriggered("x".repeat(100000), budget), true);
});

test("an unset or nonsense token budget disables the guard rather than misfiring", () => {
  assert.equal(tokenTriggered("x".repeat(100000), 0), false);
  assert.equal(tokenTriggered("x".repeat(100000), NaN), false);
  assert.equal(tokenTriggered("x".repeat(100000), -5), false);
});

test("prompt order is stable-first, so the cacheable prefix does not move", () => {
  // Caching only helps if the SAME bytes appear first every time. Persona,
  // then owner summary, then session summary, then the recent turns last.
  const ordered = orderForCache({
    persona: "PERSONA",
    ownerSummary: "OWNER",
    sessionSummary: "SESSION",
    turns: "TURNS",
    latest: "LATEST",
  });
  assert.equal(ordered.indexOf("PERSONA"), 0);
  assert.ok(ordered.indexOf("PERSONA") < ordered.indexOf("OWNER"));
  assert.ok(ordered.indexOf("OWNER") < ordered.indexOf("SESSION"));
  assert.ok(ordered.indexOf("SESSION") < ordered.indexOf("TURNS"));
  assert.ok(ordered.indexOf("TURNS") < ordered.indexOf("LATEST"));
});

test("a missing section is omitted rather than leaving a blank gap", () => {
  const ordered = orderForCache({ persona: "PERSONA", turns: "TURNS" });
  assert.ok(!ordered.includes("undefined"));
  assert.ok(!/\n\n\n/.test(ordered), "no empty sections");
  assert.equal(ordered.indexOf("PERSONA"), 0);
});

test("the cache-ordered prompt is byte-identical across calls with the same inputs", () => {
  // This is the property caching actually depends on.
  const args = {
    persona: "P",
    ownerSummary: "O",
    sessionSummary: "S",
    turns: "T",
    latest: "L",
  };
  assert.equal(orderForCache(args), orderForCache({ ...args }));
});
