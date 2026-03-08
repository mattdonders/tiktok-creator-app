# TikTok Creator App — Build Instructions

## What We're Building

A minimal web app that exists solely to get approved for TikTok's Content Posting API.
Once approved, the API credentials will be used by a separate Python pipeline
(`~/Development/faceless-instagram`) to automatically post videos to TikTok.

The app needs to look like a legitimate "tool for content creators" — because it is,
technically. The owner is a content creator using it to post their own videos.

## Stack

- **Hosting**: Cloudflare Pages (free tier, deploy from GitHub)
- **OAuth callback**: Cloudflare Worker (handles the TikTok OAuth token exchange)
- **Domain**: `tiktok.mattdonders.com` subdomain (DNS via Cloudflare)
- **Framework**: Plain HTML/CSS — no React, no build step. Keep it simple.

## Pages to Build

### 1. `/` — Landing Page
A clean, professional landing page. Tone: simple SaaS tool for creators.

Content:
- App name: **CreatorPost** (or similar — pick something clean)
- Tagline: "Schedule and publish your TikTok videos automatically"
- Brief feature list: auto-publish, scheduling, multi-account support
- "Get Started" CTA button (can be a waitlist form or just mailto)
- Footer with links to Privacy Policy and Terms

Design: Dark mode, clean, modern. Think Linear/Vercel aesthetic.

### 2. `/privacy` — Privacy Policy
A real, complete privacy policy. Use a generator (e.g. privacypolicygenerator.info)
with these inputs:
- App name: CreatorPost
- Contact email: matt@mattdonders.com
- Data collected: TikTok account info, video content you choose to post
- No data sold to third parties
- Data stored securely

This page MUST be live and real — TikTok reviews it during the app approval process.

### 3. `/terms` — Terms of Service
Boilerplate ToS. Can be minimal.

### 4. `/callback` — OAuth Callback (Cloudflare Worker)
This is the only dynamic endpoint. TikTok redirects here after a user authorizes the app.

The Worker should:
1. Receive the `?code=` query param from TikTok
2. Exchange it for an access token via TikTok's token endpoint
3. Store the token (can just log it / send to a Discord webhook for now)
4. Return a success page: "Connected! You can close this window."

The client_id and client_secret will be set as Cloudflare Worker secrets (not in code).

## TikTok App Setup (Developer Portal)

After the site is live, apply at: https://developers.tiktok.com

App configuration:
- **App name**: CreatorPost
- **Category**: Tools
- **Platform**: Web
- **Redirect URI**: `https://tiktok.mattdonders.com/callback`
- **Privacy Policy URL**: `https://tiktok.mattdonders.com/privacy`
- **Scopes to request**: `video.publish`, `video.upload`

The `video.publish` scope is what allows posting videos directly to TikTok without
the user needing to approve each post in the TikTok app.

## File Structure

```
tiktok-creator-app/
├── public/
│   ├── index.html        # Landing page
│   ├── privacy.html      # Privacy policy
│   ├── terms.html        # Terms of service
│   └── styles.css        # Shared styles
├── worker/
│   └── callback.js       # Cloudflare Worker for OAuth callback
├── wrangler.toml          # Cloudflare Worker config
└── README.md
```

## Deployment

1. Push to GitHub (new repo: `mattdonders/tiktok-creator-app`)
2. Connect repo to Cloudflare Pages (automatic deploys on push)
3. Add custom domain `tiktok.mattdonders.com` in Cloudflare Pages settings
4. Deploy the Worker separately via `wrangler deploy`
5. Set Worker secrets: `wrangler secret put TIKTOK_CLIENT_ID` etc.

## Environment Variables / Secrets (set after TikTok app is approved)

```
TIKTOK_CLIENT_ID=...
TIKTOK_CLIENT_SECRET=...
DISCORD_WEBHOOK_URL=...   # To receive tokens after OAuth
```

## Notes

- The OAuth flow is only needed once per TikTok account to get the initial token.
  After that, the pipeline refreshes tokens automatically.
- The pipeline at `~/Development/faceless-instagram` will use `tiktok_publisher.py`
  which will be rewritten to use the TikTok API directly once credentials are obtained.
- Keep the site live permanently — TikTok periodically checks that the privacy policy
  URL is still accessible.
