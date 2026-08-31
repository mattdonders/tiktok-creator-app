// Unit tests for the Pinterest single-Pin publishing engine (Phase B, slice B1).
// All Pinterest network I/O is injected/mocked; no live call is ever made. The D1
// layer is a small in-memory fake that faithfully models the atomic conditional
// claim/finalize statements the engine issues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  validateSinglePinJob,
  buildCreatePinPayload,
  classifyCreatePinOutcome,
  canClaim,
  isStaleLease,
  computeContentHash,
  claimJob,
  createPinOnce,
  listBoards,
  executeApprovedJob,
  insertApprovedPinJob,
  stagePinImageToR2,
  PINTEREST_JOB_STATES,
} from '../lib/pinterest-publish.js';
import {
  PINTEREST_BOARD_ALIASES,
  resolveBoardMatch,
  BOARD_UNKNOWN_ALIAS,
  BOARD_UNRESOLVED_ZERO,
  BOARD_UNRESOLVED_MULTI,
} from '../lib/pinterest-boards.js';

const ALIASES = { 'home-maintenance': 'Home Maintenance Troubleshooting' };

test('production alias maps Beginner Food Gardening to the exact owner-created board name', () => {
  assert.equal(PINTEREST_BOARD_ALIASES['beginner-food-gardening'], 'Beginner Food Gardening');
  assert.deepEqual(
    resolveBoardMatch('beginner-food-gardening', [{ id: 'garden-1', name: 'Beginner Food Gardening' }]),
    { ok: true, boardId: 'garden-1' },
  );
});

// ─── In-memory fake D1 (models the exact statements the engine issues) ───────

const INSERT_COLS = [
  'id', 'external_job_id', 'source', 'manifest_id', 'content_hash', 'user_id',
  'account_id', 'board_alias', 'title', 'description', 'link', 'alt_text',
  'image_key', 'ai_disclosure', 'publish_at', 'approved_at', 'created_at',
];

class FakeDB {
  constructor() {
    this.jobs = new Map();
    this.accounts = new Map();
    this.pinsInserted = [];
  }
  seedJob(job) { this.jobs.set(job.id, { attempt_count: 0, claimed_at: null, published_at: null, error_category: null, ...job }); }
  seedAccount(acct) { this.accounts.set(acct.id, acct); }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async first() { return db._run(sql, args); },
          async run() { return db._run(sql, args); },
        };
      },
    };
  }

  _run(sql, args) {
    // Atomic claim
    if (sql.includes("SET state = 'publishing'")) {
      const [nowSec, id] = args;
      const job = this.jobs.get(id);
      if (job && job.state === 'approved' && job.publish_at <= nowSec) {
        job.state = 'publishing';
        job.claimed_at = nowSec;
        job.attempt_count += 1;
        return { ...job };
      }
      return null;
    }
    if (sql.includes("SET state = 'published'")) {
      const [nowSec, id] = args;
      const job = this.jobs.get(id);
      if (job && job.state === 'publishing') { job.state = 'published'; job.published_at = nowSec; job.claimed_at = null; job.error_category = null; }
      return null;
    }
    if (sql.includes("SET state = 'needs_review'")) {
      const [cat, id] = args;
      const job = this.jobs.get(id);
      if (job && job.state === 'publishing') { job.state = 'needs_review'; job.error_category = cat; job.claimed_at = null; }
      return null;
    }
    if (sql.includes("SET state = 'approved'")) {
      const [id] = args;
      const job = this.jobs.get(id);
      if (job && job.state === 'publishing') { job.state = 'approved'; job.claimed_at = null; }
      return null;
    }
    if (sql.includes('FROM connected_accounts')) {
      const [id] = args;
      return this.accounts.get(id) ?? null;
    }
    if (sql.startsWith('INSERT INTO pinterest_publish_jobs')) {
      const row = {};
      INSERT_COLS.forEach((c, i) => { row[c] = args[i]; });
      row.state = 'approved';
      row.attempt_count = 0;
      // UNIQUE(source, external_job_id)
      for (const j of this.jobs.values()) {
        if (j.source === row.source && j.external_job_id === row.external_job_id) {
          throw new Error('UNIQUE constraint failed: pinterest_publish_jobs.source, pinterest_publish_jobs.external_job_id');
        }
      }
      this.jobs.set(row.id, row);
      return null;
    }
    throw new Error('FakeDB: unrecognized SQL: ' + sql);
  }
}

