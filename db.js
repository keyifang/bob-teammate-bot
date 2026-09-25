import pg from "pg";

// Built on first use rather than at import time. Reading DATABASE_URL during
// module evaluation depends on env.js having been imported first, which is easy
// to get wrong and fails with a confusing SASL error. Lazy construction removes
// the ordering hazard entirely.
let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set - cannot connect to Postgres");
    }
    // Small pool on purpose: the only production target is a managed instance
    // reached through a connection pooler (Supabase's pgbouncer) that multiplexes
    // many clients over a small number of server connections, plus a free-tier
    // dyno. A default-size pool there exhausts connections and looks like a
    // random "too many clients" failure.
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX ?? 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT PRIMARY KEY,
    name TEXT,
    cross_chat_summary TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS chats (
    chat_id BIGINT PRIMARY KEY,
    title TEXT,
    owner_user_id BIGINT REFERENCES users(user_id),
    summary TEXT DEFAULT '',
    last_unsolicited_reply TIMESTAMPTZ,
    intro_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
  // Additive migration for databases created before intro_sent existed.
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS intro_sent BOOLEAN DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id BIGINT REFERENCES chats(chat_id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    user_id BIGINT,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_created
    ON messages (chat_id, created_at)`,
];

// One statement per call. Supabase's pooler runs in transaction mode, which
// rejects a multi-statement query string, and every managed provider that sits
// in front of Postgres benefits from being able to parse statements separately.
export async function ensureSchema() {
  for (const statement of SCHEMA_STATEMENTS) {
    await getPool().query(statement);
  }
}

export async function upsertUser(userId, name) {
  await getPool().query(
    `INSERT INTO users (user_id, name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET name = $2`,
    [userId, name]
  );
}

export async function getOrCreateChat(chatId, title) {
  const { rows } = await getPool().query(
    `INSERT INTO chats (chat_id, title)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET title = COALESCE(chats.title, $2)
     RETURNING *`,
    [chatId, title ?? null]
  );
  return rows[0];
}

export async function setChatOwnerIfUnset(chatId, ownerUserId) {
  await getPool().query(
    `UPDATE chats SET owner_user_id = $1
     WHERE chat_id = $2 AND owner_user_id IS NULL`,
    [ownerUserId, chatId]
  );
}

export async function getChatOwner(chatId) {
  const { rows } = await getPool().query(
    `SELECT u.* FROM chats c
     JOIN users u ON u.user_id = c.owner_user_id
     WHERE c.chat_id = $1`,
    [chatId]
  );
  return rows[0] ?? null;
}

export async function addParticipant(chatId, userId) {
  await getPool().query(
    `INSERT INTO chat_participants (chat_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [chatId, userId]
  );
}

export async function insertMessage(chatId, userId, sender, text) {
  // sender is NOT NULL in the schema. A caller passing undefined would abort
  // the whole update with a constraint violation, so it is normalised here
  // rather than relying on every caller to remember.
  const safeSender = sender || "Unknown";
  const safeText = text ?? "";
  await getPool().query(
    `INSERT INTO messages (chat_id, user_id, sender, text)
     VALUES ($1, $2, $3, $4)`,
    [chatId, userId, safeSender, safeText]
  );
  await getPool().query(
    `UPDATE chats SET updated_at = now() WHERE chat_id = $1`,
    [chatId]
  );
}

export async function getRecentMessages(chatId, limit) {
  const { rows } = await getPool().query(
    `SELECT sender, text, created_at FROM messages
     WHERE chat_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [chatId, limit]
  );
  return rows.reverse();
}

export async function getMessageCount(chatId) {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = $1`,
    [chatId]
  );
  return rows[0].count;
}

export async function getMessagesToSummarize(chatId, keepLast) {
  const { rows } = await getPool().query(
    `SELECT id, sender, text FROM messages
     WHERE chat_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT (SELECT GREATEST(COUNT(*) - $2, 0) FROM messages WHERE chat_id = $1)`,
    [chatId, keepLast]
  );
  return rows;
}

export async function deleteMessagesByIds(ids) {
  if (!ids.length) return;
  await getPool().query(`DELETE FROM messages WHERE id = ANY($1::bigint[])`, [ids]);
}

export async function getChatSummary(chatId) {
  const { rows } = await getPool().query(
    `SELECT summary FROM chats WHERE chat_id = $1`,
    [chatId]
  );
  return rows[0]?.summary ?? "";
}

export async function updateChatSummary(chatId, summary) {
  await getPool().query(
    `UPDATE chats SET summary = $1, updated_at = now() WHERE chat_id = $2`,
    [summary, chatId]
  );
}

export async function updateUserCrossChatSummary(userId, summary) {
  await getPool().query(
    `UPDATE users SET cross_chat_summary = $1, updated_at = now() WHERE user_id = $2`,
    [summary, userId]
  );
}

export async function getLastUnsolicitedReply(chatId) {
  const { rows } = await getPool().query(
    `SELECT last_unsolicited_reply FROM chats WHERE chat_id = $1`,
    [chatId]
  );
  const value = rows[0]?.last_unsolicited_reply;
  return value ? new Date(value).getTime() : 0;
}

export async function setLastUnsolicitedReply(chatId) {
  await getPool().query(
    `UPDATE chats SET last_unsolicited_reply = now() WHERE chat_id = $1`,
    [chatId]
  );
}

// Returns true only for the caller that flipped the flag, so exactly one
// introduction is ever posted per chat even if Bob is removed and re-added
// (TC-02) or the joining update is delivered twice (TC-35).
export async function claimIntro(chatId) {
  const { rows } = await getPool().query(
    `UPDATE chats SET intro_sent = TRUE, updated_at = now()
     WHERE chat_id = $1 AND intro_sent = FALSE
     RETURNING chat_id`,
    [chatId]
  );
  return rows.length > 0;
}

export async function hasClaimedIntro(chatId) {
  const { rows } = await getPool().query(
    `SELECT intro_sent FROM chats WHERE chat_id = $1`,
    [chatId]
  );
  return rows[0]?.intro_sent === true;
}

// Called only when the intro failed to send, so a later opportunity can retry.
export async function releaseIntro(chatId) {
  await getPool().query(
    `UPDATE chats SET intro_sent = FALSE WHERE chat_id = $1`,
    [chatId]
  );
}

export async function getChatTitle(chatId) {
  const { rows } = await getPool().query(
    `SELECT title FROM chats WHERE chat_id = $1`,
    [chatId]
  );
  return rows[0]?.title ?? "";
}

export async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}
