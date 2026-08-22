// Pinterest single-Pin publishing engine (Phase B, slice B1 — BUILT, NOT ACTIVATED).
//
// This is the ONE publication engine that both immediate (execute-now, B1) and
// scheduled (cron publish-due, B3) paths call — there is no second implementation.
// Flow per approved job:
//   claim exactly once (atomic) → load owner-prod account → resolve board alias
//   against the LIVE board list (in memory) → build the Create Pin payload from OUR
//   data → perform AT MOST ONE POST /v5/pins → classify → published | needs_review
//   | released (rate-limited, not executed).
//
// Invariants: no Pinterest board_id or pin_id is ever persisted; the Create Pin call
// is never blind-retried; ambiguous outcomes go to needs_review for human inspection.
// Every production fetch is host-locked to api.pinterest.com via assertProductionUrl.

import { assertProductionUrl, PINTEREST_PRODUCTION_HOST } from './pinterest-production.js';
import { resolveBoardMatch } from './pinterest-boards.js';

const PINTEREST_PRODUCTION_API_BASE = `https://${PINTEREST_PRODUCTION_HOST}/v5`;

export const PINTEREST_JOB_STATES = {
  APPROVED:     'approved',
  PUBLISHING:   'publishing',
  PUBLISHED:    'published',
  NEEDS_REVIEW: 'needs_review',
  CANCELED:     'canceled',
};

export const PINTEREST_AI_DISCLOSURE_VALUES = ['AI_MODIFIED', 'SYNTHETIC_PERFORMER'];

// Field length limits (Pinterest v5 Create Pin).
const LIMITS = { title: 100, description: 800, link: 2048, alt_text: 500 };

// Lease/attempt bounds for crash recovery (§12).
export const STALE_LEASE_SECONDS = 15 * 60;
export const MAX_ATTEMPTS = 3;

const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };

// ─── Pure: validation ────────────────────────────────────────────────────────

