#!/usr/bin/env python3
"""
Generate the 3 CreatorPost TikTok videos via HeyGen API.

Usage:
    # List available avatars to pick one:
    python scripts/generate_videos.py --list-avatars

    # Generate all 3 videos:
    python scripts/generate_videos.py --avatar-id YOUR_AVATAR_ID

Output: scripts/output/video_1.mp4, video_2.mp4, video_3.mp4
"""

import argparse
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

API_KEY  = os.getenv("HEYGEN_API_KEY")
BASE_URL = "https://api.heygen.com"
HEADERS  = {"x-api-key": API_KEY, "Content-Type": "application/json"}

OUTPUT_DIR    = Path(__file__).parent / "output"
POLL_INTERVAL = 30
MAX_WAIT      = 1800

# ── Scripts ────────────────────────────────────────────────────────────────────

VIDEOS = [
    {
        "title": "creatorpost_video_2_burnout",
        "caption": (
            "The part of content creation nobody talks about 👇\n\n"
            "It's not the filming. It's everything after.\n\n"
            "#burnout #contentcreator #creatortips #tiktokgrowth #socialmedia"
        ),
        "narration": (
            "Nobody talks about this — but a huge reason creators burn out isn't the filming. "
            "It's everything after.  "
            "Editing, captioning, scheduling, manually uploading... by the time you're done "
            "with post-production, you're exhausted before the video even goes live.  "
            "The creators who stay consistent long-term? They automate the boring parts. "
            "They batch their content and let tools handle the publishing.  "
            "That's the whole idea behind what I'm building with CreatorPost. "
            "Take the grind out of posting so you can focus on actually creating."
        ),
    },
    {
        "title": "creatorpost_video_1_automated",
        "caption": (
            "I automated my entire TikTok upload process and saved hours every week ⚡\n\n"
            "If you're posting consistently, manual uploads are killing your time.\n\n"
            "#contentcreator #tiktokautomation #creatortips #contentcreation #socialmediatools"
        ),
        "narration": (
            "I used to spend way too much time manually uploading videos to TikTok.  "
            "Like — I'd film a batch of content, edit everything, and then have to sit there "
            "and upload each one individually, write the caption, add the hashtags... "
            "it was eating up an hour every single week.  "
            "So I built a tool that does it for me. I drop the video in, set a time, "
            "and it posts automatically using TikTok's official API. "
            "No app. No manual upload. Just done.  "
            "It's called CreatorPost — I'm opening it up to other creators soon. "
            "Link in bio if you want early access."
        ),
    },
    {
        "title": "creatorpost_video_3_daily",
        "caption": (
            "How I post daily on TikTok without touching my phone 📱✨\n\n"
            "Film once. Schedule everything. Post on autopilot.\n\n"
            "This is the only way I've stayed consistent for months.\n\n"
            "#tiktokgrowth #contentcreator #socialmediatips #creatortips #consistency"
        ),
        "narration": (
            "I post on TikTok every single day — and I'm barely on my phone.  "
            "Here's how: I film a week's worth of content in one session. "
            "Usually Sunday afternoon, maybe two hours total. "
            "Then I drop everything into my scheduling tool, set the times, and I'm done.  "
            "Monday through Sunday, videos go out automatically. No reminders. "
            "No logging in at 6pm to manually upload. Just consistent posting on autopilot.  "
            "Consistency is literally the most important thing for growth on this platform — "
            "and the only way I've been able to stay consistent is by removing the friction of posting.  "
            "I built a tool called CreatorPost to do exactly this. "
            "Early access is open — link in bio."
        ),
    },
]

# ── API helpers ────────────────────────────────────────────────────────────────

def list_avatars():
    resp = requests.get(f"{BASE_URL}/v2/avatars", headers=HEADERS)
    resp.raise_for_status()
    return resp.json()["data"]["avatars"]


def generate_video(narration, avatar_id, voice_id, title):
    payload = {
        "title": title,
        "dimension": {"width": 1080, "height": 1920},
        "video_inputs": [{
            "character": {
                "type": "avatar",
                "avatar_id": avatar_id,
                "avatar_style": "normal",
                "scale": 1.0,
                "offset": {"x": 0.0, "y": 0.0},
            },
            "voice": {
                "type": "text",
                "voice_id": voice_id,
                "input_text": narration,
                "speed": 1.0,
            },
            "background": {
                "type": "color",
                "value": "#0a0a0a",  # CreatorPost dark background
            },
        }],
        "caption": True,  # auto-captions on
    }
    resp = requests.post(f"{BASE_URL}/v2/video/generate", headers=HEADERS, json=payload)
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise RuntimeError(f"HeyGen error: {data['error']}")
    video_id = data["data"]["video_id"]
    print(f"  Submitted. video_id: {video_id}")
    return video_id


def poll_status(video_id):
    elapsed = 0
    while elapsed < MAX_WAIT:
        resp = requests.get(f"{BASE_URL}/v1/video_status.get",
                            headers=HEADERS, params={"video_id": video_id})
        resp.raise_for_status()
        data = resp.json()["data"]
        status = data["status"]
        print(f"  [{elapsed:>4}s] Status: {status}")
        if status == "completed":
            return data
        if status == "failed":
            raise RuntimeError(f"Generation failed: {data.get('error')}")
        time.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL
    raise TimeoutError("Video not ready after 30 minutes")


def download_video(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.get(url, stream=True)
    resp.raise_for_status()
    with open(path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
    print(f"  Saved: {path} ({path.stat().st_size / 1_000_000:.1f} MB)")


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_list(args):
    avatars = list_avatars()
    filtered = avatars if args.all else [a for a in avatars if not a.get("premium")]
    print(f"\n{'ID':<40} {'Name':<30} {'Gender'}")
    print("-" * 85)
    for a in sorted(filtered, key=lambda x: x.get("avatar_name", "")):
        print(f"{a['avatar_id']:<40} {a.get('avatar_name',''):<30} {a.get('gender','')}")
    print(f"\n{len(filtered)} avatars. Use --all to include premium.")


def cmd_generate(args):
    # Resolve voice
    voice_id = args.voice_id
    if not voice_id:
        # Default to a natural English male voice
        voice_id = "en-US-ChristopherNeural"
        print(f"Using default voice: {voice_id}")

    videos = VIDEOS if args.video == "all" else [VIDEOS[int(args.video) - 1]]

    for i, video in enumerate(videos, 1):
        print(f"\n── Video {i}: {video['title']} ──")
        video_id = generate_video(video["narration"], args.avatar_id, voice_id, video["title"])
        status   = poll_status(video_id)
        out_path = OUTPUT_DIR / f"{video['title']}.mp4"
        download_video(status["video_url"], out_path)
        # Save companion caption file
        caption_path = OUTPUT_DIR / f"{video['title']}.txt"
        caption_path.write_text(video["caption"])
        print(f"  Caption : {caption_path}")
        print(f"  Duration: {status.get('duration', '?')}s")

    print("\nAll done!")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print("HEYGEN_API_KEY not set in .env", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Generate CreatorPost TikTok videos via HeyGen")
    sub = parser.add_subparsers(dest="cmd")

    p_list = sub.add_parser("list-avatars")
    p_list.add_argument("--all", action="store_true")

    p_gen = sub.add_parser("generate")
    p_gen.add_argument("--avatar-id", required=True)
    p_gen.add_argument("--voice-id",  default=None)
    p_gen.add_argument("--video",     default="all", help="1, 2, 3, or all (default: all)")

    args = parser.parse_args()
    if args.cmd == "list-avatars":
        cmd_list(args)
    elif args.cmd == "generate":
        cmd_generate(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
