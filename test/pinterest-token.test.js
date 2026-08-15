// Unit tests for Pinterest production token lifecycle (Phase B, slice B3).
// Zero live OAuth/Pinterest network — fetch is a fake. Proves rotating-refresh
// persistence, shared proactive/publish-time refresh, no-blind-retry ambiguity handling,
// and concurrency safety (at most one writer commits a rotation for a given token).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenNeedsRefresh,
  classifyRefreshOutcome,
  refreshPinterestProductionToken,
  ensurePinterestTokenFresh,
  refreshExpiredPinterestTokens,
  loadPinterestProductionAccount,
  PROACTIVE_REFRESH_THRESHOLD_SECONDS,
  PUBLISH_SAFETY_THRESHOLD_SECONDS,
} from '../lib/pinterest-token.js';

const NOW = 1_700_000_000;

// ─── Fake connected_accounts D1 ──────────────────────────────────────────────

class FakeAccountsDB {
  constructor(row) { this.row = row ? { ...row } : null; this.writes = 0; }
  prepare(sql) {
    const db = this;
    const stmt = {
      _sql: sql, _args: [],
      bind(...a) { return { ...stmt, _args: a }; },
      async first() { return db._exec(this._sql, this._args, 'first'); },
      async run() { return db._exec(this._sql, this._args, 'run'); },
      async all() { return db._exec(this._sql, this._args, 'all'); },
    };
    return stmt;
  }
  _exec(sql, args) {
    if (sql.includes('SELECT id, access_token, refresh_token, token_expires_at')) {
      return this.row ? { ...this.row } : null;
    }
    if (sql.startsWith('SELECT refresh_token FROM connected_accounts')) {
      return this.row ? { refresh_token: this.row.refresh_token } : null;
    }
    if (sql.includes('UPDATE connected_accounts') && sql.includes('SET access_token')) {
      const [access, refresh, expires, id, whereRefresh] = args;
      if (this.row && this.row.id === id && this.row.refresh_token === whereRefresh) {
        this.row.access_token = access; this.row.refresh_token = refresh; this.row.token_expires_at = expires;
        this.writes++;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    throw new Error('FakeAccountsDB: unrecognized SQL: ' + sql);
  }
}

const ENV = { PINTEREST_CLIENT_ID: 'cid', PINTEREST_CLIENT_SECRET: 'csecret' };
function account(over = {}) {
  return { id: 'acct-prod', access_token: 'pina_old', refresh_token: 'pinr_old', token_expires_at: NOW + 5 * 86400, ...over };
}
// A fetch that returns a rotating token; records that no token value is logged by us.
function okRefreshFetch(newAccess = 'pina_new', newRefresh = 'pinr_new', expiresIn = 2592000) {
  return async () => ({ status: 200, async json() { return { access_token: newAccess, refresh_token: newRefresh, expires_in: expiresIn }; } });
}

// ─── pure helpers ────────────────────────────────────────────────────────────

test('tokenNeedsRefresh: within threshold true, healthy false, null unknown false', () => {
  assert.equal(tokenNeedsRefresh(NOW + 3 * 86400, NOW, PROACTIVE_REFRESH_THRESHOLD_SECONDS), true);
  assert.equal(tokenNeedsRefresh(NOW + 20 * 86400, NOW, PROACTIVE_REFRESH_THRESHOLD_SECONDS), false);
  assert.equal(tokenNeedsRefresh(null, NOW, PROACTIVE_REFRESH_THRESHOLD_SECONDS), false);
});

test('classifyRefreshOutcome: 200+tokens refreshed; 4xx/5xx/network → reconnect (no retry)', () => {
  assert.deepEqual(classifyRefreshOutcome({ kind: 'response', status: 200, hasTokens: true }), { result: 'refreshed' });
  assert.equal(classifyRefreshOutcome({ kind: 'response', status: 400, hasTokens: false }).result, 'reconnect');
  assert.equal(classifyRefreshOutcome({ kind: 'response', status: 503, hasTokens: false }).result, 'reconnect');
  assert.equal(classifyRefreshOutcome({ kind: 'network_error' }).result, 'reconnect');
});

// ─── healthy vs refresh gating ───────────────────────────────────────────────

test('ensurePinterestTokenFresh: healthy token is NOT refreshed', async () => {
  const db = new FakeAccountsDB(account({ token_expires_at: NOW + 25 * 86400 }));
  let fetched = false;
  const res = await ensurePinterestTokenFresh(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: async () => { fetched = true; return { status: 200, async json() { return {}; } }; } },
    account({ token_expires_at: NOW + 25 * 86400 }), PUBLISH_SAFETY_THRESHOLD_SECONDS,
  );
  assert.equal(res.result, 'healthy');
  assert.equal(fetched, false);
  assert.equal(db.writes, 0);
});

test('ensurePinterestTokenFresh: near-expiry token IS refreshed and BOTH tokens rotate + expiry updates', async () => {
  const db = new FakeAccountsDB(account({ token_expires_at: NOW + 30 * 60 })); // 30 min left
  const res = await ensurePinterestTokenFresh(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: okRefreshFetch('pina_new', 'pinr_new', 2592000) },
    db.row, PUBLISH_SAFETY_THRESHOLD_SECONDS,
  );
  assert.equal(res.result, 'refreshed');
  assert.equal(db.row.access_token, 'pina_new');
  assert.equal(db.row.refresh_token, 'pinr_new');   // rotating refresh token persisted
  assert.equal(db.row.token_expires_at, NOW + 2592000);
});

