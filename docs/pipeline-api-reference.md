# CreatorPost — Pipeline API Reference

**Base URL:** `https://creatorpost.app`
**Auth:** All `/api/v1/` endpoints require a Bearer API key in the `Authorization` header.

```
Authorization: Bearer cp_<your_key>
```

API keys are managed at `creatorpost.app/account`.

---

## Endpoints

### `GET /api/v1/accounts`

Returns all connected social accounts for the authenticated user.

**Response:**
```json
[
  {
    "id": "uuid",
    "platform": "tiktok",
    "display_name": "Get Daily History Facts",
    "platform_user_id": "7123456789"
  }
]
```

Use the `id` field as `account_id` in all other endpoints. Do not rely on `display_name` for matching — use the UUID.

---

### `POST /api/v1/publish`

Upload and publish a video to TikTok.

**Request:** `multipart/form-data` or JSON with `video_url`

| Field        | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `account_id` | string | yes      | Account UUID from `/api/v1/accounts` |
| `caption`    | string | yes      | Video caption / description |
| `file`       | file   | one of   | Video file (multipart upload) |
| `video_url`  | string | one of   | Public URL to pull video from |

**Response:**
```json
{
  "ok": true,
  "publish_id": "v_pub_...",
  "status": "processing"
}
```

**Notes:**
- FILE upload is significantly faster than `video_url` — TikTok processes it immediately vs. joining a download queue
- Until Direct Post is approved, videos are sent to TikTok drafts (inbox). Status will be `inbox` rather than `published`
- Poll `GET /api/v1/stats` to check when a video transitions from `processing` to `published`/`inbox`

---

### `POST /api/v1/publish/photo`

Publish a photo carousel to TikTok. Images are fetched by TikTok directly from the provided URLs — upload to B2 first and pass the public URLs.

**Request:** JSON body

```json
{
  "account_id": "uuid",
  "caption":    "Your caption here",
  "images":     ["https://your-bucket.com/img1.jpg", "https://your-bucket.com/img2.jpg"],
  "music_id":   "7123456789012345678"
}
```

| Field        | Type            | Required | Description |
|-------------|-----------------|----------|-------------|
| `account_id` | string          | yes      | Account UUID from `/api/v1/accounts` |
| `caption`    | string          | yes      | Post caption, max 2200 chars |
| `images`     | array of strings | yes     | Public image URLs, in display order. Max 35. |
| `music_id`   | string          | no       | TikTok sound ID. If omitted, TikTok auto-selects music. |

**Response:**
```json
{
  "ok": true,
  "publish_id": "v_pub_...",
  "post_id": "uuid"
}
```

**Notes:**
- Images are displayed in array order
- `photo_cover_index` is always `0` (first image) — contact if you need this configurable
- If `music_id` is omitted, `auto_add_music: true` is sent so TikTok picks trending audio
- No inbox fallback for photo posts — requires Direct Post approval (same as video)
- Rate limits: same as video, no limits enforced on our side
- **Image format: use JPEG only.** TikTok's docs claim PNG/WEBP are supported but in practice the API rejects PNGs with `file_format_check_failed`. Always convert to JPEG before uploading to B2.
- **Poll for status after publishing** — TikTok processes images async. A 200 response does not mean the post succeeded. Use `GET /api/v1/publish/status` to confirm (see below).

---

### `GET /api/v1/publish/status`

Poll TikTok's publish status for a post. **Call this after every publish** — TikTok processes images async and can fail after returning a valid `publish_id`. Updates the post record in the DB automatically.

**Query params:** `publish_id`, `account_id`

**Example:**
```
GET /api/v1/publish/status?publish_id=p_inbox_url~v2.xxx&account_id=<uuid>
Authorization: Bearer cp_...
```

**Response:**
```json
{ "status": "PUBLISH_COMPLETE", "fail_reason": null, "video_id": "7123456789012345678" }
```

| `status` | Meaning |
|---|---|
| `PROCESSING_DOWNLOAD` | TikTok still working — keep polling |
| `SEND_TO_USER_INBOX` | Went to TikTok drafts (Direct Post not yet approved) |
| `PUBLISH_COMPLETE` / `DOWNLOAD_COMPLETE` | Live on TikTok — `video_id` is set |
| `FAILED` | Rejected — check `fail_reason` |

**Suggested polling strategy:** poll every 3–5 seconds for up to 60 seconds. If still `PROCESSING_DOWNLOAD` after that, log it and move on — the next `/api/v1/sync` call will resolve it.

---

### `POST /api/v1/sync`

Syncs all published TikTok videos for an account into the CreatorPost database. Also refreshes the stored `follower_count` for that account.

**Request:** JSON body

```json
{ "account_id": "uuid" }
```

**Response:**
```json
{
  "ok": true,
  "imported": 1,
  "skipped": 42,
  "follower_count": 1284,
  "video_ids": ["7312345678901234567"]
}
```

