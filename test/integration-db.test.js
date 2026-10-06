// Integration tests for the db layer against a REAL Postgres instance.
//
// Skipped unless BOB_TEST_DATABASE_URL points at a throwaway database. It is
// dropped and recreated by these tests, so never point it at anything real.
//
//   BOB_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/bobdb_test npm test

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const TEST_DB = process.env.BOB_TEST_DATABASE_URL;
const skip = TEST_DB
  ? false
  : "set BOB_TEST_DATABASE_URL to a throwaway database to run";

let db;
let admin;

before(async () => {
  if (!TEST_DB) return;
  admin = new pg.Pool({ connectionString: TEST_DB });
  await admin.query(
    `DROP TABLE IF EXISTS subscriptions, bot_owner_memory, bot_summaries,
     bot_messages, bot_chats, bots, messages, chat_participants, chats,
     users CASCADE`
  );
  // db.js reads DATABASE_URL at import time, so set it before importing.
  process.env.DATABASE_URL = TEST_DB;
  db = await import("../db.js");
  await db.ensureSchema();
});

after(async () => {
  if (db) await db.closePool().catch(() => {});
  if (admin) await admin.end().catch(() => {});
});

const CHAT = 900000001;
const ALICE = 700000001;
const BOB_ID = 700000002;

test("ensureSchema is idempotent", { skip }, async () => {
  await db.ensureSchema();
  await db.ensureSchema();
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
  );
  assert.ok(rows[0].n >= 4, `expected 4 tables, got ${rows[0].n}`);
});

test("chat creation, title coalescing and ownership", { skip }, async () => {
  const created = await db.getOrCreateChat(CHAT, "Trip planning");
  assert.equal(Number(created.chat_id), CHAT);
  assert.equal(created.title, "Trip planning");

  // A later message with no title must not wipe the existing one.
  const again = await db.getOrCreateChat(CHAT, null);
  assert.equal(again.title, "Trip planning");

  assert.equal(await db.getChatOwner(CHAT), null);

  await db.upsertUser(ALICE, "Alice");
  await db.setChatOwnerIfUnset(CHAT, ALICE);
  assert.equal((await db.getChatOwner(CHAT)).name, "Alice");

  // Ownership is first-writer-wins: a second caller must not steal the chat.
  await db.upsertUser(BOB_ID, "Bob");
  await db.setChatOwnerIfUnset(CHAT, BOB_ID);
  assert.equal((await db.getChatOwner(CHAT)).name, "Alice");
});

test("upsertUser updates the name in place", { skip }, async () => {
  await db.upsertUser(ALICE, "Alice Renamed");
  assert.equal((await db.getChatOwner(CHAT)).name, "Alice Renamed");
  await db.upsertUser(ALICE, "Alice");
});

test("addParticipant is idempotent", { skip }, async () => {
  await db.addParticipant(CHAT, ALICE);
  await db.addParticipant(CHAT, ALICE);
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM chat_participants WHERE chat_id = $1",
    [CHAT]
  );
  assert.equal(rows[0].n, 1);
});

test("messages round-trip in chronological order", { skip }, async () => {
  await db.insertMessage(CHAT, ALICE, "Alice", "first");
  await db.insertMessage(CHAT, ALICE, "Alice", "second");
  await db.insertMessage(CHAT, BOB_ID, "Bob", "third");

  const recent = await db.getRecentMessages(CHAT, 10);
  assert.deepEqual(
    recent.map((m) => m.text),
    ["first", "second", "third"]
  );
  assert.equal(await db.getMessageCount(CHAT), 3);
});

test("getRecentMessages returns the newest N, still in chronological order", { skip }, async () => {
  const recent = await db.getRecentMessages(CHAT, 2);
  assert.deepEqual(
    recent.map((m) => m.text),
    ["second", "third"]
  );
});