test('expired token → refresh happens via the same path before any publish', async () => {
  const db = new FakeAccountsDB(account({ token_expires_at: NOW - 10 })); // already expired
  const res = await ensurePinterestTokenFresh(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: okRefreshFetch() },
    db.row, PUBLISH_SAFETY_THRESHOLD_SECONDS,
  );
  assert.equal(res.result, 'refreshed');
  assert.equal(db.row.refresh_token, 'pinr_new');
});

test('proactive path and publish-time path use the SAME refresh implementation', async () => {
  // Both call ensurePinterestTokenFresh → refreshPinterestProductionToken. Prove that the
  // proactive wrapper produces the identical rotation a direct publish-time refresh does.
  const dbA = new FakeAccountsDB(account({ token_expires_at: NOW + 3 * 86400 }));
  const proactive = await refreshExpiredPinterestTokens({ DB: dbA, env: ENV, nowSec: NOW, fetchImpl: okRefreshFetch('pina_z', 'pinr_z') });
  assert.equal(proactive.status, 'refreshed');
  assert.equal(dbA.row.refresh_token, 'pinr_z');

  const dbB = new FakeAccountsDB(account({ token_expires_at: NOW + 30 * 60 }));
  const publish = await refreshPinterestProductionToken({ DB: dbB, env: ENV, nowSec: NOW, fetchImpl: okRefreshFetch('pina_z', 'pinr_z') }, dbB.row);
  assert.equal(publish.result, 'refreshed');
  assert.equal(dbB.row.refresh_token, 'pinr_z');
});

// ─── failure / ambiguity ─────────────────────────────────────────────────────

test('refresh definite rejection (invalid_grant) → reconnect_required, no token written', async () => {
  const db = new FakeAccountsDB(account({ token_expires_at: NOW + 60 }));
  const res = await refreshPinterestProductionToken(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: async () => ({ status: 400, async json() { return { error: 'invalid_grant' }; } }) },
    db.row,
  );
  assert.equal(res.result, 'reconnect');
  assert.equal(res.error_category, 'reconnect_required');
  assert.equal(db.row.refresh_token, 'pinr_old'); // unchanged
  assert.equal(db.writes, 0);
});

test('refresh network ambiguity → reconnect_required, NO blind retry (exactly one fetch)', async () => {
  const db = new FakeAccountsDB(account({ token_expires_at: NOW + 60 }));
  let calls = 0;
  const res = await refreshPinterestProductionToken(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: async () => { calls++; throw new Error('ECONNRESET'); } },
    db.row,
  );
  assert.equal(res.result, 'reconnect');
  assert.equal(calls, 1);                 // one attempt only
  assert.equal(db.row.refresh_token, 'pinr_old');
});

