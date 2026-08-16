# Pinterest — Activation A: Review + Safe Production Deployment + Read-Only Verification

**Date:** 2026-08-15 · **Operator:** owner-supervised (Claude Code) · **Result:** COMPLETE
**Scope:** commission the CreatorPost Pinterest backend (slices B0–B4) into production,
apply the additive jobs migration, and verify read-only that the deploy is healthy and the
Pinterest **write path remains fail-closed**. No Pinterest write, OAuth grant, Pin, manifest
submission, or scheduler activation was performed.

This is the durable record of Activation A. It is a deployment/verification log, not a design
doc — the design lives in `docs/pinterest-phase-b0…b3-*.md` and the B4 handoff record in the
Content Lab repo (`content-lab/pinterest-integration/PINTEREST_PHASE_B4_HANDOFF.md`).

---

## 1. What was deployed

Fast-forward of `main` from `1b09c6e` (pre-Pinterest baseline) to `4452b15`, adding the six
Pinterest commits plus one activation-safety commit:

```
4452b15 chore(activation-safety): disable Pinterest scheduler cron on default branch
569160e feat: add pinterest connection status endpoint      (B4)
23b3c91 feat: add pinterest scheduled executor               (B3)
2e08800 feat: add pinterest cohort ingestion                 (B2)
731e0fe feat: add pinterest single-pin publishing engine      (B1)
d1f07cb feat: prepare pinterest production oauth              (B0)
```

21 files, +4243 / −3. All Pinterest-scoped (lib/, functions/[[route]].js, migrations/,
schema.sql, docs/, test/) plus the one workflow edit. No unrelated files; no hardcoded
secrets in the diff (scanned).

**Deploy mechanism:** Cloudflare Pages **Git integration** — every push to `main`
auto-deploys (README §Deploy). The push *is* the deploy; no manual `wrangler pages deploy`
was run.

- Pages project: `tiktok-creator-app` (domains `tiktok-creator-app.pages.dev`, `creatorpost.app`)
- Deployment `536a9600-f4da-4f06-ae22-79d0820b6b6a`, source `4452b15`, Environment Production, **Active**
- Prior active deployment was `1b09c6e` (baseline).

---

## 2. Pre-deploy gate (all passed)

- **Independent diff review** of `1b09c6e..569160e`: verdict **SAFE**, no material defects.
  Confirmed: POST /jobs is internal-token-**only** and fails closed when the token is unset;
  GET jobs/connection + cancel + execute-now require internal-token **or** owner session;
  `/api/cron/publish-due` is `CRON_SECRET`-only (503 when unset); Create-Pin is at-most-once
  (ambiguous network/5xx/2xx-without-id → `needs_review`, only 429 releases); no board_id or
  pin_id is ever persisted; `assertProductionUrl()` host-locks to `api.pinterest.com`; the
  only module export is `onRequest` — no `scheduled` handler, no top-level side effects, so
  **nothing auto-activates on deploy**.
- **Tests:** full CreatorPost suite `node --test` → **139 pass / 0 fail** (twice).
- **Migration** `migrations/2026-08-15-pinterest-publish-jobs.sql`: additive only
  (`CREATE TABLE/INDEX IF NOT EXISTS`, no ALTER/DROP/backfill), byte-identical to the
  `schema.sql` addition.

---

## 3. Activation-safety: scheduler kept inert (§4)

A GitHub Actions `schedule:` cron activates the moment its workflow file reaches the default
branch. Commit `4452b15` comments out the `schedule:` trigger in
`.github/workflows/pinterest-publish-due.yml`, keeping only `workflow_dispatch:`. The publish
path is therefore fail-closed on **two independent** guards: (a) no cron trigger is armed, and
(b) `/api/cron/publish-due` requires `CRON_SECRET` + only acts on due `approved` jobs.

**To re-enable later (authorized activation only):** uncomment the two `schedule:` lines in
that workflow. Do not do so before `CRON_SECRET` is intentionally scoped and Pinterest
Standard access is live.

---

## 4. D1 migration applied (§9)

Applied exactly once to production D1 (`creatorpost`, id `e848bad2-…`):

```
wrangler d1 execute creatorpost --remote --file=migrations/2026-08-15-pinterest-publish-jobs.sql
```

Verified afterward:

- `pinterest_publish_jobs` table present; indexes `idx_ppj_due` + `idx_ppj_source` present.
- Row count **0** (empty).
- Total tables 8 → 9. No existing table/data altered (additive, idempotent).

---

## 5. Post-deploy verification (read-only)

**Core surfaces (smoke):** `/`, `/login`, `/dashboard`, `/accounts` → **HTTP 200**, no 5xx.

**Pinterest routes — unauthenticated, all live + fail-closed:**

| Route | Method | Result | Meaning |
|---|---|---|---|
| `/api/internal/pinterest/jobs` | POST | **401** | write ingest fail-closed (internal-token-only, token unset) |
| `/api/internal/pinterest/jobs` | GET | **401** | live (not 404), needs internal-token/owner session |
| `/api/internal/pinterest/connection` | GET | **401** | live, fail-closed |
| `/api/internal/pinterest/jobs/:id/cancel` | POST | **401** | fail-closed |
| `/api/internal/pinterest/jobs/:id/execute-now` | POST | **401** | fail-closed |
| `/api/cron/publish-due` | POST | **401** | requires `CRON_SECRET` (see finding 6.1) |
| `/auth/pinterest/production` | GET | **302** | entry exists; redirect **not** followed, no grant started |

401 (not 404) proves the routes deployed; 401 (not 500) proves they fail closed; no route
returned 200 unauthenticated.

**Write-path state (§10/§11/§14/§15):**

- `CREATORPOST_INTERNAL_TOKEN` — **not present** in production Pages secrets → unset →
  POST /jobs can never ingest a manifest. (Present but pre-existing and untouched:
  `CRON_SECRET`, `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`.)
- Production Pinterest OAuth — **not performed.** `connected_accounts` has no `owner-prod`
  row (production PUID = `owner-prod`). The only `pinterest` row is the pre-existing Phase A
  sandbox sentinel `platform_user_id = phase-a-sandbox-proof`, which the production connection
  loader and publish/token path (both filter `platform_user_id = 'owner-prod'`) ignore. So
  GET /connection reports disconnected and the publish path has no account to use.
- Scheduler — `schedule:` disabled (§3); no due jobs (table empty); no owner-prod account.

---

## 6. Findings (none blocking; write path remains fail-closed)

**6.1 `CRON_SECRET` is already set in production.** `/api/cron/publish-due` returned 401
(not the 503 that an unset secret would give). This is the **pre-existing shared** `CRON_SECRET`
that the existing TikTok token-refresh workflow (`.github/workflows/cron.yml` →
`/api/cron/refresh-tokens`) already uses. It was **not** set as part of this activation.
Impact: `publish-due` is reachable by a caller holding that secret, **but** the scheduler cron
that would call it is disabled (§3), the jobs table is empty, and no production Pinterest
account exists — so no Pin can be created. When the scheduler is later activated, note that
`publish-due` shares the same `CRON_SECRET` as `refresh-tokens` (by design — both are the
mechanical cron auth).

**6.2 Pre-existing Phase A sandbox row.** `connected_accounts` contains one `pinterest` row
from the earlier sandbox Standard-access demo (`phase-a-sandbox-proof`). It is isolated from
the production `owner-prod` path and needs no action for Activation A. (A future cleanup could
delete it via the `deleteSentinelPuid` sentinel, but that is out of scope here.)

**6.3 Operator note — `/auth/pinterest/production` was probed once (GET → 302).** The redirect
was **not** followed and no callback was completed; D1 confirms no `owner-prod` row was created,
so no OAuth was initiated or persisted. Recorded for transparency.

---

## 7. Explicitly NOT done (still gated, require separate authorization)

- Did **not** set/generate `CREATORPOST_INTERNAL_TOKEN`.
- Did **not** perform production Pinterest OAuth / create an `owner-prod` connection.
- Did **not** create a Pin, submit a manifest, or insert any job row.
- Did **not** enable the recurring scheduler (cron stays commented out).
- Did **not** push or deploy the Content Lab handoff tool (`content-lab` commit `66a749e`
  stays local, unpushed).
- Did **not** modify any unrelated secret, OAuth grant, Pinterest app setting, `CRON_SECRET`,
  or `PINTEREST_CLIENT_*`.

**The Pinterest write path is fail-closed after Activation A.** Enabling it (internal token,
production OAuth, scheduler cron, first real cohort submission) is a separate, explicitly
authorized activation.
