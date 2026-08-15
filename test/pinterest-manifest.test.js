// Unit tests for Pinterest cohort manifest ingestion (Phase B, slice B2).
// Zero live Pinterest/network I/O. D1 is an in-memory fake modeling the exact
// statements the ingestion layer issues, including atomic DB.batch(); R2 is a fake
// bucket with injectable failure to prove all-or-nothing cleanup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifest,
  parsePublishAt,
  computeManifestHash,
  computeJobContentHash,
  deriveJobId,
  ingestManifest,
  listJobs,
  cancelJob,
  MAX_COHORT_PINS,
  MAX_IMAGE_BYTES,
} from '../lib/pinterest-manifest.js';

const ALIASES = { 'lawn-troubleshooting': 'Lawn & Yard Troubleshooting', 'home-maintenance': 'Home Maintenance Troubleshooting' };

// ─── Fake D1 supporting SELECT .all(), atomic .batch(), conditional cancel ────

const INSERT_COLS = [
  'id', 'external_job_id', 'source', 'manifest_id', 'content_hash', 'user_id',
  'account_id', 'board_alias', 'title', 'description', 'link', 'alt_text',
  'image_key', 'ai_disclosure', 'publish_at', 'approved_at', 'created_at',
];

class FakeDB {
  constructor() { this.jobs = new Map(); this.failBatch = false; }
  seedJob(job) { this.jobs.set(job.id, { state: 'approved', attempt_count: 0, claimed_at: null, published_at: null, error_category: null, ...job }); }

  prepare(sql) {
    const db = this;
    const stmt = {
      _sql: sql, _args: [],
      bind(...args) { return { ...stmt, _args: args }; },
      async first() { return db._exec(this._sql, this._args, 'first'); },
      async all()   { return db._exec(this._sql, this._args, 'all'); },
      async run()   { return db._exec(this._sql, this._args, 'run'); },
    };
    return stmt;
  }

  async batch(stmts) {
    if (this.failBatch) throw new Error('batch failure (injected)');
    const snapshot = new Map([...this.jobs].map(([k, v]) => [k, { ...v }]));
    try {
      for (const s of stmts) this._exec(s._sql, s._args, 'run');
    } catch (err) {
      this.jobs = snapshot; // atomic: roll back the whole batch
      throw err;
    }
    return stmts.map(() => ({ success: true }));
  }