// ─── concurrency ─────────────────────────────────────────────────────────────

test('two concurrent refreshers sharing one stored token: at most one commits a rotation, loser is non-destructive', async () => {
  // Shared DB. Both read pinr_old. Winner rotates to pinr_A; loser (using the now-consumed
  // pinr_old) is rejected by Pinterest. The CAS guarantees the loser NEVER commits a second
  // rotation and NEVER clobbers the winner's token. The loser lands on either 'superseded'
  // (it re-read after the winner committed) or 'reconnect' (it re-read the still-stale token
  // before the winner's write landed) — both are safe: no data loss, at most one write. A
  // 'reconnect' here is a benign false alarm (the stored token is in fact healthy), which is
  // the lock-free residual documented in the refresh ambiguity policy.
  const db = new FakeAccountsDB(account({ token_expires_at: NOW + 60 }));
  let firstServed = false;
  const fetchImpl = async () => {
    if (!firstServed) { firstServed = true; return { status: 200, async json() { return { access_token: 'pina_A', refresh_token: 'pinr_A', expires_in: 2592000 }; } }; }
    return { status: 400, async json() { return { error: 'invalid_grant' }; } }; // consumed token
  };
  const shared = db.row;
  const [r1, r2] = await Promise.all([
    refreshPinterestProductionToken({ DB: db, env: ENV, nowSec: NOW, fetchImpl }, { ...shared }),
    refreshPinterestProductionToken({ DB: db, env: ENV, nowSec: NOW, fetchImpl }, { ...shared }),
  ]);
  const results = [r1.result, r2.result];
  assert.equal(results.filter((r) => r === 'refreshed').length, 1);          // exactly one rotation committed
  assert.equal(results.filter((r) => r === 'superseded' || r === 'reconnect').length, 1); // loser non-destructive
  assert.equal(db.row.refresh_token, 'pinr_A');           // newest token retained, never clobbered
  assert.equal(db.writes, 1);                             // only one committing write, ever
});

test('losing refresher cannot overwrite newer token state (CAS guards the write)', async () => {
  // The stored token has already advanced to pinr_new by the time a stale caller (holding
  // pinr_old) gets a 200 back. Its CAS write must not commit.
  const db = new FakeAccountsDB(account({ refresh_token: 'pinr_new', token_expires_at: NOW + 60 }));
  const stale = { id: 'acct-prod', refresh_token: 'pinr_old', token_expires_at: NOW + 60 };
  const res = await refreshPinterestProductionToken({ DB: db, env: ENV, nowSec: NOW, fetchImpl: okRefreshFetch('pina_x', 'pinr_x') }, stale);
  assert.equal(res.result, 'superseded');
  assert.equal(db.row.refresh_token, 'pinr_new'); // untouched
  assert.equal(db.writes, 0);
});

// ─── wrapper + logging discipline ────────────────────────────────────────────

test('refreshExpiredPinterestTokens: no account → no_account; reconnect surfaces a sanitized alert', async () => {
  const none = await refreshExpiredPinterestTokens({ DB: new FakeAccountsDB(null), env: ENV, nowSec: NOW, fetchImpl: okRefreshFetch() });
  assert.deepEqual(none, { refreshed: 0, status: 'no_account' });

  const db = new FakeAccountsDB(account({ token_expires_at: NOW + 60 }));
  const res = await refreshExpiredPinterestTokens({ DB: db, env: ENV, nowSec: NOW, fetchImpl: async () => ({ status: 401, async json() { return {}; } }) });
  assert.equal(res.status, 'reconnect_required');
  assert.ok(res.alert && res.alert.event === 'pinterest_token_reconnect_required');
  // Alert carries only local sanitized data — never a token.
  assert.equal(JSON.stringify(res.alert).includes('pinr'), false);
  assert.equal(JSON.stringify(res.alert).includes('pina'), false);
});

test('loadPinterestProductionAccount targets owner-prod only', async () => {
  const db = new FakeAccountsDB(account());
  const row = await loadPinterestProductionAccount(db);
  assert.equal(row.id, 'acct-prod');
});
