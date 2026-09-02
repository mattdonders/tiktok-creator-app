# CreatorPost — TODO

## 🚀 Soft-Launch Checklist (do in order)

### Week 1 — Ship & Test (now)
- [x] Token refresh cron (GitHub Actions every 6h → `/api/cron/refresh-tokens`)
- [x] Rolling sessions (cookie + DB expiry refresh on every API call)
- [x] Welcome email on first sign-up
- [x] Onboarding banner for new users with no accounts connected
- [x] Empty state connect links in "Publish To" panel
- [x] Beta badge on landing page + nav
- [x] Auto-redirect logged-in users from landing page → dashboard
- [x] Login page email pre-fill from localStorage
- [x] AI Caption / Hashtags button label fixes
- [x] Upgrade button → "Pro plan coming soon — Join waitlist"
- [x] API Keys button moved inline with section header
- [ ] Reconnect own TikTok accounts (refresh display_name + avatar)
- [ ] Run end-to-end production test: real video → TikTok + Instagram + YouTube

### Week 2 — Own Platform Seeding
- [ ] Post HeyGen Video 3 first ("TikTok's Secret API" — strongest hook) via CreatorPost → @creatorpostapp TikTok + Instagram, pin it
- [ ] Post existing 3 TikTok videos to Instagram Reels via CreatorPost (validates flow + builds @creatorpostapp IG)
- [ ] Write Twitter/X thread on personal account: "I got approved for TikTok's Content Posting API — here's what it took"

### Week 3 — Community Distribution
- [ ] Post on r/SideProject — builder story angle
- [ ] Post on r/Entrepreneur — efficiency angle
- [ ] DM 10-20 known creators with direct beta invite
- [ ] Tweet #buildinpublic with real pipeline numbers

### Week 4 — Feedback + Polish
- [ ] Collect feedback (Tally form or direct DM)
- [ ] Fix top 2-3 reported issues
- [ ] If TikTok Direct Post approved → update landing page, remove inbox caveats
  - Also make the `/api/publish` Inbox fallback fail loud (see "Known: silent Inbox fallback" below). Once Direct Post is approved, a silent downgrade to Inbox is a correctness bug, not a safety net — and the persisted-data answer can then drop its Inbox reference.
- [ ] Start Product Hunt prep (screenshots, tagline, hunter outreach)

---

## 📣 Marketing / Content

- [ ] Generate 3 HeyGen promo videos using Avatar 4 + Dustin avatar
  - Video 3 first ("TikTok's Secret API" — strongest hook)
  - Video 1 second ("The Manual Upload Trap")
  - Video 2 third ("Before vs After")
  - Post to TikTok + Instagram only (skip YouTube Shorts)
  - Pin all 3 on @creatorpostapp TikTok + Instagram profiles

## 🟠 Platform Expansion (v2.1)

- [ ] Add Threads publishing (shares Meta OAuth with Instagram — near-free if IG done)
- [ ] Update dashboard account selector to show platform icons per account

## 🏢 Teams (Future)

- [ ] Design teams model: team → members (user_ids) + shared connected accounts
- [ ] Build team invite / member management UI

## 🟢 Product / Monetization

- [ ] Define pricing tiers (free / pro / agency)
- [ ] Set up Stripe (or Lemon Squeezy — simpler for solo)
- [ ] Build billing page / upgrade flow
- [ ] Add usage limits to free tier (e.g. 5 posts/month, 1 account)
- [ ] Add waitlist → invite flow (convert signups)

## 🔵 Branding & Marketing

- [ ] Set up a short newsletter (Beehiiv free tier) for updates + creator tips
- [ ] Write landing page blog post: "How to auto-post TikTok videos with an API"
- [ ] Submit to Product Hunt (after Direct Post approved + 5+ real users)

## ⚙️ Technical Debt / Improvements

- [ ] Rate limit `/auth/send` endpoint (prevent magic link spam)
- [ ] Add `_redirects` file for clean URL routing if needed
- [ ] Add Threads publishing

---

## ✅ Completed

- [x] Auto-retry logic (`withRetry` + platform-specific `isRetryable` predicates wired into all 6 publish routes)
- [x] D1 migration: `retry_count` + `last_error` columns added to `posts` table (applied 2026-03-28)
- [x] Rate limit tracking (`captureRateLimits` helper wired into TikTok, Instagram, YouTube publish + status flows)
- [x] Fix Instagram publish: missing `failed` DB write on `media_publish` exhaustion
- [x] `sendDiscordAlert` extended with optional `color` + `title` params (yellow 0xffcc00 for rate limit warnings)
- [x] Build v1 app (plain HTML + Cloudflare Workers, single TikTok account)
- [x] Fix avatar broken image (initials fallback)
- [x] Fix schedule toggle CSS specificity bug
- [x] Fix disconnect button (server-side cookie clear via `/api/logout`)
- [x] Add inbox/draft fallback for TikTok direct post failures
- [x] Submit TikTok production app for review
- [x] TikTok production app APPROVED
- [x] Scaffold v2 architecture: Hono + D1 + magic link auth + multi-account
- [x] Create D1 database `creatorpost` and apply schema
- [x] Merge v2 → main, deploy to creatorpost.app
- [x] Set up Resend + verify creatorpost.app sending domain
- [x] Magic link auth working end-to-end
- [x] TikTok OAuth working with production credentials
- [x] Fix disconnect UX (removes account only, no logout)
- [x] Add Axiom structured logging
- [x] Set up social accounts @creatorpostapp (TikTok, Instagram, Twitter, YouTube)
- [x] Write branding content (docs/branding.md)
- [x] Write HeyGen promo video scripts (docs/heygen-video-prompt.md)
- [x] Add YouTube Shorts publishing
- [x] Add Instagram Reels publishing
- [x] Token refresh cron (GitHub Actions)
- [x] Rolling sessions
- [x] Welcome email on signup
- [x] Onboarding UX (banner, empty states, button labels)
- [x] Beta badge + landing page auto-redirect
- [x] API Keys button + Upgrade button polish
- [x] Photo carousel endpoint (`/api/v1/publish/photo`) — R2 proxy, description field, MEDIA_UPLOAD fallback
- [x] Fix photo post `invalid_params` (title→description, strip auto_add_music from fallback)
- [x] Fix sync: resolve inbox posts to published, dedupe records, log video/list errors
- [x] Add `username` field to connected accounts + backfill endpoint
- [x] Add `video_ids` to `/api/v1/sync` response
- [x] Fix recheck button for inbox posts + `updatePostStatus` find by publish_id
- [x] Posts & Analytics page (`/posts`) with infinite scroll, filters, aggregate stats
- [x] Pipeline API reference doc (`docs/pipeline-api-reference.md`)
- [x] Fix interaction toggles (Comment/Duet/Stitch) defaulting to ON — violated TikTok Content Sharing Guidelines; fixed HTML default + `resetForm()` re-check bug (commit `d76af6a`, 2026-08-04)
- [x] Record 3-clip TikTok Direct Post demo video (OAuth, post-to-TikTok flow, post-trigger validation) and submit 4th Content Posting API application (submitted 2026-08-04, awaiting response 2-4 weeks) — clips + notes in `docs/submission-videos/`

