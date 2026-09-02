# CreatorPost — TikTok audit upload asset

Generated via `render.sh` (deterministic ffmpeg motion graphic — dark background,
`public/logo.png`, Arial system font, dark-theme brand palette from `public/styles.css`:
bg `#0f0f11`, text `#ededed`, accent `#7c5cfc`). No stock footage, no third-party
material, no music, no AI-generated people.

For: `cp-tiktok-demo@mattdonders.com` → `@creatorpost_dev`.

## File
`creatorpost-audit-test-clip.mp4` — 1080x1920, H264, 8.00s, 30fps, no audio track, ~164KB, `+faststart`.

## On-screen copy (in order)
1. (0-2s) CreatorPost logo, fade in/out
2. (2-4s) "CreatorPost" / "TikTok Content Posting API"
3. (4-6s) "Review Demo" / "Original test content . August 2026"
4. (6-8s) small logo + "creatorpost.app"

## Recommended TikTok caption
> CreatorPost TikTok Content Posting API review demo. Original test content created for this integration review.

No hashtags. Do not describe the resulting Upload/Drafts flow as an approved Direct Post.

## Recommended post settings
- Commercial Content disclosure: OFF (not sponsored/commercial content)
- Audio: none baked in
- Interaction toggles: normal truthful demo defaults
- Privacy: choose from whatever options `creator_info` actually returns at record time

## Verification stills
`stills/frame-a-logo.png`, `frame-b-title.png`, `frame-c-review.png`, `frame-d-domain.png` — extracted at 1s/3s/5s/7s. Confirmed legible on a phone-sized frame, correct resolution/codec, zero audio streams (`ffprobe` stream count = 0 audio).

---

## Superseded 2026-08-21 — replaced by neutral variant (v2)

This file (`creatorpost-audit-test-clip.mp4`) bakes in the CreatorPost logo,
"CreatorPost" / "TikTok Content Posting API" text, and "creatorpost.app" text
across all four segments. Per TikTok Watermark Guidelines (no app
branding/logos/watermarks/links/promotional text in content shared via the
API), this asset is no longer used for the live audit recording. Kept in the
repo for reference/rollback only — do not re-point `AUDIT_VIDEO_PATH` back at
this file without re-running the same compliance review.

## Current asset: `creatorpost-audit-test-clip-neutral.mp4`

Generated via `render-neutral.sh` — ffmpeg's own synthetic `testsrc2` pattern
(not third-party material) with a shifting hue and a large on-screen
countdown number (1-8, one per second). No stock footage, no third-party
material, no music, no AI-generated people, no CreatorPost logo, no
"creatorpost.app" text, no promotional claim.

- **File**: `creatorpost-audit-test-clip-neutral.mp4` — 1080x1920, H264, 8.00s, 30fps, no audio track, ~7MB, `+faststart`.
- **Visual identity**: SMPTE-style color bars + ffmpeg's own burned-in timecode overlay (top-left, part of the `testsrc2` source itself) + a large countdown number (1 → 8) centered on screen, hue shifting continuously across the 8s. This gives a reviewer a simple, deterministic way to confirm it's the same clip across CreatorPost preview → TikTok Inbox → TikTok editor → final profile post (matching color/number at a given second).
- **Caption**: unchanged (`AUDIT_CAPTION` in `automation/scenarios/creatorpost-tiktok-audit/config.js`) — the editable TikTok caption may still identify this as an integration-review test; only the baked-in video content itself needed to be brand-neutral.
- **Recommended post settings**: unchanged from below (Commercial Content disclosure OFF; no baked-in audio; interaction toggles per truthful demo defaults; privacy per whatever `creator_info` actually returns at record time).

## Verification stills (neutral variant)
`stills-neutral/frame-first.png`, `frame-mid.png`, `frame-last.png` — extracted at 0s/4s/~8s. Confirmed correct resolution/codec, zero audio streams (`ffprobe` stream count = 0 audio), zero CreatorPost branding.

---

## Superseded 2026-09-02 — replaced by neutral variant v3 (Direct Post resubmission)

`creatorpost-audit-test-clip-neutral.mp4` (v2) is the clip posted in the
previous, rejected audit video. For the Sept 2026 Direct Post resubmission the
posted content is deliberately a **different-looking clip**, so a reviewer
comparing the two videos can tell at a glance that this is a new post and not
re-used footage. v2 is kept for reference/rollback.

## Current asset: `creatorpost-audit-test-clip-neutral-v3.mp4`

Generated via `render-neutral-v3.sh`. Same compliance envelope as v2 —
ffmpeg's own synthetic source, no CreatorPost logo, no `creatorpost.app` text,
no watermark, no promotional claim, no third-party/copyright material, no
music, no audio stream.

- **File**: 1080x1920, H264, 10.00s, 30fps, no audio track, ~75KB, `+faststart`.
- **How it differs from v2**:
  | | v2 (previous submission) | v3 (this submission) |
  |---|---|---|
  | source | animated `testsrc2`, hue rotating | static `smptehdbars` |
  | motion | continuous hue shift | white band sweeping top → bottom |
  | counter | 1 → 8, white on black | 10 → 1, **yellow** on black |
  | duration | 8s | 10s |
  | stamp | none | `TEST CLIP 03 - 2026-09` |
- **Verification stills**: `stills-neutral-v3/frame-first.png`, `frame-mid.png`, `frame-last.png` (0s / 5s / ~10s). `ffprobe` audio stream count = 0.
- **Wired at**: `automation/scenarios/creatorpost-tiktok-audit/config.js` → `AUDIT_VIDEO_PATH`.
