# whoswronghere — Cross-Platform Audit

_Generated 2026-03-27_

---

## 1. Current Platform Configuration

**Config file:** `faceless-instagram/accounts/whoswronghere/config.json`

```json
{
  "handle": "whoswronghere",
  "tagline": "Pick a side.",
  "brand_color": [210, 35, 45],
  "stroke_color": [150, 20, 30],
  "tiktok_enabled": true,
  "ig_enabled": false,
  "carousel_enabled": true,
  "hook_font": "oswald",
  "creatorpost_account_id": "5dbc7735-3c25-49c3-8faf-a853263607a8"
}
```

| Platform | Status | Notes |
|---|---|---|
| TikTok | ✅ Enabled | Posts photo carousels via CreatorPost API (`creatorpost_account_id` set) |
| Instagram | ❌ Disabled | `ig_enabled: false`, no IG token or user_id |
| YouTube | ❌ Not configured | No `youtube_enabled` or `youtube_channel_id` |

**Current posting pipeline:**
- Cron runs `aitah_pipeline/cli.py auto-post` twice daily (8:30 AM + 4:30 PM MST)
- Flow: Reddit ingest → filter/score → generate slides → render (Oswald font, 1080×1350, crimson brand) → upload images to B2 → POST to CreatorPost `/api/v1/publish/photo` → TikTok inbox

---

## 2. Carousel-to-Reel Conversion Script

**Script:** `faceless-instagram/carousel_to_reel.py`

**Accounts currently using it:** dormchic, lovechicfinds, quietluxemeals

### What it does

Takes content (text hooks, Pexels images/video, or recipe data) and produces a 1080×1920 portrait MP4 Reel, then publishes it to Instagram via the Graph API.

```
Input: account config + content type flag
    ↓
Render 5–7 slides (1080×1920, brand colors, progress dots)
    ↓
Add swipe transitions (9-frame slide per transition)
    ↓
Stitch slides + music → MP4 (H.264/AAC, 30fps, ~25–40s)
    ↓
instagram_publisher.py → IG Graph API /media → /media_publish
    ↓
Output: MP4 at accounts/{account}/output/reel_{timestamp}.mp4 + published IG Media ID
```

### Invocation

```bash
python carousel_to_reel.py {account} --type {text|inspo|recipe|image_hook|video_hook}
```

| Flag | Description |
|---|---|
| `--type text` | Text-hook hook slide + 5 body slides + CTA |
| `--type inspo` | Pexels photo hook + blur-background photo slides + CTA (default 70% of runs) |
| `--type recipe` | Recipe hero photo + 3 recipe slides + "comment RESET" CTA |
| `--type image_hook` | Pexels photo hook + text body slides |
| `--type video_hook` | 4s Pexels video hook + text slides (falls back to image_hook) |
| `--skip-publish` | Generate MP4 only, don't call instagram_publisher |
| `--dry-run` | Print plan, no generation |

### Inputs

- `accounts/{account}/config.json` — brand colors, handle, IG token, IG user_id
- `accounts/{account}/bio.md` — hook formulas, niche context, image search prompts
- `accounts/{account}/assets/music/carousel/*.mp3` — background music tracks
- `accounts/{account}/used_topics.jsonl` — dedup log (prevents repeating topics)
- Pexels API (for inspo/image_hook/video_hook types)

### Outputs

- `accounts/{account}/output/reel_{timestamp}.mp4` — final video
- Published IG Media ID (logged to `published_videos` table in SQLite stats DB)
- Discord notification on success/failure

### Key rendering details

| Detail | Value |
|---|---|
| Resolution | 1080×1920 (9:16) |
| Slide duration | 2.5s per slide |
| Swipe transition | 9 frames ≈ 0.3s |
| Total duration | `(slides × 2.5s) + ((slides-1) × 0.3s)` ≈ 25–40s |
| Codec | H.264 + AAC |
| Framerate | 30fps |

### Required config.json fields for IG

```json
{
  "ig_enabled": true,
  "ig_user_id": "17841402...",
  "ig_access_token": "IGAAVp2nrf0ZCJBZAxxxxx...",
  "token_issued_at": "2026-03-27T...",
  "ig_save_cta": "Save this for the next time you're in an argument."
}
```

---

## 3. How theenchantedfiles and darkhorsefiles Post to YouTube

Both accounts use **`story_pipeline.py`**, which has YouTube publishing built in at the end of its run.

### Configs

**theenchantedfiles** — `youtube_enabled: true`, `youtube_channel_id: "UCgliYd-ShWam-hKJKAWAVAQ"`, `longform_enabled: true`

**darkhorsefiles** — `youtube_enabled: true`, `youtube_channel_id: "UCYDvItY3t_AQ5-9d9aBPJ9Q"`, `longform_enabled: true`

### Flow (story_pipeline.py)

```
Story script generated (130–200 words) + scene images via Flux
    ↓
MP4 rendered (portrait video, text overlays, voiceover)
    ↓
if youtube_enabled:
    call youtube_publisher.py --account {account} --video-path {mp4} --title {hook}
    ↓
YouTube API: resumable upload → video ID → logged to stats DB
```

