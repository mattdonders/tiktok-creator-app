// Unit tests for the sanitized Pinterest connection-status GET surface (Phase B, slice B4).
// The status logic is covered against an in-memory D1 fake; the route's auth rules and
// non-leakage are covered by static inspection of the handler (the Hono app is not
// importable under node --test). No live Pinterest/D1 call is ever made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadPinterestConnectionStatus } from '../lib/pinterest-connection.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_700_000_000;

// Minimal fake: one connected_accounts row (or none). Records that only the owner-prod
// row is queried.
class FakeDB {
  constructor(row) { this.row = row ? { ...row } : null; this.boundPuid = null; }
  prepare(sql) {
    const db = this;
    assert.ok(/FROM connected_accounts/.test(sql), 'must query connected_accounts');
    assert.ok(/platform = 'pinterest'/.test(sql), 'must scope to pinterest');
    const stmt = { _args: [], bind(...a) { return { ...stmt, _args: a }; }, async first() { db.boundPuid = this._args[0]; return db.row ? { ...db.row } : null; } };
    return stmt;
  }
}

const ALLOWED_KEYS = new Set([
  'ok', 'connected', 'platform', 'platform_user_id', 'token_expires_at',
  'token_expired', 'seconds_until_expiry', 'access_token_present', 'refresh_token_present',
]);

function assertShape(res) {
  for (const k of Object.keys(res)) assert.ok(ALLOWED_KEYS.has(k), `unexpected field leaked: ${k}`);
  // Never surface any token material or client credential, even as a substring.
  const json = JSON.stringify(res);
  // Anchor each as a quoted JSON key so we catch a leaked raw column without colliding
  // with the legitimate `platform_user_id` field (governed by ALLOWED_KEYS above).
  for (const forbidden of ['access_token"', 'refresh_token"', '"user_id"', '"created_at"', '"display_name"', '"client_secret"', '"client_id"']) {
    assert.equal(json.includes(forbidden), false, `must not leak ${forbidden}`);
  }
}

// ─── disconnected ────────────────────────────────────────────────────────────

test('no owner-prod row → sanitized disconnected state (never a raw 404 / DB error)', async () => {
  const db = new FakeDB(null);
  const res = await loadPinterestConnectionStatus(db, NOW);
  assert.deepEqual(res, {
    ok: true, connected: false, platform: 'pinterest', platform_user_id: null,
    token_expires_at: null, token_expired: null, seconds_until_expiry: null,
    access_token_present: false, refresh_token_present: false,
  });
  assert.equal(db.boundPuid, 'owner-prod');   // queried the production account only
  assertShape(res);
});

// ─── connected ───────────────────────────────────────────────────────────────

test('connected owner-prod with a fresh token → connected + presence booleans + expiry math', async () => {
  const db = new FakeDB({ platform_user_id: 'owner-prod', access_token: 'pina_SECRET', refresh_token: 'pinr_SECRET', token_expires_at: NOW + 1000 });
  const res = await loadPinterestConnectionStatus(db, NOW);
  assert.equal(res.connected, true);
  assert.equal(res.platform_user_id, 'owner-prod');
  assert.equal(res.token_expires_at, NOW + 1000);
  assert.equal(res.token_expired, false);
  assert.equal(res.seconds_until_expiry, 1000);
  assert.equal(res.access_token_present, true);
  assert.equal(res.refresh_token_present, true);
  assertShape(res);
});

test('token VALUES are never exposed (only booleans + expiry)', async () => {
  const db = new FakeDB({ platform_user_id: 'owner-prod', access_token: 'pina_LEAKME', refresh_token: 'pinr_LEAKME', token_expires_at: NOW + 5 });
  const res = await loadPinterestConnectionStatus(db, NOW);
  const json = JSON.stringify(res);
  assert.equal(json.includes('pina_LEAKME'), false);
  assert.equal(json.includes('pinr_LEAKME'), false);
  assert.equal(json.includes('LEAKME'), false);
  assertShape(res);
});

test('expired token → token_expired true and negative seconds_until_expiry', async () => {
  const db = new FakeDB({ platform_user_id: 'owner-prod', access_token: 'pina_x', refresh_token: 'pinr_x', token_expires_at: NOW - 10 });
  const res = await loadPinterestConnectionStatus(db, NOW);
  assert.equal(res.token_expired, true);
  assert.equal(res.seconds_until_expiry, -10);
});

test('null token_expires_at → expiry fields null, not a crash', async () => {
  const db = new FakeDB({ platform_user_id: 'owner-prod', access_token: 'pina_x', refresh_token: null, token_expires_at: null });
  const res = await loadPinterestConnectionStatus(db, NOW);
  assert.equal(res.token_expires_at, null);
  assert.equal(res.token_expired, null);
  assert.equal(res.seconds_until_expiry, null);
  assert.equal(res.refresh_token_present, false);   // null refresh → absent
  assert.equal(res.access_token_present, true);
});

test('empty access_token → connected:false and access_token_present:false', async () => {
  const db = new FakeDB({ platform_user_id: 'owner-prod', access_token: '', refresh_token: 'pinr_x', token_expires_at: NOW + 100 });
  const res = await loadPinterestConnectionStatus(db, NOW);
  assert.equal(res.connected, false);
  assert.equal(res.access_token_present, false);
  assert.equal(res.refresh_token_present, true);
});

// ─── static route auth + non-leakage ─────────────────────────────────────────

test('connection route exists, uses the SAME read-auth as GET /jobs, and no weaker path', () => {
  const route = readFileSync(join(ROOT, 'functions', '[[route]].js'), 'utf8');
  const idx = route.indexOf("'/api/internal/pinterest/connection'");
  assert.ok(idx > 0, 'connection route must exist');
  const handler = route.slice(idx, idx + 500);
  // internal token OR owner session, else 401 — identical guard to the existing jobs GET.
  assert.ok(/hasInternalToken\(c\)/.test(handler), 'must accept internal token');
  assert.ok(/ownerSession\(c\)/.test(handler), 'must accept owner session');
  assert.ok(/401/.test(handler), 'must 401 when neither auth holds');
  assert.match(handler, /if \(!\(await hasInternalToken\(c\)\) && !\(await ownerSession\(c\)\)\) return c\.json\(\{ ok: false, error: 'unauthorized' \}, 401\);/);
  // Must NOT be reachable via a generalized cp_ API key, and must delegate to the
  // sanitized loader rather than hand-building a row.
  assert.equal(/apiKeyAuth|requireApiKey|Bearer cp_/.test(handler), false);
  assert.ok(/loadPinterestConnectionStatus\(c\.env\.DB, now\(\)\)/.test(handler), 'must use the sanitized loader');
});

test('the GET /jobs read surface remains sanitized (no tokens, image keys, or Pinterest ids)', () => {
  const manifest = readFileSync(join(ROOT, 'lib', 'pinterest-manifest.js'), 'utf8');
  const m = manifest.match(/export async function listJobs[\s\S]*?ORDER BY publish_at/);
  assert.ok(m, 'listJobs must exist');
  const select = m[0];
  for (const forbidden of ['access_token', 'refresh_token', 'image_key', 'content_hash', 'pin_id', 'board_id']) {
    assert.equal(select.includes(forbidden), false, `GET /jobs must not select ${forbidden}`);
  }
  assert.ok(select.includes('board_alias'), 'exposes local board_alias, not a Pinterest board id');
});
