#!/bin/bash
# CreatorPost TikTok audit upload asset — deterministic ffmpeg motion graphic.
# Reuses public/logo.png and the real dark-theme brand palette from public/styles.css
# (--bg: #0f0f11, --text: #ededed, accent gradient #a78bfa -> #7c3aed).
# No stock footage, no third-party material, no music.
set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
LOGO="$REPO_ROOT/public/logo.png"
FONT_BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG="/System/Library/Fonts/Supplemental/Arial.ttf"

W=1080
H=1920
FPS=30
BG="0x0f0f11"
TEXT="0xededed"
ACCENT="0x7c5cfc"

OUT="creatorpost-audit-test-clip.mp4"
STILLS_DIR="stills"
mkdir -p "$STILLS_DIR"

# Clean, background-matched, transparent version of the logo (crop to actual
# icon bounding box + colorkey off the non-transparent PNG background) so it
# no longer shows a mismatched box against the video's dark background.
LOGO_CLEAN="logo_clean.png"
ffmpeg -y -i "$LOGO" -vf "crop=560:560:245:231,colorkey=0x221f25:0.14:0.08,format=rgba" \
  -update 1 -frames:v 1 "$LOGO_CLEAN"

# Segment A (0-2s): logo fade+scale in on dark bg
ffmpeg -y -f lavfi -i "color=c=${BG}:s=${W}x${H}:d=2:r=${FPS}" -i "$LOGO_CLEAN" \
  -filter_complex "\
[1:v]scale=320:320[logo]; \
[0:v][logo]overlay=(W-w)/2:(H-h)/2-120:format=auto, \
fade=t=in:st=0:d=0.4, fade=t=out:st=1.6:d=0.4[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -an seg_a.mp4

# Segment B (2-4s): "CreatorPost" title + subtitle
ffmpeg -y -f lavfi -i "color=c=${BG}:s=${W}x${H}:d=2:r=${FPS}" \
  -vf "\
drawtext=fontfile='${FONT_BOLD}':text='CreatorPost':fontcolor=${TEXT}:fontsize=88:x=(w-text_w)/2:y=(h/2)-160, \
drawtext=fontfile='${FONT_REG}':text='TikTok Content Posting API':fontcolor=${ACCENT}:fontsize=46:x=(w-text_w)/2:y=(h/2)-40, \
fade=t=in:st=0:d=0.4, fade=t=out:st=1.6:d=0.4" \
  -c:v libx264 -pix_fmt yuv420p -an seg_b.mp4

# Segment C (4-6s): "Review Demo" + date line
ffmpeg -y -f lavfi -i "color=c=${BG}:s=${W}x${H}:d=2:r=${FPS}" \
  -vf "\
drawtext=fontfile='${FONT_BOLD}':text='Review Demo':fontcolor=${TEXT}:fontsize=80:x=(w-text_w)/2:y=(h/2)-140, \
drawtext=fontfile='${FONT_REG}':text='Original test content • August 2026':fontcolor=${ACCENT}:fontsize=42:x=(w-text_w)/2:y=(h/2)-20, \
fade=t=in:st=0:d=0.4, fade=t=out:st=1.6:d=0.4" \
  -c:v libx264 -pix_fmt yuv420p -an seg_c.mp4

# Segment D (6-8s): small logo + creatorpost.app, held for final identification frame
ffmpeg -y -f lavfi -i "color=c=${BG}:s=${W}x${H}:d=2:r=${FPS}" -i "$LOGO_CLEAN" \
  -filter_complex "\
[1:v]scale=180:180[logo]; \
[0:v][logo]overlay=(W-w)/2:(H/2)-250:format=auto[bg1]; \
[bg1]drawtext=fontfile='${FONT_BOLD}':text='creatorpost.app':fontcolor=${TEXT}:fontsize=64:x=(w-text_w)/2:y=(h/2)-50, \
fade=t=in:st=0:d=0.4, fade=t=out:st=1.6:d=0.4[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -an seg_d.mp4

# Concat all 4 segments
printf "file 'seg_a.mp4'\nfile 'seg_b.mp4'\nfile 'seg_c.mp4'\nfile 'seg_d.mp4'\n" > concat_list.txt
ffmpeg -y -f concat -safe 0 -i concat_list.txt -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$OUT"

rm -f seg_a.mp4 seg_b.mp4 seg_c.mp4 seg_d.mp4 concat_list.txt

# Verification stills: first frame, ~4s (mid), last frame
ffmpeg -y -i "$OUT" -vf "select=eq(n\,0)" -vframes 1 "$STILLS_DIR/frame-first.png"
ffmpeg -y -ss 4 -i "$OUT" -vframes 1 "$STILLS_DIR/frame-mid.png"
ffmpeg -y -sseof -0.1 -i "$OUT" -vframes 1 "$STILLS_DIR/frame-last.png"

echo "DONE: $OUT"
