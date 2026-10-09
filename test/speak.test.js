// When Bob speaks in a group unprompted.
//
// WHY THIS EXISTS
//
// The old rule: a question mark and a cooldown. So Bob interjects on ANY
// question to ANYONE - "does anyone know if the 3pm moved?" - which is noise,
// not presence. In a group, a friend who butts into every conversation is
// tiresome, and one who never does is useless.
//
// A group colleague does three things, and the logic must distinguish them:
//   - answers when it can genuinely help (asked, or clearly their domain)
//   - stays quiet when it would add nothing
//   - stays quiet when someone is mid-flow with the group

import test from "node:test";
import assert from "node:assert/strict";

import { shouldSpeak, canHelp, CONFIDENT_NOISE } from "../speak.js";

// A question Bob's tools can genuinely answer.
test("Bob speaks when asked directly", () => {
  assert.equal(canHelp({ text: "@bob what's the weather in Beijing", addressed: true }), true);
});

test("Bob does not answer a question that is not his", () => {
  // Someone asking Maya about her weekend has nothing to do with Bob.
  const r = canHelp({ text: "maya did you end up going to the coast?", addressed: false });
  assert.equal(r, false, "must not interject on someone else's conversation");
});

test("Bob speaks up when the question is squarely his domain", () => {
  assert.equal(
    canHelp({ text: "does anyone know what the weather is in Berlin right now?", addressed: false }),
    true,
    "weather is his, even unaddressed"
  );
  assert.equal(
    canHelp({ text: "what's the air quality like in singapore today?", addressed: false }),
    true
  );
});

test("Bob stays out of a conversation he cannot help with", () => {
  for (const t of [
    "does anyone know if the 3pm got moved?",
    "has anyone seen the new cafe on 5th?",
    "my flight got cancelled again",
    "what did you all think of the film?",
  ]) {
    assert.equal(canHelp({ text: t, addressed: false }), false, `must stay out: ${t}`);
  }
});

test("a greeting to the group does not require an answer", () => {
  assert.equal(canHelp({ text: "morning all", addressed: false }), false);
});

test("confidence noise never reaches the user", () => {
  // These are the OBSERVED inventions - claims about a limitation that does not
  // exist. Deliberately NOT included: "the weather may vary" (an honest hedge)
  // and "let me check" (a model mid-work). Flagging those would punish
  // uncertainty, which is the opposite of what is wanted.
  for (const t of [
    "I don't have access to real-time data.",
    "As an AI, I cannot browse.",
    "The weather tool is unavailable right now.",
    "My searches are throttled at the moment.",
    "Check wttr.in for the current reading.",
  ]) {
    assert.equal(
      CONFIDENT_NOISE.test(t),
      true,
      `must be recognised as noise: ${t}`
    );
  }
});

test("a real answer is not mistaken for noise", () => {
  for (const t of [
    "Beijing right now: 21C, partly cloudy.",
    "I don't have that figure, check bom.gov.au.",
  ]) {
    assert.equal(CONFIDENT_NOISE.test(t), false, `must pass: ${t}`);
  }
});

// The decision itself, including the cooldown.
test("the cooldown governs volunteering, not being spoken to", () => {
  // Someone who names Bob twice in a minute is WAITING. Ignoring the second
  // message because of a self-imposed rate limit reads as broken, and the whole
  // point of a group assistant is being reliable when addressed.
  const addressed = shouldSpeak({
    text: "@bob what's the weather in Beijing",
    addressed: true,
    lastSpokeAt: Date.now() - 1000,
    cooldownMs: 45000,
  });
  assert.equal(addressed, true, "a direct mention must always be answered");

  // Volunteering is the thing that needs pacing.
  const volunteered = shouldSpeak({
    text: "what's the weather in Beijing today",
    addressed: false,
    lastSpokeAt: Date.now() - 1000,
    cooldownMs: 45000,
  });
  assert.equal(volunteered, false, "but Bob must not butt in repeatedly");
});

test("Bob speaks after the cooldown has passed", () => {
  const speak = shouldSpeak({
    text: "@bob what's the weather in Beijing",
    addressed: true,
    lastSpokeAt: Date.now() - 60000,
    cooldownMs: 45000,
  });
  assert.equal(speak, true);
});

test("being named by anyone is enough to be spoken to", () => {
  // A direct "hey bob" with no question must still get a reply, or Bob reads as
  // broken in the exact moment someone tries to use him.
  const speak = shouldSpeak({
    text: "hey bob, you around?",
    addressed: true,
    lastSpokeAt: 0,
    cooldownMs: 45000,
  });
  assert.equal(speak, true);
});

test("an unaddressed question never fires on the cooldown alone", () => {
  // The old behaviour was: question mark + cooldown expired = speak. That is
  // what produced interjections on other people's conversations.
  const speak = shouldSpeak({
    text: "does anyone know if the 3pm moved?",
    addressed: false,
    lastSpokeAt: 0,
    cooldownMs: 45000,
  });
  assert.equal(speak, false, "a question to someone else is not Bob's to answer");
});

test("a never-spoken chat does not block a first reply", () => {
  assert.equal(
    shouldSpeak({ text: "@bob hello", addressed: true, lastSpokeAt: 0, cooldownMs: 45000 }),
    true
  );
});

test("missing or malformed input is safe", () => {
  for (const q of [undefined, null, "", "   ", 42, {}]) {
    assert.doesNotThrow(() => shouldSpeak({ text: q, addressed: true, lastSpokeAt: 0 }));
  }
});