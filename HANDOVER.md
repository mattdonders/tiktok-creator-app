# CreatorPost — Session Handover (2026-03-13 to 2026-03-15)

## 1. Session Summary

Heavy bug-fixing and pipeline polish session. Main themes:
- Investigated TikTok's internal web upload API via HAR capture (devtools research)
- Fixed multiple photo carousel (`/api/v1/publish/photo`) bugs causing `invalid_params`
- Fixed sync (`/api/v1/sync` + `/api/tiktok/sync-posts`) to correctly resolve inbox posts to published
- Added `username` field to connected accounts (replaces ugly open_id in UI)
- Added `video_ids` to sync response for pipeline engineer
- Cleaned up D1 data (duplicate/blank caption records for dormchic, lovechicfinds)
- Updated pipeline API reference doc

---

## 2. What Worked & What Didn't

### Photo Post Bugs Fixed (3 separate issues)

**Bug 1: `auto_add_music` in MEDIA_UPLOAD fallback**
- `auto_add_music` is only valid for `DIRECT_POST` mode
- When DIRECT_POST fails and we fall back to MEDIA_UPLOAD, sending `auto_add_music` caused `invalid_params`
- Fix: strip `auto_add_music` from `post_info` before the MEDIA_UPLOAD fallback attempt

**Bug 2: `title` vs `description` for photo captions**
- TikTok photo posts use `description` (max 4000 chars) not `title` (max 90 chars) for the caption
- We were sending `title: caption.slice(0, 2200)` — any caption >90 chars caused TikTok to reject the entire `post_info` with `invalid_params`
- Fix: changed to `description: caption.slice(0, 4000)`

**Bug 3: `embed_type` invalid field in `video/list`**
- Added `embed_type` speculatively to the `video/list` fields during debugging
- TikTok rejects it as invalid, breaking ALL syncs silently (just returned 0/0)
- Fix: removed `embed_type` from fields list
- **Note:** Added error logging to sync so future `video/list` API errors are visible in Axiom instead of silently returning 0/0

### Sync Fixes

**Bug: Inbox posts never resolved to published**
- Photo posts and inbox video posts stored with `status=processing`, no `video_id`
- Sync only matched `status = 'processing'` — inbox posts were skipped
- Fix: sync now matches `status IN ('processing', 'inbox')`

**Bug: Duplicate records on sync**
- Inbox posts had `video_id = NULL` in DB
- When sync ran, `WHERE NOT EXISTS (SELECT 1 FROM posts WHERE video_id = ?)` found nothing → inserted new blank-caption record
- Fix: sync now tries to UPDATE an existing processing/inbox post (matched by closest `created_at`) before falling back to INSERT

**Bug: `updatePostStatus` not finding DB-loaded posts**
- Dashboard `recheckStatus()` calls `updatePostStatus(publish_id, ...)` but `updatePostStatus` searched only by `p.id` (UUID)
- Posts loaded from DB have UUID as `p.id`, not `publish_id` — never matched
- Fix: `posts.find(p => p.id === id || p.publish_id === id)`

**Recheck button missing for inbox posts**
- Button condition was `p.status === 'processing'` only
- Fix: added `|| p.status === 'inbox'`

### Username Feature
- Connected accounts showed TikTok `open_id` (e.g. `-000HFzrn3IZxYBwnSRPvyILoU8SbEVk-m7q`) as the handle
- Added `username` column to `connected_accounts`, fetch it from TikTok API during OAuth
- Backfill endpoint: `POST /api/tiktok/backfill-usernames` (dev only) — uses stored tokens, no re-auth needed
- `/api/me` SELECT updated to include `username`

### Image fetch validation
- R2 proxy for photo images didn't check `imgRes.ok` before uploading
- A 403/404 from source URL would silently upload garbage to R2 and pass bad URL to TikTok
- Fix: throws immediately if image fetch fails

### HAR Analysis (research only, no code changes)
- Captured TikTok web uploader network traffic
- Internal endpoint: `POST /tiktok/web/project/post/v1/` — completely different from public API
- Uses `STS2` credentials + `tt-ticket-guard-*` anti-bot headers — not replicable externally
- `content_check_lite` is NOT an API field — it's a TikTok Studio UI tool only
- `auto_add_music` is photo-only, no video equivalent
- Processing delay cannot be reduced via any `post_info` field — it's a TikTok queue issue
- `FILE_UPLOAD` is already the optimal path

---

## 3. Key Decisions Made

