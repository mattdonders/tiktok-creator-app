#!/usr/bin/env bash
# Builds submission-v5/v7-final-cut.mp4 — the CORRECTED TikTok Direct Post audit cut.
#
# Why v7 exists: the v6 cut ended in TikTok's Upload/Inbox workflow (CreatorPost's
# /api/publish silently falls back to post/publish/inbox/video/init when the Direct
# Post init fails), so it demonstrated Upload, not Direct Post. v7 replaces that
# ending with a real, verified Direct Post: privacy Only Me / SELF_ONLY, explicit
# confirmation, Publish Now, Processing -> Published, and the post visible directly
# on @creatorpost_dev's TikTok profile grid with TikTok's own private/lock badge.
# No Inbox, no drafts, no native iOS editing, no manual TikTok publish.
#
# Sources:
#   automation/out/fresh-oauth-flow.mp4       (accepted OAuth footage, reused verbatim)
#   automation/out/fresh-directpost-flow.mp4  (fresh single-take Direct Post capture)
#
# Presentation system is unchanged from v6: source UI is never overlaid or cropped;
# a 200px black caption band is appended BELOW the 1440x900 video area.
# Final canvas: 1440x1100 @ 25fps.
set -euo pipefail
cd "$(dirname "$0")"

SRC_OAUTH="automation/out/fresh-oauth-flow.mp4"
SRC_DP="automation/out/fresh-directpost-flow.mp4"

SEG="v7-segments"
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
    local tf="/tmp/v7_capline_$$_${i}.txt"
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
card "$SEG/01_opening.mp4" 5 "0x0B0B12" \
"CreatorPost — TikTok Direct Post Audit (Corrected Resubmission)\n\nOAuth authorization  →  Direct Post (Only Me / SELF_ONLY)\n→  post live on the creator's own TikTok profile" 34

echo "== 02_oauth (reused, accepted footage) =="
cat > /tmp/v7_cap_oauth.txt <<'EOF'
0.0|6.5|Clicking "+ TikTok" in CreatorPost begins real OAuth authorization.
6.5|11.5|TikTok's own consent screen: creatorpost_dev, full permission list, then Continue.
11.5|22.0|TikTok's "Verify it's really you" identity step-up.
22.0|24.4|Back on CreatorPost — "1 TikTok connected."
EOF
footage "$SRC_OAUTH" 0 24.4 "" "$SEG/02_oauth.mp4" /tmp/v7_cap_oauth.txt

echo "== 03_directpost (single continuous take) =="
# One unbroken 94s window of the real capture (source 16.0s -> 110.0s): compose,
# compliance, explicit confirmation, Publish Now, Processing -> Published, and
# the TikTok-web profile proof. Nothing is cut out of the publishing sequence.
cat > /tmp/v7_cap_dp.txt <<'EOF'
0.0|8.0|Composer: the audit video is selected and a caption entered.\nPublishing target is the connected TikTok account, creatorpost_dev.
8.0|17.0|The TikTok Settings panel loads creator identity and options\nlive from TikTok's creator_info endpoint.
17.0|24.0|Privacy is chosen explicitly — nothing is preselected.\n"Only Me" = SELF_ONLY, required for an unaudited Direct Post.
24.0|30.0|Comment / Duet / Stitch default OFF. Duet and Stitch are greyed out\nand labelled "Turned off in your TikTok account settings".
30.0|38.0|Commercial disclosure is OFF by default. Turned on, it requires an\nexplicit Promotional content / Branded content choice.
38.0|46.0|TikTok's rule that Branded content cannot be private is enforced\nin the UI and explained to the creator.
46.0|53.0|With both selected, the declaration cites TikTok's Branded Content\nPolicy and Music Usage Confirmation.
53.0|56.0|Disclosure returned OFF and privacy set back to "Only Me"\nfor the real submission.
56.0|59.0|Publishing stays blocked until the creator ticks the explicit\nconfirmation checkbox.
59.0|64.0|Publish Now — DIRECT POST. CreatorPost reports\n"Posted to creatorpost_dev" — not a draft, not an upload.
64.0|71.0|The post appears in Recent Posts as Processing…
71.0|86.0|…and then Published. No Inbox, no draft, and no step inside\nthe native TikTok app.
86.0|94.0|TikTok web, signed in as @creatorpost_dev: the post is live on the\nprofile grid, carrying TikTok's own private (lock) badge.
EOF
footage "$SRC_DP" 16.0 94.0 "" "$SEG/03_directpost.mp4" /tmp/v7_cap_dp.txt

echo "== concat =="
cat > "$SEG/concat.txt" <<'EOF'
file '01_opening.mp4'
file '02_oauth.mp4'
file '03_directpost.mp4'
EOF
ffmpeg -y -v error -f concat -safe 0 -i "$SEG/concat.txt" -c copy v7-final-cut.mp4

echo "== done =="
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -show_entries format=duration -of default=noprint_wrappers=1 v7-final-cut.mp4
ls -la v7-final-cut.mp4
