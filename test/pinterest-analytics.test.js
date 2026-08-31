// Read-only Pinterest analytics tests. All Pinterest and D1 operations are fakes;
// no test performs network I/O or uses a real token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizePinForAnalytics,
  listBoardPinsWithMetrics,
  loadBoardPinAnalytics,
} from '../lib/pinterest-analytics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_800_000_000;
const ALIASES = { 'moving-new-home-checklist': 'Moving & New Home Checklist' };

class FakeDB {
  constructor(row) { this.row = row; this.bound = null; }
  prepare(sql) {
    const db = this;
    assert.ok(sql.includes('connected_accounts'));
    const stmt = {
      _args: [],
      bind(...args) { return { ...stmt, _args: args }; },
      async first() { db.bound = this._args[0]; return db.row ? { ...db.row } : null; },
    };
    return stmt;
  }
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('sanitizePinForAnalytics keeps campaign identity/metrics and drops media/provider extras', () => {
  const pin = sanitizePinForAnalytics({
    id: '123', created_at: '2026-09-01T16:00:00Z', link: 'https://example.com/?utm_content=mv01',
    title: 'Title', alt_text: 'Alt', ai_disclosures: { values: ['AI_MODIFIED', 7] },
    pin_metrics: { '90d': { impression: 4, bad: 'x' }, lifetime_metrics: { pin_click: 2 } },
    media: { secret: 'not returned' }, board_owner: { username: 'not returned' },
  });
  assert.deepEqual(pin, {
    id: '123', created_at: '2026-09-01T16:00:00Z', link: 'https://example.com/?utm_content=mv01',
    title: 'Title', alt_text: 'Alt', ai_disclosures: ['AI_MODIFIED'],
    pin_metrics: { '90d': { impression: 4 }, lifetime_metrics: { pin_click: 2 } },
  });
  assert.equal('media' in pin, false);
  assert.equal('board_owner' in pin, false);
});

test('listBoardPinsWithMetrics uses GET pagination with pin_metrics=true', async () => {
  const seen = [];
  const fake = async (url, options) => {
    seen.push({ url: new URL(url), options });
    if (seen.length === 1) return response(200, { items: [{ id: '1', pin_metrics: {} }], bookmark: 'next' });
    return response(200, { items: [{ id: '2', pin_metrics: {} }], bookmark: null });
  };
  const pins = await listBoardPinsWithMetrics(fake, 'secret-token', '987');
  assert.equal(pins.length, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url.host, 'api.pinterest.com');
  assert.equal(seen[0].url.pathname, '/v5/boards/987/pins');
  assert.equal(seen[0].url.searchParams.get('pin_metrics'), 'true');
  assert.equal(seen[1].url.searchParams.get('bookmark'), 'next');
  assert.ok(seen.every((call) => call.options.method === undefined));
  assert.ok(seen.every((call) => call.options.headers.Authorization === 'Bearer secret-token'));
});

test('loadBoardPinAnalytics resolves the owned board and returns sanitized pins', async () => {
  const db = new FakeDB({ id: 'a', access_token: 'secret-token', token_expires_at: NOW + 1000 });
  const fake = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v5/boards') {
      return response(200, { items: [{ id: 'b1', name: 'Moving & New Home Checklist' }], bookmark: null });
    }
    if (parsed.pathname === '/v5/boards/b1/pins') {
      return response(200, { items: [{ id: 'p1', link: 'https://example.com/?utm_content=mv01', pin_metrics: { '90d': { impression: 3 } } }], bookmark: null });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const out = await loadBoardPinAnalytics({ DB: db, fetchImpl: fake, aliasMap: ALIASES, nowSec: NOW }, 'moving-new-home-checklist');
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(out.pins[0].id, 'p1');
  assert.equal(out.pins[0].pin_metrics['90d'].impression, 3);
  assert.equal(db.bound, 'owner-prod');
  assert.equal(JSON.stringify(out).includes('secret-token'), false);
});

test('unknown alias and expired connection fail before Pinterest I/O', async () => {
  let calls = 0;
  const fake = async () => { calls++; throw new Error('must not run'); };
  const db = new FakeDB({ id: 'a', access_token: 'secret', token_expires_at: NOW - 1 });
  const unknown = await loadBoardPinAnalytics({ DB: db, fetchImpl: fake, aliasMap: ALIASES, nowSec: NOW }, 'unknown');
  assert.deepEqual(unknown, { ok: false, status: 400, error: 'unknown_board_alias' });
  const expired = await loadBoardPinAnalytics({ DB: db, fetchImpl: fake, aliasMap: ALIASES, nowSec: NOW }, 'moving-new-home-checklist');
  assert.deepEqual(expired, { ok: false, status: 409, error: 'reconnect_required' });
  assert.equal(calls, 0);
});

test('analytics route uses privileged read auth and delegates to the sanitized loader', () => {
  const route = readFileSync(join(ROOT, 'functions', '[[route]].js'), 'utf8');
  const idx = route.indexOf("'/api/internal/pinterest/analytics/pins'");
  assert.ok(idx > 0, 'analytics route must exist');
  const end = route.indexOf('\n});', idx);
  const handler = route.slice(idx, end + 4);
  assert.ok(/hasInternalToken\(c\)/.test(handler));
  assert.ok(/ownerSession\(c\)/.test(handler));
  assert.ok(/loadBoardPinAnalytics/.test(handler));
  assert.equal(/app\.(post|put|patch|delete)/.test(handler), false);
});
