# Pinterest Phase B / B3 — Scheduled Executor + Token Lifecycle + Failure Alerting

> **BUILD ONLY. NOT ACTIVATED.** Everything described here exists in code and tests but is
> inert. No production deploy, no pushed branch, no real Pinterest call, no enabled GitHub
> schedule, no production secret. Activation is gated and documented in §19–§20 below.

## 1. Mission

Make unattended publication of *already-approved* Pinterest jobs mechanically possible in
code and tests — without enabling it. B3 owns exactly five things: (1) waking up on a
schedule; (2) production Pinterest token lifecycle; (3) invoking the existing B1 engine for
due approved jobs; (4) minimal scheduler health/reporting; (5) alerting a human when
intervention is required. It owns nothing else — no composer, no calendar, no approval UI,
no generalized job queue.

## 2. Baseline

Built on top of B0 (`d1f07cb`, production isolation helpers), B1 (`731e0fe`, the single
Create-Pin engine `executeApprovedJob`), and B2 (`2e08800`, approved-cohort manifest
ingestion). Starting HEAD for B3 was `2e08800` on `pinterest-phase-b2-cohort-ingestion`;
B3 work lives on branch `pinterest-phase-b3-scheduled-executor`. No B0/B1/B2 file behavior
was altered (one additive column was added to a scheduler SELECT — see §10).

## 3. Official documentation verified

Re-verified against Pinterest v5 and GitHub Actions docs on 2026-08-15:

- **Pinterest OAuth refresh:** `POST https://api.pinterest.com/v5/oauth/token`, HTTP Basic
  `base64(client_id:client_secret)`, form body `grant_type=refresh_token&refresh_token=…`.
  Access token TTL 30 days (2,592,000 s). Refresh token TTL 60 days, **rotating**: every
  successful refresh returns a **new** `refresh_token` and consumes the old one. No
  idempotency key; no documented retry guidance.
- **GitHub Actions schedule:** minimum cadence 5 minutes; scheduled runs may be delayed
  (especially at the top of the hour) and can occasionally be dropped under load; cron is
  UTC POSIX. These properties only ever *delay* publication — jobs remain `approved` until
  claimed, never lost — so they are acceptable for a low-volume, few-Pins/day cadence.

No fact contradicted the canonical Rev-2 design, so no STOP condition was triggered.

## 4. Scheduler mechanism

A GitHub Actions scheduled workflow (`.github/workflows/pinterest-publish-due.yml`) issues
an authenticated `POST /api/cron/publish-due` to the deployed Pages Function. The route
calls `runPublishDue()` (`lib/pinterest-scheduler.js`), which does one bounded pass and
returns. There is **no** long-running process, no in-app timer, no generalized scheduler
table — the wake-up signal is entirely external, matching the existing token-refresh cron.

## 5. Cadence

`cron: '2-57/5 * * * *'` — approximately every 5 minutes, deliberately **off** the top of
the hour to avoid GitHub's top-of-hour congestion (the most-dropped slot). Cadence is not a
retry mechanism (see §14/§17): it only revisits still-`approved` due jobs.

## 6. Cron authentication

`/api/cron/publish-due` mirrors the existing `/api/cron/refresh-tokens` contract exactly:

- `CRON_SECRET` unset → **503 `not_configured`** (fail closed).
- `Authorization` header not equal to `Bearer <CRON_SECRET>` → **401 `unauthorized`**.
- Correct Bearer → proceed.

No other credential authorizes this route. The internal token
(`CREATORPOST_INTERNAL_TOKEN`) does **not** work here, and a normal `cp_session` / user API
key does **not** work here. Verified by a static test that inspects the handler.

## 7. Due selection and per-run cap

`selectDueJobs(DB, nowSec, limit)` selects only rows with `state='approved'` **and**
`publish_at <= now`, ordered `publish_at ASC` (oldest first), `LIMIT` = `PUBLISH_DUE_MAX_PER_RUN`
(**10**). Future jobs and every non-approved state (`canceled`/`publishing`/`published`/
`needs_review`) are excluded. A run publishes at most 10 jobs; any overflow simply waits for
the next wake-up. The cap bounds a single Pages Function invocation's serial work.

## 8. B1 engine reuse (one publication implementation)

For each due job, the scheduler calls the **exact** existing engine
`executeApprovedJob({DB, env, fetchImpl, aliasMap, nowSec}, job.id)`. There is no second
Create-Pin code path anywhere in B3. The scheduler never resolves boards, builds payloads,
or calls the Pin API itself — it only *selects* and *delegates*. Selection confers no
ownership; the engine performs its own atomic claim.

## 9. Concurrency and duplicate safety

