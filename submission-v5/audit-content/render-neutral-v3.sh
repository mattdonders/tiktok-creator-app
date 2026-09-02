#!/bin/bash
# CreatorPost TikTok audit upload asset — NEUTRAL variant v3 (Sept 2026 Direct Post resubmission).
#
# Same compliance envelope as v2 (render-neutral.sh): ffmpeg's own synthetic
# source, no app logo, no creatorpost.app text, no watermark, no promotional
# claim, no third-party/copyright material, no music, no audio track.
#
# Deliberately DIFFERENT-LOOKING from v2 so a reviewer comparing this
# resubmission against the previous audit video can tell at a glance that the
# posted content is a new clip, not a re-run of the old footage:
#   v2: animated testsrc2, hue rotating through the spectrum, count UP 1->8,
#       white number on a black box, 8s.
#   v3: static SMPTE HD bars, a white band sweeping top->bottom, count DOWN
#       10->1, yellow number on a dark box, 10s, plus a neutral date stamp.
set -euo pipefail

cd "$(dirname "$0")"

FONT_BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"

W=1080
H=1920
FPS=30
DUR=10

OUT="creatorpost-audit-test-clip-neutral-v3.mp4"
STILLS_DIR="stills-neutral-v3"
mkdir -p "$STILLS_DIR"

ffmpeg -y -f lavfi -i "smptehdbars=size=${W}x${H}:rate=${FPS}:duration=${DUR}" \
  -vf "drawbox=x=0:y=(h/${DUR})*t-40:w=iw:h=80:color=white@0.55:t=fill, \
drawtext=fontfile='${FONT_BOLD}':text='%{eif\:${DUR}-floor(t)\:d}':fontcolor=yellow:fontsize=340:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.7:boxborderw=28, \
drawtext=fontfile='${FONT_BOLD}':text='TEST CLIP 03 - 2026-09':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h-260:box=1:boxcolor=black@0.7:boxborderw=18" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$OUT"

# Verification stills: first frame, ~5s (mid), last frame
ffmpeg -y -i "$OUT" -vf "select=eq(n\,0)" -update 1 -vframes 1 "$STILLS_DIR/frame-first.png"
ffmpeg -y -ss 5 -i "$OUT" -update 1 -vframes 1 "$STILLS_DIR/frame-mid.png"
ffmpeg -y -sseof -0.1 -i "$OUT" -update 1 -vframes 1 "$STILLS_DIR/frame-last.png"

echo "DONE: $OUT"