// Fake fetch: routes by URL to a board-list responder and a pin responder, counting
// calls. Never touches the network.
function makeFetch({ boards = [], pinStatus = 201, pinBody = { id: '999' }, pinThrows = false } = {}) {
  const calls = { boards: 0, pins: 0 };
  const fn = async (url) => {
    if (url.includes('/boards')) {
      calls.boards += 1;
      return { ok: true, status: 200, async json() { return { items: boards, bookmark: null }; } };
    }
    if (url.includes('/pins')) {
      calls.pins += 1;
      if (pinThrows) throw new Error('network reset');
      return { ok: pinStatus >= 200 && pinStatus < 300, status: pinStatus, async json() { return pinBody; } };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  fn.calls = calls;
  return fn;
}

function baseJob(over = {}) {
  return {
    id: 'job1', external_job_id: 'ext1', source: 'hm-cohort-2', manifest_id: 'man1',
    content_hash: 'hash1', user_id: 'user1', account_id: 'acct1',
    board_alias: 'home-maintenance', title: 'T', description: 'D', link: 'https://ex.com',
    alt_text: 'A', image_key: 'pinterest-jobs/job1.png', ai_disclosure: null,
    publish_at: 1000, approved_at: 1000, state: 'approved', created_at: 1000, ...over,
  };
}

function envWith(bucket) { return { R2_PUBLIC_URL: 'https://cdn.example.com', MEDIA_BUCKET: bucket }; }

// ─── validateSinglePinJob ────────────────────────────────────────────────────

test('validateSinglePinJob accepts a valid approved job', () => {
  assert.deepEqual(validateSinglePinJob(baseJob()), { ok: true });
});

test('validateSinglePinJob rejects over-long title and bad ai_disclosure', () => {
  const r = validateSinglePinJob(baseJob({ title: 'x'.repeat(101), ai_disclosure: 'AI_GENERATED' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'title'));
  assert.ok(r.errors.some((e) => e.field === 'ai_disclosure'));
});

test('validateSinglePinJob rejects missing required fields and bad publish_at', () => {
  const r = validateSinglePinJob({ title: 'ok', publish_at: 'soon' });
  assert.equal(r.ok, false);
  for (const f of ['external_job_id', 'source', 'board_alias', 'publish_at']) {
    assert.ok(r.errors.some((e) => e.field === f), `expected error for ${f}`);
  }
});

test('validateSinglePinJob allows the two real AI disclosure values', () => {
  assert.equal(validateSinglePinJob(baseJob({ ai_disclosure: 'AI_MODIFIED' })).ok, true);
  assert.equal(validateSinglePinJob(baseJob({ ai_disclosure: 'SYNTHETIC_PERFORMER' })).ok, true);
});

// ─── board alias resolution ──────────────────────────────────────────────────

test('resolveBoardMatch resolves exactly one case-insensitive match to a board id', () => {
  const r = resolveBoardMatch('home-maintenance', [{ id: '111', name: 'home maintenance TROUBLESHOOTING' }], ALIASES);
  assert.deepEqual(r, { ok: true, boardId: '111' });
});

test('resolveBoardMatch → zero matches', () => {
  const r = resolveBoardMatch('home-maintenance', [{ id: '111', name: 'Other Board' }], ALIASES);
  assert.deepEqual(r, { ok: false, reason: BOARD_UNRESOLVED_ZERO });
});

test('resolveBoardMatch → multiple matches (ambiguous, never guess)', () => {
  const r = resolveBoardMatch('home-maintenance', [
    { id: '1', name: 'Home Maintenance Troubleshooting' },
    { id: '2', name: 'Home Maintenance Troubleshooting' },
  ], ALIASES);
  assert.deepEqual(r, { ok: false, reason: BOARD_UNRESOLVED_MULTI });
});

test('resolveBoardMatch → unknown alias', () => {
  assert.deepEqual(resolveBoardMatch('nope', [], ALIASES), { ok: false, reason: BOARD_UNKNOWN_ALIAS });
});

// ─── payload builder ─────────────────────────────────────────────────────────

test('buildCreatePinPayload maps fields, image source, and omits AI when absent', () => {
  const p = buildCreatePinPayload(baseJob({ ai_disclosure: null }), '111', 'https://cdn.example.com/pinterest-jobs/job1.png');
  assert.equal(p.board_id, '111');
  assert.equal(p.title, 'T');
  assert.equal(p.description, 'D');
  assert.equal(p.link, 'https://ex.com');
  assert.equal(p.alt_text, 'A');
  assert.deepEqual(p.media_source, { source_type: 'image_url', url: 'https://cdn.example.com/pinterest-jobs/job1.png' });
  assert.equal('ai_disclosures' in p, false);
});

test('buildCreatePinPayload includes ai_disclosures.values only when specified', () => {
  const p = buildCreatePinPayload(baseJob({ ai_disclosure: 'AI_MODIFIED' }), '111', 'https://cdn/x.png');
  assert.deepEqual(p.ai_disclosures, { values: ['AI_MODIFIED'] });
});

test('buildCreatePinPayload omits optional text fields that are absent', () => {
  const p = buildCreatePinPayload({ image_key: 'k' }, '111', 'https://cdn/x.png');
  assert.equal('title' in p, false);
  assert.equal('description' in p, false);
  assert.equal('link' in p, false);
  assert.equal('alt_text' in p, false);
});

// ─── outcome classifier ──────────────────────────────────────────────────────

test('classifyCreatePinOutcome: 200/201 with id → published', () => {
  assert.equal(classifyCreatePinOutcome({ kind: 'response', status: 200, hasId: true }).state, 'published');
  assert.equal(classifyCreatePinOutcome({ kind: 'response', status: 201, hasId: true }).state, 'published');
});

test('classifyCreatePinOutcome: 2xx without id → needs_review/ambiguous', () => {
  assert.deepEqual(classifyCreatePinOutcome({ kind: 'response', status: 200, hasId: false }), { state: 'needs_review', error_category: 'ambiguous' });
});

test('classifyCreatePinOutcome: 429 → released (rate_limited, not executed)', () => {
  assert.deepEqual(classifyCreatePinOutcome({ kind: 'response', status: 429, hasId: false }), { state: 'approved', error_category: 'rate_limited' });
});

test('classifyCreatePinOutcome: definite 4xx → needs_review/pinterest_rejected', () => {
  for (const s of [400, 401, 403, 404]) {
    assert.deepEqual(classifyCreatePinOutcome({ kind: 'response', status: s, hasId: false }), { state: 'needs_review', error_category: 'pinterest_rejected' });
  }
});

test('classifyCreatePinOutcome: 5xx and network error → needs_review/ambiguous', () => {
  assert.deepEqual(classifyCreatePinOutcome({ kind: 'response', status: 500, hasId: false }), { state: 'needs_review', error_category: 'ambiguous' });
  assert.deepEqual(classifyCreatePinOutcome({ kind: 'response', status: 503, hasId: false }), { state: 'needs_review', error_category: 'ambiguous' });
  assert.deepEqual(classifyCreatePinOutcome({ kind: 'network_error' }), { state: 'needs_review', error_category: 'ambiguous' });
});

// ─── claim / lease predicates ────────────────────────────────────────────────

test('canClaim only for approved + due', () => {
  assert.equal(canClaim({ state: 'approved', publish_at: 100 }, 200), true);
  assert.equal(canClaim({ state: 'approved', publish_at: 300 }, 200), false); // not due
  for (const s of ['publishing', 'published', 'needs_review', 'canceled']) {
    assert.equal(canClaim({ state: s, publish_at: 100 }, 200), false);
  }
});

test('isStaleLease: stale publishing lease or max attempts → true; fresh → false', () => {
  assert.equal(isStaleLease({ state: 'publishing', claimed_at: 0, attempt_count: 1 }, 100000), true);
  assert.equal(isStaleLease({ state: 'publishing', claimed_at: 99999, attempt_count: 3 }, 100000), true);
  assert.equal(isStaleLease({ state: 'publishing', claimed_at: 99999, attempt_count: 1 }, 100000), false);
  assert.equal(isStaleLease({ state: 'approved', claimed_at: 0, attempt_count: 1 }, 100000), false);
});

// ─── claimJob against the fake D1 ────────────────────────────────────────────

test('claimJob: first claim succeeds, second claim fails', async () => {
  const db = new FakeDB(); db.seedJob(baseJob());
  const first = await claimJob(db, 'job1', 2000);
  assert.ok(first);
  assert.equal(first.state, 'publishing');
  assert.equal(first.attempt_count, 1);
  const second = await claimJob(db, 'job1', 2000);
  assert.equal(second, null);
});

test('claimJob: canceled/published/needs_review cannot be claimed', async () => {
  for (const s of ['canceled', 'published', 'needs_review']) {
    const db = new FakeDB(); db.seedJob(baseJob({ state: s }));
    assert.equal(await claimJob(db, 'job1', 2000), null);
  }
});

test('claimJob: a not-yet-due approved job cannot be claimed', async () => {
  const db = new FakeDB(); db.seedJob(baseJob({ publish_at: 5000 }));
  assert.equal(await claimJob(db, 'job1', 2000), null);
});

test('claimJob: a stale publishing job is NOT automatically re-claimed', async () => {
  const db = new FakeDB(); db.seedJob(baseJob({ state: 'publishing', claimed_at: 0, attempt_count: 1 }));
  assert.equal(await claimJob(db, 'job1', 999999), null); // never auto-retried
});

// ─── createPinOnce: exactly one attempt, id discarded, host-locked ───────────

test('createPinOnce performs exactly ONE POST and never returns the pin id', async () => {
  const fetchImpl = makeFetch({ pinStatus: 201, pinBody: { id: '999' } });
  const outcome = await createPinOnce(fetchImpl, 'tok', { board_id: '1' });
  assert.equal(fetchImpl.calls.pins, 1);
  assert.deepEqual(outcome, { kind: 'response', status: 201, hasId: true });
  assert.equal('id' in outcome, false);            // id never surfaced
  assert.equal(JSON.stringify(outcome).includes('999'), false);
});

test('createPinOnce maps a thrown fetch to network_error (no retry)', async () => {
  const fetchImpl = makeFetch({ pinThrows: true });
  const outcome = await createPinOnce(fetchImpl, 'tok', { board_id: '1' });
  assert.deepEqual(outcome, { kind: 'network_error' });
  assert.equal(fetchImpl.calls.pins, 1);           // still exactly one attempt
});

test('createPinOnce refuses a non-production (sandbox) API base', async () => {
  const fetchImpl = makeFetch();
  await assert.rejects(
    () => createPinOnce(fetchImpl, 'tok', {}, 'https://api-sandbox.pinterest.com/v5'),
    /non-production host/,
  );
  assert.equal(fetchImpl.calls.pins, 0);           // never even attempted
});

test('listBoards refuses a non-production API base', async () => {
  const fetchImpl = makeFetch();
  await assert.rejects(() => listBoards(fetchImpl, 'tok', 'https://api-sandbox.pinterest.com/v5'), /non-production host/);
  assert.equal(fetchImpl.calls.boards, 0);
});

// ─── executeApprovedJob: the shared engine, end to end (mocked) ──────────────

test('executeApprovedJob happy path → published, exactly one Pin POST, id not persisted', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }], pinStatus: 201, pinBody: { id: '777' } });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');

  assert.deepEqual(res, { claimed: true, state: 'published' });
  assert.equal(fetchImpl.calls.pins, 1);
  const job = db.jobs.get('job1');
  assert.equal(job.state, 'published');
  assert.equal(job.published_at, 2000);
  // No Pinterest-derived id was ever stored on the row.
  assert.equal('pin_id' in job, false);
  assert.equal('board_id' in job, false);
  assert.equal(JSON.stringify(job).includes('777'), false);
});