  _exec(sql, args, mode) {
    if (sql.startsWith('INSERT INTO pinterest_publish_jobs')) {
      const row = {};
      INSERT_COLS.forEach((c, i) => { row[c] = args[i]; });
      row.state = 'approved'; row.attempt_count = 0;
      for (const j of this.jobs.values()) {
        if (j.source === row.source && j.external_job_id === row.external_job_id) {
          throw new Error('UNIQUE constraint failed: pinterest_publish_jobs.source, external_job_id');
        }
      }
      this.jobs.set(row.id, row);
      return { meta: { changes: 1 } };
    }
    if (sql.includes('SELECT external_job_id, manifest_id, content_hash, state')) {
      const [source, ...ids] = args;
      const results = [...this.jobs.values()]
        .filter((j) => j.source === source && ids.includes(j.external_job_id))
        .map((j) => ({ external_job_id: j.external_job_id, manifest_id: j.manifest_id, content_hash: j.content_hash, state: j.state }));
      return { results };
    }
    if (sql.includes('FROM pinterest_publish_jobs') && sql.includes('ORDER BY publish_at')) {
      // Status list: apply the simple WHERE built by listJobs (best-effort match).
      let rows = [...this.jobs.values()];
      let a = 0;
      if (sql.includes('state = ?') && !sql.includes("state = 'needs_review'") && !sql.includes("state = 'approved' AND")) { const v = args[a++]; rows = rows.filter((j) => j.state === v); }
      if (sql.includes('source = ?'))      { const v = args[a++]; rows = rows.filter((j) => j.source === v); }
      if (sql.includes('manifest_id = ?')) { const v = args[a++]; rows = rows.filter((j) => j.manifest_id === v); }
      if (sql.includes("state = 'needs_review'")) rows = rows.filter((j) => j.state === 'needs_review');
      if (sql.includes("state = 'approved' AND publish_at >= ?")) { const v = args[a++]; rows = rows.filter((j) => j.state === 'approved' && j.publish_at >= v); }
      return { results: rows.map((j) => ({ id: j.id, external_job_id: j.external_job_id, source: j.source, manifest_id: j.manifest_id, board_alias: j.board_alias, title: j.title, publish_at: j.publish_at, approved_at: j.approved_at, state: j.state, attempt_count: j.attempt_count, claimed_at: j.claimed_at, published_at: j.published_at, error_category: j.error_category, created_at: j.created_at })) };
    }
    if (sql.includes("SET state = 'publishing'") && sql.includes('RETURNING')) {
      const [claimedAt, id, dueAt] = args;
      const j = this.jobs.get(id);
      if (j && j.state === 'approved' && j.publish_at <= dueAt) {
        j.state = 'publishing'; j.claimed_at = claimedAt; j.attempt_count = (j.attempt_count ?? 0) + 1;
        return { ...j };
      }
      return null;
    }
    if (sql.startsWith('SELECT state FROM pinterest_publish_jobs WHERE id')) {
      const j = this.jobs.get(args[0]);
      return j ? { state: j.state } : null;
    }
    if (sql.includes("SET state = 'canceled'")) {
      const j = this.jobs.get(args[0]);
      if (j && j.state === 'approved') { j.state = 'canceled'; return { meta: { changes: 1 } }; }
      return { meta: { changes: 0 } };
    }
    throw new Error('FakeDB: unrecognized SQL: ' + sql);
  }
}

// Fake R2 bucket. failOnPutIndex triggers a put() throw at the Nth call.
class FakeBucket {
  constructor({ failOnPutIndex = -1 } = {}) { this.objects = new Map(); this.deleted = []; this.putCount = 0; this.failOnPutIndex = failOnPutIndex; }
  async put(key, bytes, opts) {
    if (this.putCount === this.failOnPutIndex) { this.putCount++; throw new Error('R2 put failure (injected)'); }
    this.putCount++; this.objects.set(key, { bytes, opts }); return { key };
  }
  async delete(key) { this.deleted.push(key); this.objects.delete(key); }
}

// ─── Builders ────────────────────────────────────────────────────────────────

const IMG = () => new Uint8Array([137, 80, 78, 71]); // "PNG" magic-ish bytes
function pin(over = {}) {
  return {
    external_job_id: 'Y01', board_alias: 'lawn-troubleshooting',
    title: 'Brown patches', description: 'Why the lawn browns', alt_text: 'brown lawn',
    link: 'https://starthere.home/lawn', ai_disclosure: 'AI_MODIFIED',
    publish_at: '2026-08-20T16:00:00Z', ...over,
  };
}
function manifest(over = {}) {
  return { manifest_version: 1, manifest_id: 'lawn-c03-v1', source: 'start-here-home', pins: [pin()], ...over };
}
function imagesFor(m, bytesByJob = {}) {
  const images = {};
  for (const p of m.pins) images[p.external_job_id] = { bytes: bytesByJob[p.external_job_id] ?? IMG(), contentType: 'image/png', size: 4 };
  return images;
}
function deps(db, bucket, over = {}) {
  return { DB: db, bucket, r2PublicBase: 'https://cdn.example.com', userId: 'u1', accountId: 'acct1', aliasMap: ALIASES, nowSec: 1_700_000_000, ...over };
}

// ─── parsePublishAt ──────────────────────────────────────────────────────────

test('parsePublishAt: accepts Z and explicit offset, normalizes to UTC seconds', () => {
  assert.equal(parsePublishAt('2026-08-20T16:00:00Z').seconds, Math.floor(Date.parse('2026-08-20T16:00:00Z') / 1000));
  const off = parsePublishAt('2026-08-20T09:00:00-07:00');
  assert.equal(off.ok, true);
  assert.equal(off.seconds, Math.floor(Date.parse('2026-08-20T16:00:00Z') / 1000));
});

