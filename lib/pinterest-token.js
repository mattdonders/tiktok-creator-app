// Pinterest PRODUCTION token lifecycle (Phase B, slice B3 — BUILT, NOT ACTIVATED).
//
// ONE refresh implementation shared by BOTH triggers:
//   (a) the existing 6-hour /api/cron/refresh-tokens (proactive, keeps the rotating
//       60-day refresh chain alive well before the 30-day access token expires); and
//   (b) the publish-time safety check inside /api/cron/publish-due (refresh only when
//       a due job is about to run against a near-expiry token).
// Both call ensurePinterestTokenFresh() → refreshPinterestProductionToken(); there is
// no second refresh path.
//
// Pinterest refresh tokens ROTATE on every successful refresh (a new refresh_token is
// returned) and the old one is consumed. Two dangers are handled here WITHOUT any new
// schema or distributed lock:
//   1. Concurrent refreshers sharing the same stored refresh token — a compare-and-swap
//      persist (WHERE refresh_token = <observed>) guarantees AT MOST ONE writer commits
//      a rotation for a given stored token; the loser detects the supersession by
//      re-reading and stands down instead of clobbering the newer token or false-alarming.
//   2. Ambiguous network loss AFTER Pinterest may have rotated (our connection dies
//      before we store the new token) — never blind-retried; classified reconnect_required
//      so a human reconnects, rather than replaying a possibly-consumed refresh token.
//
// SECURITY: never logs, returns, or embeds any token value or the client secret.

import { assertProductionUrl, PINTEREST_PRODUCTION_HOST, PINTEREST_PRODUCTION_PUID } from './pinterest-production.js';

const PINTEREST_PRODUCTION_TOKEN_URL = `https://${PINTEREST_PRODUCTION_HOST}/v5/oauth/token`;

// OFFICIAL PINTEREST FACT (v5, re-verified 2026-08-15): access token 30d,
// continuous rotating refresh token 60d, refresh at POST /v5/oauth/token.
export const PINTEREST_ACCESS_TTL_SECONDS = 30 * 86400;   // 2_592_000
export const PINTEREST_REFRESH_TTL_SECONDS = 60 * 86400;  // 5_184_000

// Proactive threshold: refresh in the 6-hour cron once the access token is within 7
// days of expiry. Comfortably exercises the rotating chain (well inside 30 days) while
// keeping refreshes infrequent.
export const PROACTIVE_REFRESH_THRESHOLD_SECONDS = 7 * 86400;

// Publish-time safety threshold: only refresh right before publishing when the token is
// within 1 hour of expiry. A clearly-healthy token is never refreshed at publish time.
export const PUBLISH_SAFETY_THRESHOLD_SECONDS = 60 * 60;

// ─── Pure helpers ────────────────────────────────────────────────────────────

// Does the access token need refreshing given its expiry? A null/unknown expiry is
// treated as NOT proactively refreshable here (we cannot compute a window); the publish
// engine still fails closed on a genuinely dead token via its own reconnect path.
export function tokenNeedsRefresh(tokenExpiresAt, nowSec, thresholdSec) {
  if (typeof tokenExpiresAt !== 'number') return false;
  return tokenExpiresAt < nowSec + thresholdSec;
}

// Classify exactly one refresh attempt. `outcome` is either
//   { kind:'response', status, hasTokens }  or  { kind:'network_error' }.
// 'refreshed' → persist the rotated tokens. 'reconnect' → a human must reconnect; we
// never blind-retry (the refresh token may have been consumed server-side).
export function classifyRefreshOutcome(outcome) {
  if (outcome?.kind === 'response') {
    if (outcome.status === 200 && outcome.hasTokens) return { result: 'refreshed' };
    // 400/401 invalid_grant etc. → definite rejection; 5xx/other → ambiguous. Either
    // way the safe local disposition is the same: reconnect_required, no auto-retry.
    return { result: 'reconnect', error_category: 'reconnect_required' };
  }
  // Network timeout/reset: Pinterest may have rotated before we heard back → ambiguous.
  return { result: 'reconnect', error_category: 'reconnect_required' };
}

// ─── D1: load the single owner-prod account ──────────────────────────────────

export async function loadPinterestProductionAccount(DB) {
  return DB.prepare(
    `SELECT id, access_token, refresh_token, token_expires_at
       FROM connected_accounts
      WHERE platform = 'pinterest' AND platform_user_id = ?
      LIMIT 1`,
  ).bind(PINTEREST_PRODUCTION_PUID).first();
}

// ─── Refresh network call (exactly one attempt, host-locked) ─────────────────