test('executeApprovedJob: zero board matches → needs_review, NO Pin POST made', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Unrelated Board' }] });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');

  assert.equal(res.state, 'needs_review');
  assert.equal(res.error_category, BOARD_UNRESOLVED_ZERO);
  assert.equal(fetchImpl.calls.pins, 0);
  assert.equal(db.jobs.get('job1').state, 'needs_review');
});

test('executeApprovedJob: ambiguous network error → needs_review/ambiguous', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }], pinThrows: true });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');
  assert.deepEqual(res, { claimed: true, state: 'needs_review', error_category: 'ambiguous' });
  assert.equal(db.jobs.get('job1').state, 'needs_review');
});

test('executeApprovedJob: 5xx → needs_review/ambiguous; 400 → needs_review/pinterest_rejected', async () => {
  for (const [status, cat] of [[500, 'ambiguous'], [400, 'pinterest_rejected']]) {
    const db = new FakeDB();
    db.seedJob(baseJob());
    db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
    const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }], pinStatus: status });
    const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');
    assert.equal(res.error_category, cat);
    assert.equal(db.jobs.get('job1').state, 'needs_review');
  }
});

test('executeApprovedJob: 429 → released back to approved (attempt_count preserved)', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }], pinStatus: 429 });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');
  assert.deepEqual(res, { claimed: true, state: 'approved', error_category: 'rate_limited' });
  const job = db.jobs.get('job1');
  assert.equal(job.state, 'approved');
  assert.equal(job.attempt_count, 1);   // a claim happened; not reset
});