Duplicate-safety rests entirely on B1's atomic conditional claim
(`UPDATE … SET state='publishing' WHERE id=? AND state='approved' AND publish_at<=? RETURNING *`).
Because selection is not ownership:

- Two overlapping cron runs that both select the same job → only one claim succeeds; the
  loser sees `claimed:false` and records a silent `skipped` (no alert). Exactly one Create
  Pin POST occurs. (Tested.)
- A simultaneous execute-now on the same job → same guarantee.
- A duplicate/re-fired cron trigger → harmless; already-claimed or non-approved jobs are not
  reselected.

No new lock, lease column, or distributed coordination was introduced.

## 10. Stale-lease handling

`sweepStaleLeases(DB, nowSec)` runs first each pass. It scans `state='publishing'` rows and,
for any that `isStaleLease()` deems stale (lease older than `STALE_LEASE_SECONDS` = 15 min,
or `attempt_count >= MAX_ATTEMPTS` = 3), performs a **conditional** transition to
`needs_review` with `error_category='stale_claim'` (`WHERE id=? AND state='publishing'`, so a
legitimately-finishing publisher is never raced). A stale job is **never** silently
re-approved — it may have created a Pin before its process died, so it is left for human
inspection. One `pinterest_stale_claim` alert is emitted per swept job.

> **B3 defect found and fixed in B3 code (not a B0/B1/B2 issue):** the initial sweep SELECT
> omitted the `state` column, but `isStaleLease()` requires `row.state === 'publishing'`, so
> the sweep would have silently never fired. A regression test caught it; the fix adds
> `state` to the SELECT column list. This is the only change to B3's own logic post-first-draft.

## 11. Production token lifecycle

One owner-prod Pinterest account (`platform='pinterest'`, `platform_user_id='owner-prod'`)
holds the production tokens in `connected_accounts`. Freshness is ensured by **one** shared
implementation (`lib/pinterest-token.js`) used by both triggers:

- **Proactive** (existing 6-hour `/api/cron/refresh-tokens`): refresh when the access token
  is within **7 days** of expiry (`PROACTIVE_REFRESH_THRESHOLD_SECONDS`). Keeps the rotating
  60-day chain alive well inside the 30-day access window.
- **Publish-time safety** (inside `/api/cron/publish-due`, once per run before executing):
  refresh only when within **1 hour** of expiry (`PUBLISH_SAFETY_THRESHOLD_SECONDS`). A
  clearly-healthy token is never refreshed at publish time.

Both call `ensurePinterestTokenFresh()` → `refreshPinterestProductionToken()`. There is no
second refresh path. A successful refresh persists the new access token, the **new rotating
refresh token**, and the new expiry together.

## 12. Rotating-refresh concurrency (no new schema)

Two refreshers can share the same stored refresh token (e.g. proactive cron coinciding with
a publish-time refresh). Safety is a **compare-and-swap** persist:
`UPDATE … SET access_token=?, refresh_token=?, token_expires_at=? WHERE id=? AND refresh_token=<observed>`.
At most **one** writer commits a rotation for a given stored token. The CAS loser
(`changes==0`) stands down as `superseded` and never clobbers the newer token. No distributed
lock, no new column. (Tested with two concurrent refreshers → exactly one commit, newest
token retained, one write total.)

## 13. Refresh ambiguity policy

Exactly **one** refresh POST per attempt — never a blind retry, because a retried refresh
token may already be consumed server-side. Any non-200, `invalid_grant`, 5xx, or network
error → `reconnect_required` (a human reconnects). Before declaring `reconnect_required`, the
implementation re-reads the stored token; if a concurrent refresher already advanced it, the
caller recognizes it merely lost the race and returns `superseded`. **Residual (accepted):**
if the winner's CAS has not yet committed when the loser re-reads, the loser may emit a benign
false `reconnect_required` alert even though the stored token is in fact healthy. This is the
lock-free residual — non-destructive (no data loss, at most one rotation ever commits) and
consistent with the canonical "manual reconnect acceptable" disposition. A test asserts the
loser is always non-destructive (`superseded` **or** `reconnect`, never a second rotation).

## 14. Rate-limit behavior

A `429` from Create Pin is interpreted by B1 as a **pre-execution safe release**: the job is
returned to `approved` (attempt_count preserved) and no Pin was created. The scheduler counts
it as `rate_limited` and emits **no** alert — a single deferral is normal and the job is
naturally retried on a later wake-up. The scheduler performs no in-run retry.

## 15. Discord alert policy

Alerts are local operational signals only (sanitized, never a token/secret/board_id/pin_id).
`runPublishDue()` returns an `alerts[]` list; the route emits each to Discord via
`sendDiscordAlert` (best-effort, never throws). Alerts fire **only** for:

