# Pinterest — Phase A Implementation Record

**Status:** Implemented on an isolated local branch. **Not pushed, not deployed, no live OAuth/API call performed.** Awaiting human + ChatGPT review before any live action.

## What this is (and is not)

Phase A is a **Sandbox approval-proof only**. Its sole purpose is to produce the working demo that Pinterest requires for a later **Standard-access application**. The flow is: CreatorPost owner → real Pinterest OAuth → verified callback → **Sandbox** token → explicit human-triggered proof → create a Sandbox board if needed → create exactly **one** Sandbox image Pin → show success live.

This is **NOT**:
- production Pinterest publishing,
- Phase B (multi-user, profile sync, scheduled posting, cron refresh),
- authorization to deploy, change Cloudflare secrets, or touch Start Here Home.

Architecture: **A1** (minimal CreatorPost-native Sandbox proof). Not A2 (full integration), not A3 (Postman-as-product).

## Branch / commit

- Branch: `pinterest-phase-a`
- Base (`main`): `19584994b0db3e0554c2ec6e42c9b95549751f4b`
- Commit: local only — see `git log -1` on the branch. No push, no PR, no merge.

## Pinterest app facts

- **App ID `1601308`** — non-secret; safe to record here.
- **App secret** — never requested, printed, logged, committed, or placed in source. Provided to the running app only via the Cloudflare environment binding `PINTEREST_CLIENT_SECRET` (not set as part of Phase A implementation).
- Trial access: active.
- **Callback / redirect URI:** `${origin}/callback/pinterest` (e.g. `https://creatorpost.app/callback/pinterest`). Must be registered on the Pinterest app before any live OAuth attempt.
- **Scopes:** `boards:read,boards:write,pins:read,pins:write`.
- **Environment variables (must be set out-of-band before live use):** `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`.

## Files changed

| File | Change |
|---|---|
| `lib/pinterest-sandbox.js` | **NEW.** Pure, dependency-free helpers: `verifyOAuthState()` (fail-closed CSRF check), `assertSandboxUrl()` (throws unless host is `api-sandbox.pinterest.com`), `PINTEREST_SANDBOX_HOST`, and the embedded proof-image base64 (`PINTEREST_PROOF_IMAGE_BASE64`, a harmless 1000×1500 solid PNG). Kept outside `functions/` so it is not routed and is unit-testable. |
| `functions/[[route]].js` | **MOD.** Import of the helpers. New Pinterest Phase A section: constants, `isPhaseAOwner()`/`loadOwnerEmail()`, `GET /auth/pinterest`, `GET /callback/pinterest`, `POST /api/pinterest/proof`, and `exchangePinterestSandboxCode()` (Basic-auth token exchange against the Sandbox host). No existing route touched. |
| `public/account.html` | **MOD.** Owner-only card (hidden unless `isDev`): "Connect Pinterest (Sandbox · Test)" link + "Run Pinterest Sandbox Proof" button + status line. Reflects the `?pinterest=…` callback result. Never exposes tokens/secret. |
| `test/pinterest-sandbox.test.js` | **NEW.** `node --test` coverage of state verification and Sandbox-host enforcement (incl. look-alike/spoof hosts and malformed URLs). |
| `package.json` | **MOD.** Added `"test": "node --test"`. No dependency changes. |
| `docs/pinterest-phase-a-implementation.md` | **NEW.** This record. |

## Sandbox-only, fail-closed design

- The **only** Pinterest API host in the Phase A code path is `api-sandbox.pinterest.com`. Production `api.pinterest.com` appears nowhere except in comments documenting its absence.
- `assertSandboxUrl()` is called immediately before **every** token/API fetch; a non-Sandbox host throws before any request is made.
- Pinterest Sandbox tokens are strictly isolated from production (a Sandbox token cannot be used against production, and vice versa), so the flow is inherently fail-closed.
- The authorization endpoint `https://www.pinterest.com/oauth/` is the normal, unavoidably-shared auth host and is expected; it carries no API/token capability.

