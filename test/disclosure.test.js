import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureAiDisclosure,
  AI_DISCLOSURE_SENTENCE,
  INTRO_MESSAGE_PROMPT,
  PERSONA_SYSTEM_PROMPT,
} from "../config.js";

// FR-02 is a hard product requirement: Bob must say it is an AI on joining.
// Leaving that to the model is a coin flip, so these tests pin the guarantee
// that the disclosure survives whatever the model returns.

test("negative control: a disclosure-free intro is NOT passed through", () => {
  // If this ever returned the input unchanged, the guarantee below is void.
  const out = ensureAiDisclosure("Hey all, Bob here. Happy to help!");
  assert.notEqual(out, "Hey all, Bob here. Happy to help!");
});

test("a model intro that omits the disclosure gets it appended", () => {
  const out = ensureAiDisclosure("Hey all, Bob here - happy to help out.");
  assert.ok(out.includes(AI_DISCLOSURE_SENTENCE), out);
  assert.ok(out.startsWith("Hey all, Bob here"), out);
});

test("the appended disclosure is at most one added sentence", () => {
  const base = "Hey all, Bob here.";
  const out = ensureAiDisclosure(base);
  assert.equal(out, `${base} ${AI_DISCLOSURE_SENTENCE}`);
});

const ALREADY_DISCLOSED = [
  "Hi, I'm Bob, an AI teammate joining to help.",
  "I'm an AI, so I won't pretend otherwise.",
  "Hey - Bob here. As an AI I can look things up fast.",
  "I am a bot that helps with planning.",
  "Bob here, your AI assistant.",
  "Just so you know: artificial intelligence at your service.",
  "I'm a language model, but a useful one.",
];

for (const text of ALREADY_DISCLOSED) {
  test(`an intro that already discloses is left alone: ${text.slice(0, 32)}...`, () => {
    assert.equal(ensureAiDisclosure(text), text);
  });
}

test("the disclosure cannot be suppressed by whitespace or casing tricks", () => {
  const out = ensureAiDisclosure("   ");
  assert.equal(out, AI_DISCLOSURE_SENTENCE);

  const upper = ensureAiDisclosure("HEY EVERYONE");
  assert.ok(/AI/i.test(upper), upper);
});

test("empty and non-string input still yields a disclosure", () => {
  assert.equal(ensureAiDisclosure(""), AI_DISCLOSURE_SENTENCE);
  assert.equal(ensureAiDisclosure(null), AI_DISCLOSURE_SENTENCE);
  assert.equal(ensureAiDisclosure(undefined), AI_DISCLOSURE_SENTENCE);
});

test("the intro prompt asks for a 2-3 sentence AI introduction", () => {
  assert.ok(/AI/i.test(INTRO_MESSAGE_PROMPT), "prompt must name the AI disclosure");
  assert.ok(
    /2-3 sentences|short/i.test(INTRO_MESSAGE_PROMPT),
    "prompt must bound the length"
  );
});

test("a disclosure-free reply is never sent when the intro claim is held", () => {
  // Mirrors what the first DM does: humanize output -> ensureAiDisclosure.
  const modelSaid = "Sure thing, here's the plan.";
  const sent = ensureAiDisclosure(modelSaid);
  assert.notEqual(sent, modelSaid);
  assert.ok(sent.includes(modelSaid), "the actual answer must survive intact");
});

test("repeated application is idempotent", () => {
  const once = ensureAiDisclosure("Hey there.");
  const twice = ensureAiDisclosure(once);
  assert.equal(twice, once);
});

test("the persona prompt does not invite a human impression", () => {
  // "the group already knows this" is fine; instructing deception is not.
  assert.ok(!/pretend to be human|act human|don't mention you are an ai/i.test(PERSONA_SYSTEM_PROMPT));
});