test('parsePublishAt: rejects timezone-less datetime; accepts integer unix seconds', () => {
  assert.deepEqual(parsePublishAt('2026-08-20T16:00:00'), { ok: false, code: 'missing_timezone' });
  assert.equal(parsePublishAt(1_700_000_000).seconds, 1_700_000_000);
  assert.equal(parsePublishAt('nonsense').ok, false);
});

// ─── validateManifest ────────────────────────────────────────────────────────

test('validateManifest: a valid one-item manifest passes', () => {
  const m = manifest();
  const r = validateManifest(m, ['Y01'], ALIASES);
  assert.equal(r.ok, true);
  assert.equal(r.pins[0].publish_at_sec, Math.floor(Date.parse('2026-08-20T16:00:00Z') / 1000));
});

test('validateManifest: a valid 15-item manifest passes', () => {
  const pins = Array.from({ length: 15 }, (_, i) => pin({ external_job_id: `Y${String(i + 1).padStart(2, '0')}` }));
  const m = manifest({ pins });
  const r = validateManifest(m, pins.map((p) => p.external_job_id), ALIASES);
  assert.equal(r.ok, true);
  assert.equal(r.pins.length, 15);
});

test('validateManifest: unsupported version rejected distinctly', () => {
  const r = validateManifest(manifest({ manifest_version: 2 }), ['Y01'], ALIASES);
  assert.equal(r.ok, false);
  assert.equal(r.version_unsupported, true);
});

test('validateManifest: empty pins rejected', () => {
  const r = validateManifest(manifest({ pins: [] }), [], ALIASES);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === 'pins' && i.code === 'empty'));
});

test('validateManifest: too many pins rejected', () => {
  const pins = Array.from({ length: MAX_COHORT_PINS + 1 }, (_, i) => pin({ external_job_id: `Y${i}` }));
  const r = validateManifest(manifest({ pins }), pins.map((p) => p.external_job_id), ALIASES);
  assert.ok(r.issues.some((i) => i.field === 'pins' && i.code === 'too_many'));
});

test('validateManifest: duplicate external_job_id rejected', () => {
  const m = manifest({ pins: [pin({ external_job_id: 'Y01' }), pin({ external_job_id: 'Y01' })] });
  const r = validateManifest(m, ['Y01'], ALIASES);
  assert.ok(r.issues.some((i) => i.code === 'duplicate'));
});

test('validateManifest: unknown board alias rejects the manifest', () => {
  const r = validateManifest(manifest({ pins: [pin({ board_alias: 'no-such-board' })] }), ['Y01'], ALIASES);
  assert.ok(r.issues.some((i) => i.field === 'board_alias' && i.code === 'unknown_board_alias'));
});

test('validateManifest: timezone-less timestamp rejected', () => {
  const r = validateManifest(manifest({ pins: [pin({ publish_at: '2026-08-20T16:00:00' })] }), ['Y01'], ALIASES);
  assert.ok(r.issues.some((i) => i.field === 'publish_at' && i.code === 'missing_timezone'));
});

test('validateManifest: invalid AI enum rejected', () => {
  const r = validateManifest(manifest({ pins: [pin({ ai_disclosure: 'AI_GENERATED' })] }), ['Y01'], ALIASES);
  assert.ok(r.issues.some((i) => i.field === 'ai_disclosure'));
});

test('validateManifest: title/alt/link length boundaries enforced', () => {
  const r = validateManifest(manifest({ pins: [pin({ title: 'x'.repeat(101), alt_text: 'y'.repeat(501) })] }), ['Y01'], ALIASES);
  assert.ok(r.issues.some((i) => i.field === 'title'));
  assert.ok(r.issues.some((i) => i.field === 'alt_text'));
});

test('validateManifest: missing image for a pin rejected', () => {
  const r = validateManifest(manifest(), [], ALIASES); // no image keys
  assert.ok(r.issues.some((i) => i.field === 'image' && i.code === 'missing_image'));
});

