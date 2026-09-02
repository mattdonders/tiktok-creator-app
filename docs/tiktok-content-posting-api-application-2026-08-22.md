# TikTok Content Posting API Application — submitted answers

Record of what has actually been sent to
`https://developers.tiktok.com/application/content-posting-api`, kept so the exact
answers are on hand if the application is rejected and needs resubmitting.

**The answers below are the CURRENT ones, as submitted 2026-09-02.** Fields revised
for that submission are marked `(revised 2026-09-02)`; everything else was carried
over verbatim from 2026-08-22. Superseded wording is preserved in the submission log
at the bottom — do not delete it, it is the record of what a rejection was rejecting.

The filename keeps its original `2026-08-22` date so existing links stay valid; the
first snapshot came from the confirmation screen captured that day 6:22 PM as
`TikTok for Developers.pdf`.

## General Information

**Full Name**
Matthew Donders

**Organization name**
CreatorPost

**Organization website**
https://creatorpost.app

**Describe your organization's work as it relates to TikTok** *(revised 2026-09-02)*
> CreatorPost is a social publishing platform for creators and small teams. Users connect
> their TikTok accounts through TikTok OAuth, view their connected account information,
> profile statistics and existing video data, and prepare content for publishing to
> TikTok. CreatorPost uses TikTok's Content Posting API to support **Direct Post
> publishing to a creator's TikTok profile**, as well as draft uploads when native TikTok
> completion is required, while presenting TikTok-provided privacy, interaction and
> commercial-content controls to the creator. Users review their settings and explicitly
> confirm each post before content is sent to TikTok.

**TikTok representative email address**
Not provided

## API Client Information

**App ID**
`7614726586902005771`

**Explain the goal of your application and how Content Posting API integration can be beneficial** *(revised 2026-09-02)*
> CreatorPost is a social publishing platform that helps creators and small teams manage
> and publish content to their connected social accounts. The goal of the TikTok
> integration is to let users securely connect their own TikTok accounts, prepare videos
> in CreatorPost, review TikTok-provided publishing settings and disclosures, and
> explicitly choose when to publish their content.
>
> Access to TikTok's Content Posting API allows CreatorPost to provide **Direct Post
> functionality so a creator can publish a video directly from CreatorPost to their
> TikTok profile**, while keeping the creator in control of privacy, interaction settings,
> commercial-content disclosures, music usage confirmation, and final per-post consent.
> CreatorPost also supports TikTok's Upload workflow when native completion in TikTok is
> appropriate.
>
> This reduces repetitive manual file handling while preserving TikTok's required
> controls and giving creators a clear, transparent publishing experience.

**Approximately how many users use your API client(s) to publish videos to TikTok on a daily basis?**
Less than 100

**Explain how you determined the daily usage estimate**
> CreatorPost is currently in an early production rollout with a small number of
> connected users and publishing activity. Based on actual current usage of the live
> application, the number of users publishing to TikTok on a typical day is well below
> 100. Since "Less than 100" is the lowest available range, I selected it as the most
> accurate and conservative estimate of current daily usage.

## Supporting Documents

**Please upload a screen recording of the Post to TikTok user experience in your integration**
`v10-final-cut.mp4` *(revised 2026-09-02)* — built via `submission-v5/build-v10-cut.sh`, see `submission-v5/v10-final-cut.mp4`. 175.88s, 1440x1100 @ 25fps.

**Please list the API response data fields that your API client will save in its database**
> When a creator connects their TikTok account, CreatorPost stores the TikTok OAuth
> access token, refresh token, and token expiration time. These credentials are stored
> server-side only and are used solely to make authenticated requests to TikTok's API on
> the creator's behalf; they are not exposed to the browser or shared with third parties.
> CreatorPost also stores the creator's TikTok open_id, display name, avatar URL,
> username, and follower count for account identification and basic account statistics.
> For TikTok videos and publishing activity, CreatorPost stores the TikTok video ID,
> TikTok-reported creation time, video caption/description when applicable, TikTok
> publish_id, and the resulting publishing status used to track whether content is
> processing, published, failed, or sent to the creator's TikTok Inbox. CreatorPost does
> not persist TikTok engagement metrics such as view count, like count, comment count, or
> share count. Those values are fetched from TikTok when needed and are not stored in
> CreatorPost's database.
>
> (Full field-by-field trace behind this answer: `docs/tiktok-data-fields.md`)

## Declaration

Three checkboxes agreed to:
- Agreement to TikTok for Developers Terms of Service and Production-use Guidelines
- Acknowledgment that TikTok is not bound by CreatorPost's terms/policies when accessing a provided demo account
- Attestation that the above facts are true, with acknowledgment that API access may be terminated if found untrue

## Submission log