// Perform EXACTLY ONE refresh POST. No withRetry. Returns an outcome descriptor for
// classifyRefreshOutcome plus, on success, the parsed rotated tokens (in memory only).
async function refreshTokenOnce(fetchImpl, env, refreshToken) {
  assertProductionUrl(PINTEREST_PRODUCTION_TOKEN_URL);
  if (!env.PINTEREST_CLIENT_ID || !env.PINTEREST_CLIENT_SECRET) {
    // Misconfiguration, not a token problem — surface as reconnect (no network call).
    return { outcome: { kind: 'response', status: 0, hasTokens: false } };
  }
  const basic = btoa(`${env.PINTEREST_CLIENT_ID}:${env.PINTEREST_CLIENT_SECRET}`);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  let res;
  try {
    res = await fetchImpl(PINTEREST_PRODUCTION_TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    return { outcome: { kind: 'network_error' } };
  }
  if (res.status !== 200) return { outcome: { kind: 'response', status: res.status, hasTokens: false } };
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  const hasTokens = !!data && typeof data.access_token === 'string' && data.access_token.length > 0
    && typeof data.refresh_token === 'string' && data.refresh_token.length > 0;
  return { outcome: { kind: 'response', status: 200, hasTokens }, data };
}

// ─── The one refresh operation (concurrency-safe, no schema change) ──────────

// Refresh the production token using the account's CURRENTLY-OBSERVED refresh token.
// deps: { DB, env, fetchImpl?, nowSec }. account: { id, refresh_token, ... }.
// Returns one of:
//   { result:'refreshed', rotated:true }            — we won and stored the new tokens
//   { result:'superseded' }                          — a concurrent refresh already
//                                                       rotated; token is healthy, no write
//   { result:'reconnect', error_category:'reconnect_required' } — human must reconnect
export async function refreshPinterestProductionToken(deps, account) {
  const { DB, env, fetchImpl = fetch, nowSec } = deps;
  const observed = account?.refresh_token;
  if (typeof observed !== 'string' || observed.length === 0) {
    return { result: 'reconnect', error_category: 'reconnect_required' };
  }

  const { outcome, data } = await refreshTokenOnce(fetchImpl, env, observed);
  const decision = classifyRefreshOutcome(outcome);

  if (decision.result === 'refreshed') {
    const expiresAt = Number.isFinite(data.expires_in) ? nowSec + data.expires_in : null;
    // Compare-and-swap: only commit if the stored refresh token is still the one we
    // rotated from. AT MOST ONE writer wins for a given stored token.
    const upd = await DB.prepare(
      `UPDATE connected_accounts
          SET access_token = ?, refresh_token = ?, token_expires_at = ?
        WHERE id = ? AND refresh_token = ?`,
    ).bind(data.access_token, data.refresh_token, expiresAt, account.id, observed).run();
    const changed = upd?.meta?.changes ?? upd?.changes ?? 0;
    if (changed > 0) return { result: 'refreshed', rotated: true };
    // Lost the CAS: another refresher already advanced the stored token. Do NOT clobber
    // the newer token with ours; treat as healthy.
    return { result: 'superseded' };
  }

  // Rejected/ambiguous. Before declaring reconnect_required, check whether a concurrent
  // refresher rotated the stored token past what we observed — if so, we simply lost the
  // race (our network call used a now-consumed token) and the account is actually fine.
  const fresh = await DB.prepare(
    'SELECT refresh_token FROM connected_accounts WHERE id = ?',
  ).bind(account.id).first();
  if (fresh && typeof fresh.refresh_token === 'string' && fresh.refresh_token !== observed) {
    return { result: 'superseded' };
  }
  return { result: 'reconnect', error_category: 'reconnect_required' };
}

// ─── Shared entrypoint (both proactive + publish-time paths call THIS) ────────

// Ensure the production token is fresh enough. Refreshes via the ONE implementation
// above only when within `thresholdSec` of expiry. Returns:
//   { result:'healthy' } | { result:'refreshed' } | { result:'superseded' }
//   | { result:'reconnect', error_category:'reconnect_required' }
export async function ensurePinterestTokenFresh(deps, account, thresholdSec) {
  if (!account?.id) return { result: 'reconnect', error_category: 'reconnect_required' };
  if (!tokenNeedsRefresh(account.token_expires_at, deps.nowSec, thresholdSec)) {
    return { result: 'healthy' };
  }
  return refreshPinterestProductionToken(deps, account);
}

// ─── Proactive-cron wrapper (added to /api/cron/refresh-tokens) ──────────────

// Refresh the owner-prod Pinterest token proactively (7-day window). Never throws.
// Returns { refreshed, status, alert? } — `alert` is a sanitized reconnect notice the
// caller may forward to Discord (local data only, never a token).
export async function refreshExpiredPinterestTokens(deps) {
  const { DB } = deps;
  const account = await loadPinterestProductionAccount(DB);
  if (!account?.id) return { refreshed: 0, status: 'no_account' };

  const res = await ensurePinterestTokenFresh(deps, account, PROACTIVE_REFRESH_THRESHOLD_SECONDS);
  if (res.result === 'refreshed') return { refreshed: 1, status: 'refreshed' };
  if (res.result === 'superseded') return { refreshed: 0, status: 'superseded' };
  if (res.result === 'healthy') return { refreshed: 0, status: 'healthy' };
  return {
    refreshed: 0,
    status: 'reconnect_required',
    alert: { event: 'pinterest_token_reconnect_required', error_category: 'reconnect_required' },
  };
}
