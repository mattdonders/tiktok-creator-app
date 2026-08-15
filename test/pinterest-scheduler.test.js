// Unit tests for the Pinterest scheduled executor (Phase B, slice B3 — BUILT, NOT ACTIVATED).
//
// The scheduler is the unattended wake-up layer only; it delegates every publication to the
// EXACT B1 engine (executeApprovedJob). These tests drive that real engine through an
// in-memory D1 fake and an injected fetch — NO live Pinterest/OAuth call is ever made. They
// prove: bounded oldest-first due selection; single-engine reuse (one Create Pin path);
// atomic-claim duplicate safety across overlapping runs; conservative stale-lease recovery
// (→ needs_review, never → approved); alert discipline; and publish-time token safety via the
// shared refresh implementation. Cron-route auth + inert GitHub workflow are validated by
// static inspection at the bottom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runPublishDue,
  selectDueJobs,
  sweepStaleLeases,
  PUBLISH_DUE_MAX_PER_RUN,
} from '../lib/pinterest-scheduler.js';

const ALIASES = { 'home-maintenance': 'Home Maintenance Troubleshooting' };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── In-memory fake D1 (models every statement the scheduler + B1 engine issue) ──

class FakeDB {
  constructor() {
    this.jobs = new Map();
    this.accounts = new Map();       // keyed by account id
    this.refreshWrites = 0;
  }
  seedJob(job) {
    this.jobs.set(job.id, {
      state: 'approved', attempt_count: 0, claimed_at: null, published_at: null,
      error_category: null, title: null, source: null, external_job_id: null, ...job,
    });
  }
  seedAccount(acct) { this.accounts.set(acct.id, acct); }

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

