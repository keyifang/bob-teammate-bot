// Phase 5: relay sequencing.
//
// A relay turn is our own record, not a Telegram message, so the ordering,
// the fan-out cap and the cancellation rule can all be tested directly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  planRelay,
  buildDiscussionContext,
  createTurnRegistry,
  RELAY_MAX_BOTS,
} from "../relay.js";

const bot = (name, position) => ({ display_name: name, relay_position: position });

test("planRelay orders by relay_position", () => {
  const plan = planRelay([bot("C", 2), bot("A", 0), bot("B", 1)]);
  assert.deepEqual(plan.map((b) => b.display_name), ["A", "B", "C"]);
});

test("planRelay caps the fan-out, because cost multiplies with N", () => {
  const many = Array.from({ length: 8 }, (_, i) => bot(`B${i}`, i));
  const plan = planRelay(many);
  assert.equal(plan.length, RELAY_MAX_BOTS);
  // The cap keeps the FIRST bots in position order, not an arbitrary subset.
  assert.deepEqual(plan.map((b) => b.display_name), ["B0", "B1", "B2"]);
});

test("planRelay is safe with nothing to do", () => {
  assert.deepEqual(planRelay([]), []);
  assert.deepEqual(planRelay(null), []);
  assert.deepEqual(planRelay([bot("A", 0)], 0), []);
  // A negative cap must not slice from the end.
  assert.deepEqual(planRelay([bot("A", 0), bot("B", 1)], -1), []);
});

test("a missing relay_position does not scramble the order", () => {
  const plan = planRelay([bot("A", undefined), bot("B", 1)]);
  assert.deepEqual(plan.map((b) => b.display_name), ["A", "B"]);
});

test("the first bot sees an empty discussion, later bots see what was said", () => {
  assert.equal(buildDiscussionContext([]), "");
  assert.equal(buildDiscussionContext(undefined), "");

  const ctx = buildDiscussionContext([
    { name: "Alice", text: "Lisbon, definitely." },
    { name: "Carol", text: "Porto is cheaper." },
  ]);
  assert.ok(ctx.includes("Alice: Lisbon, definitely."));
  assert.ok(ctx.includes("Carol: Porto is cheaper."));
  // Order is the speaking order, so the last bot sees the discussion in sequence.
  assert.ok(ctx.indexOf("Alice") < ctx.indexOf("Carol"));
});

test("beginning a turn invalidates the previous one", () => {
  const turns = createTurnRegistry();
  const first = turns.begin(1);
  assert.equal(turns.isCurrent(1, first), true);

  const second = turns.begin(1);
  assert.equal(turns.isCurrent(1, first), false, "the old token must stop the old turn");
  assert.equal(turns.isCurrent(1, second), true);
});

test("turns in different chats do not invalidate each other", () => {
  const turns = createTurnRegistry();
  const a = turns.begin(100);
  const b = turns.begin(200);
  assert.equal(turns.isCurrent(100, a), true);
  assert.equal(turns.isCurrent(200, b), true);
});

test("a human message cancels the turn in flight without starting a new one", () => {
  const turns = createTurnRegistry();
  const token = turns.begin(1);
  turns.cancel(1);
  assert.equal(
    turns.isCurrent(1, token),
    false,
    "an interjection must stop the remaining bots"
  );
});

test("a token from a chat it was not issued for is never current", () => {
  const turns = createTurnRegistry();
  const token = turns.begin(1);
  assert.equal(turns.isCurrent(2, token), false);
  assert.equal(turns.isCurrent(1, undefined), false);
});
