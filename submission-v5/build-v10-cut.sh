#!/usr/bin/env bash
# Builds submission-v5/v10-final-cut.mp4 — the final TikTok Direct Post audit cut.
#
# Lineage: v6 ended in TikTok's Upload/Inbox workflow (CreatorPost's /api/publish
# silently falls back to post/publish/inbox/video/init when the Direct Post init
# fails), so it demonstrated Upload, not Direct Post, and was rejected. v7 replaced
# that with a real Direct Post. v8 added a TikTok-side before/after pair. v9 made
# the pair complete: BOTH accounts hold zero posts at the start, exactly one at
# the end. v10 fixes three presentation defects in v9 and nothing else:
#
#   1. Blank privacy state was ASSERTED but never VISIBLE. During v9's blank-privacy
#      dwell the page was still scrolled to the composer, so #tiktok-privacy sat
#      below the fold and only entered frame after it had been set. Segment 04b is
#      a re-capture of that beat alone, with the control scrolled into view, so the
#      reviewer watches "— select privacy level —" become "Only Me". That capture
#      was made with --dry-run: it stops before Publish, so no second post exists.
#   2. v9 captioned the Direct Post as successful while the button still read
#      "Uploading…". The publish cue is now split at the exact frame the green
#      banner appears (source 97.7s).
#   3. The cut ended on TikTok Studio. It now ends on a manual, human-driven
#      verification on tiktok.com itself: the private account, the single post,
#      its lock badge, and the post opened and held.
#
# No Inbox, no drafts, no native iOS editing, no manual TikTok publish.
#
# Sources:
#   automation/out/fresh-oauth-flow.mp4         accepted OAuth footage, reused verbatim
#   automation/out/fresh-directpost-flow.mp4    the real single-take Direct Post capture
#   automation/out/privacy-beat-capture.mp4     dry-run re-capture, privacy beat only (no publish)
#   audit-content/manual-tiktok-profile-verification.mov   manual screen recording, tiktok.com
#
# Presentation is unchanged from v6-v9: source UI is never overlaid or cropped;
# a 200px black caption band is appended BELOW the 1440x900 video area.
# Final canvas: 1440x1100 @ 25fps.
set -euo pipefail
cd "$(dirname "$0")"

SRC_OAUTH="automation/out/fresh-oauth-flow.mp4"
SRC_DP="automation/out/fresh-directpost-flow.mp4"
SRC_PRIV="automation/out/privacy-beat-capture.mp4"
SRC_MANUAL="audit-content/manual-tiktok-profile-verification.mov"

SEG="v10-segments"
mkdir -p "$SEG"

FONT="/System/Library/Fonts/SFNS.ttf"
W=1440
VH=900        # video area height (native source height, no scaling)
BAND=200      # caption band height
H=$((VH+BAND))
FPS=25

card() {
  local out="$1" dur="$2" bg="$3" text="$4" fsize="${5:-46}"
  local tf; tf="$(mktemp)"
  printf '%b' "$text" > "$tf"
  ffmpeg -y -v error -f lavfi -i "color=c=${bg}:s=${W}x${H}:d=${dur}:r=${FPS}" \
    -vf "drawtext=fontfile=${FONT}:textfile=${tf}:fontcolor=white:fontsize=${fsize}:line_spacing=16:x=(w-text_w)/2:y=(h-text_h)/2:box=0" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 18 -an "$out"
}

