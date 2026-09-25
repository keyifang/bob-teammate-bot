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
    "DROP TABLE IF EXISTS messages, chat_participants, chats, users CASCADE"
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
