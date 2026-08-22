# Pinterest Phase B — Slice B0: Production OAuth Transition (BUILT, NOT ACTIVATED)

**Status:** Code complete on branch `pinterest-phase-b0-production-oauth`. **Not deployed, not
activated, not pushed.** Governing rule: **BUILD ASSUMING APPROVAL, ACTIVATE ONLY AFTER APPROVAL.**
Pinterest Standard access is still under review; nothing in this slice contacts Pinterest, mutates
production data, or is wired into any UI.

---

## 1. Scope of this slice

B0 is the *production OAuth transition only*: authorize → code exchange against production Pinterest,
persist a production access token **and a rotating refresh token**, and retire the Phase A sandbox
sentinel account, all owner-only and fail-closed against the sandbox environment. It deliberately does
**not** implement any B1+ publishing/manifest architecture.

## 2. What was built

| Piece | Location |
|---|---|
| `assertProductionUrl` (fail-closed host lock → `api.pinterest.com`) | `lib/pinterest-production.js` |
| `productionTokenIsUsable` (refresh token REQUIRED) | `lib/pinterest-production.js` |
| `planProductionConnect` (pure persistence-plan decision) | `lib/pinterest-production.js` |
| `PINTEREST_PRODUCTION_HOST` / `PINTEREST_PRODUCTION_PUID` (`owner-prod`) / sentinel const | `lib/pinterest-production.js` |
| Production constants (`PINTEREST_PRODUCTION_TOKEN_URL`, prod state cookie) | `functions/[[route]].js` |
| `GET /auth/pinterest/production` (owner-only authorize initiator) | `functions/[[route]].js` |
| Production callback handler + shared-callback delegation guard | `functions/[[route]].js` |
| `exchangePinterestProductionCode` (Basic-auth form POST, production-locked) | `functions/[[route]].js` |
| Unit tests (19) | `test/pinterest-production.test.js` |

## 3. Files changed

- **Added:** `lib/pinterest-production.js`, `test/pinterest-production.test.js`, this doc.
- **Modified:** `functions/[[route]].js` — one import block, one constants block, one delegation guard
  line in the existing callback, one new auth route, one new callback handler function, one new
  exchange function. **No Phase A sandbox logic was altered** (the callback's Phase A body is untouched;
  the guard only delegates when the distinct prod cookie is present).
- **Not touched:** `schema.sql` (no migration needed — see §7), `public/account.html` (no UI change —
  see §9), the 6-hour refresh-token cron, any B1 component.

## 4. Docs verification (B0 §4)

Verified against current official Pinterest docs (`developers.pinterest.com/docs/getting-started/
set-up-authentication-and-authorization/` and `.../developer-tools/sandbox/`). **No material
contradiction with the approved design.** Confirmed:

- Token endpoint `https://api.pinterest.com/v5/oauth/token`; authorize `https://www.pinterest.com/oauth/`.
- HTTP Basic `base64(client_id:client_secret)`, `Content-Type: application/x-www-form-urlencoded`,
  body `grant_type=authorization_code&code&redirect_uri`. **No PKCE.**
- Response: `access_token` (`pina…`), rotating `refresh_token` (`pinr…`), `expires_in` = 2592000 (30d),
  `refresh_token_expires_in` = 5184000 (60d).
- Same app / same `client_id`+`client_secret` for Trial→Standard; **tokens are NOT interchangeable**
  between sandbox and production (reinforces the fail-closed separation).
- Scopes `boards:read,boards:write,pins:read,pins:write` are correct; `user_accounts:*` is NOT needed.
- **`continuous_refresh`:** apps created **on/after 2025-09-25** get continuous (indefinitely
  refreshable, 60-day) refresh tokens automatically. The CreatorPost app was created Aug 2026 → after
  the cutoff → the token request **does not** pass `continuous_refresh=true`. *(Activation dependency:
  if the app's creation date is ever found to predate 2025-09-25, add `continuous_refresh=true` to the
  exchange body — see §12 open risks.)*

## 5. Environment separation (fail-closed, both directions)

- `assertProductionUrl` throws unless HTTPS **and** host is exactly `api.pinterest.com`. It rejects the
  sandbox host, http downgrades, look-alike suffixes (`api.pinterest.com.evil.example`), subdomain
  spoofs, unrelated hosts, and malformed URLs.
- The existing `assertSandboxUrl` is unchanged and still rejects the production host.
- A dedicated unit test asserts each guard fails closed against the other's host.
- Production and sandbox use **distinct state cookies** (`pinterest_prod_oauth_state` vs
  `pinterest_oauth_state`) and **distinct `platform_user_id`s** (`owner-prod` vs `phase-a-sandbox-proof`).

## 6. Token handling & refresh-token persistence

- Access token, **rotating refresh token**, and `token_expires_at` are all persisted for the production
  connection — unlike Phase A, which stored `refresh_token = NULL` by design.
- `productionTokenIsUsable` requires a non-empty access token **and** a non-empty refresh token. A
  missing/blank refresh token is treated as **not connected**: no DB write, sandbox sentinel preserved,
  redirect `…?pinterest=no_refresh_token`.
- **No token, secret, authorization code, or raw response body is ever logged.** Only expiry metadata
  and generic error categories are logged (mirrors Phase A).

