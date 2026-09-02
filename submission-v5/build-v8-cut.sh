#!/usr/bin/env bash
# Builds submission-v5/v8-final-cut.mp4 — the CORRECTED TikTok Direct Post audit cut.
#
# Why v8 exists: v6 ended in TikTok's Upload/Inbox workflow (CreatorPost's
# /api/publish silently falls back to post/publish/inbox/video/init when the
# Direct Post init fails), so it demonstrated Upload, not Direct Post. v7
# replaced that with a real Direct Post, but @creatorpost_dev still held older
# test posts, so nothing in the recording ruled out the new post having come
# from somewhere else. For v8 the account was emptied first, and the cut now
# opens on TikTok's own Posts table holding ZERO posts and closes on the same
# table holding exactly ONE — the post created by the Direct Post call in
# between, with TikTok's "Only me" privacy and its exact creation timestamp.
#
# No Inbox, no drafts, no native iOS editing, no manual TikTok publish.
#
# Sources:
#   automation/out/fresh-oauth-flow.mp4       (accepted OAuth footage, reused verbatim)
#   automation/out/fresh-directpost-flow.mp4  (fresh single-take Direct Post capture)
#
# Presentation system is unchanged from v6/v7: source UI is never overlaid or
# cropped; a 200px black caption band is appended BELOW the 1440x900 video area.
# Final canvas: 1440x1100 @ 25fps.
set -euo pipefail
cd "$(dirname "$0")"

SRC_OAUTH="automation/out/fresh-oauth-flow.mp4"
SRC_DP="automation/out/fresh-directpost-flow.mp4"

SEG="v8-segments"
mkdir -p "$SEG"

FONT="/System/Library/Fonts/SFNS.ttf"
W=1440
VH=900        # video area height (native source height, no scaling)
BAND=200      # caption band height
H=$((VH+BAND))
FPS=25

# ---- title card (full-canvas, own background) -----------------------------
card() {
  local out="$1" dur="$2" bg="$3" text="$4" fsize="${5:-46}"
  local tf; tf="$(mktemp)"
  printf '%b' "$text" > "$tf"
  ffmpeg -y -v error -f lavfi -i "color=c=${bg}:s=${W}x${H}:d=${dur}:r=${FPS}" \
    -vf "drawtext=fontfile=${FONT}:textfile=${tf}:fontcolor=white:fontsize=${fsize}:line_spacing=16:x=(w-text_w)/2:y=(h-text_h)/2:box=0" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an "$out"
}

# ---- footage segment: pad to +200px black band, drawtext captions in band --
# args: src ss dur prefilter(or "") out capfile
# capfile lines: "start|end|text"  ('\n' in text becomes a real line break)
footage() {
  local src="$1" ss="$2" dur="$3" prefilter="$4" out="$5" capfile="$6"

  local dt="" i=0
  while IFS='|' read -r a b t; do
    [ -z "$a" ] && continue
    i=$((i+1))
    local tf="/tmp/v8_capline_$$_${i}.txt"
    printf '%b' "$t" > "$tf"
    dt="${dt}drawtext=fontfile=${FONT}:textfile=${tf}:fontcolor=white:fontsize=30:line_spacing=10:x=(w-text_w)/2:y=${VH}+(${BAND}-text_h)/2:box=0:enable='between(t\,${a}\,${b})',"
  done < "$capfile"
  dt="${dt%,}"

  local vf="${prefilter:+${prefilter},}pad=${W}:${H}:0:0:color=black,${dt}"

  ffmpeg -y -v error -ss "$ss" -t "$dur" -i "$src" \
    -vf "$vf" -r "$FPS" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an "$out"
}

echo "== 01_opening =="
card "$SEG/01_opening.mp4" 6 "0x0B0B12" \
"CreatorPost — TikTok Direct Post Audit (Corrected Resubmission)\n\nOAuth authorization  →  TikTok account holds ZERO posts\n→  Direct Post (Only Me / SELF_ONLY)  →  exactly ONE post on the account" 32