  _exec(sql, args, mode) {
    // ── B1 atomic claim (RETURNING *) ──
    if (sql.includes("SET state = 'publishing'")) {
      const [nowSec, id] = args;
      const job = this.jobs.get(id);
      if (job && job.state === 'approved' && job.publish_at <= nowSec) {
        job.state = 'publishing'; job.claimed_at = nowSec; job.attempt_count += 1;
        return { ...job };
      }
      return null;
    }
    // ── stale-lease sweep UPDATE (literal 'stale_claim'; binds [id]) — check BEFORE B1 needs_review ──
    if (sql.includes("error_category = 'stale_claim'")) {
      const [id] = args;
      const job = this.jobs.get(id);
      if (job && job.state === 'publishing') {
        job.state = 'needs_review'; job.error_category = 'stale_claim'; job.claimed_at = null;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    // ── B1 finalize: published / needs_review(cat) / approved(release) ──
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
    // ── scheduler: due-job selection (approved + due, oldest-first, bounded) ──
    if (sql.includes("WHERE state = 'approved' AND publish_at <= ?")) {
      const [nowSec, limit] = args;
      const rows = [...this.jobs.values()]
        .filter((j) => j.state === 'approved' && j.publish_at <= nowSec)
        .sort((a, b) => a.publish_at - b.publish_at)
        .slice(0, limit)
        .map((j) => ({ id: j.id, source: j.source, external_job_id: j.external_job_id, title: j.title, publish_at: j.publish_at }));
      return { results: rows };
    }
    // ── scheduler: stale-lease scan (all publishing rows) ──
    if (sql.includes("WHERE state = 'publishing'")) {
      const rows = [...this.jobs.values()]
        .filter((j) => j.state === 'publishing')
        .map((j) => ({ id: j.id, state: j.state, source: j.source, external_job_id: j.external_job_id, title: j.title, publish_at: j.publish_at, claimed_at: j.claimed_at, attempt_count: j.attempt_count }));
      return { results: rows };
    }
    // ── token: load owner-prod account (by platform_user_id) ──
    if (sql.includes('FROM connected_accounts') && sql.includes('platform_user_id = ?')) {
      const [puid] = args;
      const acct = [...this.accounts.values()].find((a) => a.platform === 'pinterest' && a.platform_user_id === puid);
      return acct ? { id: acct.id, access_token: acct.access_token, refresh_token: acct.refresh_token, token_expires_at: acct.token_expires_at } : null;
    }
    // ── token: CAS refresh persist ──
    if (sql.includes('UPDATE connected_accounts') && sql.includes('SET access_token')) {
      const [access, refresh, expires, id, whereRefresh] = args;
      const acct = this.accounts.get(id);
      if (acct && acct.refresh_token === whereRefresh) {
        acct.access_token = access; acct.refresh_token = refresh; acct.token_expires_at = expires;
        this.refreshWrites++;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith('SELECT refresh_token FROM connected_accounts')) {
      const [id] = args;
      const acct = this.accounts.get(id);
      return acct ? { refresh_token: acct.refresh_token } : null;
    }
    // ── B1: load account by id (for the Create Pin token) ──
    if (sql.includes('FROM connected_accounts')) {
      const [id] = args;
      return this.accounts.get(id) ?? null;
    }
    throw new Error('FakeDB: unrecognized SQL: ' + sql);
  }
}

// Fake fetch: routes token-refresh, board-list, and create-pin. Counts calls. No network.
function makeFetch({ boards = [{ id: '111', name: 'Home Maintenance Troubleshooting' }], pinStatus = 201, pinBody = { id: '999' }, pinThrows = false, refreshStatus = 200, refreshBody = { access_token: 'pina_new', refresh_token: 'pinr_new', expires_in: 2592000 } } = {}) {
  const calls = { boards: 0, pins: 0, refresh: 0 };
  const fn = async (url) => {
    if (url.includes('/oauth/token')) {
      calls.refresh += 1;
      return { status: refreshStatus, async json() { return refreshBody; } };
    }
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

const NOW = 2000;
function envBase() { return { R2_PUBLIC_URL: 'https://cdn.example.com', MEDIA_BUCKET: null, PINTEREST_CLIENT_ID: 'cid', PINTEREST_CLIENT_SECRET: 'csecret' }; }

// A publishable approved job whose account_id points at the seeded owner-prod account.
function dueJob(over = {}) {
  return {
    id: 'job1', external_job_id: 'ext1', source: 'hm-cohort-2', manifest_id: 'man1',
    content_hash: 'h1', user_id: 'user1', account_id: 'acct-prod',
    board_alias: 'home-maintenance', title: 'T', description: 'D', link: 'https://ex.com',
    alt_text: 'A', image_key: 'pinterest-jobs/job1.png', ai_disclosure: null,
    publish_at: 1000, approved_at: 1000, state: 'approved', created_at: 1000, ...over,
  };
}
function seedHealthyProdAccount(db) {
  db.seedAccount({ id: 'acct-prod', platform: 'pinterest', platform_user_id: 'owner-prod', access_token: 'pina_live', refresh_token: 'pinr_live', token_expires_at: NOW + 30 * 86400 });
}
function deps(db, fetchImpl, over = {}) {
  return { DB: db, env: envBase(), fetchImpl, aliasMap: ALIASES, nowSec: NOW, ...over };
}

// ─── Due selection ───────────────────────────────────────────────────────────

test('selectDueJobs: only approved+due, oldest-first, and honors the per-run cap', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ id: 'future', publish_at: 9999 }));                       // not due
  db.seedJob(dueJob({ id: 'canceled', state: 'canceled', publish_at: 100 }));    // wrong state
  db.seedJob(dueJob({ id: 'publishing', state: 'publishing', publish_at: 100 })); // wrong state
  db.seedJob(dueJob({ id: 'published', state: 'published', publish_at: 100 }));   // wrong state
  db.seedJob(dueJob({ id: 'nr', state: 'needs_review', publish_at: 100 }));       // wrong state
  db.seedJob(dueJob({ id: 'b', publish_at: 900 }));
  db.seedJob(dueJob({ id: 'a', publish_at: 500 }));                              // oldest
  db.seedJob(dueJob({ id: 'c', publish_at: 1500 }));

  const all = await selectDueJobs(db, NOW);
  assert.deepEqual(all.map((j) => j.id), ['a', 'b', 'c']);   // oldest-first, only due+approved

  const capped = await selectDueJobs(db, NOW, 2);
  assert.deepEqual(capped.map((j) => j.id), ['a', 'b']);     // cap enforced
});

test('PUBLISH_DUE_MAX_PER_RUN bounds a single pass', async () => {
  const db = new FakeDB();
  for (let i = 0; i < PUBLISH_DUE_MAX_PER_RUN + 5; i++) db.seedJob(dueJob({ id: `j${i}`, external_job_id: `e${i}`, publish_at: 100 + i }));
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch();
  const { summary } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(summary.due, PUBLISH_DUE_MAX_PER_RUN);
  assert.equal(fetchImpl.calls.pins, PUBLISH_DUE_MAX_PER_RUN); // never more than the cap in one run
});

// ─── Single-engine reuse + happy path ────────────────────────────────────────

test('runPublishDue publishes a due job through the ONE B1 engine (one Create Pin POST)', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch({ pinBody: { id: '777' } });

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));

  assert.equal(summary.due, 1);
  assert.equal(summary.published, 1);
  assert.equal(summary.claimed, 1);
  assert.equal(fetchImpl.calls.pins, 1);
  assert.equal(db.jobs.get('job1').state, 'published');
  assert.deepEqual(alerts, []);                              // success is never alerted
  // No Pinterest id ever leaks into scheduler output.
  assert.equal(JSON.stringify(summary).includes('777'), false);
});

