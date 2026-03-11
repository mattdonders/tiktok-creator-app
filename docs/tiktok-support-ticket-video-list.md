# TikTok Support Ticket — video.list scope_not_authorized

## Ticket Status
- **Submitted:** 2026-03-10
- **TikTok response received:** 2026-03-11 (requesting more info)
- **Log ID:** 202603100851240EF1C2FF8F739D033636

## Issue Summary
`video.list` scope is listed and enabled in the app but returns `scope_not_authorized`
(HTTP 401) when calling `/v2/video/query/`. The Display API product does not appear
as an addable product in the developer portal.

## App Details
- **App ID:** 7614726586902005771
- **Client Key:** aw6wvd9phoeqxemc
- **Status:** Live / Production
- **Approved product:** Content Posting API

## Error Response
```json
{
  "error": {
    "code": "scope_not_authorized",
    "message": "The user did not authorize the scope required for completing this request.",
    "log_id": "202603100851240EF1C2FF8F739D033636"
  }
}
```
**Endpoint:** `POST https://open.tiktokapis.com/v2/video/query/`
**HTTP status:** 401

## cURL to Reproduce
```bash
curl -s -X POST "https://open.tiktokapis.com/v2/video/query/" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"filters": {"video_ids": ["7589883055670693134","7588664616188693774"]}}'
```

## Steps to Reproduce
1. App ID 7614726586902005771 — Production, Content Posting API approved
2. `video.list` scope listed and enabled in app scope configuration
3. User completes OAuth flow — token issued successfully
4. Call POST /v2/video/query/ with issued access token
5. Receive HTTP 401 scope_not_authorized

## Root Cause (suspected)
`video.list` belongs to the Display API product, which is separate from Content Posting API.
Display API does not appear as an addable product in the portal for this app.
Only available products: Login Kit, Share Kit, Content Posting API, Webhooks, Data Portability API.

## Reply to TikTok (2026-03-11)
See draft in conversation — needs Client Key filled in before sending.
