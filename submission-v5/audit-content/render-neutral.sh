#!/bin/bash
# CreatorPost TikTok audit upload asset — NEUTRAL variant (v2).
#
# Replaces the original branded asset (creatorpost-audit-test-clip.mp4, kept
# for reference/rollback) per TikTok Watermark Guidelines: no app logo, no
# creatorpost.app text, no brand watermark, no promotional claim, no
# third-party/copyright material, no music.
#
# Content: ffmpeg's own synthetic testsrc2 pattern (not third-party material)
# with a shifting hue and a large on-screen countdown number (1-8, one per
# second). The countdown is neutral (not a brand/product claim) and gives a
# reviewer an easy, deterministic way to visually track the same clip across
# CreatorPost preview -> TikTok Inbox -> TikTok editor -> final profile post.
set -euo pipefail

cd "$(dirname "$0")"

FONT_BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"

W=1080
H=1920
FPS=30
DUR=8

OUT="creatorpost-audit-test-clip-neutral.mp4"
STILLS_DIR="stills-neutral"
mkdir -p "$STILLS_DIR"

ffmpeg -y -f lavfi -i "testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR}" \
  -vf "hue=H=2*PI*t/${DUR}:s=1, \
drawtext=fontfile='${FONT_BOLD}':text='%{eif\:1+floor(t)\:d}':fontcolor=white:fontsize=320:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.55:boxborderw=24" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$OUT"

# Verification stills: first frame, ~4s (mid), last frame
ffmpeg -y -i "$OUT" -vf "select=eq(n\,0)" -update 1 -vframes 1 "$STILLS_DIR/frame-first.png"
ffmpeg -y -ss 4 -i "$OUT" -update 1 -vframes 1 "$STILLS_DIR/frame-mid.png"
ffmpeg -y -sseof -0.1 -i "$OUT" -update 1 -vframes 1 "$STILLS_DIR/frame-last.png"

echo "DONE: $OUT"
