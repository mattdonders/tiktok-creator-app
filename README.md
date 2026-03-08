# CreatorPost

A minimal web app for TikTok's Content Posting API approval.

## Stack

- **Frontend**: Plain HTML/CSS — no build step
- **Hosting**: Cloudflare Pages (auto-deploy from GitHub)
- **OAuth callback**: Cloudflare Pages Function (`functions/callback.js` → `/callback`)
- **Domain**: `tiktok.mattdonders.com`

## Local preview

```bash
npx serve public
# or
python3 -m http.server 8080 --directory public
```

## Deploy

### One-time Cloudflare Pages setup
1. Connect this repo to Cloudflare Pages
2. Set **Build output directory** to `public` (no build command needed)
3. Add custom domain `tiktok.mattdonders.com`
4. In **Settings → Environment variables**, add:
   - `TIKTOK_CLIENT_ID`
   - `TIKTOK_CLIENT_SECRET`
   - `DISCORD_WEBHOOK_URL`

After that, every push to `main` auto-deploys everything — static files and the `/callback` function.

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