- `pinterest_stale_claim` — a stuck publishing lease was swept to needs_review.
- `pinterest_needs_review` — a definite rejection or ambiguous outcome needs a human.
- `pinterest_token_reconnect_required` — the production token is unusable and must be
  reconnected.

**No** alert is emitted for success, a no-op/empty run, an already-claimed skip, or a single
rate-limit deferral.

## 16. Observability

Each run logs (via the existing `log()`/Axiom path) a `cron_publish_due` event with the run
summary: `{ due, claimed, published, needs_review, rate_limited, skipped, stale_swept }`. The
proactive refresh cron additionally reports a Pinterest `status`
(`healthy`/`refreshed`/`superseded`/`no_account`/`reconnect_required`). No token value, client
secret, Authorization header, board_id, pin_id, or raw Pinterest/D1/R2 body is ever logged.

## 17. No auto-retry / ambiguous writes are terminal

Ambiguous outcomes (5xx, network loss, 2xx-without-id) are finalized to `needs_review` and
left **permanently** for a human — the code never automatically re-drives them. Cron
frequency revisits only still-`approved` jobs; it is not a retry mechanism for anything that
already left the approved state.

## 18. GitHub workflow (inert)

`.github/workflows/pinterest-publish-due.yml`: `on.schedule` `2-57/5 * * * *` plus
`workflow_dispatch`; a single `ubuntu-latest` job that runs
`curl -sf -X POST https://creatorpost.app/api/cron/publish-due -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"`
under `set -o pipefail`. It references **only** `secrets.CRON_SECRET` — no Pinterest client id/
secret, no refresh/access token, no internal token, no direct `api.pinterest.com` surface.
The header comment states it is built-not-activated. It stays inert until pushed to the
default branch. (A static test enforces all of these properties.)

## 19. Activation prerequisites (Gates A–J — DOCUMENT ONLY, do not perform)

Activation is out of scope for B3 and must not be performed here. When authorized:

- **A. Pinterest Standard access is live** for the production app.
- **B. Owner-prod account connected** in production via the real OAuth flow (B0), so
  `connected_accounts` holds a valid production access + rotating refresh token.
- **C. Approved jobs exist** in production D1 (B2 ingestion), each with a resolvable board
  alias and a staged R2 image.
- **D. `CRON_SECRET` set** as a production secret and as a GitHub Actions repo secret
  (identical value).
- **E. `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET` set** as production secrets (used by
  the refresh path only; never in CI).
- **F. Code deployed** to production (B0–B3 merged and released) so both cron routes exist.
- **G. Board aliases** (`PINTEREST_BOARD_ALIASES`) match the live board names.
- **H. Refresh cron healthy** — `/api/cron/refresh-tokens` returns a Pinterest `status` and
  the token stays fresh over at least one proactive cycle.
- **I. Dry manual proof** — a single `workflow_dispatch` (or one manual authenticated POST)
  against production with **zero** due jobs returns `{ due: 0 }` and creates no Pin.
- **J. Explicit owner go/no-go** recorded before enabling the schedule.

## 20. Exact activation steps (DOCUMENT ONLY — do not run in B3)

1. Merge B0→B1→B2→B3 and deploy to production (git-pull deploy, per project policy).
2. Set production secrets `CRON_SECRET`, `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`.
3. Set the GitHub Actions repo secret `CRON_SECRET` to the same value.
4. Confirm Gates A–H.
5. Trigger the workflow **once** via `workflow_dispatch` with no due jobs (Gate I); confirm
   `{ due: 0 }`, no Pin, no error alert.
6. Seed/approve one real job at a near `publish_at`; run one manual dispatch; confirm exactly
   one Pin and a `published` row.
7. Only after the owner's go (Gate J), leave the `schedule:` trigger in place on the default
   branch so it runs automatically. (Until then the schedule only exists on the unmerged
   branch and never fires.)

To **deactivate**: remove/disable the workflow (or unset `CRON_SECRET`), which fails the route
closed (503) — approved jobs simply stop being executed and remain safely `approved`.

## 21. What remains for B4

Content-Lab-facing surfaces: the manifest generator/CLI that produces approved cohorts, any
approval UI, calendar/composer/jobs dashboard, and board-picker/settings management. B3 does
not touch Content Lab, Start Here Home, cohort files, the manifest generator, or any UI.

## 22. STOP discipline

B3 stayed inside scope: no deploy, no push, no production OAuth, no production migration, no
production secret, no real Pinterest call, no enabled schedule, no second Create-Pin path, no
UI, no generalized scheduler, no unrelated refactoring, no TikTok/IG/YouTube behavior change.
The rotating-refresh concurrency was made safe with CAS and **no** new schema/migration, so no
STOP condition fired. The one defect discovered (§10) was in B3's own new code and was fixed
within B3 with a covering test; no B0/B1/B2 defect was found.