test('no due jobs → early return, no token load, no fetch, no alert', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ publish_at: 9999 }));   // future only
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch();
  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(summary.due, 0);
  assert.equal(fetchImpl.calls.refresh, 0);
  assert.equal(fetchImpl.calls.boards, 0);
  assert.equal(fetchImpl.calls.pins, 0);
  assert.deepEqual(alerts, []);
});

// ─── Concurrency / duplicate safety ──────────────────────────────────────────

test('two overlapping scheduler runs cannot publish the same job twice', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch();

  const [r1, r2] = await Promise.all([
    runPublishDue(deps(db, fetchImpl)),
    runPublishDue(deps(db, fetchImpl)),
  ]);

  assert.equal(fetchImpl.calls.pins, 1);                       // exactly one Create Pin, ever
  assert.equal(db.jobs.get('job1').state, 'published');
  const totalPublished = r1.summary.published + r2.summary.published;
  assert.equal(totalPublished, 1);                             // published by exactly one run
  const totalSkipped = r1.summary.skipped + r2.summary.skipped;
  assert.equal(totalSkipped, 1);                              // the loser skipped (claim lost), no alert
  assert.deepEqual([...r1.alerts, ...r2.alerts], []);
});

test('a job already claimed by execute-now is a harmless skip (no alert, no second POST)', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ state: 'publishing', claimed_at: NOW, attempt_count: 1 })); // just claimed, fresh lease
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch();

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(summary.due, 0);        // publishing is not selected as due
  assert.equal(summary.skipped, 0);
  assert.equal(fetchImpl.calls.pins, 0);
  assert.deepEqual(alerts, []);
});

// ─── Stale-lease recovery ────────────────────────────────────────────────────

test('sweepStaleLeases moves a stale publishing job → needs_review(stale_claim), never → approved', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ id: 'stuck', state: 'publishing', claimed_at: 0, attempt_count: 1 })); // very old lease
  const swept = await sweepStaleLeases(db, 999999);
  assert.equal(swept.length, 1);
  assert.equal(swept[0].id, 'stuck');
  const job = db.jobs.get('stuck');
  assert.equal(job.state, 'needs_review');       // never silently re-approved
  assert.equal(job.error_category, 'stale_claim');
});

test('a fresh publishing lease is left untouched by the sweep', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ id: 'fresh', state: 'publishing', claimed_at: 999900, attempt_count: 1 }));
  const swept = await sweepStaleLeases(db, 999999);
  assert.equal(swept.length, 0);
  assert.equal(db.jobs.get('fresh').state, 'publishing');
});

test('runPublishDue emits exactly one stale_claim alert per swept job', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ id: 'stuck', state: 'publishing', claimed_at: 0, attempt_count: 3 }));
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch();

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl, { nowSec: 999999 }));
  assert.equal(summary.stale_swept, 1);
  const stale = alerts.filter((a) => a.event === 'pinterest_stale_claim');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].error_category, 'stale_claim');
});

// ─── Execution outcomes → summary + alert discipline ─────────────────────────

test('definite Pinterest rejection → needs_review + one alert', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch({ pinStatus: 400 });

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(summary.needs_review, 1);
  assert.equal(db.jobs.get('job1').state, 'needs_review');
  const nr = alerts.filter((a) => a.event === 'pinterest_needs_review');
  assert.equal(nr.length, 1);
  assert.equal(nr[0].error_category, 'pinterest_rejected');
});

test('ambiguous 5xx/network → needs_review + alert (left permanently for a human)', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch({ pinThrows: true });

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(summary.needs_review, 1);
  assert.equal(alerts.filter((a) => a.event === 'pinterest_needs_review')[0].error_category, 'ambiguous');
  assert.equal(db.jobs.get('job1').state, 'needs_review');
});

test('safe rate-limit (429) → job stays approved, NO alert, no auto-retry this run', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  seedHealthyProdAccount(db);
  const fetchImpl = makeFetch({ pinStatus: 429 });

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(summary.rate_limited, 1);
  assert.equal(summary.published, 0);
  assert.equal(db.jobs.get('job1').state, 'approved');   // released, retried on a LATER run only
  assert.equal(fetchImpl.calls.pins, 1);                 // single attempt, no in-run retry
  assert.deepEqual(alerts, []);                          // a single deferral is not alert-worthy
});