test('validateManifest: orphan image (unreferenced part) rejected', () => {
  const r = validateManifest(manifest(), ['Y01', 'Y99'], ALIASES);
  assert.ok(r.issues.some((i) => i.field === 'image' && i.code === 'orphan_image' && i.external_job_id === 'Y99'));
});

// ─── hashing / canonicalization ──────────────────────────────────────────────

test('computeManifestHash: identical logical manifest with reordered JSON keys hashes identically', async () => {
  const a = manifest();
  const b = { source: 'start-here-home', pins: [ { publish_at: '2026-08-20T16:00:00Z', board_alias: 'lawn-troubleshooting', external_job_id: 'Y01', ai_disclosure: 'AI_MODIFIED', link: 'https://starthere.home/lawn', alt_text: 'brown lawn', description: 'Why the lawn browns', title: 'Brown patches' } ], manifest_id: 'lawn-c03-v1', manifest_version: 1 };
  const digest = { Y01: 'deadbeef' };
  assert.equal(await computeManifestHash(a, digest), await computeManifestHash(b, digest));
});

test('computeManifestHash: pin order does not matter', async () => {
  const p1 = pin({ external_job_id: 'Y01' }), p2 = pin({ external_job_id: 'Y02' });
  const d = { Y01: 'aa', Y02: 'bb' };
  const h1 = await computeManifestHash(manifest({ pins: [p1, p2] }), d);
  const h2 = await computeManifestHash(manifest({ pins: [p2, p1] }), d);
  assert.equal(h1, h2);
});

test('computeManifestHash: changed title / publish time / image / AI each differ', async () => {
  const base = await computeManifestHash(manifest(), { Y01: 'aa' });
  assert.notEqual(base, await computeManifestHash(manifest({ pins: [pin({ title: 'Different' })] }), { Y01: 'aa' }));
  assert.notEqual(base, await computeManifestHash(manifest({ pins: [pin({ publish_at: '2026-09-01T16:00:00Z' })] }), { Y01: 'aa' }));
  assert.notEqual(base, await computeManifestHash(manifest(), { Y01: 'bb' })); // image digest changed
  assert.notEqual(base, await computeManifestHash(manifest({ pins: [pin({ ai_disclosure: null })] }), { Y01: 'aa' }));
});

test('computeJobContentHash: image bytes are part of job identity; deriveJobId is deterministic', async () => {
  const h1 = await computeJobContentHash(pin(), 'start-here-home', 100, 'imgA');
  const h2 = await computeJobContentHash(pin(), 'start-here-home', 100, 'imgB');
  assert.notEqual(h1, h2);
  assert.equal(await deriveJobId('start-here-home', 'Y01'), await deriveJobId('start-here-home', 'Y01'));
  assert.match(await deriveJobId('start-here-home', 'Y01'), /^pj_[0-9a-f]{32}$/);
});

// ─── ingestManifest: happy path + atomicity ──────────────────────────────────

test('ingestManifest: valid 15-item cohort → all inserted atomically, images staged', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const pins = Array.from({ length: 15 }, (_, i) => pin({ external_job_id: `Y${String(i + 1).padStart(2, '0')}` }));
  const m = manifest({ pins });
  const res = await ingestManifest(deps(db, bucket), m, imagesFor(m));
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'accepted');
  assert.equal(res.body.job_count, 15);
  assert.equal(db.jobs.size, 15);
  assert.equal(bucket.objects.size, 15);
  // Image key is deterministic under the persistent prefix; no Pinterest ids stored.
  const anyJob = [...db.jobs.values()][0];
  assert.match(anyJob.image_key, /^pinterest-jobs\/pj_[0-9a-f]{32}\.png$/);
  assert.equal('board_id' in anyJob, false);
  assert.equal('pin_id' in anyJob, false);
});

test('ingestManifest: one invalid pin → ZERO jobs inserted, ZERO images staged (all-or-nothing)', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest({ pins: [pin({ external_job_id: 'Y01' }), pin({ external_job_id: 'Y02', title: 'x'.repeat(101) })] });
  const res = await ingestManifest(deps(db, bucket), m, imagesFor(m));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_manifest');
  assert.equal(db.jobs.size, 0);
  assert.equal(bucket.putCount, 0);
});

