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
