# Pinterest Phase B — Slice B1: Single Approved-Pin Publishing Engine (BUILT, NOT ACTIVATED)

**Status:** Code complete, built on top of B0 (`d1f07cb`). **Not deployed, not pushed to publish,
not activated. No production OAuth performed, no real Pin created, no production D1/R2 mutated, no
scheduler touched.** Governing rule: **BUILD ASSUMING APPROVAL, ACTIVATE ONLY AFTER APPROVAL.**
Pinterest Standard access is still under review.

---

## 1. Mission / scope of this slice

B1 builds the smallest mechanical primitive that takes **one** explicitly human-approved Pinterest
Pin instruction and executes it safely, end to end:

> approved instruction → validate → immutable local job → claim exactly once → resolve the local
> board alias against the **live** Pinterest board list → build the Create Pin payload from data we
> own → perform **exactly one** Create Pin attempt → classify → `published` **or** `needs_review`
> (**or** released back to `approved` when rate-limited, because the write was provably *not*
> executed).

This is the **one** publication engine. Both the immediate path (execute-now, this slice) and the
future scheduled path (B3 cron) call the same `executeApprovedJob()` — there is deliberately no
second "publish immediately" implementation.

## 2. Human-approval assumption

The engine assumes approval already happened upstream. A job only enters the system in state
`approved`; there is no `pending_review` state and no approval workflow here. The immutable job row
*is* the approval record.

## 3. What was built

| Piece | Location |
|---|---|
| Job table (additive) | `schema.sql` (`pinterest_publish_jobs`) + `migrations/2026-08-15-pinterest-publish-jobs.sql` |
| Board alias resolution (pure) | `lib/pinterest-boards.js` (`resolveBoardMatch`) |
| Publishing engine (pure decisions + thin D1 executors + injectable I/O + orchestrator) | `lib/pinterest-publish.js` |
| Two owner-only endpoints (ingest one job, execute-now) | `functions/[[route]].js` |
| Tests | `test/pinterest-publish.test.js` (41 tests) |
| This doc | `docs/pinterest-phase-b1-single-pin-engine.md` |

## 4. Real job model (`pinterest_publish_jobs`)

Columns store **only data we own or the owner's approved instruction**. States:
`approved | publishing | published | needs_review | canceled` (no `pending_review`).
`UNIQUE(source, external_job_id)` gives ingestion dedupe. Two indexes support due-scan
(`state, publish_at`) and per-source lookup. See `schema.sql` lines for column-level comments.

**Never persisted:** the Pinterest `board_id` (resolved live, held in memory, discarded) and the
Pinterest `pin_id` (inspected only to confirm definite success, then discarded). `error_category`
is a **local sanitized category** — never a raw Pinterest body.

## 5. Minimal single-job ingestion seam (why this shape)

B1 needs *a* way to get one approved job in. The chosen seam is the **smallest** that works:
`POST /api/internal/pinterest/jobs` accepts a multipart body — one JSON `manifest` part (the approved
instruction) + one `image` file — validates it, stages the image, computes the content hash, and
inserts exactly one `approved` row. It is **owner-session gated only** (no new `CREATORPOST_INTERNAL_TOKEN`
secret was introduced — that, plus multi-image cohort manifests, manifest-level idempotency, and
CLI productization, are explicitly deferred to B2). It supports **one** job per call by construction.

## 6. R2 image staging (SSRF-safe, jpeg/png only)

`stagePinImageToR2(env, jobId, bytes, contentType)` accepts **only** `image/jpeg`/`image/png` and
writes to a **persistent** key `pinterest-jobs/<job_id>.<ext>` (a scheduled job may be >24h out, so
the 24h temp-cleanup convention is intentionally *not* used). The Create Pin payload references our
own `R2_PUBLIC_URL` object — Pinterest fetches only from our bucket, so there is no user-controlled
URL and no SSRF surface.

## 7. Board alias resolution (never guess, never auto-create)

The manifest carries a **local** alias we own (e.g. `home-maintenance`), never a Pinterest id.
`resolveBoardMatch(alias, liveBoards, aliasMap)` maps the alias to an expected board **name**, then
requires **exactly one** case-insensitive match in the live board list:

- exactly one → resolved `board_id` (in memory only)
- unknown alias → `unknown_board_alias` → `needs_review`
- zero matches → `board_alias_unresolved` → `needs_review`
- more than one → `board_alias_ambiguous` → `needs_review`

The engine never guesses and never creates a board.

## 8. Create Pin payload + AI disclosure

`buildCreatePinPayload(job, boardId, imageUrl)` emits exactly:
`board_id`, `media_source: { source_type: 'image_url', url }`, and — only when present —
`title`/`description`/`link`/`alt_text`. `ai_disclosures` is included **only** when the approved job
specifies one, as `{ values: ['AI_MODIFIED'] }` (or `SYNTHETIC_PERFORMER`). The enum is validated at
ingestion; `AI_GENERATED` is **not** a valid Pinterest value and is rejected. No unsupported fields
are ever added.

## 9. Exactly one Create Pin attempt (no blind retry)

`createPinOnce()` performs **one** `POST /v5/pins` and returns an outcome descriptor. It is **not**
wrapped in `withRetry`; 5xx, network errors, and timeouts are **never** retried, because a retry could
create a duplicate Pin. A thrown fetch maps to `{ kind: 'network_error' }`; otherwise
`{ kind: 'response', status, hasId }`. The returned Pin id is used only to confirm `hasId` and is then
discarded.