test("getMessagesToSummarize keeps the newest messages and prefers the oldest by insertion order", { skip }, async () => {
  // The whole batch is inserted in one statement so every created_at is
  // identical - this is what a real burst of chat messages looks like, and it
  // is the case that a created_at-only ORDER BY gets wrong.
  const texts = ["m1", "m2", "m3", "m4", "m5", "m6"];
  await admin.query(
    `INSERT INTO messages (chat_id, user_id, sender, text)
     SELECT $1, $2, 'Alice', t FROM unnest($3::text[]) AS t`,
    [CHAT, ALICE, texts]
  );

  const total = await db.getMessageCount(CHAT);
  const toSummarize = await db.getMessagesToSummarize(CHAT, 3);

  assert.equal(toSummarize.length, total - 3, "must leave exactly 3 messages behind");
  // The 3 kept messages must be the NEWEST ones.
  const kept = await db.getRecentMessages(CHAT, 3);
  for (const row of kept) {
    assert.ok(
      !toSummarize.some((s) => s.text === row.text),
      `${row.text} was both kept and summarised`
    );
  }
  assert.deepEqual(kept.map((m) => m.text), ["m4", "m5", "m6"]);

  // Oldest-first, no duplicates: the ids returned must be strictly increasing.
  const ids = toSummarize.map((r) => Number(r.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});

test("getMessagesToSummarize returns nothing when under the keep threshold", { skip }, async () => {
  const fresh = CHAT + 1;
  await db.getOrCreateChat(fresh, "Small chat");
  await db.insertMessage(fresh, ALICE, "Alice", "only message");
  const rows = await db.getMessagesToSummarize(fresh, 20);
  assert.deepEqual(rows, []);
});

test("deleteMessagesByIds removes exactly the given rows and no-ops on empty", { skip }, async () => {
  const before = await db.getMessageCount(CHAT);
  const rows = await db.getMessagesToSummarize(CHAT, 3);
  const ids = rows.map((r) => Number(r.id));

  await db.deleteMessagesByIds([]);
  assert.equal(await db.getMessageCount(CHAT), before, "empty delete must not touch rows");

  await db.deleteMessagesByIds(ids);
  assert.equal(await db.getMessageCount(CHAT), before - ids.length);
});

test("chat and cross-chat summaries persist and surface", { skip }, async () => {
  assert.equal(await db.getChatSummary(CHAT), "");
  await db.updateChatSummary(CHAT, "Decided on Lisbon in May.");
  assert.equal(await db.getChatSummary(CHAT), "Decided on Lisbon in May.");

  await db.updateUserCrossChatSummary(ALICE, "Likes window seats.");
  assert.equal((await db.getChatOwner(CHAT)).cross_chat_summary, "Likes window seats.");
});

test("getChatSummary for an unknown chat returns empty, not undefined", { skip }, async () => {
  assert.equal(await db.getChatSummary(123456789012), "");
});

test("unsolicited cooldown timestamp round-trips", { skip }, async () => {
  assert.equal(await db.getLastUnsolicitedReply(CHAT), 0);
  await db.setLastUnsolicitedReply(CHAT);
  const ts = await db.getLastUnsolicitedReply(CHAT);
  assert.ok(ts > 0);
  assert.ok(Math.abs(Date.now() - ts) < 60000);
});

// --- Phase 1: bot-scoped schema ---------------------------------------------
//
// Everything above keys memory on chat_id, which is one memory per chat. The
// product needs one memory per BOT, so a bot carries what it learned in one
// group into the next (requirement 9) and two users' bots never mix
// (requirement 10). Both properties are consequences of the key, so these
// tests pin the key, not a filtering convention.

const CHAT_A = 910000001;
const CHAT_B = 910000002;
const OWNER_1 = 710000001;
const OWNER_2 = 710000002;

async function seedBotChats() {
  await db.upsertUser(OWNER_1, "Owner One");
  await db.upsertUser(OWNER_2, "Owner Two");
  await db.getOrCreateChat(CHAT_A, "Group A");
  await db.getOrCreateChat(CHAT_B, "Group B");
}

test("ensureSchema creates the bot-scoped tables", { skip }, async () => {
  await seedBotChats();
  const { rows } = await admin.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of [
    "bots",
    "bot_chats",
    "bot_messages",
    "bot_summaries",
    "bot_owner_memory",
  ]) {
    assert.ok(names.includes(t), `missing table ${t} (have: ${names.join(", ")})`);
  }
});

test("a bot is registered under an owner and found by its telegram id", { skip }, async () => {
  const bot = await db.createBot({
    ownerUserId: OWNER_1,
    telegramUserId: 800000001,
    displayName: "Alice",
    telegramToken: "token-alice",
    modelTier: "nemotron-3-ultra-550b-a55b:free",
  });
  assert.equal(bot.display_name, "Alice");

  const found = await db.getBotByTelegramUserId(800000001);
  assert.equal(Number(found.bot_id), Number(bot.bot_id));
  assert.equal(Number(found.owner_user_id), OWNER_1);
  assert.equal(found.model_tier, "nemotron-3-ultra-550b-a55b:free");

  assert.equal(await db.getBotByTelegramUserId(999999999), null);
});

test("one telegram bot maps to exactly one Bob", { skip }, async () => {
  await assert.rejects(
    () =>
      db.createBot({
        ownerUserId: OWNER_2,
        telegramUserId: 800000001,
        displayName: "Impostor",
        telegramToken: "token-impostor",
      }),
    /duplicate key|unique/i,
    "a second row with the same telegram_user_id must be rejected"
  );
});

test("getBotByName is case-insensitive and scoped to the chat it is linked to", { skip }, async () => {
  const { rows } = await admin.query(
    "SELECT bot_id FROM bots WHERE telegram_user_id = $1",
    [800000001]
  );
  const aliceId = rows[0].bot_id;
  await db.linkBotToChat(aliceId, CHAT_A, { relayPosition: 0 });

  const hit = await db.getBotByName(CHAT_A, "alice");
  assert.ok(hit, "a lowercase call must find the bot named Alice");
  assert.equal(Number(hit.bot_id), Number(aliceId));

  // Linked to chat A only, so chat B must not see it.
  assert.equal(await db.getBotByName(CHAT_B, "Alice"), null);
});

test("linkBotToChat is idempotent and keeps the relay position", { skip }, async () => {
  const { rows } = await admin.query(
    "SELECT bot_id FROM bots WHERE telegram_user_id = $1",
    [800000001]
  );
  const aliceId = rows[0].bot_id;
  await db.linkBotToChat(aliceId, CHAT_A, { relayPosition: 0 });
  await db.linkBotToChat(aliceId, CHAT_A, { relayPosition: 3 });

  const { rows: linked } = await admin.query(
    "SELECT count(*)::int AS n, max(relay_position)::int AS pos FROM bot_chats WHERE bot_id = $1 AND chat_id = $2",
    [aliceId, CHAT_A]
  );
  assert.equal(linked[0].n, 1, "linking twice must not create two rows");
  assert.equal(linked[0].pos, 3, "the latest relay position must win");
});

test("each bot keeps its own messages: one bot never sees another's", { skip }, async () => {
  const botA = await db.createBot({
    ownerUserId: OWNER_1,
    telegramUserId: 800000002,
    displayName: "Bob",
    telegramToken: "token-bob",
  });
  const botB = await db.createBot({
    ownerUserId: OWNER_2,
    telegramUserId: 800000003,
    displayName: "Carol",
    telegramToken: "token-carol",
  });
  await db.linkBotToChat(botA.bot_id, CHAT_A, { relayPosition: 1 });
  await db.linkBotToChat(botB.bot_id, CHAT_A, { relayPosition: 2 });

  await db.insertBotMessage(botA.bot_id, CHAT_A, "Alice", "for alice only");
  await db.insertBotMessage(botB.bot_id, CHAT_A, "Alice", "for bob only");

  const seenByA = await db.getRecentBotMessages(botA.bot_id, CHAT_A, 10);
  assert.deepEqual(
    seenByA.map((m) => m.text),
    ["for alice only"],
    "bot A must not read bot B's history in the same chat"
  );
  assert.equal(await db.getBotMessageCount(botA.bot_id, CHAT_A), 1);
});

test("tier-B summary is per chat, tier-C owner memory travels with the bot", { skip }, async () => {
  const { rows } = await admin.query(
    "SELECT bot_id FROM bots WHERE telegram_user_id = $1",
    [800000002]
  );
  const botA = rows[0].bot_id;

  assert.equal(await db.getBotSummary(botA, CHAT_A), "");
  await db.updateBotSummary(botA, CHAT_A, "In group A we planned Lisbon.");
  assert.equal(await db.getBotSummary(botA, CHAT_A), "In group A we planned Lisbon.");
  // A summary for a chat the bot has not been in yet must read empty, never
  // leak group A's.
  assert.equal(await db.getBotSummary(botA, CHAT_B), "");

  await db.updateBotOwnerMemory(botA, "Owner likes window seats and hates red-eyes.");
  assert.equal(
    await db.getBotOwnerMemory(botA),
    "Owner likes window seats and hates red-eyes."
  );

  // The whole point of requirement 9: link the same bot into a second group and
  // its owner memory is already there, with no migration or copy step.
  await db.linkBotToChat(botA, CHAT_B, { relayPosition: 0 });
  assert.equal(
    await db.getBotOwnerMemory(botA),
    "Owner likes window seats and hates red-eyes."
  );
  assert.equal(await db.getBotSummary(botA, CHAT_B), "", "group B has its own summary");
});

test("two owners using the same display name do not collide", { skip }, async () => {
  const one = await db.createBot({
    ownerUserId: OWNER_1,
    telegramUserId: 800000010,
    displayName: "Helper",
    telegramToken: "t1",
  });
  const two = await db.createBot({
    ownerUserId: OWNER_2,
    telegramUserId: 800000011,
    displayName: "Helper",
    telegramToken: "t2",
  });
  await db.linkBotToChat(one.bot_id, CHAT_A, { relayPosition: 0 });
  await db.linkBotToChat(two.bot_id, CHAT_B, { relayPosition: 0 });

  const inA = await db.getBotByName(CHAT_A, "Helper");
  const inB = await db.getBotByName(CHAT_B, "Helper");
  assert.equal(Number(inA.owner_user_id), OWNER_1);
  assert.equal(Number(inB.owner_user_id), OWNER_2);

  // The identity that matters is bot_id, not the name.
  await db.insertBotMessage(one.bot_id, CHAT_A, "Alice", "owner one's memory");
  assert.equal(await db.getBotMessageCount(two.bot_id, CHAT_B), 0);
});

test("getBotsForChat returns every relay participant in position order", { skip }, async () => {
  const bots = await db.getBotsForChat(CHAT_A);
  const positions = bots.map((b) => Number(b.relay_position));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(bots.length >= 3, `expected the linked bots, got ${bots.length}`);
  assert.ok(bots.every((b) => b.display_name), "each row must carry its display name");
});

// Phase 8: subscriptions. Billing state is stored, and a missing row is a
// valid state meaning "free" - never an error, because a billing hiccup must
// not take a working bot offline.
test("a subscription round-trips and defaults to no subscription", { skip }, async () => {
  assert.equal(await db.getSubscription(OWNER_1), null, "no row means free, not an error");

  await db.setSubscription(OWNER_1, { plan: "pro", status: "active", botQuota: 5 });
  const sub = await db.getSubscription(OWNER_1);
  assert.equal(sub.plan, "pro");
  assert.equal(sub.status, "active");
  assert.equal(Number(sub.bot_quota), 5);

  // Upsert, not insert: a plan change must update in place.
  await db.setSubscription(OWNER_1, { plan: "free", status: "canceled" });
  const changed = await db.getSubscription(OWNER_1);
  assert.equal(changed.plan, "free");
  assert.equal(changed.status, "canceled");
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1",
    [OWNER_1]
  );
  assert.equal(rows[0].n, 1, "a plan change must not create a second row");
});

