// Pinterest PRODUCTION OAuth support (Phase B, slice B0 — owner-only).
//
// This module is the production twin of `pinterest-sandbox.js`. The two are kept
// deliberately separate and boring: each fails closed against the other's host so
// a sandbox token can never be minted against production and vice-versa (Pinterest
// explicitly forbids cross-environment token use). Pure and dependency-free so the
// production persistence decisions are unit-testable without a live D1 or network.
//
// SECURITY: nothing here logs, returns, or embeds tokens/secrets. It only shapes
// decisions and row values; the route layer performs the actual fetch + D1 writes.

// Production API host. The ONLY host these guards accept.
export const PINTEREST_PRODUCTION_HOST = 'api.pinterest.com';

// Local synthetic account identity for the single owner production connection.
// This is NOT a Pinterest-derived identifier — it is a fixed local sentinel that
// keeps the production row addressable and uniquely upsertable via the existing
// UNIQUE(user_id, platform, platform_user_id) constraint.
export const PINTEREST_PRODUCTION_PUID = 'owner-prod';

// The Phase A sandbox-proof sentinel that production connection retires.
export const PINTEREST_SANDBOX_SENTINEL_PUID = 'phase-a-sandbox-proof';

// Fail-closed guard: throws unless `urlStr` is HTTPS AND its host is exactly the
// production host. Mirrors assertSandboxUrl but locked to production. Rejects http
// downgrades, the sandbox host, look-alike/subdomain-spoof hosts, and malformed
// URLs. Call before every production token/API fetch.
export function assertProductionUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error('Pinterest production: refused malformed API URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Pinterest production: refused non-HTTPS target (${url.protocol})`);
  }
  if (url.host !== PINTEREST_PRODUCTION_HOST) {
    throw new Error(`Pinterest production: refused non-production host (${url.host})`);
  }
  return true;
}

// Pure precondition: is a production token response usable for a durable Phase B
// connection? Requires BOTH a non-empty access token AND a non-empty rotating
// refresh token. Unlike Phase A (which stored a NULL refresh token), production
// MUST persist a refresh token — without it the account cannot survive the 30-day
// access-token expiry, so we treat a missing/blank refresh token as not-connected.
export function productionTokenIsUsable(tokenData) {
  return (
    !!tokenData &&
    typeof tokenData.access_token === 'string' &&
    tokenData.access_token.length > 0 &&
    typeof tokenData.refresh_token === 'string' &&
    tokenData.refresh_token.length > 0
  );
}

// Pure: given a token response and connection context, produce the plan the route
// executes atomically. When the token is not usable, returns {ok:false, reason} and
// NO row — the caller must perform zero DB mutation (the sandbox sentinel is NOT
// removed). When usable, returns {ok:true, row, deleteSentinelPuid} describing the
// owner-prod upsert plus the sentinel to retire in the SAME transaction.
//
// ctx: { userId, accountId, nowSec }
export function planProductionConnect(tokenData, ctx) {
  if (!productionTokenIsUsable(tokenData)) {
    return { ok: false, reason: 'missing_refresh_token' };
  }
  const expiresAt = Number.isFinite(tokenData.expires_in)
    ? ctx.nowSec + tokenData.expires_in
    : null;
  return {
    ok: true,
    row: {
      id: ctx.accountId,
      user_id: ctx.userId,
      platform: 'pinterest',
      platform_user_id: PINTEREST_PRODUCTION_PUID,
      // No Pinterest profile identity is fetched or stored in B0 (no
      // user_accounts scope); display_name/avatar stay null by design.
      display_name: null,
      avatar_url: null,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: expiresAt,
      created_at: ctx.nowSec,
    },
    deleteSentinelPuid: PINTEREST_SANDBOX_SENTINEL_PUID,
  };
}