// Validate ONE already-approved single-Pin job instruction. Returns
// { ok:true } or { ok:false, errors:[{field,msg}] }. Image bytes/type are validated
// separately at staging (stagePinImageToR2).
export function validateSinglePinJob(input) {
  const errors = [];
  const reqStr = (v) => typeof v === 'string' && v.trim().length > 0;

  if (!reqStr(input?.external_job_id)) errors.push({ field: 'external_job_id', msg: 'required' });
  if (!reqStr(input?.source))          errors.push({ field: 'source', msg: 'required' });
  if (!reqStr(input?.board_alias))     errors.push({ field: 'board_alias', msg: 'required' });

  for (const f of ['title', 'description', 'link', 'alt_text']) {
    const v = input?.[f];
    if (v == null) continue;
    if (typeof v !== 'string') { errors.push({ field: f, msg: 'must be a string' }); continue; }
    if (v.length > LIMITS[f]) errors.push({ field: f, msg: `exceeds ${LIMITS[f]} chars` });
  }

  const ai = input?.ai_disclosure;
  if (ai != null && !PINTEREST_AI_DISCLOSURE_VALUES.includes(ai)) {
    errors.push({ field: 'ai_disclosure', msg: `must be null or one of ${PINTEREST_AI_DISCLOSURE_VALUES.join(', ')}` });
  }

  if (!Number.isInteger(input?.publish_at) || input.publish_at < 0) {
    errors.push({ field: 'publish_at', msg: 'must be a UTC unix-seconds integer' });
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

// ─── Pure: Create Pin payload ────────────────────────────────────────────────

// Build the exact Pinterest v5 Create Pin body from OUR stored job + a live-resolved
// board_id + our own R2 image URL. Optional text fields are omitted when absent; the
// AI-disclosure field is included ONLY when the approved job specifies one (never
// inferred). No unsupported fields are added.
export function buildCreatePinPayload(job, boardId, imageUrl) {
  const payload = {
    board_id:     String(boardId),
    media_source: { source_type: 'image_url', url: imageUrl },
  };
  if (job.title)       payload.title = job.title;
  if (job.description) payload.description = job.description;
  if (job.link)        payload.link = job.link;
  if (job.alt_text)    payload.alt_text = job.alt_text;
  if (job.ai_disclosure) payload.ai_disclosures = { values: [job.ai_disclosure] };
  return payload;
}

// ─── Pure: outcome classifier + claim/lease predicates ───────────────────────

// Classify exactly one Create Pin attempt. `outcome` is either
//   { kind:'response', status, hasId }  or  { kind:'network_error' }.
// Returns { state, error_category }. 'approved' means release (rate-limited, the
// request was NOT executed). needs_review categories are sanitized/local only.
export function classifyCreatePinOutcome(outcome) {
  if (outcome?.kind === 'response') {
    const s = outcome.status;
    if ((s === 200 || s === 201) && outcome.hasId) {
      return { state: PINTEREST_JOB_STATES.PUBLISHED, error_category: null };
    }
    // 429 → rate limited: the create was rejected before execution, so the Pin was
    // NOT created. Safe to release/defer, NOT an ambiguous write.
    if (s === 429) return { state: PINTEREST_JOB_STATES.APPROVED, error_category: 'rate_limited' };
    // 5xx / no reliable response → Pin creation cannot be ruled out → ambiguous.
    if (s >= 500)  return { state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: 'ambiguous' };
    // Other 4xx → definite rejection (validation/permission/invalid board/media).
    if (s >= 400)  return { state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: 'pinterest_rejected' };
    // 2xx without an id, or anything else unexpected → cannot confirm → ambiguous.
    return { state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: 'ambiguous' };
  }
  // Network timeout / connection reset after submission → ambiguous, never retried.
  return { state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: 'ambiguous' };
}

// Pure: can this row be claimed now? Mirrors the atomic claim WHERE clause.
export function canClaim(row, nowSec) {
  return !!row && row.state === PINTEREST_JOB_STATES.APPROVED && row.publish_at <= nowSec;
}

// Pure: is a claimed ('publishing') job a stale lease eligible for conservative
// recovery? A stale claim is resolved to needs_review — NEVER silently re-approved,
// because a prior attempt may already have created a Pin.
export function isStaleLease(row, nowSec) {
  if (!row || row.state !== PINTEREST_JOB_STATES.PUBLISHING) return false;
  const leaseExpired = typeof row.claimed_at === 'number' && row.claimed_at < nowSec - STALE_LEASE_SECONDS;
  return leaseExpired || row.attempt_count >= MAX_ATTEMPTS;
}

// ─── Content hash (dedupe key, §13) ──────────────────────────────────────────

export async function computeContentHash(input) {
  const canonical = JSON.stringify({
    external_job_id: input.external_job_id,
    source:          input.source,
    board_alias:     input.board_alias,
    title:           input.title ?? null,
    description:     input.description ?? null,
    link:            input.link ?? null,
    alt_text:        input.alt_text ?? null,
    ai_disclosure:   input.ai_disclosure ?? null,
    publish_at:      input.publish_at,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── D1: claim / finalize / load (thin executors of the decisions above) ─────

// Atomic single-statement claim. Only a row currently 'approved' AND due can be
// claimed; RETURNING gives us the row we now exclusively own. Concurrent/duplicate
// callers get null. (D1 serializes writes; a single UPDATE is atomic.)
export async function claimJob(DB, id, nowSec) {
  const row = await DB.prepare(
    `UPDATE pinterest_publish_jobs
        SET state = 'publishing', claimed_at = ?, attempt_count = attempt_count + 1
      WHERE id = ? AND state = 'approved' AND publish_at <= ?
      RETURNING *`,
  ).bind(nowSec, id, nowSec).first();
  return row ?? null;
}

export async function finalizePublished(DB, id, nowSec) {
  await DB.prepare(
    `UPDATE pinterest_publish_jobs
        SET state = 'published', published_at = ?, claimed_at = NULL, error_category = NULL
      WHERE id = ? AND state = 'publishing'`,
  ).bind(nowSec, id).run();
}

export async function finalizeNeedsReview(DB, id, errorCategory) {
  await DB.prepare(
    `UPDATE pinterest_publish_jobs
        SET state = 'needs_review', error_category = ?, claimed_at = NULL
      WHERE id = ? AND state = 'publishing'`,
  ).bind(errorCategory, id).run();
}

// Release a claimed job back to approved WITHOUT resetting attempt_count — used only
// when the create was provably NOT executed (rate limited).
export async function releaseToApproved(DB, id) {
  await DB.prepare(
    `UPDATE pinterest_publish_jobs
        SET state = 'approved', claimed_at = NULL
      WHERE id = ? AND state = 'publishing'`,
  ).bind(id).run();
}

export async function loadAccountById(DB, accountId) {
  return DB.prepare(
    'SELECT access_token, token_expires_at FROM connected_accounts WHERE id = ?',
  ).bind(accountId).first();
}

// ─── Pinterest I/O (host-locked; injectable fetch for tests) ─────────────────

// List the owner's boards live (bookmark-paginated, bounded). Returns [{id,name,...}].
// Throws on a non-OK response so the caller can classify a list failure safely.
export async function listBoards(fetchImpl, accessToken, apiBase = PINTEREST_PRODUCTION_API_BASE) {
  const boards = [];
  let bookmark = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${apiBase}/boards`);
    // Documented default page_size is 25; the max is not documented, so stay at the
    // safe default and rely on bookmark pagination (bounded to 10 pages) instead.
    url.searchParams.set('page_size', '25');
    if (bookmark) url.searchParams.set('bookmark', bookmark);
    const target = url.toString();
    assertProductionUrl(target);
    const res = await fetchImpl(target, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`board_list_status_${res.status}`);
    const data = await res.json();
    for (const b of data.items ?? []) boards.push(b);
    bookmark = data.bookmark || null;
    if (!bookmark) break;
  }
  return boards;
}

// Perform EXACTLY ONE Create Pin attempt. No retry, no withRetry. Returns an outcome
// descriptor for the classifier. The returned Pin id is inspected only to confirm
// definite success and is then DISCARDED — never returned to the caller or persisted.
export async function createPinOnce(fetchImpl, accessToken, payload, apiBase = PINTEREST_PRODUCTION_API_BASE) {
  const url = `${apiBase}/pins`;
  assertProductionUrl(url);
  let res;
  try {
    res = await fetchImpl(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch {
    // Timeout / connection reset — the write may or may not have landed.
    return { kind: 'network_error' };
  }
  let hasId = false;
  if (res.ok) {
    try {
      const body = await res.json();
      hasId = typeof body?.id === 'string' && body.id.length > 0;
    } catch {
      hasId = false;
    }
  }
  return { kind: 'response', status: res.status, hasId };
}

// ─── Orchestrator: the shared claim+publish engine ───────────────────────────

// Execute one approved job by id. deps: { DB, env, fetchImpl?, aliasMap?, nowSec }.
// Returns a summary { claimed, state?, error_category? }. Callers (execute-now now,
// cron later) alert/observe from the summary; the engine itself persists no Pinterest
// data and performs at most one Create Pin attempt.
export async function executeApprovedJob(deps, jobId) {
  const { DB, env, fetchImpl = fetch, aliasMap, nowSec } = deps;

  const job = await claimJob(DB, jobId, nowSec);
  if (!job) return { claimed: false };

  const account = await loadAccountById(DB, job.account_id);
  if (!account?.access_token ||
      (typeof account.token_expires_at === 'number' && account.token_expires_at <= nowSec)) {
    await finalizeNeedsReview(DB, jobId, 'reconnect_required');
    return { claimed: true, state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: 'reconnect_required' };
  }

  let boards;
  try {
    boards = await listBoards(fetchImpl, account.access_token);
  } catch {
    await finalizeNeedsReview(DB, jobId, 'board_list_failed');
    return { claimed: true, state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: 'board_list_failed' };
  }

  const match = resolveBoardMatch(job.board_alias, boards, aliasMap);
  if (!match.ok) {
    await finalizeNeedsReview(DB, jobId, match.reason);
    return { claimed: true, state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: match.reason };
  }

  const imageUrl = `${String(env.R2_PUBLIC_URL).replace(/\/$/, '')}/${job.image_key}`;
  const payload = buildCreatePinPayload(job, match.boardId, imageUrl);

  // EXACTLY ONE attempt.
  const outcome = await createPinOnce(fetchImpl, account.access_token, payload);
  const decision = classifyCreatePinOutcome(outcome);

  if (decision.state === PINTEREST_JOB_STATES.PUBLISHED) {
    await finalizePublished(DB, jobId, nowSec);   // Pin id already discarded
    return { claimed: true, state: PINTEREST_JOB_STATES.PUBLISHED };
  }
  if (decision.state === PINTEREST_JOB_STATES.APPROVED) {
    await releaseToApproved(DB, jobId);            // rate limited → not executed
    return { claimed: true, state: PINTEREST_JOB_STATES.APPROVED, error_category: decision.error_category };
  }
  await finalizeNeedsReview(DB, jobId, decision.error_category);
  return { claimed: true, state: PINTEREST_JOB_STATES.NEEDS_REVIEW, error_category: decision.error_category };
}

// ─── Single-job ingestion seam (B1 only — NOT cohort ingestion) ──────────────

// Validate a single approved job's image bytes and stage them durably in R2 under a
// PERSISTENT prefix (a scheduled job may be >24h out, so NOT the 24h temp convention).
// Returns the R2 object key. Throws on a disallowed content type.
export async function stagePinImageToR2(env, jobId, bytes, contentType) {
  const ext = ALLOWED_IMAGE_TYPES[contentType];
  if (!ext) throw new Error('unsupported_image_type');
  const key = `pinterest-jobs/${jobId}.${ext}`;
  await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return key;
}

// Build (but do not run) the prepared INSERT for ONE already-approved job
// (state='approved'). This is the single source of truth for the job-insert column
// contract, so both the single-job path and B2's atomic DB.batch() cohort insert use
// exactly the same statement. Returns a bound D1 prepared statement.
export function buildApprovedPinJobInsert(DB, job, nowSec) {
  return DB.prepare(
    `INSERT INTO pinterest_publish_jobs
       (id, external_job_id, source, manifest_id, content_hash, user_id, account_id,
        board_alias, title, description, link, alt_text, image_key, ai_disclosure,
        publish_at, approved_at, state, attempt_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0, ?)`,
  ).bind(
    job.id, job.external_job_id, job.source, job.manifest_id, job.content_hash,
    job.user_id, job.account_id, job.board_alias,
    job.title ?? null, job.description ?? null, job.link ?? null, job.alt_text ?? null,
    job.image_key, job.ai_disclosure ?? null,
    job.publish_at, nowSec, nowSec,
  );
}

// Insert ONE already-approved job. The UNIQUE(source, external_job_id) constraint
// rejects a duplicate submission. Behavior is unchanged from B1; it now delegates to
// buildApprovedPinJobInsert so the column contract lives in one place.
export async function insertApprovedPinJob(DB, job, nowSec) {
  await buildApprovedPinJobInsert(DB, job, nowSec).run();
  return job.id;
}
