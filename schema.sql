-- CreatorPost v2 — D1 Database Schema

CREATE TABLE IF NOT EXISTS users (
  id          TEXT    PRIMARY KEY,  -- crypto.randomUUID()
  email       TEXT    UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token       TEXT    PRIMARY KEY,
  email       TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES users(id),
  platform         TEXT    NOT NULL,  -- 'tiktok'
  platform_user_id TEXT    NOT NULL,
  display_name     TEXT,
  avatar_url       TEXT,
  access_token     TEXT    NOT NULL,
  refresh_token    TEXT,
  token_expires_at INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE(user_id, platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id),
  account_id   TEXT    NOT NULL REFERENCES connected_accounts(id),
  platform     TEXT    NOT NULL,
  caption      TEXT,
  status       TEXT    NOT NULL DEFAULT 'processing',  -- processing | scheduled | published | failed
  publish_id   TEXT,
  scheduled_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user     ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_user        ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_account     ON posts(account_id);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