test('executeApprovedJob: missing account token → needs_review/reconnect_required, no fetch', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: '', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }] });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');
  assert.equal(res.error_category, 'reconnect_required');
  assert.equal(fetchImpl.calls.boards, 0);
  assert.equal(fetchImpl.calls.pins, 0);
});

test('executeApprovedJob: expired token → needs_review/reconnect_required', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 1000 }); // <= nowSec
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }] });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 }, 'job1');
  assert.equal(res.error_category, 'reconnect_required');
  assert.equal(fetchImpl.calls.pins, 0);
});

test('executeApprovedJob: concurrent execute of the same job claims exactly once → one Pin POST', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob());
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }], pinStatus: 201, pinBody: { id: '1' } });

  const deps = { DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 2000 };
  const [a, b] = await Promise.all([executeApprovedJob(deps, 'job1'), executeApprovedJob(deps, 'job1')]);

  const claimed = [a, b].filter((r) => r.claimed);
  const notClaimed = [a, b].filter((r) => !r.claimed);
  assert.equal(claimed.length, 1);
  assert.equal(notClaimed.length, 1);
  assert.equal(fetchImpl.calls.pins, 1);   // at most one Create Pin attempt
});

test('executeApprovedJob: a job already publishing is not claimable → claimed:false, no Pin POST', async () => {
  const db = new FakeDB();
  db.seedJob(baseJob({ state: 'publishing', claimed_at: 0, attempt_count: 1 }));
  db.seedAccount({ id: 'acct1', access_token: 'pina_x', token_expires_at: 99999 });
  const fetchImpl = makeFetch({ boards: [{ id: '111', name: 'Home Maintenance Troubleshooting' }] });

  const res = await executeApprovedJob({ DB: db, env: envWith(null), fetchImpl, aliasMap: ALIASES, nowSec: 999999 }, 'job1');
  assert.deepEqual(res, { claimed: false });
  assert.equal(fetchImpl.calls.pins, 0);
});

