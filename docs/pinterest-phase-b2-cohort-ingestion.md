# Pinterest Phase B — Slice B2: Approved Cohort Manifest Ingestion + Internal API (BUILT, NOT ACTIVATED)

**Status:** Code complete, built on top of B1 (`731e0fe`). **Not deployed, not pushed to publish,
not activated. No production OAuth performed, no real Pin created, no production D1/R2 mutated, no
scheduler built or touched, no token refresh added.** Governing rule:
**BUILD ASSUMING APPROVAL, ACTIVATE ONLY AFTER APPROVAL.** Pinterest Standard access is still under
review.

---

## 1. Mission / scope of this slice

B2 turns the proven single-Pin primitive from B1 into the **real owner workflow**: a human-reviewed
**cohort manifest** (1..N approved pins, one owned image per pin) is submitted **once**, over an
**authenticated** internal channel, and either the **entire cohort** is accepted as immutable
`approved` jobs or **nothing** is. B2 adds **ingestion and internal APIs only** — it does **not** add
any unattended execution. Publication still happens exclusively through B1's `executeApprovedJob()`
(execute-now today; the B3 cron later).

> reviewed manifest → authenticate (internal token) → validate EVERY pin + image →
> classify against existing rows (idempotent retry vs. conflict) → stage ALL images to R2 →
> **atomically** insert immutable `approved` jobs (all-or-nothing) → status / cancel.

## 2. What was built

| Piece | Location |
|---|---|
| Ingestion core (validation, hashing, dedupe, atomic insert, cleanup) | `lib/pinterest-manifest.js` (new) |
| Shared INSERT contract extracted from B1 | `lib/pinterest-publish.js` (`buildApprovedPinJobInsert`) |
| Four internal endpoints + auth helpers | `functions/[[route]].js` |
| Tests | `test/pinterest-manifest.test.js` (34 tests) |
| This doc | `docs/pinterest-phase-b2-cohort-ingestion.md` |

The two B1 endpoints (single-job ingest + execute-now) were **replaced** by the four B2 endpoints
below; execute-now is preserved verbatim in behavior (same B1 engine).

## 3. Internal authentication (`CREATORPOST_INTERNAL_TOKEN`)

Cohort **submission** is gated on a dedicated `CREATORPOST_INTERNAL_TOKEN` Bearer secret, compared in
**constant time** over fixed-length SHA-256 digests (`secretsEqual`; the Workers runtime has no
`timingSafeEqual`). `hasInternalToken()` **fails closed** when the secret is unset or the header is
missing/malformed, and the token is **never logged**. The secret is **not set** in this slice — the
real Cloudflare secret is deliberately unconfigured, so the write endpoint returns 401 until
activation. The token is Pinterest's write key into CreatorPost; it never appears in a manifest, a
response body, or a log line.

## 4. Auth matrix (write vs. convenience read)

| Endpoint | Auth |
|---|---|
| `POST /api/internal/pinterest/jobs` (submit cohort) | **internal token ONLY** |
| `GET /api/internal/pinterest/jobs` (status) | internal token **OR** owner session |
| `POST /api/internal/pinterest/jobs/:id/cancel` | internal token **OR** owner session |
| `POST /api/internal/pinterest/jobs/:id/execute-now` | internal token **OR** owner session |

The write path is intentionally the **narrowest** (machine token only). Read/cancel/execute-now also
accept a privileged `@mattdonders.com` browser session for hands-on operator convenience. None of
these are reachable through the generalized `Bearer cp_...` public API-key publish routes — Pinterest
stays off that surface entirely.

## 5. Manifest contract (version 1)

A manifest is a single JSON object:

```jsonc
{
  "manifest_version": 1,
  "manifest_id": "lawn-c03-v1",   // caller-owned, versioned identity (a re-review bumps the version)
  "source": "start-here-home",    // logical origin; part of job identity
  "pins": [
    {
      "external_job_id": "Y01",   // stable per-pin id, unique within source
      "board_alias": "lawn-troubleshooting",  // LOCAL alias, never a Pinterest board_id
      "title": "…", "description": "…", "link": "https://…", "alt_text": "…",
      "ai_disclosure": "AI_MODIFIED",         // or SYNTHETIC_PERFORMER or null; AI_GENERATED rejected
      "publish_at": "2026-08-20T16:00:00Z"     // integer unix seconds OR ISO-8601 WITH explicit zone
    }
  ]
}
```

Each pin's image is a separate multipart part named `image:<external_job_id>` — association is by
name, never by upload order. `manifest_version` other than `1` is rejected distinctly
(`unsupported_manifest_version`).

## 6. Human-approval representation

The manifest **is** the approval artifact: a human reviewed the cohort upstream (Content Lab / Start
Here Home), and submitting it under the internal token asserts that approval. There is **no**
`pending_review` state and **no** in-app approval workflow. Every accepted row enters directly as
`approved`; the immutable row is the approval record. `manifest_id` carries a version suffix so a
re-reviewed cohort is a **new** identity, not an edit of the old one (see §13/§21).

## 7. Whole-manifest validation before any write

