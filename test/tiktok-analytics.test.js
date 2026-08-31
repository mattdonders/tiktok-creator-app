// Account-scoped TikTok analytics tests. Every D1/TikTok operation is fake;
// no test uses a real token or performs network I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTikTokAccountAnalytics,
  normalizeTikTokAnalyticsQuery,
  sanitizeTikTokVideo,
} from '../lib/tiktok-analytics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_800_000_000;
const ACCOUNT_ID = 'account-qlm';
const USER_ID = 'owner-user';
const TOKEN = 'tt-secret-must-never-leak';

class FakeDB {
  constructor(row) {
    this.row = row ? { ...row } : null;
    this.sql = null;
    this.args = null;
    this.writeAttempted = false;
  }

  prepare(sql) {
    this.sql = sql;
    if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/i.test(sql)) {
      this.writeAttempted = true;
      throw new Error('write SQL is forbidden');
    }
    const db = this;
    const statement = {
      _args: [],
      bind(...args) { return { ...statement, _args: args }; },
      async first() {
        db.args = this._args;
        return db.row ? { ...db.row } : null;
      },
    };
    return statement;
  }
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

function accountRow(overrides = {}) {
  return {
    id: ACCOUNT_ID,
    platform_user_id: 'open-id',
    display_name: 'Quiet Luxe Meals',
    username: 'quietluxemeals',
    access_token: TOKEN,
    token_expires_at: NOW + 3600,
    ...overrides,
  };
}

function successFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    if (url.includes('/user/info/')) {
      return response(200, {
        data: { user: {
          username: 'quietluxemeals', display_name: 'Quiet Luxe Meals',
          follower_count: 50, following_count: 0, likes_count: 1054, video_count: 57,
        } },
        error: { code: 'ok' },
      });
    }
    return response(200, {
      data: {
        videos: [{
          id: '7617528876855528734', create_time: 1_799_990_000,
          video_description: 'caption', view_count: 0, like_count: 4,
          comment_count: 0, share_count: 1, duration: 9, is_aigc: true,
        }],
        has_more: true, cursor: 1_799_989_000,
      },
      error: { code: 'ok' },
    });
  };
}

test('pagination validation is bounded and deterministic', () => {
  assert.deepEqual(normalizeTikTokAnalyticsQuery({}), { ok: true, cursor: null, max_count: 20 });
  assert.deepEqual(normalizeTikTokAnalyticsQuery({ cursor: '123', maxCount: '5' }), { ok: true, cursor: 123, max_count: 5 });
  assert.deepEqual(normalizeTikTokAnalyticsQuery({ maxCount: 21 }), { ok: false, status: 400, error: 'invalid_pagination' });
  assert.deepEqual(normalizeTikTokAnalyticsQuery({ cursor: '-1' }), { ok: false, status: 400, error: 'invalid_pagination' });
});

test('video sanitizer preserves explicit zero and drops non-allowlisted fields', () => {
  const out = sanitizeTikTokVideo({
    id: '7617528876855528734', create_time: 1_799_990_000,
    video_description: 'caption', view_count: 0, like_count: null,
    comment_count: 2, share_count: 0, duration: 0, is_aigc: false,
    access_token: TOKEN, raw_provider_payload: { secret: TOKEN },
  });
  assert.equal(out.video_id, '7617528876855528734');
  assert.equal(out.views, 0);
  assert.equal(out.likes, null);
  assert.equal(out.shares, 0);
  assert.equal(out.duration_seconds, 0);
  assert.equal(out.is_aigc, false);
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
  assert.deepEqual(Object.keys(out), [
    'video_id', 'published_at', 'description', 'views', 'likes', 'comments',
    'shares', 'duration_seconds', 'is_aigc',
  ]);
});

