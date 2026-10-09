// What Bob remembers about the user.
//
// The purpose is a colleague and friend, not a search box. Told "my partner Sam
// is vegetarian and I'm allergic to peanuts", then asked what to order for
// dinner, it must use that - in any chat, days later.

import test from "node:test";
import assert from "node:assert/strict";

import { extractFacts, looksLikeCorrection, formatFacts } from "../memory.js";

test("a dietary constraint stated about the user is remembered", () => {
  const facts = extractFacts("my partner Sam is vegetarian and I'm allergic to peanuts");
  assert.ok(facts.length > 0, "something must be remembered");
  const all = facts.join(" | ").toLowerCase();
  assert.match(all, /allerg|peanut/, "the allergy must survive");
});

test("a named third party is captured, because the name is what is needed later", () => {
  const facts = extractFacts("my partner Sam is vegetarian");
  assert.match(facts.join(" "), /Sam/);
});

test("a third party's attributes are NOT attributed to them", () => {
  // Observed live: storing "Sam (my partner) is vegetarian" beside "I'm allergic
  // to peanuts" produced "considering Sam's diet and peanut allergy" - reading as
  // though SAM is allergic. That is a factual claim about a real person's
  // health, inferred from a sentence about the speaker, so only the link is
  // stored and the attribute stays with whoever said it.
  const facts = extractFacts("my partner Sam is vegetarian and I'm allergic to peanuts");
  const aboutSam = facts.filter((f) => /Sam/.test(f));
  for (const f of aboutSam) {
    assert.ok(
      !/vegetarian|allerg/i.test(f),
      `must not attribute an attribute to Sam: ${f}`
    );
  }
  // The user's own allergy must still be captured, verbatim.
  assert.match(facts.join(" "), /allerg/i);
});

test("credentials and card details are never stored", () => {
  // The single most damaging thing this feature could do.
  for (const t of [
    "my api key is sk-or-v1-abc123",
    "my password is hunter2",
    "my credit card is 4111 1111 1111 1111",
    "my bank account number is 12345678",
  ]) {
    assert.deepEqual(extractFacts(t), [], `must not store from: ${t.slice(0, 30)}`);
  }
});

test("ordinary chat is not turned into facts", () => {
  // Over-collecting makes every reply carry noise, which costs tokens and
  // buries the facts that matter.
  for (const t of [
    "hey, what's up?",
    "thanks!",
    "see you tomorrow",
    "the weather is nice today",
  ]) {
    const facts = extractFacts(t);
    assert.ok(facts.length === 0, `must not invent a fact from: ${t}`);
  }
});

test("an empty or non-string input is safe", () => {
  for (const t of ["", "   ", null, undefined, 42, {}]) {
    assert.ok(Array.isArray(extractFacts(t)));
  }
});

test("facts are de-duplicated and bounded", () => {
  const facts = extractFacts("I'm allergic to peanuts. I'm allergic to peanuts.");
  assert.equal(new Set(facts).size, facts.length, "no duplicates");
  assert.ok(facts.length <= 3, "and at most a few per message");
});

test("a fact is bounded in length, so a pasted wall of text cannot flood memory", () => {
  const facts = extractFacts("I'm allergic to " + "peanuts, ".repeat(100));
  for (const f of facts) assert.ok(f.length <= 200, `fact was ${f.length} chars`);
});

test("a correction is recognised, so a stale fact can be retracted", () => {
  assert.equal(looksLikeCorrection("actually Sam eats meat now"), true);
  assert.equal(looksLikeCorrection("no longer allergic to peanuts"), true);
  assert.equal(looksLikeCorrection("what should we order?"), false);
});

test("formatFacts renders stably, so the cached prompt prefix does not move", () => {
  const facts = ["Sam (my partner) is vegetarian", "Allergic to peanuts"];
  assert.equal(formatFacts(facts), formatFacts([...facts]), "ordering must not change output");
  assert.match(formatFacts(facts), /- Sam/);
  assert.equal(formatFacts([]), "", "no facts means no section, not an empty one");
});
