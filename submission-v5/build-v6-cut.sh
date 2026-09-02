#!/usr/bin/env bash
# Builds submission-v5/v6-final-cut.mp4 — the v6 TikTok Direct Post audit resubmission cut.
# FULL REPLACEMENT of the old clip1/clip2/clip3 pipeline. Sources are the fresh,
# post-compliance-fix recordings only:
#   automation/out/fresh-oauth-flow.mp4     (real TikTok OAuth authorization)
#   automation/out/fresh-desktop-flow.mp4   (authoritative CreatorPost publishing UX)
#   automation/out/ios/ios-screen-recording-compressed.mp4 (native TikTok completion)
#
# Presentation system: source UI is never overlaid or cropped. A dedicated 200px
# black caption band is appended BELOW the video area; captions live only there.
# Canvas is native to the actual source resolution (1440x900, confirmed via ffprobe
# — NOT 1920x1080 as originally assumed), so no scaling/pillarboxing is introduced
# for the landscape clips. Final canvas: 1440x1100 @ 25fps.
set -euo pipefail
cd "$(dirname "$0")"

SRC_OAUTH="automation/out/fresh-oauth-flow.mp4"
SRC_DESKTOP="automation/out/fresh-desktop-flow.mp4"
SRC_IOS="automation/out/ios/ios-screen-recording-compressed.mp4"

SEG="v6-segments"
mkdir -p "$SEG"

FONT="/System/Library/Fonts/SFNS.ttf"
W=1440
VH=900        # video area height (native source height, no scaling)
BAND=200      # caption band height
H=$((VH+BAND))
FPS=25

esc() { echo "${1//:/\\:}"; }

# ---- title/transition card (full-canvas, own background) ------------------
# text: literal '\n' sequences become real line breaks (via textfile=, which
# sidesteps drawtext's inline text= escaping entirely)
card() {
  local out="$1" dur="$2" bg="$3" text="$4" fsize="${5:-46}"
  local tf; tf="$(mktemp)"
  printf '%b' "$text" > "$tf"
  ffmpeg -y -f lavfi -i "color=c=${bg}:s=${W}x${H}:d=${dur}:r=${FPS}" \
    -vf "drawtext=fontfile=${FONT}:textfile=${tf}:fontcolor=white:fontsize=${fsize}:line_spacing=16:x=(w-text_w)/2:y=(h-text_h)/2:box=0" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an "$out"
}

# ---- footage segment: pad to +200px black band, drawtext captions in band --
# args: src ss dur scale_pad_filter(or "") out capfile
footage() {
  local src="$1" ss="$2" dur="$3" prefilter="$4" out="$5" capfile="$6"

  # Build chained drawtext filters from capfile: lines of "start|end|text"
  local dt="" i=0
  while IFS='|' read -r a b t; do
    [ -z "$a" ] && continue
    i=$((i+1))
    local tf="/tmp/v6_capline_$$_${i}.txt"
    printf '%s' "$t" > "$tf"
    dt="${dt}drawtext=fontfile=${FONT}:textfile=${tf}:fontcolor=white:fontsize=30:line_spacing=8:x=(w-text_w)/2:y=${VH}+(${BAND}-text_h)/2:box=0:enable='between(t\,${a}\,${b})',"
  done < "$capfile"
  dt="${dt%,}"

  local vf="${prefilter:+${prefilter},}pad=${W}:${H}:0:0:color=black,${dt}"

  ffmpeg -y -ss "$ss" -t "$dur" -i "$src" \
    -vf "$vf" -r "$FPS" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an "$out"
}

echo "== 01_opening =="
card "$SEG/01_opening.mp4" 5 "0x0B0B12" \
"CreatorPost — TikTok Direct Post Audit (Resubmission)\n\nOAuth authorization -> CreatorPost publishing UX\n-> native TikTok completion" 34

echo "== 02_oauth =="
cat > /tmp/v6_cap_oauth.txt <<'EOF'
0.0|6.5|Clicking "+ TikTok" in CreatorPost begins real OAuth authorization.
6.5|11.5|TikTok's own consent screen: creatorpost_dev, full permission list, then Continue.
11.5|22.0|TikTok's "Verify it's really you" identity step-up.
22.0|24.4|Back on CreatorPost — "1 TikTok connected."
EOF
footage "$SRC_OAUTH" 0 24.4 "" "$SEG/02_oauth.mp4" /tmp/v6_cap_oauth.txt

echo "== 03_desktop =="
cat > /tmp/v6_cap_desktop.txt <<'EOF'
0.0|6.0|Returning to CreatorPost after authorization — TikTok account connected.
6.0|15.0|Account page: manual "Sync Posts" confirms live TikTok stats and video list.
15.0|24.0|Composer: audit video selected, caption entered, "Post to TikTok" enabled.
24.0|36.0|TikTok panel loads creator identity and live privacy options from TikTok.
36.0|45.0|Comment / Duet / Stitch default OFF; commercial disclosure toggle also OFF.
45.0|60.0|Disclosure states: Promotional vs. Branded Content, and TikTok's privacy restriction on branded content.
60.0|72.0|Publish stays blocked until privacy, disclosure, and confirmation are all satisfied.
72.0|75.0|Explicit checkbox required: "I confirm I want to publish this content to TikTok."
75.0|81.0|Publish Now triggers the real submission — CreatorPost uploads to TikTok and reports a truthful result.
EOF
footage "$SRC_DESKTOP" 0 81 "" "$SEG/03_desktop.mp4" /tmp/v6_cap_desktop.txt

echo "== 11_transition =="
card "$SEG/11_transition.mp4" 3.5 "0x0B0B12" \
"TikTok's Upload workflow is completed by the creator\ninside the native TikTok app." 36

echo "== 12_ios =="
# portrait 1080x2346 -> scale to fit 900px height, pillarbox into 1440x900, then pad band
IOS_SCALE="scale=414:900,pad=${W}:${VH}:(${W}-414)/2:0:color=black"
cat > /tmp/v6_cap_ios.txt <<'EOF'
0.0|4.0|On iOS: opening TikTok's Inbox to find the System Notification for the CreatorPost upload.
4.0|10.0|Notification tapped — TikTok loads the uploaded draft for native completion.
10.0|20.0|Completing the post natively in TikTok: privacy, caption, and settings review.
20.0|26.0|Publish confirmed — "Video posted! Everyone can view."
26.0|31.3|Public profile proof: the published post live on creatorpost_dev's grid.
EOF
footage "$SRC_IOS" 0 31.3 "$IOS_SCALE" "$SEG/12_ios.mp4" /tmp/v6_cap_ios.txt

echo "== concat =="
cat > "$SEG/concat.txt" <<EOF
file '01_opening.mp4'
file '02_oauth.mp4'
file '03_desktop.mp4'
file '11_transition.mp4'
file '12_ios.mp4'
EOF
ffmpeg -y -f concat -safe 0 -i "$SEG/concat.txt" -c copy v6-final-cut.mp4

echo "== done =="
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name,duration -of default=noprint_wrappers=1 v6-final-cut.mp4
ls -la v6-final-cut.mp4
