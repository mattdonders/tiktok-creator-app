-- Migration: add pinterest_publish_jobs (Pinterest Phase B, slice B1).
-- Additive only. Creates ONE new table + 2 indexes. No existing table is altered,
-- no data is backfilled, nothing else is touched. Idempotent (IF NOT EXISTS).
--
-- NOT APPLIED to production during BUILD. Future production apply command:
--   wrangler d1 execute creatorpost --remote --file=migrations/2026-08-15-pinterest-publish-jobs.sql
-- (local dev:  wrangler d1 execute creatorpost --local  --file=migrations/2026-08-15-pinterest-publish-jobs.sql)

CREATE TABLE IF NOT EXISTS pinterest_publish_jobs (
  id              TEXT    PRIMARY KEY,
  external_job_id TEXT    NOT NULL,
  source          TEXT    NOT NULL,
  manifest_id     TEXT    NOT NULL,
  content_hash    TEXT    NOT NULL,
  user_id         TEXT    NOT NULL REFERENCES users(id),
  account_id      TEXT    NOT NULL REFERENCES connected_accounts(id),
  board_alias     TEXT    NOT NULL,
  title           TEXT,
  description     TEXT,
  link            TEXT,
  alt_text        TEXT,
  image_key       TEXT    NOT NULL,
  ai_disclosure   TEXT,
  publish_at      INTEGER NOT NULL,
  approved_at     INTEGER NOT NULL,
  state           TEXT    NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  claimed_at      INTEGER,
  published_at    INTEGER,
  error_category  TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(source, external_job_id)
);
CREATE INDEX IF NOT EXISTS idx_ppj_due    ON pinterest_publish_jobs(state, publish_at);
CREATE INDEX IF NOT EXISTS idx_ppj_source ON pinterest_publish_jobs(source, state);
