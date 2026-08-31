// TikTok token refresh lifecycle. This module is intentionally separate from the
// analytics endpoint: analytics never refreshes a token or writes D1. The existing
// authenticated cron is the sole caller.
//
// SECURITY:
// - exactly one network attempt per account (no ambiguous blind retry)
// - no provider response body, access token, refresh token, or client secret is logged
// - a compare-and-swap update prevents a stale worker from overwriting a newer token

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_REFRESH_THRESHOLD_SECONDS = 24 * 60 * 60;

export function tokenNeedsRefresh(tokenExpiresAt, nowSec) {
  return typeof tokenExpiresAt === 'number'
    && tokenExpiresAt < nowSec + TIKTOK_REFRESH_THRESHOLD_SECONDS;
}

async function refreshTokenOnce(fetchImpl, env, refreshToken) {
  if (!env.TIKTOK_CLIENT_ID || !env.TIKTOK_CLIENT_SECRET) {
    return { outcome: 'reconnect_required' };
  }
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_ID,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  let response;
  try {
    response = await fetchImpl(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    return { outcome: 'reconnect_required' };
  }
  if (response.status !== 200) return { outcome: 'reconnect_required' };

  let data;
  try { data = await response.json(); } catch { data = null; }
  const valid = data
    && typeof data.access_token === 'string' && data.access_token.length > 0
    && typeof data.refresh_token === 'string' && data.refresh_token.length > 0;
  return valid ? { outcome: 'refreshed', data } : { outcome: 'reconnect_required' };
}

export async function refreshTikTokAccountToken({ DB, env, nowSec, fetchImpl = fetch }, account) {
  const observedRefreshToken = account?.refresh_token;
  if (!account?.id || typeof observedRefreshToken !== 'string' || !observedRefreshToken) {
    return { result: 'reconnect_required' };
  }

  const attempt = await refreshTokenOnce(fetchImpl, env, observedRefreshToken);
  if (attempt.outcome === 'refreshed') {
    const expiresAt = Number.isFinite(attempt.data.expires_in)
      ? nowSec + attempt.data.expires_in
      : null;
    const update = await DB.prepare(
      `UPDATE connected_accounts
          SET access_token = ?, refresh_token = ?, token_expires_at = ?
        WHERE id = ? AND refresh_token = ?`,
    ).bind(
      attempt.data.access_token,
      attempt.data.refresh_token,
      expiresAt,
      account.id,
      observedRefreshToken,
    ).run();
    const changes = update?.meta?.changes ?? update?.changes ?? 0;
    return changes > 0 ? { result: 'refreshed' } : { result: 'superseded' };
  }

  // A concurrent worker may already have rotated the token. Re-read before
  // declaring reconnect_required so the loser does not create a false failure.
  const current = await DB.prepare(
    'SELECT refresh_token FROM connected_accounts WHERE id = ?',
  ).bind(account.id).first();
  if (current?.refresh_token && current.refresh_token !== observedRefreshToken) {
    return { result: 'superseded' };
  }
  return { result: 'reconnect_required' };
}

// Preserves the incumbent cron contract: return only the number successfully
// refreshed. Individual failures are sanitized and never throw or log credentials.
export async function refreshExpiredTikTokTokens({ DB, env, nowSec, fetchImpl = fetch }) {
  const threshold = nowSec + TIKTOK_REFRESH_THRESHOLD_SECONDS;
  const { results = [] } = await DB.prepare(
    `SELECT id, refresh_token, token_expires_at FROM connected_accounts
      WHERE platform = 'tiktok' AND refresh_token IS NOT NULL
        AND token_expires_at IS NOT NULL AND token_expires_at < ?`,
  ).bind(threshold).all();

  let refreshed = 0;
  for (const account of results) {
    try {
      const outcome = await refreshTikTokAccountToken(
        { DB, env, nowSec, fetchImpl },
        account,
      );
      if (outcome.result === 'refreshed') refreshed += 1;
    } catch {
      // Fail closed and continue other accounts. The cron summary exposes only a
      // count; no raw exception or credential-bearing provider body is emitted.
    }
  }
  return refreshed;
}
