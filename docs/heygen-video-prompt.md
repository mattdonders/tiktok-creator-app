# CreatorPost — HeyGen Promo Video Prompts

Send these to the faceless-instagram pipeline to generate 3 promo videos.
Use HeyGen with Avatar IV + expressive style for best quality.

---

## Setup First

Create account skeleton at `~/Development/faceless-instagram/accounts/creatorpost/`

### config.json
```json
{
  "handle": "creatorpostapp",
  "tagline": "Schedule your TikToks. Save your sanity.",
  "brand_color": [124, 58, 237],
  "model": "claude-sonnet-4-6",
  "tts_enabled": false,
  "combined_idea_script": true,
  "heygen_enabled": true,
  "heygen_avatar_id": "REPLACE_WITH_AVATAR_ID",
  "heygen_voice_id": "REPLACE_WITH_VOICE_ID",
  "heygen_look_ids": [],
  "tiktok_enabled": true,
  "youtube_enabled": true,
  "twitter_enabled": true,
  "instagram_enabled": true
}
```

---

## Video 1 — "The Manual Upload Trap"

**Concept:** Pain point hook. The loop most creators are stuck in.

### Script JSON
```json
{
  "slides": [
    {
      "text": "You spend 20 minutes uploading a TikTok.\nThen you do it again tomorrow.",
      "animation": "slide_up"
    },
    {
      "text": "Open app. Wait for upload.\nWrite caption. Add hashtags.",
      "animation": "slide_up"
    },
    {
      "text": "Pick a publish time.\nHope you don't forget.",
      "animation": "slide_up"
    },
    {
      "text": "That's 2+ hours a week.\nJust on uploads.",
      "animation": "slide_up"
    },
    {
      "text": "CreatorPost does all of this\nautomatically.",
      "animation": "slide_up"
    },
    {
      "text": "Schedule once. It posts itself.\nYou just create.",
      "animation": "slide_up"
    },
    {
      "text": "Follow @creatorpostapp\nSchedule your TikToks. Save your sanity.",
      "animation": "slide_up"
    }
  ]
}
```

**Caption:**
```
You're losing 2 hours a week to manual TikTok uploads. Here's how to get them back.

CreatorPost auto-publishes your videos on schedule using TikTok's official Content Posting API.

Free to start → creatorpost.app 🔗

#contentcreator #tiktoktips #tiktokgrowth #creatortool #contentautomation
```

---

## Video 2 — "Before vs After"

**Concept:** Simple transformation. Old way vs CreatorPost way.

### Script JSON
```json
{
  "slides": [
    {
      "text": "Here's what posting 4 TikToks\nused to look like.",
      "animation": "slide_up"
    },
    {
      "text": "4 videos × 20 min each\n= 80 minutes of your week. Gone.",
      "animation": "slide_up"
    },
    {
      "text": "Now here's the CreatorPost way.\nUpload all 4 at once.",
      "animation": "slide_up"
    },
    {
      "text": "Set your schedule.\nWalk away.",
      "animation": "slide_up"
    },
    {
      "text": "They post automatically.\nYou don't touch your phone.",
      "animation": "slide_up"
    },
    {
      "text": "80 minutes back every week.\nForever.",
      "animation": "slide_up"
    },
    {
      "text": "Follow @creatorpostapp\nSchedule your TikToks. Save your sanity.",
      "animation": "slide_up"
    }
  ]
}
```

**Caption:**
```
Before CreatorPost: 80 minutes a week on uploads.
After: 5 minutes.

The math isn't complicated.

Free → creatorpost.app 🔗

#contentcreator #creatortips #tiktokgrowth #socialmediatools #contentautomation
```

---

## Video 3 — "TikTok's Secret API"

**Concept:** Educational/curiosity hook. Reveals something most creators don't know.

### Script JSON
```json
{
  "slides": [
    {
      "text": "TikTok has an official API\nthat lets you post without opening the app.",
      "animation": "slide_up"
    },
    {
      "text": "It's called the Content Posting API.\nAnd most creators have no idea it exists.",
      "animation": "slide_up"
    },
    {
      "text": "You upload your video.\nSet a time. That's it.",
      "animation": "slide_up"
    },
    {
      "text": "The API publishes it automatically\nwithout any manual steps.",
      "animation": "slide_up"
    },
    {
      "text": "We built CreatorPost\non top of this exact API.",
      "animation": "slide_up"
    },
    {
      "text": "It's free to start.\nNo credit card needed.",
      "animation": "slide_up"
    },
    {
      "text": "Follow @creatorpostapp\nSchedule your TikToks. Save your sanity.",
      "animation": "slide_up"
    }
  ]
}
```

**Caption:**
```
TikTok has an official API that auto-publishes videos without touching the app. Most creators don't know it exists.

We built CreatorPost on top of it. Free to start.

creatorpost.app 🔗

#tiktoktips #contentcreator #tiktokgrowth #creatortool #tiktokapi
```

---

## How to Generate

```bash
cd ~/Development/faceless-instagram

# Generate without publishing (review first)
python pipeline.py creatorpost --script accounts/creatorpost/scripts/ready/video1.json --skip-publish

# Or trigger directly with idea text
python pipeline.py creatorpost "The manual TikTok upload trap that wastes 2 hours a week" --skip-publish
```

Review output in `accounts/creatorpost/output/` before publishing.
