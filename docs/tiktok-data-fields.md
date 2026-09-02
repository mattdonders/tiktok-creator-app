# TikTok API Response Fields Persisted to CreatorPost's D1 Database

Read-only inspection of the production implementation, done to answer TikTok's Content
Posting API application question: *"Please list the API response data fields that your
API client will save in its database."*

Source of truth: `functions/[[route]].js` (production route handler) and `schema.sql`,
`main` branch @ `1083e8b` (2026-08-22). Traced from actual code, not TikTok docs —
fields that are received but never written to D1 are called out explicitly and excluded
from the "persisted" answer.

## 1. OAuth token exchange — `POST https://open.tiktokapis.com/v2/oauth/token/`
`exchangeTikTokCode()` (functions/[[route]].js:2089), consumed in the `/callback` handler (~line 1508).

| TikTok response field | Persisted? | Table.column |
|---|---|---|
| `access_token` | Yes | `connected_accounts.access_token` |
| `refresh_token` | Yes | `connected_accounts.refresh_token` |
| `expires_in` | Yes (converted to absolute epoch: `now() + expires_in`) | `connected_accounts.token_expires_at` |
| `open_id` | Yes | `connected_accounts.platform_user_id` |
| `scope` | No — only written to a log event (`tiktok_connected`, line 1557), not to D1 | — |
| `refresh_expires_in`, `token_type` | No — received, never referenced | — |

## 2. Profile fetch — `GET .../v2/user/info/?fields=open_id,avatar_url,display_name,username`
`fetchTikTokProfile()` (line 2122); used at OAuth-connect time and in the periodic username backfill (line 3067).

| Field | Persisted? | Table.column |
|---|---|---|
| `display_name` | Yes | `connected_accounts.display_name` |
| `avatar_url` | Yes | `connected_accounts.avatar_url` |
| `username` | Yes | `connected_accounts.username` |
| `open_id` | Already captured via token exchange; not re-written here | — |

## 3. Stats sync — `GET .../v2/user/info/?fields=follower_count,display_name`
`runTikTokSync()`, line 2910.

| Field | Persisted? | Table.column |
|---|---|---|
| `follower_count` | Yes | `connected_accounts.follower_count` (+ `follower_count_updated_at`, a server timestamp, not a TikTok value) |

## 4. Video list sync — `POST .../v2/video/list/?fields=id,title,video_description,create_time,cover_image_url`
Line 2933.

| Field | Persisted? | Table.column |
|---|---|---|
| `id` | Yes | `posts.video_id` |
| `video_description` (fallback `title`) | Yes | `posts.caption` — only fills an empty caption, never overwrites one already set |
| `create_time` | Yes | `posts.tiktok_create_time` |
| `cover_image_url` | No — requested in `fields` but never read from the response; not persisted | — |
| `title` (as a distinct field, when `video_description` is present) | No — only used as a caption fallback, not stored separately | — |

## 5. Video stats query — `POST .../v2/video/query/?fields=id,view_count,like_count,comment_count,share_count`
Line 2382 (`/api/v1/posts/stats` route).

| Field | Persisted? |
|---|---|
| `view_count`, `like_count`, `comment_count`, `share_count` | **No.** Assembled into an in-memory `statsMap` keyed by post UUID and returned directly in the JSON response. Never written to D1 — no column for any of these exists on `posts` or `connected_accounts`. |
| `id` (in the separate `create_time`-only backfill query) | Written back to `posts.tiktok_create_time` only, not `video_id` (video_id is already known — it's the query key) |

## 6. Publish init — `POST .../v2/post/publish/{video,inbox/video,content}/init/`

| Field | Persisted? | Table.column |
|---|---|---|
| `publish_id` | Yes | `posts.publish_id` |
| `upload_url` | No — used immediately to PUT the video bytes, then discarded; never stored | — |

## 7. Publish status poll — `POST .../v2/post/publish/status/fetch/`
Lines 1788–1809 and 2648–2655 (duplicated logic).

| Field | Persisted? | Table.column |
|---|---|---|
| `data.status` | Yes, mapped to CreatorPost's own enum: `PUBLISH_COMPLETE`/`DOWNLOAD_COMPLETE` → `'published'`, `SEND_TO_USER_INBOX` → `'inbox'`, `FAILED` → `'failed'` | `posts.status` |
| `data.publicaly_available_post_id[0]` (TikTok's own typo) | Yes — only on the completed-publish branch | `posts.video_id` |

## 8. Token refresh — `POST .../v2/oauth/token/` (grant_type=refresh_token)
`refreshTikTokToken()` (line 2106), applied in `refreshExpiredTikTokTokens()` (line 3143).

Same three fields as initial exchange (`access_token`, `refresh_token` — falls back to
the prior value if TikTok omits it, `expires_in` → `token_expires_at`), overwriting the
existing `connected_accounts` row. No new field types.

## Fields explicitly NOT persisted (transient only, confirmed by code)
- `scope` (OAuth grant)
- `cover_image_url`, `title` as a separate field, `duration`, `height`, `width`, `embed_html`, `embed_link`, `share_url` (video/query and video/list — requested/available but not written)
- `view_count`, `like_count`, `comment_count`, `share_count` (video stats — computed per-request, never stored)
- `upload_url` (publish init — consumed once, discarded)
- `token_type`, `refresh_expires_in` (OAuth)

## CreatorPost-generated fields (not TikTok-originated, excluded above)
Living alongside TikTok data in the same tables: `id` (uuid), `user_id`, `platform`
(`'tiktok'` literal), `group_name`, `created_at` / `follower_count_updated_at` (server
timestamps), `caption` (user-authored, only backfilled from TikTok when blank), `status`
lifecycle values, `retry_count`, `last_error`, `scheduled_at`.

## Should OAuth access/refresh tokens and expiry be included in the form answer?

**Yes.** The form question is precisely aimed at credential handling — the highest-risk
category of persisted data. `access_token`, `refresh_token`, and `token_expires_at` are
the literal fields TikTok's reviewers expect disclosed; omitting them reads as evasive
once they inspect the actual OAuth implementation (which Direct Post review typically
does). Disclose them, with the one true mitigating fact: they're stored server-side only
(D1), never exposed to the client/browser, and used solely to make authenticated calls
back to TikTok's own API on the user's behalf (publish, sync, refresh) — not shared with
any third party.

---

## TikTok-form-ready answer (plain English)

> When a creator connects their TikTok account, CreatorPost stores: the TikTok OAuth
> access token, refresh token, and token expiration time (used server-side only, to make
> authenticated calls back to TikTok's API — never exposed to the client or shared with
> third parties); the TikTok user's open_id, display name, avatar URL, and username (for
> account display and identification within CreatorPost); and follower count (for basic
> account stats display). For each video published or already present on the account,
> CreatorPost stores the TikTok video ID, its TikTok-reported creation time, the video's
> caption/description, and a CreatorPost-assigned publish status (processing, published,
> failed, or sent to inbox) along with our internal publish_id used to track the specific
> publish job. CreatorPost does not persist TikTok engagement metrics (views, likes,
> comments, shares) — those are fetched live from TikTok's API when displayed and are not
> stored in our database.