// ─── Publish-time token safety (shared refresh implementation) ───────────────

test('healthy token → no refresh call before publishing', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  seedHealthyProdAccount(db);                       // 30d out — healthy
  const fetchImpl = makeFetch();
  await runPublishDue(deps(db, fetchImpl));
  assert.equal(fetchImpl.calls.refresh, 0);
  assert.equal(db.refreshWrites, 0);
});

test('near-expiry token → shared refresh runs ONCE and rotates before publishing', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob());
  db.seedAccount({ id: 'acct-prod', platform: 'pinterest', platform_user_id: 'owner-prod', access_token: 'pina_old', refresh_token: 'pinr_old', token_expires_at: NOW + 30 * 60 }); // 30 min left
  const fetchImpl = makeFetch();

  const { summary } = await runPublishDue(deps(db, fetchImpl));
  assert.equal(fetchImpl.calls.refresh, 1);            // refreshed once for the run
  assert.equal(db.accounts.get('acct-prod').refresh_token, 'pinr_new'); // rotating token persisted
  assert.equal(summary.published, 1);
});

test('unusable token (refresh rejected) → reconnect alert once; engine still fails jobs closed, no Create Pin hammering', async () => {
  const db = new FakeDB();
  db.seedJob(dueJob({ account_id: 'acct-prod' }));
  // Near-expiry so a refresh is attempted; make the refresh reject, AND the account token is
  // expired so the B1 engine also fails the job to reconnect_required without a Create Pin.
  db.seedAccount({ id: 'acct-prod', platform: 'pinterest', platform_user_id: 'owner-prod', access_token: 'pina_old', refresh_token: 'pinr_old', token_expires_at: NOW - 10 });
  const fetchImpl = makeFetch({ refreshStatus: 400, refreshBody: { error: 'invalid_grant' } });

  const { summary, alerts } = await runPublishDue(deps(db, fetchImpl));
  const reconnect = alerts.filter((a) => a.event === 'pinterest_token_reconnect_required');
  assert.equal(reconnect.length, 1);                  // alerted once
  assert.equal(fetchImpl.calls.pins, 0);              // never hammered Create Pin with a dead token
  assert.equal(db.jobs.get('job1').state, 'needs_review');
  assert.equal(summary.needs_review, 1);
});

// ─── Static: cron route auth + inert GitHub workflow ─────────────────────────

test('publish-due cron route authenticates with CRON_SECRET only (fail-closed), no other auth path', () => {
  const route = readFileSync(join(ROOT, 'functions', '[[route]].js'), 'utf8');
  const idx = route.indexOf("'/api/cron/publish-due'");
  assert.ok(idx > 0, 'publish-due route must exist');
  const handler = route.slice(idx, idx + 1200);
  assert.ok(/CRON_SECRET/.test(handler), 'must gate on CRON_SECRET');
  assert.ok(/not_configured|503/.test(handler), 'must fail closed (503) when secret unset');
  assert.ok(/401|unauthorized/.test(handler), 'must 401 on bad Authorization');
  assert.ok(/Bearer/.test(handler), 'must use Bearer scheme');
  // Must NOT accept the internal token or a normal cp_ API key for this cron.
  assert.equal(/CREATORPOST_INTERNAL_TOKEN/.test(handler), false);
  assert.equal(/cp_session|apiKey|api_key/.test(handler), false);
});

test('GitHub workflow is inert: 5-min schedule, only CRON_SECRET, no Pinterest creds/internal token, no Pin creation', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'pinterest-publish-due.yml'), 'utf8');
  assert.ok(/on:\s*[\s\S]*schedule:/.test(yml), 'has a schedule trigger');
  assert.ok(/cron:\s*'2-57\/5 \* \* \* \*'/.test(yml), 'off-the-hour ~5-min cadence');
  assert.ok(/\/api\/cron\/publish-due/.test(yml), 'targets the publish-due endpoint');
  assert.ok(/secrets\.CRON_SECRET/.test(yml), 'passes CRON_SECRET');
  // No production Pinterest credentials, internal token, or direct Pin API surface in CI.
  assert.equal(/PINTEREST_CLIENT_SECRET|PINTEREST_CLIENT_ID|refresh_token|access_token/.test(yml), false);
  assert.equal(/CREATORPOST_INTERNAL_TOKEN/.test(yml), false);
  assert.equal(/api\.pinterest\.com/.test(yml), false);
  // Documented as built-not-activated.
  assert.ok(/NOT ACTIVATED/i.test(yml), 'header must state it is inert');
});