## Owner-only mechanism

Reuses the incumbent privileged-action convention: `email.endsWith('@mattdonders.com')`. No new RBAC. All three routes enforce it server-side; the UI card is additionally gated by the same `isDev` flag client-side (defense in depth, not the security boundary).

## Persistence & logging behavior

- Stores **only** CreatorPost's own OAuth **access token** in `connected_accounts`, under a **CreatorPost-generated sentinel** `platform_user_id = 'phase-a-sandbox-proof'`. This is **not** a Pinterest identifier; it exists solely to satisfy the `NOT NULL` + `UNIQUE(user_id, platform, platform_user_id)` shape without a schema migration. Reconciliation/replacement with a real Pinterest identifier is an explicit **Phase B** concern.
- **The Pinterest `refresh_token` is deliberately NOT persisted.** Phase A (T1) has no refresh behavior; `connected_accounts.refresh_token` is written `NULL` on both insert and conflict-update. Only the access token and `token_expires_at` are stored.
- The proof board is created with `privacy: 'PUBLIC'` — a normal Sandbox board authorized by the `boards:write` scope. SECRET boards would require a scope Phase A does not request; there is no scope/privacy mismatch.
- `assertSandboxUrl()` requires **both** `https:` protocol **and** host `api-sandbox.pinterest.com`; an `http://` downgrade or any other host is refused before any fetch.
- **CSRF (proof POST):** the `cp_session` cookie is `SameSite=Lax` / `Secure` / `HttpOnly`, so it is not sent on cross-site POSTs. A forged cross-origin `POST /api/pinterest/proof` arrives unauthenticated and is rejected (401). No per-route CSRF token added; global auth unchanged.
- **OAuth state RNG:** `newId()` = `crypto.randomUUID()` (Web Crypto), a cryptographically secure source — suitable for the CSRF `state` nonce.
- **Callback ordering:** OAuth `state` is verified **before** any provider-supplied `error`/`code` is processed (fail-closed). The raw provider `error` value is never logged; a local generic `provider_error` category is recorded instead.
- All Pinterest **profile** columns (`display_name`, `avatar_url`, `username`, etc.) are left `NULL`. No Pinterest profile endpoint is ever called.
- The proof action creates a board id **in memory only** and never persists it; it discards the Pin id/URL and every other Pinterest-returned identifier. The response to the browser is only `{ ok, http_status }`.
- **No `posts` row is written.** No cron, scheduler, or api-key path is involved (`POST /api/pinterest/proof` uses the session cookie via `getSession`, not `getApiKeySession`).
- Logging records booleans/status/expiry only — never the access token or the app secret.

## Verification performed (local / static)

- `npm test` → **7/7 pass** (`node --test`).
- `node --check` on `functions/[[route]].js`, `lib/pinterest-sandbox.js`, `test/pinterest-sandbox.test.js` → all parse clean.
- Grep confirms production `api.pinterest.com` is absent from executable code (comments only).
- Grep confirms no `posts`/`cron`/`getApiKeySession` coupling in the Pinterest code.

## Remaining live validation (NOT performed — requires human authorization)

1. Register the callback URI on Pinterest app `1601308`.
2. Set `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET` in the Cloudflare environment.
3. Owner clicks **Connect Pinterest (Sandbox · Test)** → completes real OAuth → returns to `/account?pinterest=connected`.
4. Owner clicks **Run Pinterest Sandbox Proof** → expect `{ ok: true }` and a Pin visible in the Sandbox board.
5. Capture the demo evidence for the Standard-access application.

## Phase B deferrals (explicitly out of scope here)

- Replace the sentinel `platform_user_id` with a real Pinterest identifier + profile sync.
- Production endpoints, token refresh cron, scheduled/queued publishing, `posts` integration, multi-user support, api-key publishing path.
