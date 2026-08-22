#!/usr/bin/env bash
# Builds submission-v5/reference-demo-v0.mp4 — a REHEARSAL/REFERENCE cut, not a TikTok submission.
# Reuses valid portions of the Aug 4 2026 clips (docs/submission-videos/) and inserts
# placeholder title cards wherever new footage is required. Re-runnable: once real
# replacement footage exists, swap the relevant segment file(s) below and re-run.
#
# Requires: ffmpeg with the lavfi/drawtext filters (macOS system Helvetica used for cards).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

SRC=docs/submission-videos
OUT=submission-v5
SEG="$OUT/segments"
mkdir -p "$SEG"

FONT="/System/Library/Fonts/Helvetica.ttc"
W=1920
H=1080
FPS=30

# ---- helper: render a title/placeholder card ------------------------------
# args: output_file duration bg_color text_lines(\n separated) label_color
card() {
  local out="$1" dur="$2" bg="$3" text="$4" color="${5:-white}"
  local escaped="${text//:/\\:}"
  ffmpeg -y -f lavfi -i "color=c=${bg}:s=${W}x${H}:d=${dur}:r=${FPS}" \
    -vf "drawtext=fontfile=${FONT}:text='${escaped}':fontcolor=${color}:fontsize=54:line_spacing=20:x=(w-text_w)/2:y=(h-text_h)/2:box=0" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an "$out"
}

# ---- helper: trim a source clip to a segment file (re-encoded for safe concat) --
trim() {
  local src="$1" ss="$2" to="$3" out="$4"
  ffmpeg -y -ss "$ss" -to "$to" -i "$src" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an -r "$FPS" "$out"
}

echo "== Beat 1: opening / product framing (PLACEHOLDER — no suitable old footage) =="
card "$SEG/01_opening.mp4" 8 "0x0B0B12" \
"CreatorPost — TikTok Content Posting API Review\n\nA publishing tool for creators and agencies\nmanaging multiple connected social accounts.\n\nThis walkthrough demonstrates every requested\nTikTok permission and the full publishing flow,\nend to end, through to the resulting TikTok post."

echo "== Beat 2 annotation card =="
card "$SEG/02a_annotation.mp4" 2 "0x111111" \
"user.info.basic / user.info.profile\nTikTok OAuth & connected identity"

echo "== Beat 2: OAuth (REUSED — clip1 0:00-0:08) =="
trim "$SRC/clip1-oauth-authorization.mp4" 0.0 8.0 "$SEG/02b_oauth.mp4"

echo "== Beat 3: connected identity (REUSED — clip1 0:08-end) =="
trim "$SRC/clip1-oauth-authorization.mp4" 8.0 12.1 "$SEG/03_identity.mp4"

echo "== Beat 4: statistics (NEW CAPTURE REQUIRED placeholder) =="
card "$SEG/04_stats_placeholder.mp4" 6 "0x5A2D00" \
"NEW CAPTURE REQUIRED\n\nCreatorPost — follower / creator statistics\nproves: user.info.stats\n\nTarget duration: 5-8 sec"

echo "== Beat 5: sync / analytics (NEW CAPTURE REQUIRED placeholder) =="
card "$SEG/05_synclist_placeholder.mp4" 6 "0x5A2D00" \
"NEW CAPTURE REQUIRED\n\nCreatorPost — Sync Posts / Analytics\nretrieving TikTok video data\nproves: video.list\n\nTarget duration: 5-8 sec"

echo "== Beat 6 annotation card =="
card "$SEG/06a_annotation.mp4" 2 "0x111111" \
"Post preparation\nvideo · caption · privacy (live from TikTok) ·\ninteraction & disclosure controls · Music Usage Confirmation"

echo "== Beat 6: post preparation (REUSED — clip2 full) =="
trim "$SRC/clip2-post-to-tiktok-flow.mp4" 0.0 80.0 "$SEG/06b_prep.mp4"

echo "== Beat 7 annotation card =="
card "$SEG/07a_annotation.mp4" 2 "0x111111" \
"TikTok UX compliance\ndisclosure validation · branded-content rules ·\nexplicit per-post confirmation"

echo "== Beat 7: TikTok compliance / confirmation (REUSED, trimmed — clip3 0:20-1:19) =="
trim "$SRC/clip3-after-post-triggered.mp4" 20.0 79.0 "$SEG/07b_compliance.mp4"

echo "== Beat 8: Direct Post vs Upload — explanatory card =="
card "$SEG/08_directpost_vs_upload.mp4" 7 "0x0B0B12" \
"video.publish (Direct Post)\nCreatorPost requests Direct Post first.\nCurrently restricted pending TikTok approval.\n\nvideo.upload\nTikTok accepts the content into Drafts/Inbox —\nthe creator completes publishing inside TikTok."

echo "== Beat 9: CreatorPost Upload success (REUSED — clip3 1:19-end) =="
trim "$SRC/clip3-after-post-triggered.mp4" 79.0 100.066667 "$SEG/09_success.mp4"

echo "== Beat 10: TikTok web receipt (NEW CAPTURE REQUIRED placeholder) =="
card "$SEG/10_webnotif_placeholder.mp4" 6 "0x5A2D00" \
"NEW CAPTURE REQUIRED\n\nTikTok web — @creatorpost_dev\nSystem Notification: 'Your content from\nCreatorPost is ready'\n\nTarget duration: 5-8 sec"

echo "== Beat 11: desktop -> iOS transition card =="
card "$SEG/11_transition.mp4" 3 "0x0B0B12" \
"Continuing in TikTok on iPhone\n\nTikTok web does not offer an actionable\nedit/post flow for this notification."

echo "== Beat 12: TikTok iOS completion (OWNER iOS CAPTURE REQUIRED placeholder) =="
card "$SEG/12_ios_completion_placeholder.mp4" 8 "0x00394D" \
"OWNER iOS CAPTURE REQUIRED\n\nTikTok Inbox -> System Notification ->\nopen CreatorPost content -> native TikTok\nedit/post flow -> Publish\n\nTarget duration: 20-30 sec"

echo "== Beat 13: final TikTok proof (OWNER iOS CAPTURE REQUIRED placeholder) =="
card "$SEG/13_final_proof_placeholder.mp4" 8 "0x00394D" \
"OWNER iOS CAPTURE REQUIRED\n\nNavigate to @creatorpost_dev\nShow the newly created post visibly\npresent on the profile. Hold on screen.\n\nTarget duration: 10-15 sec"

echo "== Concatenating all segments =="
LIST="$SEG/concat_list.txt"
> "$LIST"
for f in 01_opening 02a_annotation 02b_oauth 03_identity 04_stats_placeholder \
         05_synclist_placeholder 06a_annotation 06b_prep 07a_annotation 07b_compliance \
         08_directpost_vs_upload 09_success 10_webnotif_placeholder 11_transition \
         12_ios_completion_placeholder 13_final_proof_placeholder; do
  echo "file '$(pwd)/$SEG/${f}.mp4'" >> "$LIST"
done

ffmpeg -y -f concat -safe 0 -i "$LIST" -c copy -movflags +faststart "$OUT/reference-demo-v0.mp4"

echo "== Done: $OUT/reference-demo-v0.mp4 =="
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 "$OUT/reference-demo-v0.mp4"
