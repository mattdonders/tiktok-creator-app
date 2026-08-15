// Unit tests for Pinterest PRODUCTION OAuth support (Phase B, slice B0).
// Pure-function coverage: production URL guard, cross-environment separation, and
// the persistence PLAN the production callback executes (owner-prod upsert +
// sentinel retirement). No network, no D1 — same node:test framework as the
// sandbox suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertProductionUrl,
  productionTokenIsUsable,
  planProductionConnect,
  PINTEREST_PRODUCTION_HOST,
  PINTEREST_PRODUCTION_PUID,
  PINTEREST_SANDBOX_SENTINEL_PUID,
} from '../lib/pinterest-production.js';

import { assertSandboxUrl, PINTEREST_SANDBOX_HOST } from '../lib/pinterest-sandbox.js';

// ---------------------------------------------------------------------------
// assertProductionUrl — fail-closed host lock
// ---------------------------------------------------------------------------

test('assertProductionUrl allows the production token endpoint', () => {
  assert.equal(assertProductionUrl('https://api.pinterest.com/v5/oauth/token'), true);
});

test('assertProductionUrl allows the production API base', () => {
  assert.equal(assertProductionUrl('https://api.pinterest.com/v5/pins'), true);
});

test('assertProductionUrl refuses the SANDBOX host (environment separation)', () => {
  assert.throws(
    () => assertProductionUrl('https://api-sandbox.pinterest.com/v5/oauth/token'),
    /non-production host/,
  );
});

test('assertProductionUrl refuses http downgrade', () => {
  assert.throws(
    () => assertProductionUrl('http://api.pinterest.com/v5/oauth/token'),
    /non-HTTPS/,
  );
});

test('assertProductionUrl refuses look-alike suffix host', () => {
  assert.throws(
    () => assertProductionUrl('https://api.pinterest.com.evil.example/v5/oauth/token'),
    /non-production host/,
  );
});

test('assertProductionUrl refuses subdomain-spoof host', () => {
  assert.throws(
    () => assertProductionUrl('https://api.pinterest.com.attacker.test/v5/oauth/token'),
    /non-production host/,
  );
});

test('assertProductionUrl refuses an unrelated host', () => {
  assert.throws(() => assertProductionUrl('https://example.com/v5/oauth/token'), /non-production host/);
});

test('assertProductionUrl refuses a malformed URL', () => {
  assert.throws(() => assertProductionUrl('not a url'), /malformed/);
});

// ---------------------------------------------------------------------------
// Cross-environment separation: each guard rejects the other's host.
// ---------------------------------------------------------------------------

test('production and sandbox guards each fail closed against the other host', () => {
  // production guard rejects sandbox host
  assert.throws(() => assertProductionUrl(`https://${PINTEREST_SANDBOX_HOST}/v5/oauth/token`));
  // sandbox guard rejects production host
  assert.throws(() => assertSandboxUrl(`https://${PINTEREST_PRODUCTION_HOST}/v5/oauth/token`));
  assert.notEqual(PINTEREST_PRODUCTION_HOST, PINTEREST_SANDBOX_HOST);
});

// ---------------------------------------------------------------------------
// productionTokenIsUsable — refresh token is REQUIRED
// ---------------------------------------------------------------------------

test('productionTokenIsUsable true only with both access and refresh tokens', () => {
  assert.equal(
    productionTokenIsUsable({ access_token: 'pina_x', refresh_token: 'pinr_y', expires_in: 2592000 }),
    true,
  );
});

test('productionTokenIsUsable false when refresh token missing', () => {
  assert.equal(productionTokenIsUsable({ access_token: 'pina_x', expires_in: 2592000 }), false);
});

test('productionTokenIsUsable false when refresh token blank', () => {
  assert.equal(productionTokenIsUsable({ access_token: 'pina_x', refresh_token: '' }), false);
});

test('productionTokenIsUsable false when access token missing', () => {
  assert.equal(productionTokenIsUsable({ refresh_token: 'pinr_y' }), false);
});

test('productionTokenIsUsable false on null/undefined', () => {
  assert.equal(productionTokenIsUsable(null), false);
  assert.equal(productionTokenIsUsable(undefined), false);
});

// ---------------------------------------------------------------------------
// planProductionConnect — the persistence plan the callback executes
// ---------------------------------------------------------------------------

const CTX = { userId: 'user-1', accountId: 'acct-1', nowSec: 1_000_000 };

test('planProductionConnect writes an owner-prod row with a non-null refresh token', () => {
  const plan = planProductionConnect(
    { access_token: 'pina_access', refresh_token: 'pinr_refresh', expires_in: 2592000 },
    CTX,
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.row.platform, 'pinterest');
  assert.equal(plan.row.platform_user_id, PINTEREST_PRODUCTION_PUID);
  assert.equal(plan.row.platform_user_id, 'owner-prod');
  assert.equal(plan.row.access_token, 'pina_access');
  assert.equal(plan.row.refresh_token, 'pinr_refresh');
  assert.ok(plan.row.refresh_token, 'refresh token must be persisted (non-null)');
  // expiry computed from now + expires_in
  assert.equal(plan.row.token_expires_at, 1_000_000 + 2592000);
  // no Pinterest profile identity persisted in B0
  assert.equal(plan.row.display_name, null);
  assert.equal(plan.row.avatar_url, null);
});

test('planProductionConnect retires ONLY the sandbox sentinel', () => {
  const plan = planProductionConnect(
    { access_token: 'pina_access', refresh_token: 'pinr_refresh', expires_in: 2592000 },
    CTX,
  );
  assert.equal(plan.deleteSentinelPuid, PINTEREST_SANDBOX_SENTINEL_PUID);
  assert.equal(plan.deleteSentinelPuid, 'phase-a-sandbox-proof');
});

test('planProductionConnect sets null expiry when expires_in absent', () => {
  const plan = planProductionConnect({ access_token: 'pina_access', refresh_token: 'pinr_refresh' }, CTX);
  assert.equal(plan.ok, true);
  assert.equal(plan.row.token_expires_at, null);
});

test('planProductionConnect refuses to connect when refresh token missing (no mutation)', () => {
  const plan = planProductionConnect({ access_token: 'pina_access', expires_in: 2592000 }, CTX);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'missing_refresh_token');
  assert.equal(plan.row, undefined, 'no row => caller performs no upsert');
  assert.equal(plan.deleteSentinelPuid, undefined, 'no delete => sandbox sentinel preserved');
});

test('planProductionConnect is deterministic for the same owner (safe repeated upsert)', () => {
  const token = { access_token: 'pina_access', refresh_token: 'pinr_refresh', expires_in: 2592000 };
  const a = planProductionConnect(token, CTX);
  const b = planProductionConnect(token, CTX);
  // Same stable owner-prod target => a retry hits the same UNIQUE row and upserts
  // rather than duplicating.
  assert.equal(a.row.platform_user_id, b.row.platform_user_id);
  assert.equal(a.row.platform_user_id, 'owner-prod');
});
