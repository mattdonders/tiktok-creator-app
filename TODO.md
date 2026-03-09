# CreatorPost — TODO

## 🔴 Immediate (unblock v2 launch)

- [ ] Create Cloudflare Pages project for v2 branch
  - Connect `tiktok-creator-app` repo, branch: `v2`
  - Build command: *(blank)*, output dir: `public`
- [ ] Bind D1 database in Pages settings
  - Settings → Functions → D1 bindings → variable `DB` → database `creatorpost`
- [ ] Set environment variables in Pages dashboard
  - `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET`, `RESEND_API_KEY`
- [ ] Sign up for Resend (resend.com) and get API key
  - Verify sending domain via Cloudflare DNS (2 min)
- [ ] Test full v2 flow end-to-end:
  - Sign up via magic link → connect TikTok → upload video

## 🟡 TikTok API

- [ ] Wait for TikTok production app review (submitted — 3–7 business days)
- [ ] Once approved: update `TIKTOK_CLIENT_ID` / `TIKTOK_CLIENT_SECRET` in Cloudflare env
- [ ] Test production video upload with real tokens
- [ ] Implement token refresh (TikTok tokens expire; need cron to refresh)

## 🟠 Platform Expansion (v2.1)

- [ ] Research & prioritize: YouTube, Instagram, LinkedIn, Threads (see branding.md)
- [ ] Add YouTube Shorts publishing (YouTube Data API v3 — easiest, no approval)
- [ ] Add Instagram Reels publishing (Meta Graph API — moderate complexity)
- [ ] Add Threads publishing (shares Meta OAuth with Instagram — near-free if IG done)
- [ ] Update dashboard account selector to show platform icons per account
- [ ] Update `connected_accounts` schema if needed for new platforms

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
- [x] Scaffold v2 architecture: Hono + D1 + magic link auth + multi-account
- [x] Create D1 database `creatorpost` and apply schema
- [x] Remove node_modules from git, clean up old function files
- [x] Push v2 branch to GitHub
