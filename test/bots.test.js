// Phase 3: named-bot routing.
//
// Which bot answers a message, and what text the model actually sees. These
// are pure functions, so every rule is pinned here without a live server.

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBotName,
  mentionedBots,
  stripAddress,
  isRelay,
  routeMessage,
  MAX_BOT_NAME,
} from "../bots.js";

const RELAY = { bot_id: 1, telegram_user_id: 900, display_name: "Bob" };
const ALICE = { bot_id: 2, telegram_user_id: 901, display_name: "Alice" };
const TRIP = { bot_id: 3, telegram_user_id: 902, display_name: "Trip Helper" };

test("normalizeBotName accepts ordinary names and collapses whitespace", () => {
  assert.deepEqual(normalizeBotName("Alice"), { ok: true, name: "Alice" });
  assert.deepEqual(normalizeBotName("  Trip   Helper "), { ok: true, name: "Trip Helper" });
  assert.deepEqual(normalizeBotName("fact-check_2"), { ok: true, name: "fact-check_2" });
});

test("normalizeBotName rejects the names that would break routing or display", () => {
  assert.equal(normalizeBotName("").ok, false);
  assert.equal(normalizeBotName("   ").ok, false);
  assert.equal(normalizeBotName("a".repeat(MAX_BOT_NAME + 1)).ok, false);
  // A name containing a comma would be ambiguous with the "Name," address form.
  assert.equal(normalizeBotName("Bob, the bot").ok, false);
  // Newlines would let one name impersonate two lines of a prompt.
  assert.equal(normalizeBotName("Bob\nAlice").ok, false);
  assert.equal(normalizeBotName("@Bob").ok, false, "the @ is the caller's, not part of the name");
});

test("mentionedBots matches whole words only, case-insensitively", () => {
  const hits = mentionedBots([ALICE, TRIP], "@alice can you check this?");
  assert.deepEqual(hits.map((b) => b.display_name), ["Alice"]);

  // "Al" is not a mention of "Alice", and "Alices" is not either.
  assert.deepEqual(mentionedBots([ALICE], "what did Al say?"), []);
  assert.deepEqual(mentionedBots([ALICE], "Alices everywhere"), []);

  // A multi-word name still matches when written out.
  assert.deepEqual(
    mentionedBots([TRIP], "trip helper, plan the route").map((b) => b.display_name),
    ["Trip Helper"]
  );
});

test("mentionedBots returns each bot at most once and in naming order", () => {
  const hits = mentionedBots([ALICE, TRIP], "@alice and also alice again");
  assert.equal(hits.length, 1, "a repeated mention is still one bot");
});

test("a name is matched inside punctuation, not just whitespace", () => {
  assert.deepEqual(mentionedBots([ALICE], "hey (Alice), thoughts?").map((b) => b.bot_id), [2]);
  assert.deepEqual(mentionedBots([ALICE], "Alice?").map((b) => b.bot_id), [2]);
  assert.deepEqual(mentionedBots([ALICE], "Alice!").map((b) => b.bot_id), [2]);
});

test("stripAddress removes only the leading address, never the question", () => {
  assert.equal(stripAddress("Alice, what do you think?", "Alice"), "what do you think?");
  assert.equal(stripAddress("@alice: go", "Alice"), "go");
  assert.equal(stripAddress("  Alice -  go  ", "Alice"), "go");
  // The name in the middle is part of the sentence and must survive.
  assert.equal(stripAddress("what does Alice think", "Alice"), "what does Alice think");
  // Unknown name -> text untouched.
  assert.equal(stripAddress("hello", "Alice"), "hello");
});

test("isRelay identifies the one bot that owns the live token", () => {
  assert.equal(isRelay(RELAY, 900), true);
  assert.equal(isRelay({ telegram_user_id: 901 }, 900), false);
  assert.equal(isRelay(null, 900), false);
  assert.equal(isRelay(RELAY, null), false, "with no relay configured, nothing is the relay");
});

test("a DM always goes to the relay, however the text reads", () => {
  const route = routeMessage({
    bots: [RELAY, ALICE],
    relayTelegramUserId: 900,
    text: "Alice who?",
    isPrivate: true,
  });
  assert.deepEqual(route.bots.map((b) => b.bot_id), [1]);
  assert.equal(route.relayOnly, true);
});

test("an @mention routes to that bot and to no other", () => {
  const route = routeMessage({
    bots: [RELAY, ALICE, TRIP],
    relayTelegramUserId: 900,
    text: "@Alice what do you think?",
  });
  assert.deepEqual(route.bots.map((b) => b.display_name), ["Alice"]);
  assert.equal(route.stripName, "Alice");
  assert.equal(route.relayOnly, false);
});

test("several mentions route to all of them, and nothing is stripped", () => {
  const route = routeMessage({
    bots: [RELAY, ALICE, TRIP],
    relayTelegramUserId: 900,
    text: "@alice and @trip helper, settle this",
  });
  assert.deepEqual(route.bots.map((b) => b.display_name).sort(), ["Alice", "Trip Helper"]);
  assert.equal(route.stripName, null, "with two addressees there is no single name to strip");
});

test("a leading name addresses a bot without an @", () => {
  const route = routeMessage({
    bots: [RELAY, ALICE],
    relayTelegramUserId: 900,
    text: "Alice: is the budget fine?",
  });
  assert.deepEqual(route.bots.map((b) => b.bot_id), [2]);
  assert.equal(route.stripName, "Alice");
});

test("the relay never answers a named bot's mention, and an unaddressed message routes to nobody", () => {
  // Naming Alice must not also trigger the relay's own reply.
  const named = routeMessage({
    bots: [RELAY, ALICE],
    relayTelegramUserId: 900,
    text: "@Alice ping",
  });
  assert.ok(!named.bots.some((b) => b.bot_id === 1));

  const unaddressed = routeMessage({
    bots: [RELAY, ALICE],
    relayTelegramUserId: 900,
    text: "what a nice day",
  });
  assert.deepEqual(unaddressed.bots, [], "an unaddressed group message routes to no bot by name");
});

test("replying to the relay addresses the relay", () => {
  const route = routeMessage({
    bots: [RELAY, ALICE],
    relayTelegramUserId: 900,
    text: "thanks",
    replyToRelay: true,
  });
  assert.deepEqual(route.bots.map((b) => b.bot_id), [1]);
  assert.equal(route.relayOnly, true);
});

test("with no relay configured, a mention still routes to the named bot", () => {
  const route = routeMessage({
    bots: [ALICE],
    relayTelegramUserId: null,
    text: "@Alice hi",
  });
  assert.deepEqual(route.bots.map((b) => b.display_name), ["Alice"]);
});