`validateManifest()` validates the **entire** cohort **before any durable side effect**: supported
version; required `manifest_id`/`source`; non-empty `pins` within `MAX_COHORT_PINS`; unique
`external_job_id` (duplicate → rejected); per-field lengths + AI enum + required strings (reusing
B1's `validateSinglePinJob`, single source of truth); locally-known `board_alias`; a timestamp with
an explicit zone; exactly one image per pin; and **no orphan images**. **Any** issue rejects the
**whole** manifest with a per-item issue list — never a partial accept.

## 8. Cohort size bound

`MAX_COHORT_PINS = 25` — an owner-scale guard (a real cohort is ~15), **not** a bulk API. It is a
tripwire against accidental mass submission, consistent with the workspace's low-volume,
human-supervised philosophy. `MAX_IMAGE_BYTES = 20 MB`, jpeg/png only.

## 9. Multipart ingestion + image mapping

The route parses `formData()`: one string `manifest` part + N `image:<external_job_id>` file parts.
Duplicate part-names for one job are collected as `duplicateImageKeys` and reject the cohort
(`duplicate_image`) before any work. Image bytes are read into memory as `Uint8Array` with the part's
declared `contentType` and byte length. Order independence is structural — mapping is by part name.

## 10. R2 staging (deterministic, retry-safe, SSRF-free)

Each job's image is staged via B1's `stagePinImageToR2()` to the **persistent** key
`pinterest-jobs/<job_id>.<ext>` where `job_id = deriveJobId(source, external_job_id)` is
**deterministic**. An identical retry therefore overwrites the **same** object (no orphan copies).
Only jpeg/png are accepted. The Create Pin payload (at B1 execution time) references our own bucket
URL only — Pinterest fetches solely from R2, so there is no user-controlled URL and no SSRF surface.
Staging happens **after** validation + dedupe and **before** the atomic insert.

## 11. Atomic cohort insertion (all-or-nothing)

All rows are inserted with a single `DB.batch([...])`, which D1 executes as one implicit transaction
(already relied upon in the B0 callback). Every statement is built by the **shared**
`buildApprovedPinJobInsert()` — the exact same INSERT contract B1's single-job path uses, so cohort
and single-job rows are byte-identical in shape. A `UNIQUE(source, external_job_id)` violation or any
error aborts the **whole** batch → there is never a 7-of-15 partial cohort. On batch failure the
staged R2 images are cleaned up (§12) and the request fails (`job_conflict` on UNIQUE, else
`persistence_failed`).

## 12. R2 cleanup on failure (best-effort, never throws)

If staging throws mid-cohort, or the atomic insert fails, `bestEffortCleanup()` deletes every
already-staged object. If a delete itself fails, the object is left as a **job-id-keyed** orphan
(safe to overwrite on the next retry) and a `pinterest_r2_orphan` event is logged (key only, no
bytes). Cleanup never throws and never turns a failed ingestion into a partial success.

## 13. Manifest-level dedupe (no new table)

Manifest identity is **reconstructed from the per-job rows** sharing a `manifest_id` — no manifests
table, no manifest-hash column. On resubmission of the same `manifest_id`:

- **All identities present, same count, every `content_hash` matches** → `already_accepted` (200),
  idempotent, zero new staging/inserts.
- **Same `manifest_id`, any content changed** (copy, schedule, or image bytes) → `manifest_conflict`
  (409). A changed cohort must be a new **version** (`…-v2`), never a silent overwrite.

## 14. Per-job dedupe + conflicting identity

Identity is `(source, external_job_id)`. If any submitted identity already exists under a
**different** `manifest_id`, the cohort is rejected `job_conflict` (409) — one pin id cannot be
reused across manifests. The per-job `content_hash` (§22) drives the same/changed decision inside a
manifest. `UNIQUE(source, external_job_id)` is the durable backstop at insert time.

## 15. Manifest persistence decision

No manifest is stored as its own entity. The **only** tables involved are the existing
`connected_accounts` (owner-prod account lookup) and `pinterest_publish_jobs` (the jobs). Manifest
membership lives in each job's `manifest_id` column (already added in B1). This keeps the schema
minimal and avoids a second source of truth that could drift from the jobs.

## 16. Atomic D1 insertion mechanism

`DB.batch()` is the all-or-nothing primitive; no distributed-transaction system, no service-account
infrastructure, no generalized social-job framework was built. The FakeDB in tests models `batch()`
with snapshot/rollback to prove that a mid-batch failure leaves **zero** rows.

## 17. Single-job endpoint evolution

B1's two owner-session endpoints were removed and folded into the B2 set. Single-Pin ingestion is now
simply a **cohort of one** through `POST /api/internal/pinterest/jobs`. The B1 execution engine
(`executeApprovedJob`, claim, classify, board resolution, Create Pin) is **unchanged**; only the
ingestion seam changed. B1's 41 tests re-ran green after the `buildApprovedPinJobInsert` extraction,
proving the refactor is behavior-preserving.

## 18. Execute-now (narrow, unchanged engine)

`POST /api/internal/pinterest/jobs/:id/execute-now` runs the **same** B1 `executeApprovedJob()` on a
**single** job. It never executes a whole cohort — B2 **acceptance ≠ publication**. An unclaimable job
(not `approved`/due, or already claimed) returns 409. This is the only execution path B2 exposes; the
scheduled path remains B3.

## 19. Status / read API

`GET /api/internal/pinterest/jobs` lists jobs with bounded filters (`state`, `source`, `manifest_id`,
`upcoming`, `needs_review`), ordered by `publish_at`, `LIMIT 500`. It selects **only** locally-owned
operational fields (`id`, `external_job_id`, `source`, `manifest_id`, `board_alias`, `title`,
`publish_at`, `approved_at`, `state`, `attempt_count`, `claimed_at`, `published_at`, `error_category`,
`created_at`). It exposes **no** tokens, **no** `image_key`/`content_hash`, and **no** Pinterest
`board_id`/`pin_id` (none are stored).

## 20. Cancellation

`POST /api/internal/pinterest/jobs/:id/cancel` conditionally sets `state='canceled'` **only** when the
job is still `approved` (unclaimed). Publishing/published/needs_review/already-canceled → 409
`cannot_cancel`; missing → 404. The row is **never deleted** (audit preserved). Because B1's claim
requires `state='approved'`, a canceled job can never subsequently be claimed/published — proven
end-to-end in tests via B1's real `claimJob`.

## 21. Editing is out of scope

There is **no** edit/PATCH endpoint. Accepted job snapshots are immutable. A changed cohort is
expressed as a **new manifest version** (`manifest_id` `…-v2`) with fresh `external_job_id`s or a new
identity — never an in-place mutation of an accepted job.

## 22. Content hashing

`computeJobContentHash(pin, source, publish_at_sec, image_digest)` is a SHA-256 over a **canonical**
JSON object with fixed key order, so reordered manifest JSON keys hash **identically**. It includes
the **image bytes** digest, so any change to copy, board alias, schedule, AI disclosure, link, alt
text, **or the image** yields a different hash → conflict on resubmission under the same manifest.
`manifest_id` is excluded (identity is `source`+`external_job_id`). `computeManifestHash()` exists as
an order-independent convenience/echo for tests and audit and is **not persisted**.

## 23. Timestamp handling

`parsePublishAt()` accepts an **integer** (already unix seconds, unambiguous) or an **ISO-8601 /
RFC3339 string carrying an explicit zone** (`Z` or `±hh:mm`), normalizing to UTC seconds. A
**timezone-less** datetime string is **rejected** (`missing_timezone`) — no server-local zone
guessing. Ambiguity is a validation error, not a silent assumption.

## 24. Board alias validation

`board_alias` is validated against the **local** `PINTEREST_BOARD_ALIASES` map only (`in aliasMap`);
an unknown alias rejects the manifest (`unknown_board_alias`). B2 makes **zero** live Pinterest calls:
the alias → real board resolution (case-insensitive, exactly-one-match) stays in the B1 engine and
runs against the **live** board list only at execution time. No Pinterest `board_id` is ever accepted
or persisted.

## 25. AI disclosure

`ai_disclosure` accepts `AI_MODIFIED`, `SYNTHETIC_PERFORMER`, or absent/null, validated by B1's
`validateSinglePinJob`. `AI_GENERATED` is **not** a valid Pinterest v5 value and is rejected. Tests
confirm a mixed cohort does not leak one pin's disclosure onto another.

## 26. Internal token vs. owner session (why both)

The write path is a **machine** channel (a future CLI/automation posting reviewed cohorts), so it
requires the revocable internal token exclusively — not tied to any browser login. Read/cancel/
execute-now additionally accept the owner's privileged session purely for hands-on operator
convenience during the supervised pilot. The two mechanisms never blur: an ordinary `Bearer cp_...`
API key can submit nothing.

## 27. No live Pinterest calls

B2 code and tests contain **zero** references to `api.pinterest.com` / `api-sandbox.pinterest.com`
and issue **no** `fetch`. Verified by grep. Every network-touching operation is deferred to the B1
engine at execution time, which is not activated.

## 28. No scheduler

No cron, scheduled Worker, Workflow, queue, `/api/cron/publish-due`, or
`.github/workflows/publish-due.yml` was added or modified. Grep confirms no scheduler references in
the B2 core. Unattended execution remains entirely B3's concern.

## 29. No token refresh

B2 adds **no** Pinterest token refresh and does **no** on-demand refresh. Ingestion needs only the
owner-prod `account_id` (a foreign-key reference), never a live token. The existing refresh cron is
untouched. Token lifecycle is B3.

## 30. No UI

No composer, uploader, board picker, calendar, scheduling form, or cohort-review page was built. The
optional settings view was deferred and left unbuilt. B2 is API + library only.

## 31. No Content Lab integration

Nothing in `content-lab/` (Start Here Home, property docs, cards) was read or modified by this build,
and no real CLI (B4) was created. B2 defines the ingestion **contract** the future CLI will target;
it does not implement that producer.

## 32. Error contract

All failures return `{ ok:false, error:<category>, issues?:[...] }` with a matching HTTP status:
`invalid_manifest`/`unsupported_manifest_version`/`duplicate_image` → 400; `manifest_conflict`/
`job_conflict`/`pinterest_prod_not_connected` → 409; `staging_failed` → 502;
`persistence_failed` → 500; `unauthorized` → 401. `error_category` and issue codes are **local,
sanitized** labels — never a raw Pinterest/D1/R2 body.

## 33. Ingestion response

Success returns `{ ok:true, status:'accepted'|'already_accepted', manifest_id, job_count, jobs:[{id,
external_job_id, state:'approved', publish_at}] }` — `accepted` (201) for a fresh cohort,
`already_accepted` (200) for an idempotent exact retry. The response never contains tokens, image
bytes, `content_hash`, `image_key`, or any Pinterest id.

## 34. R2 object identity (retry safety)

Because `job_id` (and therefore the R2 key) is a deterministic function of `(source,
external_job_id)`, an exact retry re-stages to the **same** keys — no orphaned duplicate objects
accumulate. The dedupe check runs **before** staging, so a truly identical retry does **zero** R2
work. A conflicting change is rejected before any new object is written.

## 35. Failure-injection tests

The suite injects: (a) a mid-cohort R2 `put` failure → 502, no rows, the one staged object cleaned
up; (b) a `DB.batch()` failure → 500, zero rows, **all** staged objects cleaned up; (c) a cleanup
`delete` failure on top of a batch failure → still fails safely (no partial cohort) and logs
`pinterest_r2_orphan`. These prove all-or-nothing under partial failure.

## 36. DB schema changes

**None.** B1's `pinterest_publish_jobs` already carries `manifest_id` + `content_hash`,
`UNIQUE(source, external_job_id)`, and the due/source indexes. B2 required no new table, column, or
migration, so none was added and nothing was applied to production.

## 37. Tests (`test/pinterest-manifest.test.js` → 34 tests)

Covers: **auth** (constant-time compare shape; internal-token-only write — enforced at the route,
exercised via the library contract) · **manifest** (valid 1-item, valid 15-item, unsupported version,
empty pins, too-many, duplicate id, unknown alias, timezone-less rejected, invalid AI enum, length
boundaries, missing image, orphan image) · **timestamp** (Z + offset normalize, integer seconds,
timezone-less/garbage rejected) · **hash/dedupe** (reordered JSON keys identical, pin-order
independent, changed title/schedule/image/AI differ, image bytes in job identity, deterministic
`deriveJobId`) · **multipart mapping** (per-job image, duplicate image, AI non-leak across pins) ·
**atomicity** (15 valid → all inserted; one invalid → zero inserted + zero staged; simulated batch
failure → zero accepted; no partial cohort) · **R2 cleanup** (put-failure cleanup, DB-failure
cleanup, cleanup-failure safe) · **status** (list, filter by source/state, no tokens/Pinterest ids/
image_key/content_hash exposed) · **cancel** (approved→canceled, canceled can't be claimed by B1's
real `claimJob`, publishing/published not cancelable, missing → not_found) · **bounds guard**.

## 38. Full regression

```
node --test test/pinterest-manifest.test.js   → # tests 34   # pass 34   # fail 0
npm test                                        → # tests 102  # pass 102  # fail 0
```

102 = 41 B1 + 27 pre-existing + 34 B2. The B1 suite stayed green after the
`buildApprovedPinJobInsert` extraction, confirming no B1/B0 behavior changed.

## 39. Security / logging discipline

Logs record event names, `manifest_id`/`source`, sanitized result category, HTTP status, and
`job_count` only — **never** the internal token, Authorization headers, Pinterest tokens, client
secret, image bytes, raw multipart body, or raw Pinterest/D1/R2 responses. The internal token is
compared in constant time and never echoed. No Pinterest `board_id`/`pin_id` is accepted, stored, or
logged.

## 40. B3 handoff

B3 owns unattended execution: a scheduled scan of due `approved` jobs calling the **same**
`executeApprovedJob()`, plus Pinterest token-refresh lifecycle. B2 leaves the jobs table, the shared
INSERT contract, deterministic ids, and the status/cancel surface ready for it. Nothing in B2
presumes a scheduler exists.

## 41. Activation (NOT authorized yet)

When Standard is approved: set the real `CREATORPOST_INTERNAL_TOKEN` Cloudflare secret; connect the
owner-prod account (B0); submit one reviewed cohort manifest to `POST /api/internal/pinterest/jobs`;
verify via `GET`; then `execute-now` a single job for one real Pin. Until then the write endpoint is
401 (secret unset) and execute-now has no connected account. Activation remains **not authorized**.
