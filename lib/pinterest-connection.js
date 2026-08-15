// Pinterest connection status — sanitized GET-only presentation (Phase B, slice B4).
//
// A tiny read-only view over the single owner-prod row in `connected_accounts`, so the
// production Pinterest connection can be inspected WITHOUT a manual D1 query. It returns
// ONLY locally-owned, non-sensitive operational facts: whether a connection exists, the
// access-token expiry, and boolean presence flags. It NEVER returns a token value (or
// prefix/length), the client id/secret, any Pinterest-derived identity/board/profile data,
// or the raw DB row. No live Pinterest call is ever made here.

import { PINTEREST_PRODUCTION_PUID } from './pinterest-production.js';

// Load the sanitized production connection status. Reads the one owner-prod account row
// (if any) and derives non-sensitive fields. `nowSec` lets the caller compute expiry
// state deterministically. Returns a plain object safe to serialize directly to the API.
export async function loadPinterestConnectionStatus(DB, nowSec = 0) {
  const row = await DB.prepare(
    `SELECT platform_user_id, token_expires_at, access_token, refresh_token
       FROM connected_accounts
      WHERE platform = 'pinterest' AND platform_user_id = ?
      LIMIT 1`,
  ).bind(PINTEREST_PRODUCTION_PUID).first();

  if (!row) {
    // Normal sanitized disconnected state — never a raw 404 / DB error.
    return {
      ok: true,
      connected: false,
      platform: 'pinterest',
      platform_user_id: null,
      token_expires_at: null,
      token_expired: null,
      seconds_until_expiry: null,
      access_token_present: false,
      refresh_token_present: false,
    };
  }

  const expiresAt = typeof row.token_expires_at === 'number' ? row.token_expires_at : null;
  // An access token is required (NOT NULL) for a real connection; treat empty as absent.
  const accessPresent = typeof row.access_token === 'string' && row.access_token.length > 0;
  const refreshPresent = typeof row.refresh_token === 'string' && row.refresh_token.length > 0;

  return {
    ok: true,
    connected: accessPresent,
    platform: 'pinterest',
    platform_user_id: row.platform_user_id ?? null,
    token_expires_at: expiresAt,
    token_expired: expiresAt === null ? null : expiresAt <= nowSec,
    seconds_until_expiry: expiresAt === null ? null : expiresAt - nowSec,
    access_token_present: accessPresent,
    refresh_token_present: refreshPresent,
  };
}