# args: src ss dur prefilter(or "") out capfile
# capfile lines: "start|end|text"  ('\n' in text becomes a real line break)
footage() {
  local src="$1" ss="$2" dur="$3" prefilter="$4" out="$5" capfile="$6"

  local dt="" i=0
  while IFS='|' read -r a b t; do
    [ -z "$a" ] && continue
    i=$((i+1))
    local tf="/tmp/v10_capline_$$_${i}.txt"
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
card "$SEG/01_opening.mp4" 7 "0x0B0B12" \
"CreatorPost — TikTok Direct Post Audit (Corrected Resubmission)\n\nOAuth authorization  →  both accounts hold ZERO posts\n→  privacy chosen manually: Only Me / SELF_ONLY  →  one Direct Post\n→  exactly ONE post, private, verified on tiktok.com" 30

echo "== 02_oauth (reused, accepted footage) =="
cat > /tmp/v10_cap_oauth.txt <<'EOF'
0.0|6.5|Clicking "+ TikTok" in CreatorPost begins real OAuth authorization.
6.5|11.5|TikTok's own consent screen: creatorpost_dev, full permission list, then Continue.
11.5|22.0|TikTok's "Verify it's really you" identity step-up.
22.0|24.4|Back on CreatorPost — "1 TikTok connected."
EOF
footage "$SRC_OAUTH" 0 24.4 "" "$SEG/02_oauth.mp4" /tmp/v10_cap_oauth.txt

echo "== 03_before (TikTok Studio: account is empty) =="
cat > /tmp/v10_cap_before.txt <<'EOF'
0.0|12.0|BEFORE. TikTok Studio, signed in as @creatorpost_dev:\nthe account holds no posts at all — "No posts yet".
EOF
footage "$SRC_DP" 1.5 12.0 "" "$SEG/03_before.mp4" /tmp/v10_cap_before.txt

echo "== 04a_compose (real capture, source 15.0 -> 44.0) =="
cat > /tmp/v10_cap_04a.txt <<'EOF'
0.0|9.0|CreatorPost, signed in — "1 TikTok connected" (creatorpost_dev).\nTotal Posts 0: nothing has ever been published from this account.
9.0|16.0|Sync Posts calls TikTok's real user.info.stats and video.list:\n0 posts imported, matching the empty account above.
16.0|29.0|Composer: the audit video is selected and a caption entered.\nPublishing target is the connected TikTok account, creatorpost_dev.
EOF
footage "$SRC_DP" 15.0 29.0 "" "$SEG/04a_compose.mp4" /tmp/v10_cap_04a.txt

echo "== 04b_privacy (privacy beat re-capture, source 39.5 -> 50.5) =="
# Blank until 46.4s of the source, "Only Me" from 46.5s -> 6.9s blank, 4.1s selected.
cat > /tmp/v10_cap_04b.txt <<'EOF'
0.0|6.9|Privacy is REQUIRED and starts EMPTY — "— select privacy level —".\nNothing is preselected. The options are read from TikTok's live\ncreator_info response, never from a hardcoded list.
6.9|11.0|The creator now selects "Only Me" — SELF_ONLY — by hand.\nThis is an explicit manual choice in the UI, not a default.
EOF
footage "$SRC_PRIV" 39.5 11.0 "" "$SEG/04b_privacy.mp4" /tmp/v10_cap_04b.txt

echo "== 04c_publish (real capture, source 56.0 -> 120.0) =="
# rel = source - 56.0.  The button flips to "Uploading…" at source 95.8 (rel 39.8);
# green success banner first appears at source 97.7 (rel 41.7).
cat > /tmp/v10_cap_04c.txt <<'EOF'
0.0|5.0|The TikTok Settings panel: creator identity and every option here are\nloaded live from TikTok's creator_info endpoint. Privacy is now Only Me.
5.0|12.0|Comment / Duet / Stitch default OFF. Duet and Stitch are greyed out,\n"Turned off in your TikTok account settings".
12.0|20.0|Commercial disclosure is OFF by default. Turned on it requires an explicit\nPromotional content / Branded content choice, and TikTok's rule that\nBranded content cannot be private is enforced in the UI and explained.
20.0|26.0|"Your brand" is labelled Promotional content.
26.0|32.0|"Branded content" is labelled Paid partnership. With both selected, the\ndeclaration cites the Branded Content Policy and the Music Usage Confirmation.
32.0|39.8|Disclosure returned OFF and privacy still "Only Me". Publishing stays\nblocked until the creator ticks the explicit confirmation checkbox.\nTotal Posts is still 0.
39.8|41.7|Publish Now clicked. The button reads "Uploading…" —\nthe Direct Post request is in flight.
41.7|47.0|CreatorPost confirms the DIRECT POST: "Posted to creatorpost_dev ✓".\nNot a draft, not an upload. Total Posts goes 0 → 1.
47.0|54.0|The single new post appears in Recent Posts as Processing…
54.0|64.0|…and then Published. No Inbox, no draft, and no step inside\nthe native TikTok app.
EOF
footage "$SRC_DP" 56.0 64.0 "" "$SEG/04c_publish.mp4" /tmp/v10_cap_04c.txt

echo "== 05_after (TikTok Studio: exactly one post) =="
cat > /tmp/v10_cap_after.txt <<'EOF'
0.0|14.0|AFTER. The same TikTok Studio Posts table now holds exactly ONE post:\nthe caption sent from CreatorPost, privacy "Only me" (SELF_ONLY), and\nTikTok's own creation timestamp for the Direct Post above.
EOF
footage "$SRC_DP" 168.0 14.0 "" "$SEG/05_after.mp4" /tmp/v10_cap_after.txt

echo "== 06_manual (human verification on tiktok.com) =="
# Screen recording made by hand, in the creator's own Chrome, 1792x1094 @50fps.
# Scaled to the 1440px canvas width and letterboxed rather than cropped, so the
# address bar (tiktok.com/@creatorpost_dev) stays visible as part of the evidence.
cat > /tmp/v10_cap_manual.txt <<'EOF'
0.0|8.0|FINAL CHECK, by hand, on tiktok.com — not through CreatorPost.\n@creatorpost_dev, signed in, account PRIVATE (lock beside the handle),\nholding exactly one video, and that video carries a lock badge.
8.0|14.5|The post opened on TikTok: labelled "Private", with the caption\nCreatorPost sent. This is the Direct Post, on the creator's own\nTikTok account, visible to no one else.
EOF
footage "$SRC_MANUAL" 0 14.4 "scale=1440:-2,pad=1440:900:0:10:color=black" "$SEG/06_manual.mp4" /tmp/v10_cap_manual.txt

echo "== concat =="
cat > "$SEG/concat.txt" <<'EOF'
file '01_opening.mp4'
file '02_oauth.mp4'
file '03_before.mp4'
file '04a_compose.mp4'
file '04b_privacy.mp4'
file '04c_publish.mp4'
file '05_after.mp4'
file '06_manual.mp4'
EOF
ffmpeg -y -v error -f concat -safe 0 -i "$SEG/concat.txt" -c copy v10-final-cut.mp4

echo "== done =="
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -show_entries format=duration -of default=noprint_wrappers=1 v10-final-cut.mp4
ls -la v10-final-cut.mp4
