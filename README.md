# CreatorPost

A minimal web app for TikTok's Content Posting API approval.

## Stack

- **Frontend**: Plain HTML/CSS — no build step
- **Hosting**: Cloudflare Pages (auto-deploy from GitHub)
- **OAuth callback**: Cloudflare Worker (`worker/callback.js`)
- **Domain**: `tiktok.mattdonders.com`

## Local preview

```bash
# Serve the public/ dir with any static file server
npx serve public
# or
python3 -m http.server 8080 --directory public
```

## Deploy

### Pages (static site)
1. Connect this repo to Cloudflare Pages
2. Set **Build output directory** to `public`
3. Add custom domain `tiktok.mattdonders.com`

### Worker (OAuth callback)
```bash
npx wrangler deploy

# Set secrets after TikTok app is approved:
npx wrangler secret put TIKTOK_CLIENT_ID
npx wrangler secret put TIKTOK_CLIENT_SECRET
npx wrangler secret put DISCORD_WEBHOOK_URL
```

## TikTok App Settings

| Field | Value |
|-------|-------|
| App name | CreatorPost |
| Category | Tools |
| Platform | Web |
| Redirect URI | `https://tiktok.mattdonders.com/callback` |
| Privacy Policy | `https://tiktok.mattdonders.com/privacy.html` |
| Scopes | `video.publish`, `video.upload` |

## OAuth flow (manual trigger)

```
https://www.tiktok.com/v2/auth/authorize?
  client_key=YOUR_CLIENT_ID
  &response_type=code
  &scope=video.publish,video.upload
  &redirect_uri=https://tiktok.mattdonders.com/callback
  &state=mystate123
```