test('ingestManifest: simulated D1 batch failure → no accepted jobs, staged images cleaned up', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  db.failBatch = true;
  const pins = [pin({ external_job_id: 'Y01' }), pin({ external_job_id: 'Y02' })];
  const m = manifest({ pins });
  const res = await ingestManifest(deps(db, bucket), m, imagesFor(m));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'persistence_failed');
  assert.equal(db.jobs.size, 0);
  assert.equal(bucket.objects.size, 0);       // both staged objects deleted
  assert.equal(bucket.deleted.length, 2);
});

test('ingestManifest: R2 put failure halfway → no jobs, already-staged object cleaned up', async () => {
  const db = new FakeDB(), bucket = new FakeBucket({ failOnPutIndex: 1 }); // 2nd put throws
  const pins = [pin({ external_job_id: 'Y01' }), pin({ external_job_id: 'Y02' })];
  const m = manifest({ pins });
  const res = await ingestManifest(deps(db, bucket), m, imagesFor(m));
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'staging_failed');
  assert.equal(db.jobs.size, 0);
  assert.equal(bucket.deleted.length, 1);     // the one that succeeded is cleaned up
});

test('ingestManifest: cleanup failure is safe (still fails ingestion, no partial cohort)', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  db.failBatch = true;
  bucket.delete = async () => { throw new Error('R2 delete failure'); };
  const orphanLogs = [];
  const m = manifest({ pins: [pin({ external_job_id: 'Y01' })] });
  const res = await ingestManifest(deps(db, bucket, { log: (f) => orphanLogs.push(f) }), m, imagesFor(m));
  assert.equal(res.status, 500);
  assert.equal(db.jobs.size, 0);
  assert.ok(orphanLogs.some((f) => f.event === 'pinterest_r2_orphan'));
});

// ─── dedupe ──────────────────────────────────────────────────────────────────

test('ingestManifest: exact identical resubmission is idempotent (already_accepted, no new work)', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest();
  const first = await ingestManifest(deps(db, bucket), m, imagesFor(m));
  assert.equal(first.body.status, 'accepted');
  const putsAfterFirst = bucket.putCount;

  const second = await ingestManifest(deps(db, bucket), m, imagesFor(m));
  assert.equal(second.status, 200);
  assert.equal(second.body.status, 'already_accepted');
  assert.equal(db.jobs.size, 1);              // no duplicate rows
  assert.equal(bucket.putCount, putsAfterFirst); // no re-staging
});

test('ingestManifest: same manifest_id + changed copy → manifest_conflict (409)', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest();
  await ingestManifest(deps(db, bucket), m, imagesFor(m));
  const changed = manifest({ pins: [pin({ title: 'Rewritten title' })] });
  const res = await ingestManifest(deps(db, bucket), changed, imagesFor(changed));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'manifest_conflict');
  assert.equal(db.jobs.size, 1);
});

test('ingestManifest: same manifest_id + changed image bytes → conflict', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest();
  await ingestManifest(deps(db, bucket), m, imagesFor(m));
  const res = await ingestManifest(deps(db, bucket), m, imagesFor(m, { Y01: new Uint8Array([9, 9, 9, 9]) }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'manifest_conflict');
});

test('ingestManifest: same manifest_id + changed schedule → conflict', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest();
  await ingestManifest(deps(db, bucket), m, imagesFor(m));
  const changed = manifest({ pins: [pin({ publish_at: '2026-09-09T16:00:00Z' })] });
  const res = await ingestManifest(deps(db, bucket), changed, imagesFor(changed));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'manifest_conflict');
});

test('ingestManifest: same (source, external_job_id) under a DIFFERENT manifest_id → job_conflict', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  await ingestManifest(deps(db, bucket), manifest(), imagesFor(manifest()));
  const other = manifest({ manifest_id: 'lawn-c99-v1' });
  const res = await ingestManifest(deps(db, bucket), other, imagesFor(other));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'job_conflict');
});

