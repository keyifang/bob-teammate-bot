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

  // --- Facts the user states about themselves or their world ----------------
  //
  // WHY THIS TABLE EXISTS
  //
  // Bob is a colleague and friend, not a search box. Told "my partner Sam is
  // vegetarian and I'm allergic to peanuts", it must bring that up when asked
  // what to order for dinner - in any chat, days later.
  //
  // Messages already persist, but `users` held only a name and a rolling
  // cross-chat SUMMARY. A summary is regenerated by a model call that can drop
  // or blur any of it; a fact is a row that cannot. That difference is the
  // whole point: a promise ("I'm allergic") must not be paraphrased away.
  //
  // Deliberately NOT keyed by chat_id. The user is the same person everywhere.
  `CREATE TABLE IF NOT EXISTS user_facts (
    fact_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    fact TEXT NOT NULL,
    -- The chat the fact was learned in. Provenance, not scope: recall is
    -- deliberately across ALL chats, because the person is the same everywhere.
    source_chat_id BIGINT,
    mentioned_count INT NOT NULL DEFAULT 1,
    superseded_by BIGINT REFERENCES user_facts(fact_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at TIMESTAMPTZ DEFAULT now()
  )`,
  // One live fact per phrasing, so re-stating does not duplicate it.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_facts_unique
    ON user_facts (user_id, fact) WHERE superseded_by IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_user_facts_user
    ON user_facts (user_id, last_seen_at DESC)`,

  // --- Phase 8: subscriptions ----------------------------------------------
  //
  // One row per paying user. A user with NO row is the normal free case, so
  // every reader treats "absent" as "free" rather than as an error - a billing
  // hiccup must not take a working bot offline.
  `CREATE TABLE IF NOT EXISTS subscriptions (
    user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    bot_quota INT,
    stripe_customer_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,

  // --- Phase B: shared state, so serverless works ---------------------------
  //
  // The in-process Maps (seenUpdates, chatQueues, relayTurns) hold on one
  // long-lived server and fail on serverless, where invocations share no
  // memory. These two tables restore the same guarantees via Postgres, so there
  // is one code path for both Render and Vercel.
  //
  // Atomicity comes from the PRIMARY KEY / UNIQUE constraint, not from
  // application logic: two concurrent inserts cannot both win.
  `CREATE TABLE IF NOT EXISTS processed_updates (
    update_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (update_id, chat_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_processed_updates_at
    ON processed_updates (processed_at)`,
  // A lease, not a mutex: expires_at means a crashed holder cannot wedge a chat
  // forever. The holder is recorded so only the holder may release.
  `CREATE TABLE IF NOT EXISTS chat_locks (
    chat_id BIGINT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,

  // --- Phase A/C: per-user model config and credit --------------------------
  //
  // The API key is stored because a BYOK request must send it. It is never
  // logged and never returned to a chat.
  `CREATE TABLE IF NOT EXISTS user_model_config (
    user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
  // Balance is an integer count of micro-dollars. Floats drift under repeated
  // subtraction, and a ledger that drifts is a refund argument.
  `CREATE TABLE IF NOT EXISTS user_credits (
    user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    balance_micro BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
  // Append-only, so a disputed balance can be reconstructed rather than argued.
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    delta_micro BIGINT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_ledger_user
    ON credit_ledger (user_id, created_at)`,
  // Stripe retries a webhook it could not deliver. Without this, a replayed
  // checkout.session.completed grants the same credit twice.
  `CREATE TABLE IF NOT EXISTS processed_payments (
    event_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT now()
  )`,
  // What is in a user's stored project. The FILES live in R2; this is the
  // manifest, so /project_zip can rebuild the archive without listing the
  // bucket (which needs pagination and a wider grant than a prefix read).
  `CREATE TABLE IF NOT EXISTS project_files (
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    project_name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, project_name, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_files_user
    ON project_files (user_id, project_name)`,
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

// The bot equivalent of getMessagesToSummarize. Oldest-first so the batch
// reads as a conversation, and bounded by the same "keep the newest N" rule.
export async function getBotMessagesToSummarize(botId, chatId, keepLast) {
  const { rows } = await getPool().query(
    `SELECT id, sender, text FROM bot_messages
      WHERE bot_id = $1 AND chat_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT (SELECT GREATEST(COUNT(*) - $3, 0) FROM bot_messages
               WHERE bot_id = $1 AND chat_id = $2)`,
    [botId, chatId, keepLast]
  );
  return rows;
}

// Scoped by bot_id as well as id, so a caller cannot delete another bot's rows
// by passing an id it happens to know.
export async function deleteBotMessagesByIds(botId, ids) {
  if (!ids.length) return;
  await getPool().query(
    `DELETE FROM bot_messages WHERE bot_id = $1 AND id = ANY($2::bigint[])`,
    [botId, ids]
  );
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

// --- Phase 8: subscriptions -------------------------------------------------

export async function getSubscription(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM subscriptions WHERE user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function setSubscription(userId, { plan, status = "active", botQuota = null, stripeCustomerId = null }) {
  await getPool().query(
    `INSERT INTO subscriptions (user_id, plan, status, bot_quota, stripe_customer_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id)
     DO UPDATE SET plan = EXCLUDED.plan,
                   status = EXCLUDED.status,
                   bot_quota = EXCLUDED.bot_quota,
                   stripe_customer_id = EXCLUDED.stripe_customer_id,
                   updated_at = now()`,
    [userId, plan, status, botQuota, stripeCustomerId]
  );
}

export async function countBotsForOwner(ownerUserId) {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS count FROM bots WHERE owner_user_id = $1`,
    [ownerUserId]
  );
  return rows[0].count;
}

// --- Phase B: shared state --------------------------------------------------

/**
 * Claims an update id for processing. Returns true for exactly one caller, even
 * when several run concurrently - the PRIMARY KEY does the arbitration, not
 * application logic, so it holds across serverless invocations that share no
 * memory. A missing id is allowed through: discarding a real message as a
 * duplicate is worse than processing it twice.
 */
export async function claimUpdate(updateId, chatId) {
  if (updateId === undefined || updateId === null) return true;
  const { rows } = await getPool().query(
    `INSERT INTO processed_updates (update_id, chat_id)
     VALUES ($1, $2)
     ON CONFLICT (update_id, chat_id) DO NOTHING
     RETURNING update_id`,
    [updateId, chatId]
  );
  return rows.length > 0;
}

/**
 * Claims a Stripe event id. True for exactly one caller, so a retry cannot
 * double-credit. A missing id is allowed through: losing a real payment is
 * worse than processing it twice.
 */
export async function claimPaymentEvent(eventId) {
  if (eventId === undefined || eventId === null) return true;
  const { rows } = await getPool().query(
    `INSERT INTO processed_payments (event_id)
     VALUES ($1)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [String(eventId)]
  );
  return rows.length > 0;
}

export async function pruneProcessedUpdates(keepPerChat = 500) {
  const keep = Number(keepPerChat) || 500;
  await getPool().query(
    `DELETE FROM processed_updates p
      WHERE p.processed_at < (
        SELECT min(processed_at) FROM (
          SELECT processed_at FROM processed_updates
           WHERE chat_id = p.chat_id
           ORDER BY processed_at DESC
           LIMIT $1
        ) recent
      )`,
    [keep]
  );
}

/**
 * Takes a per-chat lease. True means this holder may proceed.
 *
 * A lease rather than a mutex: `expires_at` lets a crashed holder be taken over
 * instead of wedging the chat forever. The same holder may re-acquire its own
 * lease, so a retry inside one logical job does not deadlock against itself.
 */
export async function acquireChatLock(chatId, holder, ttlSeconds = 60) {
  const ttl = Math.max(1, Number(ttlSeconds) || 60);
  const { rows } = await getPool().query(
    `INSERT INTO chat_locks (chat_id, holder, acquired_at, expires_at)
     VALUES ($1, $2, now(), now() + ($3 || ' seconds')::interval)
     ON CONFLICT (chat_id) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = now(),
           expires_at = EXCLUDED.expires_at
       WHERE chat_locks.expires_at < now()
          OR chat_locks.holder = EXCLUDED.holder
     RETURNING holder`,
    [chatId, holder, String(ttl)]
  );
  return rows.length > 0;
}

export async function releaseChatLock(chatId, holder) {
  await getPool().query(`DELETE FROM chat_locks WHERE chat_id = $1 AND holder = $2`, [
    chatId,
    holder,
  ]);
}

// --- Phase: project storage manifest ----------------------------------------

export async function saveProjectManifest(userId, projectName, files) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // A re-save REPLACES the project rather than accumulating stale paths, so a
    // file removed from the source does not linger in the archive.
    await client.query(
      `DELETE FROM project_files WHERE user_id = $1 AND project_name = $2`,
      [userId, projectName]
    );
    for (const f of files) {
      await client.query(
        `INSERT INTO project_files (user_id, project_name, path, size, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [userId, projectName, f.path, Number(f.size) || 0]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getProjectManifest(userId, projectName) {
  const { rows } = await getPool().query(
    `SELECT path, size FROM project_files
      WHERE user_id = $1 AND project_name = $2 ORDER BY path`,
    [userId, projectName]
  );
  return rows.length ? rows : null;
}

// --- Facts the user has stated ----------------------------------------------

/** Records a fact, or refreshes the one already stored with the same wording. */
export async function rememberFact(userId, fact, sourceChatId = null) {
  const text = String(fact ?? "").trim();
  if (!text) return null;
  const { rows } = await getPool().query(
    `INSERT INTO user_facts (user_id, fact, source_chat_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, fact) WHERE superseded_by IS NULL
     DO UPDATE SET mentioned_count = user_facts.mentioned_count + 1,
                   last_seen_at = now(),
                   source_chat_id = COALESCE(EXCLUDED.source_chat_id, user_facts.source_chat_id)
     RETURNING *`,
    [userId, text, sourceChatId]
  );
  return rows[0] ?? null;
}

/**
 * Everything known about a user, most recently mentioned first.
 *
 * Cross-chat on purpose: the person is the same in every group, so a fact
 * learned in one must be available in all of them.
 */
export async function recallFacts(userId, limit = 20) {
  const { rows } = await getPool().query(
    `SELECT fact, source_chat_id, mentioned_count, last_seen_at
       FROM user_facts
      WHERE user_id = $1 AND superseded_by IS NULL
      ORDER BY last_seen_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => r.fact);
}

/**
 * Retracts a fact when the user corrects it - "actually Sam eats meat now".
 *
 * A superseded row is kept rather than deleted, so the history of what was
 * believed and when stays inspectable; it simply stops being recalled.
 */
export async function supersedeFact(userId, oldFact, newFact) {
  const text = String(oldFact ?? "").trim();
  if (!text) return false;
  const { rows } = await getPool().query(
    `UPDATE user_facts SET superseded_by = (
       SELECT fact_id FROM user_facts
        WHERE user_id = $1 AND fact = $2 AND superseded_by IS NULL
     )
      WHERE user_id = $1 AND fact = $2 AND superseded_by IS NULL
     RETURNING fact_id`,
    [userId, text]
  );
  if (!rows.length) return false;
  if (newFact) await rememberFact(userId, newFact);
  return true;
}

export async function forgetFact(userId, fact) {
  const { rows } = await getPool().query(
    `DELETE FROM user_facts
      WHERE user_id = $1 AND fact = $2 AND superseded_by IS NULL
      RETURNING fact_id`,
    [userId, String(fact ?? "").trim()]
  );
  return rows.length > 0;
}

// --- Phase A/C: per-user config and credit ----------------------------------

export async function getUserModelConfig(userId) {
  const { rows } = await getPool().query(
    `SELECT provider, model, api_key FROM user_model_config WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  // Returned in the camelCase shape every caller uses. Returning the raw row
  // meant `apiKey` was undefined, so resolveUserModel saw a missing key and
  // silently fell back to the deployment default - the user's saved model
  // never took effect.
  return {
    provider: rows[0].provider,
    model: rows[0].model,
    apiKey: rows[0].api_key,
  };
}

export async function setUserModelConfig(userId, { provider, model, apiKey }) {
  await getPool().query(
    `INSERT INTO user_model_config (user_id, provider, model, api_key, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE
       SET provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           api_key = EXCLUDED.api_key,
           updated_at = now()`,
    [userId, provider, model, apiKey]
  );
}

export async function clearUserModelConfig(userId) {
  await getPool().query(`DELETE FROM user_model_config WHERE user_id = $1`, [userId]);
}

export async function getCreditBalance(userId) {
  const { rows } = await getPool().query(
    `SELECT balance_micro FROM user_credits WHERE user_id = $1`,
    [userId]
  );
  return rows[0] ? Number(rows[0].balance_micro) : 0;
}

/**
 * Adds to a balance and records the movement, in one transaction.
 *
 * The ledger is append-only so a disputed balance can be reconstructed rather
 * than argued about. A negative delta is clamped so a race between two calls
 * cannot leave a negative balance, which would read as us owing the user.
 */
export async function addCredits(userId, deltaMicro, reason) {
  const delta = Math.round(Number(deltaMicro) || 0);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_credits (user_id, balance_micro, updated_at)
       VALUES ($1, GREATEST($2, 0), now())
       ON CONFLICT (user_id) DO UPDATE
         SET balance_micro = GREATEST(user_credits.balance_micro + $2, 0),
             updated_at = now()`,
      [userId, delta]
    );
    await client.query(
      `INSERT INTO credit_ledger (user_id, delta_micro, reason) VALUES ($1, $2, $3)`,
      [userId, delta, String(reason ?? "adjustment")]
    );
    const { rows } = await client.query(
      `SELECT balance_micro FROM user_credits WHERE user_id = $1`,
      [userId]
    );
    await client.query("COMMIT");
    return Number(rows[0].balance_micro);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getCreditLedger(userId, limit = 20) {
  const { rows } = await getPool().query(
    `SELECT delta_micro, reason, created_at FROM credit_ledger
      WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, Number(limit) || 20]
  );
  return rows;
}
