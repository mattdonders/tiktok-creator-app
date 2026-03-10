# CreatorPost — TODO

## 📣 Marketing / Content

- [ ] Generate 3 HeyGen promo videos using Avatar 4 + Dustin avatar
  - Video 3 first ("TikTok's Secret API" — strongest hook)
  - Video 1 second ("The Manual Upload Trap")
  - Video 2 third ("Before vs After")
  - Preferred portrait IDs noted in session (save grid image to docs/heygen-dustin-portraits.png)
  - Post to TikTok + Instagram only (skip YouTube Shorts)
  - Pin all 3 on @creatorpostapp TikTok + Instagram profiles
- [ ] Post existing 3 TikTok videos to Instagram Reels via CreatorPost
- [ ] Post on r/SideProject + r/Entrepreneur ("I built this") for first users

## 🔴 Immediate

- [ ] Test full upload flow end-to-end with production TikTok credentials
- [ ] Verify Axiom logs are appearing after redeploy
- [ ] Reconnect TikTok account (to pull real display_name/avatar now that profile scope works)
- [ ] Implement token refresh (TikTok tokens expire; need cron to refresh)
- [ ] Wait for TikTok revision review (added scopes + second redirect URI)

## 🟠 Platform Expansion (v2.1)

- [ ] Research & prioritize: YouTube, Instagram, LinkedIn, Threads (see branding.md)
- [x] Add YouTube Shorts publishing (YouTube Data API v3 — easiest, no approval)
- [x] Add Instagram Reels publishing (Meta Graph API — moderate complexity)
- [ ] Add Threads publishing (shares Meta OAuth with Instagram — near-free if IG done)
- [ ] Update dashboard account selector to show platform icons per account
- [ ] Update `connected_accounts` schema if needed for new platforms

## 🏢 Teams (Future)

- [ ] Design teams model: team → members (user_ids) + shared connected accounts
- [ ] Add `tiktok_videos` table scoped by `platform_user_id` (not `user_id`) so all team members who share a TikTok account see the same historical stats regardless of who posted
- [ ] Build team invite / member management UI

## 🟢 Product / Monetization

- [ ] Define pricing tiers (free / pro / agency)
- [ ] Set up Stripe (or Lemon Squeezy — simpler for solo)
- [ ] Build billing page / upgrade flow
- [ ] Add usage limits to free tier (e.g. 5 posts/month, 1 account)
- [ ] Add waitlist → invite flow (convert Kit.com waitlist signups)

## 🔵 Branding & Marketing

- [ ] Claim @creatorpost on Instagram (if not already)
- [ ] Claim @creatorpost on X/Twitter (even if not actively posting)
- [ ] Claim @creatorpost on YouTube
- [ ] Post first piece of content to @creatorpost TikTok (account already created)
- [ ] Set up a short newsletter (Beehiiv free tier) for updates + creator tips
- [ ] Write landing page blog post: "How to auto-post TikTok videos with an API"
- [ ] Submit to Product Hunt (when v2 is live and stable)

## ⚙️ Technical Debt / Improvements

- [ ] Account page polish: move "Generate API Key" button to header row (inline with API KEYS label, like Connected Accounts)

- [ ] Implement proper `disconnect` endpoint (currently redirects to logout)
  - Should remove specific `connected_accounts` row, not clear session
- [ ] Add cron job for token refresh (Cloudflare Cron Triggers)
- [ ] Add proper error logging (Cloudflare Analytics or Sentry free tier)
- [ ] Rate limit `/auth/send` endpoint (prevent magic link spam)
- [ ] Add `_redirects` file for clean URL routing if needed

---

## ✅ Completed

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
