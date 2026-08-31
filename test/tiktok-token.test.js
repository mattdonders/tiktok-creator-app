import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  refreshExpiredTikTokTokens,
  refreshTikTokAccountToken,
  tokenNeedsRefresh,
} from '../lib/tiktok-token.js';

const NOW = 1_700_000_000;
const ENV = { TIKTOK_CLIENT_ID: 'client', TIKTOK_CLIENT_SECRET: 'secret' };

class FakeDB {
  constructor(rows = []) { this.rows = rows.map((row) => ({ ...row })); this.writes = 0; }
  prepare(sql) {
    const db = this;
    const statement = {
      sql, args: [],
      bind(...args) { return { ...statement, args }; },
      async all() { return db.execute(this.sql, this.args, 'all'); },
      async first() { return db.execute(this.sql, this.args, 'first'); },
      async run() { return db.execute(this.sql, this.args, 'run'); },
    };
    return statement;
  }
  execute(sql, args) {
    if (sql.includes("WHERE platform = 'tiktok'")) {
      const threshold = args[0];
      return { results: this.rows.filter((row) => row.platform === 'tiktok'
        && row.refresh_token && row.token_expires_at != null && row.token_expires_at < threshold) };
    }
    if (sql.startsWith('SELECT refresh_token')) {
      const row = this.rows.find((candidate) => candidate.id === args[0]);
      return row ? { refresh_token: row.refresh_token } : null;
    }
    if (sql.includes('UPDATE connected_accounts')) {
      const [accessToken, refreshToken, expiresAt, id, observed] = args;
      const row = this.rows.find((candidate) => candidate.id === id && candidate.refresh_token === observed);
      if (!row) return { meta: { changes: 0 } };
      Object.assign(row, { access_token: accessToken, refresh_token: refreshToken, token_expires_at: expiresAt });
      this.writes += 1;
      return { meta: { changes: 1 } };
    }
    throw new Error(`unrecognized SQL: ${sql}`);
  }
}

function account(overrides = {}) {
  return {
    id: 'qlm', platform: 'tiktok', access_token: 'old_access',
    refresh_token: 'old_refresh', token_expires_at: NOW + 60,
    ...overrides,
  };
}

function successfulFetch(access = 'new_access', refresh = 'new_refresh') {
  return async () => ({
    status: 200,
    async json() { return { access_token: access, refresh_token: refresh, expires_in: 86400 }; },
  });
}

test('refresh threshold is strictly bounded to the next 24 hours', () => {
  assert.equal(tokenNeedsRefresh(NOW + 60, NOW), true);
  assert.equal(tokenNeedsRefresh(NOW + 2 * 86400, NOW), false);
  assert.equal(tokenNeedsRefresh(null, NOW), false);
});

test('successful refresh rotates both tokens with a compare-and-swap write', async () => {
  const db = new FakeDB([account()]);
  const result = await refreshTikTokAccountToken(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: successfulFetch() },
    { ...db.rows[0] },
  );
  assert.deepEqual(result, { result: 'refreshed' });
  assert.equal(db.rows[0].access_token, 'new_access');
  assert.equal(db.rows[0].refresh_token, 'new_refresh');
  assert.equal(db.rows[0].token_expires_at, NOW + 86400);
  assert.equal(db.writes, 1);
});

test('stale refresher cannot overwrite a newer stored token', async () => {
  const db = new FakeDB([account({ refresh_token: 'already_new' })]);
  const stale = account({ refresh_token: 'old_refresh' });
  const result = await refreshTikTokAccountToken(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: successfulFetch('stale_access', 'stale_refresh') },
    stale,
  );
  assert.deepEqual(result, { result: 'superseded' });
  assert.equal(db.rows[0].refresh_token, 'already_new');
  assert.equal(db.writes, 0);
});

test('network and provider failures are single-attempt, sanitized, and non-writing', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('credential-bearing-message'); },
    async () => ({ status: 401, async json() { return { error: 'raw-provider-body' }; } }),
  ]) {
    const db = new FakeDB([account()]);
    let calls = 0;
    const result = await refreshTikTokAccountToken(
      { DB: db, env: ENV, nowSec: NOW, fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); } },
      { ...db.rows[0] },
    );
    assert.deepEqual(result, { result: 'reconnect_required' });
    assert.equal(calls, 1);
    assert.equal(db.writes, 0);
    assert.equal(JSON.stringify(result).includes('credential-bearing-message'), false);
    assert.equal(JSON.stringify(result).includes('raw-provider-body'), false);
  }
});

test('expired-token wrapper preserves the cron count contract and ignores healthy accounts', async () => {
  const db = new FakeDB([
    account(),
    account({ id: 'healthy', token_expires_at: NOW + 2 * 86400 }),
    account({ id: 'other', platform: 'instagram' }),
  ]);
  const refreshed = await refreshExpiredTikTokTokens(
    { DB: db, env: ENV, nowSec: NOW, fetchImpl: successfulFetch() },
  );
  assert.equal(refreshed, 1);
  assert.equal(db.writes, 1);
  assert.equal(db.rows.find((row) => row.id === 'healthy').refresh_token, 'old_refresh');
});

test('route wiring uses the hardened module and contains no raw TikTok refresh error logging', async () => {
  const fs = await import('node:fs/promises');
  const route = await fs.readFile(new URL('../functions/[[route]].js', import.meta.url), 'utf8');
  assert.match(route, /refreshExpiredTikTokTokens\(\{ DB: c\.env\.DB, env: c\.env, nowSec: now\(\) \}\)/);
  assert.doesNotMatch(route, /TikTok refresh error/);
  assert.doesNotMatch(route, /TikTok token refresh failed/);
});