- **2026-08-22** — submitted with `v6-final-cut.mp4`. REJECTED: the video ended in
  TikTok's Upload/Inbox workflow, so it demonstrated Upload rather than Direct Post.
  Root cause was in the product, not the edit: `/api/publish`
  (`functions/[[route]].js`) silently falls back to `TIKTOK_INBOX_INIT_URL` when the
  Direct Post `video/init` call fails, and the v6 capture recorded that fallback.
- **2026-09-02** — resubmitted with `v10-final-cut.mp4`
  (`submission-v5/build-v10-cut.sh`, 175.88s). That cut proves a real Direct Post
  end to end: both @creatorpost_dev and the CreatorPost account visibly hold zero
  posts beforehand, privacy starts blank and is manually set to Only Me /
  SELF_ONLY, one Direct Post is made, and exactly one private post exists
  afterwards — verified in TikTok Studio and then by hand on tiktok.com.
  Two written answers were revised for this submission to name Direct Post
  explicitly — the org description and the goal — and nothing else was touched.
  The daily-usage and persisted-data answers answer different questions and were
  already accurate, so they went back verbatim.

  **Superseded 2026-08-22 wording, kept for the record:**

  *Describe your organization's work as it relates to TikTok (2026-08-22, superseded):*
  > CreatorPost is a social publishing platform for creators and small teams. Users connect
  > their TikTok accounts through TikTok OAuth, view their connected account information,
  > profile statistics and existing video data, and prepare content for publishing to
  > TikTok. CreatorPost uses TikTok's Content Posting API to support video publishing and
  > draft uploads while presenting TikTok-provided privacy, interaction and
  > commercial-content controls to the creator. Users review their settings and explicitly
  > confirm each post before content is sent to TikTok, and complete the native TikTok
  > workflow when required.

  *Explain the goal of your application ... (2026-08-22, superseded):*
  > CreatorPost is a social publishing platform that helps creators and small teams manage
  > and publish content to their connected social accounts. The goal of the TikTok
  > integration is to let users securely connect their own TikTok accounts, prepare videos
  > in CreatorPost, review TikTok-provided publishing settings and disclosures, and
  > explicitly choose when to send their content to TikTok. Access to the Content Posting
  > API allows CreatorPost to provide a complete publishing workflow while keeping the
  > creator in control of privacy, interaction settings, commercial-content disclosures,
  > music usage confirmation, and final per-post consent. It also supports TikTok's Upload
  > workflow when native completion in TikTok is required. This reduces repetitive manual
  > file handling for creators while preserving TikTok's required controls and giving users
  > a clear, transparent publishing experience.

  Both superseded answers described the integration in Upload/Inbox terms; neither
  said "Direct Post". Paired with a v6 video that ended in TikTok's Upload flow,
  the application never actually asked for the thing it needed approved.

### Why the wording and the evidence now match

The whole point of the 2026-09-02 revision is that the claim in the form and the
claim on screen are now the same claim, and a reviewer can check one against the
other without inference:

| Application says | `v10-final-cut.mp4` shows |
| --- | --- |
| "publish a video directly from CreatorPost to their TikTok profile" | Publish Now in CreatorPost → "Posted to creatorpost_dev ✓" → the same video on @creatorpost_dev, with no TikTok-side completion step in between |
| "presenting TikTok-provided privacy ... controls to the creator" | `#tiktok-privacy` on screen and visibly blank, then manually set to Only Me / `SELF_ONLY` |
| "explicitly confirm each post before content is sent" | Publish stays blocked until the confirmation checkbox is ticked |
| "as well as draft uploads when native TikTok completion is required" | Scoped as the secondary path — the cut never ends in the Inbox flow |

Residual liability, unchanged by this submission: `/api/publish` in
`functions/[[route]].js` still silently falls back to `TIKTOK_INBOX_INIT_URL`
when Direct Post `video/init` fails. v10 avoids demonstrating that fallback via a
fail-loud capture gate, not via a product fix. If TikTok approves on the strength
of Direct Post, that fallback should be made fail-loud too.

## Notes for a future resubmission

- App ID and org info won't change — reuse as-is.
- Keep the Direct Post language in the org-description and goal answers. It is there
  deliberately, and it is what `v10-final-cut.mp4` demonstrates.
- Do NOT push Direct Post language into the daily-usage or persisted-data answers.
  Those questions ask something else and are already accurate; padding them reads as
  keyword-stuffing.
- The daily-usage answer is generic/durable — fine to resubmit verbatim unless usage
  materially changes.
- The data-fields answer should be re-verified against `docs/tiktok-data-fields.md`
  before resubmitting, in case the schema or sync logic changed since 2026-08-22.
- The demo video must be whatever the current audit cut is at resubmission time —
  check `submission-v5/` for the latest build before reusing `v10-final-cut.mp4`, and
  make sure whatever cut is attached still ends in Direct Post, not the Inbox flow.