| Field            | Description |
|-----------------|-------------|
| `imported`       | New videos added to the database |
| `skipped`        | Videos already in the database (not duplicated) |
| `follower_count` | Current follower count for the account (`null` if `user.info.stats` scope not granted) |
| `video_ids`      | Array of TikTok video IDs that were newly imported. Empty array if `imported: 0`. Use this to link a just-published video to stats without an extra `/stats` call. |

**When to call:**
- After a successful publish, wait ~60 seconds then call sync to import the new video
- Sync is idempotent — safe to call multiple times, will never create duplicates

---

### `GET /api/v1/posts/{post_id}`

Look up a single post by its CreatorPost UUID. Returns the current state including `video_id` (TikTok's numeric ID) once resolved. Use this to map `post_id → video_id` after publish.

**Response:**
```json
{
  "post_id":      "uuid",
  "video_id":     "7617528876855528734",
  "caption":      "Your caption here",
  "status":       "published",
  "platform":     "tiktok",
  "account_id":   "uuid",
  "account":      "Get Daily History Facts",
  "publish_time": "2026-03-20T14:00:00.000Z",
  "publish_id":   "v_pub_..."
}
```

| Field          | Description |
|---------------|-------------|
| `post_id`      | Internal CreatorPost UUID (same as what `/api/v1/publish` returned) |
| `video_id`     | TikTok's numeric video ID — `null` until resolved via sync |
| `status`       | `processing`, `inbox`, `published`, `failed`, or `scheduled` |
| `publish_time` | ISO 8601 timestamp of when the post record was created |
| `publish_id`   | TikTok's publish job ID (used to poll TikTok's own status endpoint) |

**Notes:**
- Returns `404` if `post_id` not found or belongs to a different user
- `video_id` is `null` for inbox/processing posts until `/api/v1/sync` resolves them
- Polling pattern: after publish, poll this endpoint until `video_id != null`, then call `/api/v1/stats`

---

### `GET /api/v1/stats`

Returns live per-video stats for the last 100 published TikTok posts. Stats are fetched **in real-time from TikTok on every call** — no server-side cache, no sync schedule.

**Response:**
```json
[
  {
    "post_id": "uuid",
    "video_id": "7123456789012345678",
    "account_id": "uuid",
    "account": "Get Daily History Facts",
    "follower_count": 1284,
    "caption": "The day the Berlin Wall fell...",
    "status": "published",
    "created_at": 1741824000,
    "stats": {
      "views": 4821,
      "likes": 312,
      "comments": 14,
      "shares": 28
    }
  }
]
```

| Field            | Description |
|-----------------|-------------|
| `post_id`        | Internal CreatorPost UUID for this post |
| `video_id`       | TikTok's video ID |
| `account_id`     | Account UUID |
| `account`        | Account display name |
| `follower_count` | Last known follower count — updated each time `/api/v1/sync` is called for this account |
| `follower_count_updated_at` | Unix timestamp of when `follower_count` was last refreshed. Use this to decide whether to call `/api/v1/sync` before collecting stats — if `null` or `> 86400` seconds ago, trigger a sync first |
| `caption`        | Video caption stored at time of post/sync |
| `status`         | `published`, `inbox`, `processing`, `failed`, `scheduled` |
| `created_at`     | Unix timestamp (seconds) |
| `stats`          | Live TikTok stats, or `null` if TikTok didn't return data for this video |

**Notes:**
- Only returns posts with a resolved `video_id` (inbox/processing posts are excluded until published)
- `stats` is `null` for private videos or videos TikTok's API doesn't return data for
- `follower_count` is the last value stored during sync — not fetched live on this call

---

## Recommended Pipeline Flow

### Post day (once per account per day)

```
1. POST /api/v1/publish   — upload video
2. sleep(60)              — wait for TikTok to process
3. POST /api/v1/sync      — import new video, refresh follower_count
4. GET  /api/v1/stats     — collect fresh stats
```

### Stats-only runs (as frequently as needed)

```
1. GET /api/v1/stats      — always live, no need to sync first
```

Since `/api/v1/stats` hits TikTok live on every call, you can poll it as frequently as you want. `follower_count` only refreshes when you call `/api/v1/sync`, so on post days you get an updated follower count automatically as part of the normal flow.

---

## Status Values

| Status       | Meaning |
|-------------|---------|
| `processing` | Submitted to TikTok, waiting for result |
| `published`  | Live on TikTok (Direct Post approved) |
| `inbox`      | Sent to TikTok drafts — requires manual publish in TikTok app (Direct Post pending approval) |
| `failed`     | TikTok rejected the upload |
| `scheduled`  | Scheduled for future publish |

---

## Rate Limits

No rate limits are enforced by CreatorPost. The practical constraint is TikTok's API:
- `video/query` (used by `/api/v1/stats`): max 20 video IDs per request — batched automatically
- `video/list` (used by `/api/v1/sync`): max 20 videos per page — paginated automatically

---

## Data Storage Notes

- **Video stats (views, likes, comments, shares)** are never stored — fetched live from TikTok on every `/api/v1/stats` call
- **Follower counts** are stored per account and updated each time `/api/v1/sync` is called
- **Post metadata** (caption, video_id, status, created_at) is stored permanently in the database
