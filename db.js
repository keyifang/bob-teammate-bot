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

  // --- Phase 1: bot-scoped schema ------------------------------------------
  //
  // Every table above keys memory on chat_id, which is one memory per chat.
  // The product is one memory per BOT, so the key here is (chat_id, bot_id).
  // Two product requirements fall out of that key rather than out of a
  // filtering convention someone has to remember:
  //
  //   - a bot carries what it learned in one group into the next (req 9),
  //     because bot_owner_memory is keyed on bot_id alone;
  //   - two owners' bots never mix (req 10), because bot_id -> owner_user_id
  //     is a foreign key, not a column that callers must filter by.
  //
  // Purely additive: no existing table or row is touched.
  // telegram_user_id is nullable on purpose. In the relay architecture a named
  // bot is a persona consulted server-side, not a separate Telegram bot - only
  // the relay holds a token - so a persona has no telegram id. UNIQUE permits
  // any number of NULLs, so many personas coexist; a real bot still gets one id.
  `CREATE TABLE IF NOT EXISTS bots (
    bot_id BIGSERIAL PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    telegram_user_id BIGINT UNIQUE,
    telegram_token TEXT,
    display_name TEXT NOT NULL,
    persona TEXT,
    model_tier TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS bot_chats (
    bot_id BIGINT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT TRUE,
    relay_position INT NOT NULL DEFAULT 0,
    is_primary BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (bot_id, chat_id)
  )`,
  `CREATE TABLE IF NOT EXISTS bot_messages (
    id BIGSERIAL PRIMARY KEY,
    bot_id BIGINT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_messages_bot_chat_created
    ON bot_messages (bot_id, chat_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS bot_summaries (
    bot_id BIGINT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL,
    summary TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (bot_id, chat_id)
  )`,
  // Keyed on bot_id ALONE on purpose - see the note above. That is what makes
  // cross-group memory reuse (req 9) a property of the schema.
  `CREATE TABLE IF NOT EXISTS bot_owner_memory (
    bot_id BIGINT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE,
    summary TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
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

// --- Phase 1: bot-scoped accessors -----------------------------------------
//
// The functions above are the single-bot path and stay untouched so the live
// bot keeps working. These are the multi-bot path, keyed on (bot_id, chat_id).

export async function createBot({
  ownerUserId,
  telegramUserId,
  displayName,
  telegramToken = null,
  persona = null,
  modelTier = null,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO bots
       (owner_user_id, telegram_user_id, display_name, telegram_token, persona, model_tier)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [ownerUserId, telegramUserId, displayName, telegramToken, persona, modelTier]
  );
  return rows[0];
}

export async function getBotByTelegramUserId(telegramUserId) {
  const { rows } = await getPool().query(
    `SELECT * FROM bots WHERE telegram_user_id = $1`,
    [telegramUserId]
  );
  return rows[0] ?? null;
}

// Case-insensitive on the name, but scoped to the chat: two owners may both
// have a bot called "Helper" in different groups, and each owner's own bot
// must be the one that answers.
export async function getBotByName(chatId, name) {
  const { rows } = await getPool().query(
    `SELECT b.*, bc.relay_position, bc.is_primary
       FROM bots b
       JOIN bot_chats bc ON bc.bot_id = b.bot_id
      WHERE bc.chat_id = $1 AND lower(b.display_name) = lower($2)
      LIMIT 1`,
    [chatId, name ?? ""]
  );
  return rows[0] ?? null;
}

export async function linkBotToChat(botId, chatId, { relayPosition = 0, isPrimary = false } = {}) {
  await getPool().query(
    `INSERT INTO bot_chats (bot_id, chat_id, relay_position, is_primary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bot_id, chat_id)
     DO UPDATE SET relay_position = EXCLUDED.relay_position,
                   is_primary = EXCLUDED.is_primary`,
    [botId, chatId, relayPosition, isPrimary]
  );
}

export async function getBotsForChat(chatId) {
  const { rows } = await getPool().query(
    `SELECT b.*, bc.relay_position, bc.is_primary
       FROM bots b
       JOIN bot_chats bc ON bc.bot_id = b.bot_id
      WHERE bc.chat_id = $1 AND bc.enabled = TRUE
      ORDER BY bc.relay_position ASC, b.bot_id ASC`,
    [chatId]
  );
  return rows;
}

export async function insertBotMessage(botId, chatId, sender, text) {
  const safeSender = sender || "Unknown";
  const safeText = text ?? "";
  await getPool().query(
    `INSERT INTO bot_messages (bot_id, chat_id, sender, text)
     VALUES ($1, $2, $3, $4)`,
    [botId, chatId, safeSender, safeText]
  );
}

export async function getRecentBotMessages(botId, chatId, limit) {
  const { rows } = await getPool().query(
    `SELECT sender, text, created_at FROM bot_messages
      WHERE bot_id = $1 AND chat_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [botId, chatId, limit]
  );
  return rows.reverse();
}

export async function getBotMessageCount(botId, chatId) {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS count FROM bot_messages
      WHERE bot_id = $1 AND chat_id = $2`,
    [botId, chatId]
  );
  return rows[0].count;
}

export async function getBotSummary(botId, chatId) {
  const { rows } = await getPool().query(
    `SELECT summary FROM bot_summaries WHERE bot_id = $1 AND chat_id = $2`,
    [botId, chatId]
  );
  return rows[0]?.summary ?? "";
}

export async function updateBotSummary(botId, chatId, summary) {
  await getPool().query(
    `INSERT INTO bot_summaries (bot_id, chat_id, summary, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (bot_id, chat_id)
     DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
    [botId, chatId, summary]
  );
}

export async function getBotOwnerMemory(botId) {
  const { rows } = await getPool().query(
    `SELECT summary FROM bot_owner_memory WHERE bot_id = $1`,
    [botId]
  );
  return rows[0]?.summary ?? "";
}

export async function updateBotOwnerMemory(botId, summary) {
  await getPool().query(
    `INSERT INTO bot_owner_memory (bot_id, summary, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (bot_id)
     DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
    [botId, summary]
  );
}