// ─── ingestion seam ──────────────────────────────────────────────────────────

test('insertApprovedPinJob inserts one approved row; duplicate (source, external_job_id) throws', async () => {
  const db = new FakeDB();
  const job = baseJob();
  await insertApprovedPinJob(db, job, 2000);
  assert.equal(db.jobs.get('job1').state, 'approved');
  await assert.rejects(() => insertApprovedPinJob(db, baseJob({ id: 'job2' }), 2000), /UNIQUE constraint/);
});

// ─── R2 image staging ────────────────────────────────────────────────────────

test('stagePinImageToR2 rejects an unsupported content type before any write', async () => {
  let putCalled = false;
  const bucket = { async put() { putCalled = true; } };
  await assert.rejects(() => stagePinImageToR2(envWith(bucket), 'job1', new Uint8Array([1]), 'image/gif'), /unsupported_image_type/);
  assert.equal(putCalled, false);
});

test('stagePinImageToR2 writes jpeg/png under the persistent pinterest-jobs/ prefix', async () => {
  const writes = [];
  const bucket = { async put(key, bytes, opts) { writes.push({ key, opts }); } };
  const keyJpg = await stagePinImageToR2(envWith(bucket), 'job1', new Uint8Array([1]), 'image/jpeg');
  const keyPng = await stagePinImageToR2(envWith(bucket), 'job2', new Uint8Array([1]), 'image/png');
  assert.equal(keyJpg, 'pinterest-jobs/job1.jpg');
  assert.equal(keyPng, 'pinterest-jobs/job2.png');
  assert.equal(writes[0].opts.httpMetadata.contentType, 'image/jpeg');
});

// ─── content hash ────────────────────────────────────────────────────────────

test('computeContentHash is deterministic and changes with content', async () => {
  const a = await computeContentHash(baseJob());
  const b = await computeContentHash(baseJob());
  const c = await computeContentHash(baseJob({ title: 'different' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ─── schema guardrail: table must not persist Pinterest ids ──────────────────

test('pinterest_publish_jobs schema persists NO board_id and NO pin_id', () => {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  const m = sql.match(/CREATE TABLE IF NOT EXISTS pinterest_publish_jobs\s*\(([\s\S]*?)\);/);
  assert.ok(m, 'pinterest_publish_jobs table must exist in schema.sql');
  const ddl = m[1];
  assert.equal(/\bboard_id\b/.test(ddl), false, 'must not persist board_id');
  assert.equal(/\bpin_id\b/.test(ddl), false, 'must not persist pin_id');
  assert.ok(/\bboard_alias\b/.test(ddl), 'should persist the local board_alias instead');
});

// PINTEREST_JOB_STATES has no pending_review (removed upstream, §18).
test('job state set does not include pending_review', () => {
  assert.equal(Object.values(PINTEREST_JOB_STATES).includes('pending_review'), false);
});