## 🔜 Follow-up
- [ ] Check TikTok Developer Portal "Manage apps" page for the **v10 resubmission** decision (submitted 2026-09-02 with `v10-final-cut.mp4` + Direct Post wording in two answers; expect a reply ~week of 2026-09-16 to 2026-09-30). Exact submitted answers: `docs/tiktok-content-posting-api-application-2026-08-22.md`
- [x] v6 resubmission (2026-08-22, ref `20260823012426`) — REJECTED for demonstrating Upload/Inbox rather than Direct Post. Superseded by v10.
- [x] Build v6 TikTok Direct Post audit video — full replacement of the old `docs/submission-videos/clip2/clip3` pipeline (predated the disclosure/privacy/branded-content compliance fixes). New cut in `submission-v5/` sources fresh post-fix recordings only (`fresh-oauth-flow.mp4`, `fresh-desktop-flow.mp4`, iOS native-completion recording), composites a 200px black caption band beneath unmodified 1440x900 UI footage (no overlays), and drops the TikTok-web-inbox beat entirely (owner confirmed TikTok inbox/notifications aren't functional on web — that proof lives on iOS instead). Final: `submission-v5/v6-final-cut.mp4`, 145.28s, 1440x1100, 4.3MB. Rebuildable via `submission-v5/build-v6-cut.sh`. Owner marked PASS 2026-08-22, submitting manually via Developer Portal (not done by Claude, per standing instruction not to submit).

## 📎 Known: silent Inbox fallback in `/api/publish` (note, not a task)

Recorded so it isn't rediscovered from scratch. **No work item is open for this** —
it is deliberately parked until the TikTok decision arrives.

`app.post('/api/publish')` in `functions/[[route]].js` (~line 1658) catches a failed
Direct Post `video/init` and silently retries against `TIKTOK_INBOX_INIT_URL`. The
user sees a success; the video lands in the TikTok Inbox as a draft instead of on
their profile.

Why it matters, in one line: **this is what got the 2026-08-22 application rejected.**
The v6 capture recorded the fallback firing, so the video demonstrated Upload where the
application was asking for Direct Post. v10 avoids it with a fail-loud capture gate
(aborts on `/draft|uploaded to/i`) — the capture is honest, the product is unchanged.

Consequences to keep straight:
- The persisted-data answer's Inbox reference is literally true *only because* this
  fallback exists. Fix the code first, then the answer — not the other way round.
- While it exists, "CreatorPost did a Direct Post" is not something the UI can be
  trusted to tell you. Confirm against TikTok Studio.
- It is a textbook silent default, which is a house-rule violation everywhere else.

Trigger to act: TikTok approves Direct Post (→ see the Week 4 item), or any report of a
post "succeeding" but not appearing on profile. Absent either, leave it alone — a
fail-loud change here turns a degraded post into a hard error, which is the right
behaviour only once Direct Post is actually approved.

## 📌 Pinterest Production Activation (2026-08-21)

- [x] Gate 1 — Production OAuth: connected `owner-prod` in production D1
- [x] Gate 2 — Connection verification: token present/unexpired, live board read confirmed 3/3 expected SHH boards
- [x] Fix: first production OAuth was completed as the wrong CreatorPost login (`creatorlab@mattdonders.com`), which didn't retire the Phase A sandbox sentinel (atomic retire is scoped by `user_id`, and the OAuth session's user didn't match the sentinel's owner). Deleted the stray `owner-prod` row; correct OAuth then completed as `contentlab@mattdonders.com`, which matched the sentinel's `user_id` and retired it correctly.
- [x] Recovered missing `CREATORPOST_INTERNAL_TOKEN` — not in this repo's local env; found live in `content-lab/pinterest-integration/handoff/.env`. Tightened that file's permissions 644 → 600.
- [x] **Local `main` divergence from `origin/main`** — ✅ RESOLVED, verified 2026-09-02 at `988253a`: `main` is level with `origin/main` (0 ahead / 0 behind) and contains both the TikTok audit commit `8fbda1b` and the full Pinterest B0-B4 range through `f672bd9`. No rebase needed; local working tree is no longer missing Pinterest code.
- [ ] Gate 3 (real Pin proof) — NOT authorized/attempted this session. Explicitly out of scope until separately requested.