test('ingestManifest: duplicate image part for one job → duplicate_image', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest();
  const res = await ingestManifest(deps(db, bucket), m, imagesFor(m), { duplicateImageKeys: ['Y01'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'duplicate_image');
  assert.equal(db.jobs.size, 0);
});

test('ingestManifest: a multi-item AI disclosure does not leak across pins', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest({ pins: [
    pin({ external_job_id: 'Y01', ai_disclosure: 'AI_MODIFIED' }),
    pin({ external_job_id: 'Y02', ai_disclosure: null }),
  ] });
  await ingestManifest(deps(db, bucket), m, imagesFor(m));
  const y01 = [...db.jobs.values()].find((j) => j.external_job_id === 'Y01');
  const y02 = [...db.jobs.values()].find((j) => j.external_job_id === 'Y02');
  assert.equal(y01.ai_disclosure, 'AI_MODIFIED');
  assert.equal(y02.ai_disclosure, null);
});

// ─── status / cancel ─────────────────────────────────────────────────────────

test('listJobs: filters by source/state and never exposes tokens or Pinterest ids', async () => {
  const db = new FakeDB(), bucket = new FakeBucket();
  const m = manifest({ pins: [pin({ external_job_id: 'Y01' }), pin({ external_job_id: 'Y02' })] });
  await ingestManifest(deps(db, bucket), m, imagesFor(m));
  const all = await listJobs(db, { source: 'start-here-home' }, 0);
  assert.equal(all.length, 2);
  const fields = Object.keys(all[0]);
  for (const forbidden of ['access_token', 'refresh_token', 'board_id', 'pin_id', 'image_key', 'content_hash']) {
    assert.equal(fields.includes(forbidden), false, `must not expose ${forbidden}`);
  }
  const approved = await listJobs(db, { state: 'approved' }, 0);
  assert.equal(approved.length, 2);
});

test('cancelJob: approved unclaimed → canceled; canceled cannot later be claimed by B1', async () => {
  const db = new FakeDB();
  db.seedJob({ id: 'pj_x', external_job_id: 'Y01', source: 's', manifest_id: 'm', content_hash: 'h', user_id: 'u', account_id: 'a', board_alias: 'lawn-troubleshooting', image_key: 'k', publish_at: 100, approved_at: 100, created_at: 100, state: 'approved' });
  assert.equal(await cancelJob(db, 'pj_x'), 'canceled');
  assert.equal(db.jobs.get('pj_x').state, 'canceled');
  // The B1 claim WHERE state='approved' can never match a canceled row.
  const { claimJob } = await import('../lib/pinterest-publish.js');
  assert.equal(await claimJob(db, 'pj_x', 999999), null);
});

test('cancelJob: publishing/published cannot be canceled; missing → not_found', async () => {
  const db = new FakeDB();
  db.seedJob({ id: 'pj_pub', source: 's', external_job_id: 'A', manifest_id: 'm', content_hash: 'h', user_id: 'u', account_id: 'a', board_alias: 'b', image_key: 'k', publish_at: 1, approved_at: 1, created_at: 1, state: 'publishing' });
  db.seedJob({ id: 'pj_done', source: 's', external_job_id: 'B', manifest_id: 'm', content_hash: 'h', user_id: 'u', account_id: 'a', board_alias: 'b', image_key: 'k', publish_at: 1, approved_at: 1, created_at: 1, state: 'published' });
  assert.equal(await cancelJob(db, 'pj_pub'), 'not_cancelable');
  assert.equal(await cancelJob(db, 'pj_done'), 'not_cancelable');
  assert.equal(await cancelJob(db, 'nope'), 'not_found');
});

// ─── config guardrails ───────────────────────────────────────────────────────

test('bounds are owner-scale, not bulk', () => {
  assert.ok(MAX_COHORT_PINS >= 15 && MAX_COHORT_PINS <= 50);
  assert.equal(MAX_IMAGE_BYTES, 20 * 1024 * 1024);
});
