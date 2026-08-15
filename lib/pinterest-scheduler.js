// Pinterest scheduled executor (Phase B, slice B3 — BUILT, NOT ACTIVATED).
//
// This is the unattended wake-up layer ONLY. It does NOT create Pins itself: it finds
// bounded due `approved` jobs, ensures the production token is usable via the ONE shared
// refresh implementation, and hands each job to the EXACT SAME B1 engine
// (executeApprovedJob) that execute-now uses. There is no second Create Pin path.
//
// Duplicate-safety is the D1 atomic claim inside executeApprovedJob — scheduler
// selection alone confers NO ownership, so overlapping/duplicate cron runs and a
// simultaneous execute-now cannot double-publish. Ambiguous writes are left permanently
// for human review; cron frequency is NOT a retry mechanism.

import {
  executeApprovedJob,
  isStaleLease,
  PINTEREST_JOB_STATES,
} from './pinterest-publish.js';
import {
  loadPinterestProductionAccount,
  ensurePinterestTokenFresh,
  PUBLISH_SAFETY_THRESHOLD_SECONDS,
} from './pinterest-token.js';

// Small per-run cap: real volume is a few Pins/day, and one Pages Function invocation
// must not run an unbounded serial batch. Extra due jobs simply wait for the next run.
export const PUBLISH_DUE_MAX_PER_RUN = 10;

// ─── Due selection ───────────────────────────────────────────────────────────

// Only `approved` AND due rows, oldest first, bounded. Never selects canceled /
// publishing / published / needs_review, and never touches future jobs.
export async function selectDueJobs(DB, nowSec, limit = PUBLISH_DUE_MAX_PER_RUN) {
  const res = await DB.prepare(
    `SELECT id, source, external_job_id, title, publish_at
       FROM pinterest_publish_jobs
      WHERE state = 'approved' AND publish_at <= ?
      ORDER BY publish_at ASC
      LIMIT ?`,
  ).bind(nowSec, limit).all();
  return res?.results ?? [];
}

// ─── Stale-lease sweep (conservative: → needs_review, never → approved) ──────

// A job stuck in `publishing` beyond the lease/attempt bound may have created a Pin
// before its process died, so it is NEVER silently re-approved — it becomes
// needs_review('stale_claim') for human inspection. Returns the swept jobs (for a
// single alert each).
export async function sweepStaleLeases(DB, nowSec) {
  const res = await DB.prepare(
    `SELECT id, state, source, external_job_id, title, publish_at, claimed_at, attempt_count
       FROM pinterest_publish_jobs
      WHERE state = 'publishing'`,
  ).bind().all();
  const rows = res?.results ?? [];
  const swept = [];
  for (const row of rows) {
    if (!isStaleLease(row, nowSec)) continue;
    // Conditional so we never race a legitimately-finishing publisher.
    const upd = await DB.prepare(
      `UPDATE pinterest_publish_jobs
          SET state = 'needs_review', error_category = 'stale_claim', claimed_at = NULL
        WHERE id = ? AND state = 'publishing'`,
    ).bind(row.id).run();
    const changed = upd?.meta?.changes ?? upd?.changes ?? 0;
    if (changed > 0) {
      swept.push({ id: row.id, source: row.source, external_job_id: row.external_job_id, title: row.title, publish_at: row.publish_at });
    }
  }
  return swept;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

function jobLabel(job) {
  return { id: job.id, source: job.source, external_job_id: job.external_job_id, title: job.title ?? null, publish_at: job.publish_at };
}

// Run one scheduled pass. deps: { DB, env, fetchImpl?, aliasMap?, nowSec, maxPerRun?,
// tokenThresholdSec? }. Returns { summary, alerts } — the route emits `alerts` to Discord
// (local sanitized data only) and returns `summary`. The scheduler NEVER emits alerts for
// success, no-op runs, or an already-claimed job.
export async function runPublishDue(deps) {
  const {
    DB, env, fetchImpl = fetch, aliasMap, nowSec,
    maxPerRun = PUBLISH_DUE_MAX_PER_RUN,
    tokenThresholdSec = PUBLISH_SAFETY_THRESHOLD_SECONDS,
  } = deps;

  const alerts = [];

  // 1) Conservative stale-lease recovery first (tiny volume).
  const swept = await sweepStaleLeases(DB, nowSec);
  for (const job of swept) alerts.push({ event: 'pinterest_stale_claim', job, error_category: 'stale_claim' });

  // 2) Bounded due-job selection.
  const due = await selectDueJobs(DB, nowSec, maxPerRun);
  const summary = {
    due: due.length, claimed: 0, published: 0, needs_review: 0,
    rate_limited: 0, skipped: 0, stale_swept: swept.length,
  };
  if (due.length === 0) return { summary, alerts };

  // 3) Publish-time token safety — the SAME shared refresh implementation as the 6h
  //    proactive cron, run ONCE for the single owner-prod account before executing.
  const account = await loadPinterestProductionAccount(DB);
  const tokenState = await ensurePinterestTokenFresh({ ...deps, fetchImpl }, account, tokenThresholdSec);
  if (tokenState.result === 'reconnect') {
    // Do NOT hammer Create Pin with an unusable token. The B1 engine (below) still
    // fails each job closed to needs_review('reconnect_required'); alert once here.
    alerts.push({ event: 'pinterest_token_reconnect_required', job: null, error_category: 'reconnect_required' });
  }

  // 4) Execute each due job through the ONE B1 engine, sequentially (simpler rate-limit
  //    + duplicate behavior). The engine performs the atomic claim; selection is not
  //    ownership, so an already-claimed job is a harmless skip.
  for (const job of due) {
    const result = await executeApprovedJob({ DB, env, fetchImpl, aliasMap, nowSec }, job.id);
    if (!result.claimed) { summary.skipped++; continue; }
    summary.claimed++;
    switch (result.state) {
      case PINTEREST_JOB_STATES.PUBLISHED:
        summary.published++;
        break;
      case PINTEREST_JOB_STATES.APPROVED:            // rate-limited release (not executed)
        summary.rate_limited++;
        break;
      case PINTEREST_JOB_STATES.NEEDS_REVIEW:
        summary.needs_review++;
        alerts.push({ event: 'pinterest_needs_review', job: jobLabel(job), error_category: result.error_category ?? 'ambiguous' });
        break;
      default:
        break;
    }
  }
  return { summary, alerts };
}
