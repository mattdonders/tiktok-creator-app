# TikTok Content Posting API — Application Answers

Reference doc for re-submitting at: https://developers.tiktok.com/application/content-posting-api

Last submitted: 2026-03-10 (resubmission for Direct Post access)

---

## Step 1 — General Information

**Full Name**
Matthew Donders

**Organization name**
CreatorPost

**Organization website**
https://creatorpost.app

**Describe your organization's work as it relates to TikTok**
> CreatorPost is a video scheduling and publishing platform built for independent content creators. It allows creators to upload, caption, and publish short-form videos directly to TikTok without manually opening the app. The tool is primarily used by solo creators who manage multiple TikTok accounts or run automated content pipelines (e.g. daily history, finance, or educational content). CreatorPost integrates with TikTok's Content Posting API to handle OAuth authentication, video uploads, and publishing — giving creators a single dashboard to manage their TikTok content workflow end-to-end.

**TikTok representative email address**
*(leave blank — no TikTok contact)*

---

## Step 2 — API Client Information

**App name**
CreatorPost

**App ID**
7614726586902005771

**Client Key**
*(copy from TikTok Developer Portal → App → Client Key)*

**Redirect URI**
https://creatorpost.app/auth/tiktok/callback

**Privacy Policy URL**
https://creatorpost.app/privacy

**Scopes requested**
- `user.info.basic`
- `user.info.profile`
- `user.info.stats`
- `video.upload`
- `video.publish`
- `video.list`

**Direct Post**
Yes — enabled

**Use case / how will you use the API?**
> CreatorPost uses the Content Posting API to let authenticated users upload MP4 videos and publish them directly to TikTok. The user connects their TikTok account via OAuth, then uses the dashboard to select a video file, write a caption, configure privacy and interaction settings (comment, duet, stitch), and optionally schedule the post. The app calls the TikTok Direct Post API (`/v2/post/publish/video/init/`) and polls for status confirmation. For users without Direct Post approval, it falls back to the inbox/draft flow (`/v2/post/publish/inbox/video/init/`).

---

## Step 3 — Supporting Documents

**Demo video**
Record a screen capture showing:
1. Log in to creatorpost.app with demo account (`cp-tiktok-demo@mattdonders.com`)
2. Click "+ TikTok" to connect a TikTok account via OAuth
3. Authorize on TikTok, redirect back to dashboard
4. Upload an MP4 video via the drop zone
5. Write a caption
6. Show the TikTok Settings panel:
   - Privacy level dropdown (populated from creator_info API, no default pre-selected)
   - Select "Public" from dropdown
   - Comment / Duet / Stitch toggles (defaulted ON)
   - Disclose commercial content toggle (off)
   - Music Usage Confirmation consent text with link
7. Click "Publish Now"
8. Show the post appearing in Recent Posts as "Processing" then "Published"

**Privacy Policy**
https://creatorpost.app/privacy ✓ live

**Terms of Service**
https://creatorpost.app/terms ✓ live

---

## Step 4 — Review Checklist

Before submitting, confirm:
- [ ] Demo video uploaded and shows full Direct Post UX flow
- [ ] Privacy level has NO pre-selected default (user must choose)
- [ ] Comment / Duet / Stitch shown as explicit opt-out toggles
- [ ] Commercial content disclosure section present
- [ ] Music Usage Policy confirmation link present
- [ ] Privacy policy URL live and accessible
- [ ] App is live at creatorpost.app

---

## Notes from Previous Submission

- First submission approved the base Content Posting API (inbox flow)
- This resubmission is specifically for **Direct Post** access
- TikTok reviews take approximately 2–4 weeks
- Until Direct Post is approved, posts go to the TikTok inbox/drafts for manual approval
- Previous rejection reason: missing UX compliance (privacy selector, interaction toggles, disclosure)
- All 5 UX compliance points are now implemented as of 2026-03-10
