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
  username                  TEXT,
  follower_count            INTEGER,
  follower_count_updated_at INTEGER,
  created_at                INTEGER NOT NULL,
  UNIQUE(user_id, platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id),
  account_id   TEXT    NOT NULL REFERENCES connected_accounts(id),
  platform     TEXT    NOT NULL,
  caption      TEXT,
  status       TEXT    NOT NULL DEFAULT 'processing',  -- processing | scheduled | published | failed | inbox
  publish_id   TEXT,
  scheduled_at       INTEGER,
  created_at         INTEGER NOT NULL,
  video_id           TEXT,
  tiktok_create_time INTEGER,
  retry_count        INTEGER NOT NULL DEFAULT 0,  -- number of retries before success/failure (0 = first attempt worked)
  last_error         TEXT                         -- last error message, set on permanent failure
);

-- Migrations applied to live D1 (2026-03-28) — already reflected above:
-- ALTER TABLE posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE posts ADD COLUMN last_error TEXT;

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id),
  key_hash     TEXT    NOT NULL UNIQUE,
  key_prefix   TEXT    NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user     ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_user        ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_account     ON posts(account_id);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_api_keys_user     ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash     ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS hashtag_sets (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id),
  name       TEXT    NOT NULL,
  hashtags   TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hashtag_sets_user ON hashtag_sets(user_id);

-- Pinterest Phase B publishing jobs (Rev 2 design §5). Pinterest-specific, small,
-- additive. Stores ONLY data we own or an owner instruction: NO Pinterest board_id,
-- NO Pinterest pin_id are ever persisted (resolved live / discarded — §7, §8).
-- Added 2026-08-15 (slice B1); also in migrations/2026-08-15-pinterest-publish-jobs.sql.
CREATE TABLE IF NOT EXISTS pinterest_publish_jobs (
  id              TEXT    PRIMARY KEY,           -- our internal uuid
  external_job_id TEXT    NOT NULL,              -- caller-supplied stable Pin id (dedupe)
  source          TEXT    NOT NULL,              -- cohort/property id, e.g. 'home-maintenance-cohort-2'
  manifest_id     TEXT    NOT NULL,              -- submission batch id (audit + dedupe)
  content_hash    TEXT    NOT NULL,              -- hash of approved content (idempotent-retry vs conflict)
  user_id         TEXT    NOT NULL REFERENCES users(id),
  account_id      TEXT    NOT NULL REFERENCES connected_accounts(id),
  board_alias     TEXT    NOT NULL,              -- LOCAL alias we own; resolved live at execution (§7)
  title           TEXT,                          -- <=100
  description     TEXT,                          -- <=800
  link            TEXT,                          -- <=2048
  alt_text        TEXT,                          -- <=500
  image_key       TEXT    NOT NULL,              -- R2 object key we own (§10)
  ai_disclosure   TEXT,                          -- NULL | 'AI_MODIFIED' | 'SYNTHETIC_PERFORMER'
  publish_at      INTEGER NOT NULL,              -- UTC unix seconds (== now for immediate)
  approved_at     INTEGER NOT NULL,              -- = manifest submission time
  state           TEXT    NOT NULL,              -- approved|publishing|published|needs_review|canceled
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  claimed_at      INTEGER,                        -- lease stamp for crash recovery
  published_at    INTEGER,
  error_category  TEXT,                           -- local sanitized category only (never raw Pinterest body)
  created_at      INTEGER NOT NULL,
  UNIQUE(source, external_job_id)                 -- ingestion dedupe (§13)
);
CREATE INDEX IF NOT EXISTS idx_ppj_due    ON pinterest_publish_jobs(state, publish_at);
CREATE INDEX IF NOT EXISTS idx_ppj_source ON pinterest_publish_jobs(source, state);
