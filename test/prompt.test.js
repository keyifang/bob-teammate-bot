import test from "node:test";
import assert from "node:assert/strict";

import { buildReplyPrompt } from "../prompt.js";

// FR-04 to FR-07: the three memory tiers reach the reply prompt, broadest
// first, and nothing from another chat can appear in it.

test("negative control: a prompt with no context carries no other chat's text", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    transcript: "Alice: hello",
  });
  // If this ever matched, the assertions below would be meaningless.
  assert.ok(!prompt.includes("TIER_C"), "unrelated tier C text must not appear");
  assert.ok(!prompt.includes("Some other chat"), "unrelated content must not appear");
});

test("no context at all still produces a usable prompt", () => {
  const prompt = buildReplyPrompt({ bobName: "Bob" });
  assert.ok(prompt.includes("Reply as Bob"));
  assert.ok(!prompt.includes("\n\n\n"), "no empty sections");
});

test("the three tiers appear in order C, B, A", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Alice",
    crossChatSummary: "TIER_C_MARKER",
    summary: "TIER_B_MARKER",
    transcript: "Alice: TIER_A_MARKER",
  });

  const c = prompt.indexOf("TIER_C_MARKER");
  const b = prompt.indexOf("TIER_B_MARKER");
  const a = prompt.indexOf("TIER_A_MARKER");

  assert.ok(c !== -1 && b !== -1 && a !== -1, "all three tiers must be present");
  assert.ok(c < b, "tier C must precede tier B");
  assert.ok(b < a, "tier B must precede tier A");
});

test("tier C is labelled with the owner's name so it is attributable", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Alice",
    crossChatSummary: "likes window seats",
  });
  assert.ok(prompt.includes("Alice"), prompt);
  assert.ok(/window seats/.test(prompt));
});

test("tier C is omitted entirely when there is no owner summary", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Alice",
    crossChatSummary: "",
    summary: "tier B only",
  });
  assert.ok(!/other chats with you/.test(prompt), prompt);
  assert.ok(prompt.includes("tier B only"));
});

test("tier C is omitted when there is no owner at all", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    ownerName: undefined,
    crossChatSummary: "orphaned summary",
    transcript: "Alice: hi",
  });
  assert.ok(!prompt.includes("orphaned summary"), prompt);
});

test("empty tiers leave no blank gaps", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Alice",
    crossChatSummary: "",
    summary: "",
    transcript: "Alice: hi",
  });
  assert.ok(!/\n\n\n/.test(prompt), "no empty section may leave a gap");
});

// TC-10: two chats owned by different people must produce different prompts,
// and neither prompt may contain the other's text.
test("TC-10: prompts for two chats share no chat-specific text", () => {
  const trip = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Alice",
    crossChatSummary: "TRIP_OWNER_CONTEXT",
    summary: "TRIP_TIER_B",
    transcript: "Alice: TRIP_TIER_A",
  });
  const debug = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Grace",
    crossChatSummary: "DEBUG_OWNER_CONTEXT",
    summary: "DEBUG_TIER_B",
    transcript: "Grace: DEBUG_TIER_A",
  });

  assert.ok(!trip.includes("DEBUG_"), "trip prompt leaked the other chat");
  assert.ok(!debug.includes("TRIP_"), "debug prompt leaked the other chat");
  assert.ok(trip.includes("TRIP_TIER_A") && trip.includes("TRIP_TIER_B"));
  assert.ok(debug.includes("DEBUG_TIER_A") && debug.includes("DEBUG_TIER_B"));
});

test("TC-12: tier B survives a transcript that has been pruned to tier A", () => {
  // After summarisation the raw rows are gone, so the only carrier of the old
  // decision is tier B. It must be present even when tier A is short.
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    ownerName: "Alice",
    crossChatSummary: "",
    summary: "Decided on Lisbon in May, budget 1200.",
    transcript: "Alice: so are we still on?",
  });
  assert.ok(prompt.includes("Lisbon"), prompt);
});

test("first contact adds the introduction instruction exactly once", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    transcript: "Liam: hey",
    firstContact: true,
  });
  const matches = prompt.match(/first message with this person/g) ?? [];
  assert.equal(matches.length, 1);
  assert.ok(/AI teammate/.test(prompt), "the intro instruction must name the AI");
});

test("the introduction instruction is absent on later messages", () => {
  const prompt = buildReplyPrompt({
    bobName: "Bob",
    transcript: "Liam: hey again",
    firstContact: false,
  });
  assert.ok(!/first message with this person/.test(prompt));
});

test("a non-ASCII transcript is passed through unchanged", () => {
  const transcript = "GR: 予約は木曜でいい？\nAlice: sounds good 🎉";
  const prompt = buildReplyPrompt({ bobName: "Bob", transcript });
  assert.ok(prompt.includes(transcript), "transcript must not be mangled");
});

// Phase 3: a named bot answers from its own memory, and the message being
// answered is passed separately when it is not yet in the stored transcript.
test("latest is included and ordered after the transcript", () => {
  const prompt = buildReplyPrompt({
    bobName: "Alice",
    transcript: "Human: earlier line",
    latest: "Human: the new question",
  });
  const ti = prompt.indexOf("earlier line");
  const li = prompt.indexOf("the new question");
  assert.ok(ti !== -1 && li !== -1, "both must appear");
  assert.ok(li > ti, "the newest message must come after the transcript");
  assert.ok(/Reply as Alice/.test(prompt));
});

test("with no latest, nothing is invented", () => {
  const prompt = buildReplyPrompt({ bobName: "Bob", transcript: "Alice: hi" });
  assert.ok(!/Newest message to answer/.test(prompt));
  assert.ok(!prompt.includes("undefined"));
});

// Phase 5: in a relay turn a later bot sees what earlier bots said, so the
// group gets a discussion rather than N unrelated answers.
test("discussion appears after the question and instructs not to repeat", () => {
  const prompt = buildReplyPrompt({
    bobName: "Carol",
    latest: "Human: where should we go?",
    discussion: "Alice: Lisbon.\nBob: Porto is cheaper.",
  });
  assert.ok(prompt.includes("Alice: Lisbon."), "earlier replies must reach the prompt");
  const qi = prompt.indexOf("where should we go?");
  const di = prompt.indexOf("Alice: Lisbon.");
  assert.ok(di > qi, "the discussion must come after the question it responds to");
  assert.match(prompt, /[Dd]o not repeat/);
});

test("with no discussion, nothing is invented", () => {
  const prompt = buildReplyPrompt({ bobName: "Alice", latest: "Human: hi" });
  assert.ok(!/Others have already answered/.test(prompt));
  assert.ok(!prompt.includes("undefined"));
});
