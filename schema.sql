-- Bob teammate bot schema.
-- Mirrors ensureSchema() in db.js, which is what actually runs on boot.
-- Run manually only if you prefer to provision ahead of the app.

CREATE TABLE IF NOT EXISTS users (
  user_id BIGINT PRIMARY KEY,
  name TEXT,
  cross_chat_summary TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  chat_id BIGINT PRIMARY KEY,
  title TEXT,
  owner_user_id BIGINT REFERENCES users(user_id),
  summary TEXT DEFAULT '',
  last_unsolicited_reply TIMESTAMPTZ,
  intro_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id BIGINT REFERENCES chats(chat_id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  user_id BIGINT,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created
  ON messages (chat_id, created_at);

-- ---------------------------------------------------------------------------
-- Phase 1: bot-scoped schema
--
-- The tables above key memory on chat_id, which is one memory per chat. The
-- product is one memory per BOT, so these key on (bot_id, chat_id). Two
-- requirements fall out of the key rather than a filtering convention:
--
--   - a bot carries what it learned in one group into the next, because
--     bot_owner_memory is keyed on bot_id alone;
--   - two owners' bots never mix, because bot_id -> owner_user_id is a foreign
--     key rather than a column callers must remember to filter by.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bots (
  bot_id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- Nullable on purpose: a named bot is a persona consulted server-side, not a
  -- separate Telegram bot, so it has no telegram id. UNIQUE permits many NULLs.
  telegram_user_id BIGINT UNIQUE,
  telegram_token TEXT,
  display_name TEXT NOT NULL,
  persona TEXT,
  model_tier TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_chats (
  bot_id BIGINT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT TRUE,
  relay_position INT NOT NULL DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (bot_id, chat_id)
);

CREATE TABLE IF NOT EXISTS bot_messages (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_messages_bot_chat_created
  ON bot_messages (bot_id, chat_id, created_at);

CREATE TABLE IF NOT EXISTS bot_summaries (
  bot_id BIGINT NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  summary TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bot_id, chat_id)
);

-- Keyed on bot_id ALONE on purpose: that is what makes cross-group memory reuse
-- a property of the schema rather than of a caller's care.
CREATE TABLE IF NOT EXISTS bot_owner_memory (
  bot_id BIGINT PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE,
  summary TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Phase 8: subscriptions
--
-- A user with NO row is the normal free case, so every reader treats "absent"
-- as "free" rather than as an error.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  bot_quota INT,
  stripe_customer_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