### youtube_publisher.py

**Script:** `faceless-instagram/youtube_publisher.py`

| Parameter | Description |
|---|---|
| `--account` | Account name (OAuth token at `accounts/{account}/youtube_token.json`) |
| `--video-path` | Path to MP4 |
| `--title` | Video title (max 100 chars; `#Shorts` appended automatically for non-longform) |
| `--description` | Caption/description |
| `--long-form` | Omits `#Shorts` tag; sets public visibility for full-length videos |
| `--thumbnail` | Optional JPG/PNG thumbnail path |
| `--ai-generated` | Sets `containsSyntheticMedia=true` |

**OAuth setup (one-time per account):**
```bash
python youtube_publisher.py --account whoswronghere --setup
# Opens browser OAuth, saves token to accounts/whoswronghere/youtube_token.json
```

**Privacy:**
- Shorts: `public` + `#Shorts` auto-added
- Longform: `public`, custom tags, no `#Shorts`
- Token auto-refreshes on every run (YouTube tokens expire in 1 hour)

---

## 4. What Needs to Change for Full Cross-Platform Posting

### Target state: TikTok carousel + Instagram Reel + YouTube Short

**Current gap:** whoswronghere's aitah_pipeline produces still images (carousels) for TikTok. Instagram and YouTube require an MP4. The `carousel_to_reel.py` script handles this for other accounts but is not wired to whoswronghere or the aitah_pipeline.

---

### Option A — Minimal (config only, separate crons)

**Config changes** (`accounts/whoswronghere/config.json`):
```json
{
  "ig_enabled": true,
  "ig_user_id": "<IG_BUSINESS_USER_ID>",
  "ig_access_token": "<LONG_LIVED_TOKEN>",
  "token_issued_at": "<ISO_DATETIME>",
  "ig_save_cta": "Save this for the next time you're in an argument.",
  "youtube_enabled": true,
  "youtube_channel_id": "<YOUTUBE_CHANNEL_ID>"
}
```

**New crons:**
```bash
# Instagram Reel (separate text-style reel, not sourced from aitah carousel)
0 15 * * * cd /path/to/faceless-instagram && .venv/bin/python carousel_to_reel.py whoswronghere --type text

# YouTube Short (upload the Reel MP4 as a YouTube Short)
5 15 * * * cd /path/to/faceless-instagram && .venv/bin/python youtube_publisher.py \
  --account whoswronghere \
  --video-path "accounts/whoswronghere/output/reel_latest.mp4" \
  --title "Pick a side #shorts"
```

**Limitation:** IG Reel and YouTube Short won't use the same Reddit story content as the TikTok carousel — they'll be independently generated "pick a side" content, not the same story.

---

### Option B — Full (modify aitah_pipeline to publish all 3 platforms)

Modify `aitah_pipeline/cli.py`'s `auto_post()` command to:

1. ✅ Render carousel slides (already does this)
2. ✅ Upload images to B2 (already does this)
3. ✅ Publish to TikTok via CreatorPost (already does this)
4. **NEW:** If `ig_enabled: true` → stitch slides → MP4 Reel → `instagram_publisher.py`
5. **NEW:** If `youtube_enabled: true` → take same MP4 → `youtube_publisher.py`

**Code needed:** ~100 lines in `aitah_pipeline/cli.py` mirroring the `build_reel_mp4()` + `instagram_publisher` call pattern already in `carousel_to_reel.py`.

**Result:** Single `auto-post` cron produces TikTok carousel + IG Reel + YouTube Short from the same Reddit story, same brand, same caption — no extra crons.

**Recommendation:** Option B. Keeps everything in one cron, consistent content across platforms, and whoswronghere's "pick a side" brand translates naturally to all three formats.

---

### Setup Checklist (before any code changes)

- [ ] Get whoswronghere Instagram Business Account token → run `python scripts/setup_ig_login.py`
- [ ] Get whoswronghere YouTube channel ID → YouTube Studio → Settings → Channel → Basic info
- [ ] Run YouTube OAuth setup → `python youtube_publisher.py --account whoswronghere --setup`
- [ ] Add IG token fields + YouTube fields to `accounts/whoswronghere/config.json`
- [ ] Test `carousel_to_reel.py whoswronghere --type text --skip-publish` (validate MP4 output)
- [ ] Test `youtube_publisher.py --account whoswronghere --video-path {mp4} --title "test"` (validate upload)
- [ ] Wire into aitah_pipeline (Option B) or add separate crons (Option A)

---

## Key File Reference

| Purpose | Path |
|---|---|
| whoswronghere config | `accounts/whoswronghere/config.json` |
| AITAH pipeline CLI | `aitah_pipeline/cli.py` |
| AITAH slide renderer | `aitah_pipeline/render.py` |
| Carousel-to-Reel script | `carousel_to_reel.py` |
| YouTube publisher | `youtube_publisher.py` |
| Instagram publisher | `instagram_publisher.py` |
| Slide generator (shared) | `carousel_slide_generator.py` |
| Story pipeline (enchanted/darkhorse) | `story_pipeline.py` |
| Crontab | `crons/faceless.crontab` |