## 7. Sentinel transition & atomicity

- On success the production callback runs a single `DB.batch([...])` (all-or-nothing) that (a) upserts
  the `owner-prod` row and (b) deletes the `phase-a-sandbox-proof` sentinel. The sentinel is therefore
  **never removed unless the production row is written in the same commit**.
- Token-exchange failure short-circuits **before** the batch, so a failed exchange leaves the sentinel
  intact.
- Repeated successful connects hit the same `owner-prod` UNIQUE row and **upsert** (ON CONFLICT DO
  UPDATE) rather than duplicating.
- **No schema migration:** `connected_accounts` already has nullable `refresh_token` +
  `token_expires_at` + `UNIQUE(user_id, platform, platform_user_id)`. Confirmed in `schema.sql`.

## 8. Redirect URI

Production reuses the **same registered redirect URI** `https://creatorpost.app/callback/pinterest`.
No Pinterest-dashboard redirect change is required. The shared callback distinguishes a production flow
solely by the presence of the prod state cookie (a one-line delegation guard added at the top; it is a
no-op for the sandbox flow, which never sets that cookie).

## 9. UI decision (B0 §15)

**No `account.html` change.** The production auth route `/auth/pinterest/production` is owner-gated and
can be invoked directly by navigating to it at activation time, so no UI change is technically
necessary — the smallest, lowest-risk diff. The Phase A sandbox card is left exactly as-is.

## 10. Tests

`npm test` → **27 pass / 0 fail** (19 new + 8 existing, all green; existing sandbox/CSRF tests
unchanged and still passing = no regression). New coverage in `test/pinterest-production.test.js`:

- `assertProductionUrl`: allows prod token/API URLs; refuses sandbox host, http, look-alike, subdomain
  spoof, unrelated host, malformed.
- Cross-environment: each guard fails closed against the other's host.
- `productionTokenIsUsable`: true only with both tokens; false on missing/blank refresh, missing
  access, null/undefined.
- `planProductionConnect`: writes `owner-prod` row with non-null refresh + computed expiry + null
  profile fields; retires only the sandbox sentinel; null expiry when `expires_in` absent; refuses (no
  row, no delete) when refresh token missing; deterministic owner-prod target for safe repeated upsert.

**Test approach note:** persistence decisions were extracted into the pure `planProductionConnect` /
`productionTokenIsUsable` helpers so the callback's write/transition logic is unit-testable without a
live D1 or network. The callback's state-first ordering reuses the already-tested `verifyOAuthState`
primitive in the identical order as the Phase A callback; full end-to-end OAuth/D1 behavior is an
activation-time integration check (§11 A5).

## 11. Activation runbook (DOCUMENT ONLY — do not execute until Standard access is granted)

> None of these steps were performed. They require explicit owner go-ahead after Pinterest approval.

1. **A1 — Confirm approval.** Verify the Standard-access grant email from Pinterest.
2. **A2 — Env/secrets.** Confirm `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET` are the Standard app's
   production credentials in the Cloudflare Pages production environment. No new secret is required for B0.
3. **A3 — Deploy.** Merge this branch and deploy (`wrangler pages deploy public` per existing process).
4. **A4 — Connect.** As the owner, navigate to `https://creatorpost.app/auth/pinterest/production`,
   complete the live consent, and confirm redirect to `…/account?pinterest=production_connected`.
5. **A5 — Verify persistence.** Confirm exactly one `connected_accounts` row with
   `platform_user_id='owner-prod'`, a non-null `refresh_token` and `token_expires_at`, and that the
   `phase-a-sandbox-proof` sentinel row is gone.
6. **A6 — Refresh wiring (LATER SLICE, not B0).** Adding Pinterest to the token-refresh cron is a
   separate slice; do not enable it here.

## 12. Open risks / dependencies

- **App creation date:** the no-`continuous_refresh` decision depends on the app being created
  ≥ 2025-09-25. Re-confirm at activation; if earlier, add `continuous_refresh=true` to
  `exchangePinterestProductionCode`'s body (one-line change).
- **First refresh cycle** (rotating refresh token persistence on refresh) is out of B0 scope; it must be
  handled by the later refresh slice before the 30-day access token expires.

## 13. Out of scope (explicitly NOT built here)

`pinterest_publish_jobs` table/migration, `CREATORPOST_INTERNAL_TOKEN`, any internal/publish/status/
cancel/execute-now API, manifest parsing, board-alias resolution, R2 image staging, Pin-create helper,
AI-disclosure builder, scheduler/cron route, GitHub workflow, Discord alerts, settings jobs view, and
Content Lab integration. No generalized refactoring. The Phase A sandbox proof endpoint was left
unchanged (it becomes operationally obsolete after production cutover but is not modified here).

## 14. Non-activation guarantees (what BUILD did NOT do)

No browser OAuth, no call to the production authorize/token endpoint, no real authorization code
exchanged, no production access/refresh token created or stored, no production D1 row mutated, no Pin
created, no app settings changed, no deploy, no Cloudflare env/secret change, no cron enabled, no
GitHub Actions change, and **no push**. Tests use only in-process fixtures. The unrelated dirty files
in the working tree (`.DS_Store`, `.claude/`) were left untouched and excluded from the commit.