test("counting a user's bots ignores other users' and persona rows", { skip }, async () => {
  const { rows } = await admin.query(
    "SELECT owner_user_id, count(*)::int AS n FROM bots GROUP BY owner_user_id"
  );
  for (const row of rows) {
    const counted = await db.countBotsForOwner(row.owner_user_id);
    assert.equal(counted, row.n, `owner ${row.owner_user_id} count must match`);
  }
  assert.equal(await db.countBotsForOwner(999999999), 0, "an unknown owner owns nothing");
});

// In the relay architecture the named bots are personas consulted server-side,
// not separate Telegram bots: only the relay holds a token. So telegram_user_id
// is NULL for them, and several such personas must coexist. A UNIQUE column
// permits any number of NULLs, which is exactly what this needs - but only if
// the column is nullable in the first place.
test("persona bots have no telegram id and many can coexist", { skip }, async () => {
  const made = [];
  for (const name of ["P1", "P2", "P3"]) {
    made.push(
      await db.createBot({
        ownerUserId: OWNER_1,
        telegramUserId: null,
        displayName: name,
      })
    );
  }
  const ids = made.map((b) => Number(b.bot_id));
  assert.equal(new Set(ids).size, 3, "each persona must get its own bot_id");

  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM bots WHERE telegram_user_id IS NULL"
  );
  assert.ok(rows[0].n >= 3, `expected the NULL-id personas, got ${rows[0].n}`);

  // A persona with no telegram id must not be found by telegram id.
  assert.equal(await db.getBotByTelegramUserId(null), null);
});