echo "== 02_oauth (reused, accepted footage) =="
cat > /tmp/v8_cap_oauth.txt <<'EOF'
0.0|6.5|Clicking "+ TikTok" in CreatorPost begins real OAuth authorization.
6.5|11.5|TikTok's own consent screen: creatorpost_dev, full permission list, then Continue.
11.5|22.0|TikTok's "Verify it's really you" identity step-up.
22.0|24.4|Back on CreatorPost — "1 TikTok connected."
EOF
footage "$SRC_OAUTH" 0 24.4 "" "$SEG/02_oauth.mp4" /tmp/v8_cap_oauth.txt

echo "== 03_before (TikTok Studio: account is empty) =="
# Same browser session that performs the publish below. This is the "before"
# half of the proof pair.
cat > /tmp/v8_cap_before.txt <<'EOF'
0.0|10.0|BEFORE. TikTok Studio, signed in as @creatorpost_dev:\nthe account holds no posts at all — "No posts yet".
EOF
footage "$SRC_DP" 1.5 10.0 "" "$SEG/03_before.mp4" /tmp/v8_cap_before.txt

echo "== 04_directpost (single continuous take) =="
# One unbroken 89s window of the real capture (source 16.0s -> 105.0s): compose,
# compliance, explicit confirmation, Publish Now, Processing -> Published.
# Nothing is cut out of the publishing sequence.
cat > /tmp/v8_cap_dp.txt <<'EOF'
0.0|5.0|CreatorPost, signed in — "1 TikTok connected" (creatorpost_dev).
5.0|15.0|Sync Posts calls TikTok's real user.info.stats and video.list:\n0 posts imported, matching the empty account shown above.
15.0|31.0|Composer: the audit video is selected and a caption entered.\nPublishing target is the connected TikTok account, creatorpost_dev.
31.0|36.0|The TikTok Settings panel loads creator identity and options\nlive from TikTok's creator_info endpoint.
36.0|46.0|Privacy is chosen explicitly — nothing is preselected. "Only Me" =\nSELF_ONLY. Comment / Duet / Stitch default OFF; Duet and Stitch are\ngreyed out, "Turned off in your TikTok account settings".
46.0|49.0|Commercial disclosure is OFF by default.
49.0|55.0|Turned on, it requires an explicit Promotional content / Branded\ncontent choice, and TikTok's rule that Branded content cannot be\nprivate is enforced in the UI and explained to the creator.
55.0|61.0|"Branded content" is labelled Paid partnership and cites\nTikTok's Branded Content Policy.
61.0|67.0|With both selected, the declaration cites the Branded Content Policy\nand the Music Usage Confirmation together.
67.0|73.0|Disclosure returned OFF and privacy set back to "Only Me"\nfor the real submission.
73.0|75.5|Publishing stays blocked until the creator ticks the explicit\nconfirmation checkbox.
75.5|81.0|Publish Now — DIRECT POST. CreatorPost reports\n"Posted to creatorpost_dev" — not a draft, not an upload.
81.0|84.0|The post appears in Recent Posts as Processing…
84.0|89.0|…and then Published. No Inbox, no draft, and no step inside\nthe native TikTok app.
EOF
footage "$SRC_DP" 13.0 89.0 "" "$SEG/04_directpost.mp4" /tmp/v8_cap_dp.txt

echo "== 05_after (TikTok Studio: exactly one post) =="
# Same tab, same session, after TikTok finished processing the upload. The
# intervening wait (TikTok's own review/processing) is not shown.
cat > /tmp/v8_cap_after.txt <<'EOF'
0.0|14.0|AFTER. The same TikTok Studio Posts table now holds exactly ONE post:\nthe caption sent from CreatorPost, privacy "Only me" (SELF_ONLY),\nand TikTok's own creation timestamp for the Direct Post above.
EOF
footage "$SRC_DP" 191.0 14.0 "" "$SEG/05_after.mp4" /tmp/v8_cap_after.txt

echo "== concat =="
cat > "$SEG/concat.txt" <<'EOF'
file '01_opening.mp4'
file '02_oauth.mp4'
file '03_before.mp4'
file '04_directpost.mp4'
file '05_after.mp4'
EOF
ffmpeg -y -v error -f concat -safe 0 -i "$SEG/concat.txt" -c copy v8-final-cut.mp4

echo "== done =="
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -show_entries format=duration -of default=noprint_wrappers=1 v8-final-cut.mp4
ls -la v8-final-cut.mp4