- **`description` not `title` for photo captions** — TikTok's photo post API schema differs from video. Title is max 90 chars (for display above carousel), description is the full caption up to 4000 chars.
- **Sync error logging** — Changed silent `break` to log `tiktok_sync_video_list_failed` to Axiom. Essential for diagnosing scope/token issues that return 0/0.
- **`video_ids` array in sync response** — Returns all newly imported video IDs so pipeline doesn't need a follow-up `/stats` call to identify the new video.
- **Stats cache bust on sync** — `localStorage.removeItem('cp_post_stats')` on successful sync so stats are fresh next page load.
- **No `saves`/`bookmarks` field** — Confirmed via research: TikTok's public `video/query` API only exposes `view_count`, `like_count`, `comment_count`, `share_count`. No save/bookmark/completion rate available via any accessible API tier.

---

## 4. Lessons Learned & Gotchas

- **TikTok photo vs video API fields differ significantly**: `title` (max 90), `description` (max 4000), `auto_add_music` — don't assume video field names apply to photos
- **`embed_type` is NOT a valid `video/list` field** — TikTok returns `invalid_params` and breaks all syncs. Fields confirmed valid: `id, title, video_description, create_time, cover_image_url`
- **TikTok's status endpoint is one-way for inbox posts** — Once a post goes to `SEND_TO_USER_INBOX`, the status endpoint always returns that forever. Manual publish from TikTok drafts is NOT reflected via the status API. Only `video/list` sync can detect it's live.
- **oEmbed returns empty title for photo carousel posts** — Can't recover captions for photo posts via oEmbed. Only option is pipeline logs or Discord webhook history.
- **Silent sync failures**: if `video/list` returns any API error, sync used to just return 0/0 with no explanation. Now logs to Axiom.
- **`auto_add_music` DIRECT_POST only**: must be stripped when falling back to MEDIA_UPLOAD or TikTok rejects the whole request
- **Always validate image fetch before R2 upload** — Check `imgRes.ok` before consuming the response body

---

## 5. Current State

All changes deployed to production (`main` branch, auto-deploy). Fully tested:
- Photo posts working end-to-end (pipeline confirmed `INBOX` on lovechicfinds)
- Sync working for all accounts (was broken by `embed_type` field)
- Usernames showing correctly on account page (backfill ran successfully for all 10 accounts)
- D1 data cleaned up: dormchic and lovechicfinds blank caption records fixed

**Still pending:**
- TikTok Direct Post 3rd submission — demo video not yet recorded (user planned for later)
- Wrangler auth expires frequently — occasionally need to re-login

---

## 6. Next Steps (Priority Order)

1. **Record TikTok Direct Post demo video** — Script is in `docs/tiktok-direct-post-demo-video.md`. Key: Point 3a (disclosure validation error message). This is the 3rd submission after two rejections.
2. **Submit 3rd Direct Post application** — See submission strategy at bottom of demo video doc
3. **Run end-to-end production test** — Real video → TikTok + Instagram + YouTube (in TODO.md)
4. **Reconnect own TikTok accounts** — Refresh display_name + avatar (in TODO.md)
5. **Post HeyGen promo videos** — Video 3 first ("TikTok's Secret API" hook)

---

## 7. Key Files Touched This Session

| File | Changes |
|------|---------|
| `functions/[[route]].js` | Photo endpoint: `title→description`, strip `auto_add_music` on MEDIA_UPLOAD fallback, validate image fetch; Sync: match `inbox` status, UPDATE before INSERT, log `video/list` errors, collect `video_ids`; `/api/me`: add `username` to SELECT; OAuth callback: fetch+store `username`; `fetchTikTokProfile`: add `username` to fields; new `POST /api/tiktok/backfill-usernames` endpoint |
| `public/dashboard.html` | `updatePostStatus`: search by `p.id \|\| p.publish_id`; recheck button: show for `inbox` posts too |
| `public/account.html` | `syncPosts()`: bust `cp_post_stats` cache on success; `handle` display: use `username` with `platform_user_id` fallback |
| `schema.sql` | Added `username TEXT` column to `connected_accounts` |
| `docs/pipeline-api-reference.md` | Added `video_ids` field to `/api/v1/sync` response docs |
| `docs/tiktok-direct-post-demo-video.md` | Updated for 3rd submission (was updated previous session) |

---

## 8. D1 Manual Fixes Applied

```sql
-- dormchic: copied caption from inbox dupe, deleted dupe
UPDATE posts SET caption = 'things that made my dorm feel like home #relatable #college #dormlife #fyp #collegelife'
  WHERE id = '31b2f2b0-5c58-4769-bd76-64c4cd77e580';
DELETE FROM posts WHERE id = '8e283a51-edbc-43a5-8daa-4d9f201f2852';

-- lovechicfinds: restored blank caption from pipeline log
UPDATE posts SET caption = 'Chic Home Decor ✨ #chicstyle #affordablefashion #styleinspo #fashion #aesthetic'
  WHERE id = 'b5e950bf-cf36-4794-bf63-ddef8c910035';
```