## 10. Outcome classifier

`classifyCreatePinOutcome(outcome)`:

| Outcome | Result | Meaning |
|---|---|---|
| 200/201 **with** id | `published` | confirmed created |
| 429 | `approved` + `rate_limited` | **rejected before execution → not created → safe to release/defer** |
| ≥500 | `needs_review` + `ambiguous` | create cannot be ruled out |
| other 4xx | `needs_review` + `pinterest_rejected` | definite rejection (validation/permission/media) |
| 2xx **without** id / anything else | `needs_review` + `ambiguous` | cannot confirm |
| network error / timeout | `needs_review` + `ambiguous` | write may or may not have landed |

The "ambiguous → `needs_review`, never auto-retry" bias is deliberate: a human inspects rather than
risk a duplicate.

## 11. Atomic claim + duplicate protection

`claimJob()` is a single atomic `UPDATE … SET state='publishing', attempt_count=attempt_count+1
WHERE id=? AND state='approved' AND publish_at<=? RETURNING *`. Only an `approved` **and due** row can
be claimed; concurrent/duplicate callers get `null`. A job already `publishing`, `published`,
`needs_review`, or `canceled` cannot be claimed. A **stale** `publishing` lease is **not** silently
re-approved (a prior attempt may already have created a Pin) — `isStaleLease()` flags it for
conservative human recovery instead.

## 12. Immediate execute path (shares the engine)

`POST /api/internal/pinterest/jobs/:id/execute-now` (owner-session gated) calls the **same**
`executeApprovedJob()` the B3 scheduler will call. There is no separate immediate implementation.
It returns a small summary (`{ claimed, state?, error_category? }`); an unclaimable job → 409.

## 13. Production OAuth dependency (mocked in tests)

The engine reads the owner-prod account token via `loadAccountById()` and host-locks every Pinterest
call to `api.pinterest.com` via `assertProductionUrl()` (from B0's `lib/pinterest-production.js`).
No production OAuth is performed in B1; tests inject a fake token and a mocked `fetchImpl`, so **no
live network call is ever made**. Missing/expired token → `needs_review` + `reconnect_required`
before any fetch.

## 14. Endpoints (owner-only, off the generic route)

Both endpoints are gated on the owner session (`isPhaseAOwner`) and are **not** reachable through the
existing generalized public/API-key publish routes — Pinterest is deliberately kept off that surface.

## 15. What is intentionally NOT here (deferred)

No scheduler / cron changes of any kind; no cohort ingestion (15-item manifests, manifest hash/dedupe,
Content Lab integration, CLI, multipart multi-image); no UI (composer, board picker, uploader,
calendar, jobs dashboard, settings); no proactive token refresh; no `board_id`/`pin_id` persistence;
no generic `posts`-table reuse; no `CREATORPOST_INTERNAL_TOKEN`. B0 was not amended.

## 16. Tests (`npm test` → all green)

41 B1 tests + 27 pre-existing = **68 pass, 0 fail**. Coverage: job-model validation; schema
guardrail (no `board_id`/`pin_id` columns); atomic claim (first succeeds / second fails /
canceled·published·needs_review not claimable / not-yet-due not claimable / stale not auto-retried);
board resolution (1/0/>1/unknown); payload mapping + AI included/omitted + no unsupported value +
image source; classifier (all branches); `createPinOnce` (exactly one attempt, id never surfaced,
network→network_error, sandbox host refused); `listBoards` sandbox host refused; `executeApprovedJob`
end-to-end (published + id-not-persisted, zero-board → no POST, ambiguous, 5xx, 4xx, 429-release,
reconnect_required, expired token, concurrent-claim → one POST, already-publishing → no POST); R2
staging (type guard + persistent prefix); content hash (deterministic + changes); ingestion dedupe.

## 17. Migration safety & future apply

`schema.sql` updated and a **smallest additive** migration created
(`migrations/2026-08-15-pinterest-publish-jobs.sql`): one new table + two indexes, `IF NOT EXISTS`,
no existing table altered, no backfill. **NOT applied to production.** Future apply command (from the
migration header):

```
wrangler d1 execute creatorpost --remote --file=migrations/2026-08-15-pinterest-publish-jobs.sql
```

## 18. Logging discipline

Logs record event names, sanitized `error_category`, HTTP status, and `state` only — **never** tokens,
authorization data, raw Pinterest response bodies, secrets, or image contents.

## 19. Official-doc verification

Pinterest v5 docs were re-checked against this design (Create Pin `media_source.image_url` uses field
`url`; `ai_disclosures.values` enum is `AI_MODIFIED`/`SYNTHETIC_PERFORMER`, no `AI_GENERATED`; success
is 200/201 returning `Pin{id}` with no `url`; **no idempotency mechanism** exists). No material
contradiction with the Rev 2 design was found, so no STOP was triggered. One caveat: the spec models a
429 as a pre-execution rejection (error body, no Pin id) rather than stating it verbatim; the engine
treats 429 as "not executed → release", which is the safe reading.

## 20. Activation (NOT authorized yet)

When Standard is approved: apply the migration (§17), connect the owner-prod account (B0), then create
a job via the ingest endpoint and call execute-now for a single real Pin. Until then execute-now has
no connected account and publishes nothing. Activation remains **not authorized**.