test('owned account returns sanitized account/video analytics with read-only D1', async () => {
  const db = new FakeDB(accountRow());
  const calls = [];
  const out = await loadTikTokAccountAnalytics(
    { DB: db, fetchImpl: successFetch(calls), nowSec: NOW },
    USER_ID,
    ACCOUNT_ID,
    { cursor: 123, maxCount: 5 },
  );

  assert.equal(out.ok, true);
  assert.equal(out.account.account_id, ACCOUNT_ID);
  assert.equal(out.account.followers, 50);
  assert.equal(out.videos[0].video_id, '7617528876855528734');
  assert.equal(out.videos[0].views, 0);
  assert.deepEqual(db.args, [ACCOUNT_ID, USER_ID]);
  assert.match(db.sql, /platform = 'tiktok'/);
  assert.equal(db.writeAttempted, false);
  assert.equal(JSON.stringify(out).includes(TOKEN), false);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/v2/user/info/');
  assert.equal(calls[1].url.pathname, '/v2/video/list/');
  assert.deepEqual(JSON.parse(calls[1].options.body), { max_count: 5, cursor: 123 });
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test('missing or expired account fails before TikTok I/O', async () => {
  let calls = 0;
  const neverFetch = async () => { calls += 1; throw new Error('must not fetch'); };

  const missing = await loadTikTokAccountAnalytics(
    { DB: new FakeDB(null), fetchImpl: neverFetch, nowSec: NOW }, USER_ID, ACCOUNT_ID,
  );
  assert.deepEqual(missing, { ok: false, status: 404, error: 'account_not_found' });

  const expired = await loadTikTokAccountAnalytics(
    { DB: new FakeDB(accountRow({ token_expires_at: NOW })), fetchImpl: neverFetch, nowSec: NOW },
    USER_ID,
    ACCOUNT_ID,
  );
  assert.deepEqual(expired, { ok: false, status: 409, error: 'tiktok_reconnect_required' });
  assert.equal(calls, 0);
});

test('upstream errors are categorized without raw messages or tokens', async () => {
  const db = new FakeDB(accountRow());
  const fake = async () => response(401, {
    error: { code: 'access_token_invalid', message: `bad ${TOKEN}` },
    access_token: TOKEN,
  });
  const out = await loadTikTokAccountAnalytics(
    { DB: db, fetchImpl: fake, nowSec: NOW }, USER_ID, ACCOUNT_ID,
  );
  assert.deepEqual(out, {
    ok: false,
    status: 502,
    error: 'tiktok_user_info_failed',
    upstream_code: 'access_token_invalid',
  });
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
});

test('network failures are sanitized and never include request credentials', async () => {
  const db = new FakeDB(accountRow());
  const fake = async () => { throw new Error(`network failed with ${TOKEN}`); };
  const out = await loadTikTokAccountAnalytics(
    { DB: db, fetchImpl: fake, nowSec: NOW }, USER_ID, ACCOUNT_ID,
  );
  assert.deepEqual(out, {
    ok: false,
    status: 502,
    error: 'tiktok_user_info_failed',
    upstream_code: 'network_error',
  });
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
});

test('route is GET-only, account-owned, read-only, and independent of Sync Posts', () => {
  const route = readFileSync(join(ROOT, 'functions', '[[route]].js'), 'utf8');
  const marker = "'/api/v1/accounts/:account_id/tiktok/analytics'";
  const index = route.indexOf(marker);
  assert.ok(index > 0, 'analytics route must exist');
  const end = route.indexOf('\n});', index);
  const handler = route.slice(index, end + 4);

  assert.match(handler, /getApiKeySession\(c, \{ touch: false \}\)/);
  assert.match(handler, /loadTikTokAccountAnalytics/);
  assert.match(handler, /c\.req\.param\('account_id'\)/);
  assert.equal(/app\.(post|put|patch|delete)/.test(handler), false);
  assert.equal(/\/api\/v1\/sync|\b(?:publish|upload|refresh)\b/i.test(handler), false);
  assert.equal(/access_token|refresh_token/.test(handler), false);

  const authStart = route.indexOf('async function getApiKeySession');
  const authEnd = route.indexOf('\n}', authStart);
  const authHelper = route.slice(authStart, authEnd + 2);
  assert.match(authHelper, /if \(touch\)/);
});
