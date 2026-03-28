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
- [ ] **Record TikTok Direct Post demo video** (3rd submission) — script in `docs/tiktok-direct-post-demo-video.md`, nail Point 3a validation error
- [ ] **Submit 3rd Direct Post application** with new demo video
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
