// Phase B: shared state in Postgres.
//
// The in-process Maps (chatQueues, seenUpdates, relayTurns) work on one
// long-lived server but not on serverless, where invocations share no memory.
// Moving them into Postgres gives one code path for Render and Vercel.
//
// The property that matters is atomicity: two concurrent claims for the same
// chat must not both win, or two replies post. These tests run real concurrent
// queries, because a test that awaits them in sequence would pass on a
// non-atomic implementation.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// This suite gets its OWN database. Node runs test FILES in parallel, and the
// e2e suite shares bobdb_test and drops the same tables - so pointing this at
// the same database made it clobber the e2e run mid-flight, which showed up as
// six unrelated Phase 5/6/7 failures.
const BASE_DB = process.env.BOB_TEST_DATABASE_URL;
const DB_NAME = "bobdb_test_state";

function scratchUrl() {
  const u = new URL(BASE_DB);
  return `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port}/${DB_NAME}`;
}

const skip = BASE_DB ? false : "set BOB_TEST_DATABASE_URL to a throwaway database to run";

let db;
let admin;
let adminPool;

before(async () => {
  if (!BASE_DB) return;

  const u = new URL(BASE_DB);
  const base = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port}/postgres`;
  adminPool = new pg.Pool({ connectionString: base });
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);

  const url = scratchUrl();
  admin = new pg.Pool({ connectionString: url });
  process.env.DATABASE_URL = url;
  db = await import("../db.js");
  await db.ensureSchema();
});

after(async () => {
  if (db) await db.closePool().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (adminPool) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {});
    await adminPool.end().catch(() => {});
  }
});

test("ensureSchema creates the shared-state tables", { skip }, async () => {
  const { rows } = await admin.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const names = rows.map((r) => r.table_name);
  for (const t of ["processed_updates", "chat_locks"]) {
    assert.ok(names.includes(t), `missing ${t} (have: ${names.join(", ")})`);
  }
});

test("claimUpdate lets exactly one caller win, even when called concurrently", { skip }, async () => {
  const chatId = 9001;
  // Ten concurrent claims for the same update id. Exactly one must win; the
  // in-process Set this replaces had the same property, and losing it on
  // serverless is what this table exists to restore.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => db.claimUpdate(4242, chatId))
  );
  const winners = results.filter(Boolean).length;
  assert.equal(winners, 1, `${winners} callers won the same update id`);
});

test("claimUpdate is per update id, so a different update still gets through", { skip }, async () => {
  assert.equal(await db.claimUpdate(5001, 9001), true);
  assert.equal(await db.claimUpdate(5002, 9001), true);
  // And a repeat of the first is refused.
  assert.equal(await db.claimUpdate(5001, 9001), false);
});

test("claimUpdate with no update id is allowed through, not silently dropped", { skip }, async () => {
  // Telegram always sends one, but a missing id must not cause the update to be
  // discarded as a duplicate - that would lose a real message.
  assert.equal(await db.claimUpdate(undefined, 9001), true);
  assert.equal(await db.claimUpdate(null, 9001), true);
});

test("pruneProcessedUpdates keeps the table bounded", { skip }, async () => {
  // Without pruning this table grows forever on a busy bot.
  for (let i = 0; i < 50; i++) await db.claimUpdate(7000 + i, 9002);
  await db.pruneProcessedUpdates(10);
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM processed_updates WHERE chat_id = $1",
    [9002]
  );
  assert.ok(rows[0].n <= 10, `expected at most 10 rows, got ${rows[0].n}`);
});

test("acquireChatLock lets exactly one holder in at a time", { skip }, async () => {
  const chatId = 9100;
  const a = await db.acquireChatLock(chatId, "job-a", 30);
  assert.equal(a, true, "the first holder must get the lock");
  // A second, different holder must be refused while the first holds it.
  const b = await db.acquireChatLock(chatId, "job-b", 30);
  assert.equal(b, false, "a second holder must not get the lock");
  await db.releaseChatLock(chatId, "job-a");
  const c = await db.acquireChatLock(chatId, "job-c", 30);
  assert.equal(c, true, "after release the lock is available");
  await db.releaseChatLock(chatId, "job-c");
});

test("concurrent lock acquisition yields exactly one holder", { skip }, async () => {
  const chatId = 9101;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => db.acquireChatLock(chatId, `j${i}`, 30))
  );
  assert.equal(results.filter(Boolean).length, 1, "more than one holder got in");
  await admin.query("DELETE FROM chat_locks WHERE chat_id = $1", [chatId]);
});

test("an expired lock can be taken over, so a crashed holder does not wedge a chat", { skip }, async () => {
  const chatId = 9102;
  await db.acquireChatLock(chatId, "crashed", 30);
  // Simulate the holder dying without releasing.
  await admin.query(
    "UPDATE chat_locks SET expires_at = now() - interval '1 second' WHERE chat_id = $1",
    [chatId]
  );
  const taken = await db.acquireChatLock(chatId, "recovery", 30);
  assert.equal(taken, true, "an expired lock must be reclaimable, or a crash wedges the chat forever");
  await db.releaseChatLock(chatId, "recovery");
});

test("the same holder may re-acquire its own lock", { skip }, async () => {
  // A retry inside one logical job must not deadlock against itself.
  const chatId = 9103;
  assert.equal(await db.acquireChatLock(chatId, "same", 30), true);
  assert.equal(await db.acquireChatLock(chatId, "same", 30), true);
  await db.releaseChatLock(chatId, "same");
});

test("releasing a lock held by someone else does not free it", { skip }, async () => {
  const chatId = 9104;
  await db.acquireChatLock(chatId, "holder", 30);
  await db.releaseChatLock(chatId, "someone-else");
  const blocked = await db.acquireChatLock(chatId, "intruder", 30);
  assert.equal(blocked, false, "only the holder may release");
  await db.releaseChatLock(chatId, "holder");
});

test("locks in different chats are independent", { skip }, async () => {
  assert.equal(await db.acquireChatLock(9201, "x", 30), true);
  assert.equal(await db.acquireChatLock(9202, "y", 30), true, "another chat must not be blocked");
  await db.releaseChatLock(9201, "x");
  await db.releaseChatLock(9202, "y");
});

test("claimPaymentEvent lets exactly one caller win, so a Stripe retry cannot double-credit", { skip }, async () => {
  // Stripe retries a webhook it could not deliver, and a replayed
  // checkout.session.completed must not grant the same credit twice - the same
  // class of bug as a replayed Telegram update.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => db.claimPaymentEvent("evt_same_id"))
  );
  assert.equal(results.filter(Boolean).length, 1, "more than one caller claimed the same event");
});

test("a different payment event still gets through", { skip }, async () => {
  assert.equal(await db.claimPaymentEvent("evt_a"), true);
  assert.equal(await db.claimPaymentEvent("evt_b"), true);
  assert.equal(await db.claimPaymentEvent("evt_a"), false, "a repeat must be refused");
});

test("a payment event with no id is allowed through, not silently dropped", { skip }, async () => {
  // Losing a real payment is worse than processing it twice.
  assert.equal(await db.claimPaymentEvent(null), true);
  assert.equal(await db.claimPaymentEvent(undefined), true);
});
