# TikTok Content Posting API - Application Answers

Reference doc for re-submitting at: https://developers.tiktok.com/application/content-posting-api

Last submitted: 2026-03-10 (resubmission for Direct Post access)

---

## Step 1 - General Information

**Full Name**
Matthew Donders

**Organization name**
CreatorPost

**Organization website**
https://creatorpost.app

**Describe your organization's work as it relates to TikTok**
> CreatorPost is a video scheduling and publishing platform built for independent content creators. It allows creators to upload, caption, and publish short-form videos directly to TikTok without manually opening the app. The tool is primarily used by solo creators who manage multiple TikTok accounts or run automated content pipelines (e.g. daily history, finance, or educational content). CreatorPost integrates with TikTok's Content Posting API to handle OAuth authentication, video uploads, and publishing, giving creators a single dashboard to manage their TikTok content workflow end-to-end.

**TikTok representative email address**
*(leave blank - no TikTok contact)*

---

## Step 2 - API Client Information

**App name**
CreatorPost

**App ID**
7614726586902005771

**Client Key**
*(copy from TikTok Developer Portal -> App -> Client Key)*

**Explain the goal of your application and how Content Posting API integration can be beneficial**
> The goal of CreatorPost is to remove the manual overhead of publishing videos to TikTok for independent content creators. Many creators produce videos in bulk using tools like CapCut, HeyGen, or custom pipelines and need a reliable, programmatic way to get those videos onto TikTok on a schedule without logging in and uploading each one manually. The Content Posting API is the core of CreatorPost's value: without it, the product does not exist. Integration allows creators to authenticate once, then publish directly from their desktop or automated scripts, enabling consistent posting schedules, higher output frequency, and time savings that let them focus on content quality rather than distribution logistics.

**Use case / how will you use the API?**
> CreatorPost uses the Content Posting API to let authenticated users upload MP4 videos and publish them directly to TikTok. The user connects their TikTok account via OAuth, then uses the dashboard to select a video file, write a caption, configure privacy and interaction settings (comment, duet, stitch), and optionally schedule the post. The app calls the TikTok Direct Post API (`/v2/post/publish/video/init/`) and polls for status confirmation. For users without Direct Post approval, it falls back to the inbox/draft flow (`/v2/post/publish/inbox/video/init/`).

**Please list the API response data fields that your API client will save in its database**
> From the OAuth token exchange (`/v2/oauth/token/`): `access_token`, `refresh_token`, `expires_in` (stored as `token_expires_at` unix timestamp).
>
> From the user info endpoint (`/v2/user/info/`): `open_id` (stored as `platform_user_id`), `display_name`, `avatar_url`.
>
> From the publish init endpoint (`/v2/post/publish/video/init/`): `publish_id` (used to poll status).
>
> From the publish status endpoint (`/v2/post/publish/status/fetch/`): `video_id` (stored once the post is confirmed published), `status` (mapped to our internal statuses: processing / published / failed).
>
> No video content, view counts, or other analytics data is persisted to the database. Video files are held in memory during upload only and never written to disk or stored.

**Approximately how many users use your API client(s) to publish videos to TikTok on a daily basis?**
*(dropdown - select "Less than 100")*

**Explain how you determined the daily usage estimate**
> The estimate is based on the current number of active CreatorPost users (under 50 at early-access launch) multiplied by their expected posting frequency. Independent short-form creators typically publish 1-3 videos per day. Each video publish requires: one `/v2/post/publish/video/init/` call, one or two `/v2/post/publish/status/fetch/` polls, and one `/v2/post/publish/creator_info/` call per session. At 50 users posting an average of 2 videos per day that yields roughly 300-400 API calls per day. We used 50-150 as a conservative lower bound to reflect that not all users are active daily at this stage.

---

## Step 3 - Supporting Documents

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
https://creatorpost.app/privacy - live

**Terms of Service**
https://creatorpost.app/terms - live

---

## Step 4 - Review Checklist

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
- TikTok reviews take approximately 2-4 weeks
- Until Direct Post is approved, posts go to the TikTok inbox/drafts for manual approval
- Previous rejection reason: missing UX compliance (privacy selector, interaction toggles, disclosure)
- All 5 UX compliance points are now implemented as of 2026-03-10
