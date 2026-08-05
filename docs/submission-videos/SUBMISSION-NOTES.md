# CreatorPost — TikTok App Review submission clips (4th resubmission)

Recorded 2026-08-04 against the **live production app** at `https://creatorpost.app`,
authorizing and posting to the real TikTok account `creatorpost_dev`. Clips 2 and 3 are
signed into the demo app account `cp-tiktok-demo@mattdonders.com`; clip 1 was recorded by the
owner in his own browser (Playwright could not reach the consent screen) but is signed into
**that same demo app account**, so the app identity is consistent across all three files.
Nothing is mocked — creator nickname, avatar and privacy
options are the live response from `/v2/post/publish/creator_info/query/`, and clip 3
ends on a **real submission to TikTok's Content Posting API** with its real response.

Deliverables live in `submission/`.

## Status: ✅ ALL 3 CLIPS DELIVERED (2026-08-04)

| # | file | covers requirement | duration | size | status |
|---|---|---|---|---|---|
| 1 | `clip1-oauth-authorization.mp4` | (1) TikTok authorization page | 0:12 | **0.40 MB** | ✅ (v2 re-shoot) |
| 2 | `clip2-post-to-tiktok-flow.mp4` | (2) flow to the Export/Post-to-TikTok page | 1:20 | **3.19 MB** | ✅ |
| 3 | `clip3-after-post-triggered.mp4` | (3) flow after Post-to-TikTok is triggered | 1:40 | **4.58 MB** | ✅ |

All three are 1920×1080 h264 MP4, `+faststart`, **video stream only — no audio track**
(verified with `ffprobe`; captions burned in, no voiceover, per the owner's decision).
Total 8.17 MB; the largest single file is 4.58 MB against a 50 MB per-file cap.

## Clip 1 — user flow of the TikTok authorization page (0:12) ✅ **v2**

**Recorded by the owner in his own browser** after cookie transplant was rejected by TikTok
twice (see the blocked history below). This is the **v2 re-shoot**, taken specifically to
close the app-identity mismatch flagged against v1 — see the verdict below. Source
`submission/clip1-raw-oauth-v2.mov`, 2032×1192 @ ~43 fps with an audio track; letterboxed
into 1920×1080 (aspect preserved, not stretched), audio stripped, captions burned in.

**Captions on this clip are BOTTOM-anchored**, unlike clips 2 and 3 — a top plate would
have covered the browser URL bar, which is the single most valuable thing this clip has.

Verified frame-by-frame (2 fps contact sheet across the whole clip, plus full-resolution
stills at the four moments that carry the requirement):

1. `0:00` creatorpost.app/dashboard in a real Chrome window, **URL bar visible**, header
   chip reads **`cp-tiktok-demo@mattdonders.com`**, body reads **"No accounts connected"**
   with the *Connect an account to get started* empty state
2. `0:02.5` the creator clicks **Connect TikTok**
3. `0:03` URL bar shows `tiktok.com/v2/auth/authorize?client_key=aw6wvd9phoeqxemc&response_type=code&scope=user.info.basic,user.info.profile,user.info.stats,video.upload,video…`
4. `0:04` **TikTok's own consent screen renders in full** (confirmed at full resolution):
   *"CreatorPost wants to access your TikTok account"*, the **`creatorpost_dev` account with
   its avatar** and a *Switch account* link, CreatorPost's app icon, all six requested scopes
   itemised (profile info, extended profile, engagement stats, read public videos, **post
   content to TikTok**, **upload draft content**), the Terms/Privacy line, Cancel / Continue
5. `0:06` the creator presses **Continue**
6. `0:08` back on `creatorpost.app/dashboard` — the header now reads **"1 TikTok connected"**
   and the *Publish To* list contains exactly one account, `creatorpost_dev`. Going from a
   visible **zero-account empty state to one connected account** is stronger on-camera proof
   the authorization really created a connection than v1's 17→18 counter bump.
7. `0:10.5–0:12` the Account page: Email **`cp-tiktok-demo@mattdonders.com`**, and under
   CONNECTED ACCOUNTS → TIKTOK, **"1 account" — `creatorpost_dev` / `@creatorpost_dev`**

There is a ~1 s window (`0:03`–`0:04`) where TikTok's page is still on its loading spinner.
That is TikTok's own load time, it visibly resolves on camera, and the URL bar is readable
throughout it.

### v2 verdict on the identity-mismatch nit: ✅ fully resolved, and it improved the clip

The nit was that v1 was signed into the owner's personal app account ("Faceless Pipeline",
17 connected TikTok accounts incl. getpopculturedaily / hockeygamebot / etc.) while clips 2
and 3 use the demo account. Checked explicitly in v2:

- The header identity chip reads `cp-tiktok-demo@mattdonders.com` in **every** frame, and the
  Account page shows that same address in the Email field.
- **"Faceless Pipeline" appears nowhere**, and **no third-party account names appear
  anywhere** — the connected list is empty at the start and contains only `creatorpost_dev`
  at the end.
- All three clips now show one consistent app user posting to one TikTok account.

Two unplanned bonuses: the empty→one-account transition is better evidence than a counter
bump, and removing the long personal account list means nothing unrelated to this audit is
on screen. **No new issues found.** v1 (`0:15`, 0.77 MB) is superseded and its encode has been
overwritten; the raw v1 capture is retained as `clip1-raw-oauth.mov` for reference only.

### Historical: clip 1 was BLOCKED — TWO cookie exports rejected

**Attempt 2 (fresh incognito export, 19-cookie clean set incl. `sessionid`, `sid_tt`,
`sid_guard`, `uid_tt`) failed identically to attempt 1.** Same 302 from
`/v2/auth/authorize` → `/login`; same logged-out root page; same
`passport/web/account/info/` → `message: "error"`, no user.

Two independent exports, one of them minutes-fresh, both rejected in a different browser
profile. That is no longer consistent with "the session expired" — TikTok is binding these
session cookies to the originating browser/device, so **cookie transplant is not a viable
route to clip 1 and further exports are unlikely to help.** (A contributing factor on
attempt 2: logging in via an incognito window and then closing it can invalidate the
session server-side, so the export may have been dead on arrival.)

**Resolution:** ✅ the owner recorded it directly on 2026-08-04 — see the clip 1 section
above. Cookie transplant is a dead route; do not retry it.

This was strictly better than what automation could have produced anyway: a human recording
shows the **browser URL bar**, which resolves the single biggest weakness of the other two
clips (TikTok asks that the demo domain match the submitted website URL, and Playwright
captures the viewport only). For the authorization clip specifically — the one a reviewer
scrutinises for authenticity — having a visible `tiktok.com` address bar is a real gain.

### Original attempt-1 detail



Attempted exactly the real user flow: dashboard → click **Connect TikTok** → `/auth/tiktok`
→ TikTok. No password used anywhere; cookies only; no workaround attempted.

What happened:
- The cookie file parses cleanly — 33 cookies across all three TikTok domains, `sessionid`
  included, and all 33 verified installed into the Playwright context.
- TikTok **302s `https://www.tiktok.com/v2/auth/authorize?client_key=…` straight to
  `https://www.tiktok.com/login?…&enter_from=dev_<client_key>`**. We land on the login form,
  never on the consent screen.
- Independent confirmation it's the session, not the OAuth page: loading plain
  `https://www.tiktok.com/` with those cookies renders the logged-out shell, and
  `passport/web/account/info/` returns `message: "error"` with no user object.
- Retried headed, with a genuine macOS Chrome UA, `en-US` locale and `America/Phoenix`
  timezone, in case it was headless fingerprint rejection. Identical result — so this is
  expiry/invalidation, not bot detection.

**To unblock:** a fresh cookie export taken immediately after confirming a visibly
logged-in `creatorpost_dev` session in desktop Chrome *on this machine* (TikTok binds these
to device/IP, so an export from a phone or another network likely won't work here).
`record_oauth.js` is written and already proven to reach `/v2/auth/authorize` — clip 1 is a
~40 s recording once a live session exists.

## Clip 2 — user flow to the Post-to-TikTok page (1:20)

1. `0:04` CreatorPost dashboard on creatorpost.app
2. `0:07` the composer — one page for video, caption and destination
3. `0:11` creator selects a video and types a caption
4. `0:17` selecting the TikTok account fires `creator_info/query/`
5. `0:23` the TikTok Direct Post panel appears
6. `0:27` **creator identity** — nickname `creatorpost_dev` + avatar, live from `creator_info`
7. `0:32` **privacy dropdown, no default** — options expanded inline so all four are legible;
   they come from `creator_info.privacy_level_options`
8. `0:41` **interaction settings all OFF** — Comment, Duet, Stitch unchecked by default
   *(asserted in the recording script, not just eyeballed)*
9. `0:47` the creator manually turns them on, and off again
10. `0:55` commercial-disclosure toggle, off by default
11. `1:00` Music Usage Confirmation shown and linked
12. `1:07` in-app video preview, played
13. `1:14` ready to post — publishing is the creator's explicit action

## Clip 3 — user flow after Post-to-TikTok is triggered (1:40)

Structured around every press of Publish and its consequence:

1. `0:04` setup repeated from clip 2, privacy set to *Only me*
2. `0:20` disclosure ON — "Your brand" / "Branded content" appear, neither selected
3. `0:28` **Post triggered (1 of 3)** → **blocked**:
   *"You need to indicate if your content promotes yourself, a third party, or both."*
   shown inline **and** beneath the Publish button — the exact Point 3a string TikTok
   support named in the last rejection
4. `0:38` "Your brand" → labelled *'Promotional content'*, error clears
5. `0:44` "Branded content" → labelled *'Paid partnership'*, Branded Content Policy cited
6. `0:50` **enforced rule** — branded content cannot be private: *Only Me* is cleared and
   greyed out (`option.disabled === true`, asserted)
7. `0:57` disclosure switched back off for a plain private test post
8. `1:04` **Post triggered (2 of 3)** → **blocked**:
   *"Please confirm you want to publish this content to TikTok before posting."*
9. `1:13` creator explicitly confirms this specific post
10. `1:19` **Post triggered (3 of 3)** → real submission to the Content Posting API
11. `1:26` **real API result**: *"Uploaded to creatorpost_dev ✓ (check TikTok Drafts — it may
    take a few minutes to process)"* — the draft/inbox result, because Direct Post is not yet
    approved for this client
12. `1:32` the post is tracked in the app with its processing status and a recheck control

## The interaction-toggle fix (the bug the prior run found)

**Commit `d76af6a`** — branch `creatorpost-fix3`, fast-forward merged to `main` and pushed to
origin (matching how `31edad1` / `1a02b89` were handled).

TikTok's Content Sharing Guidelines: *"Users must manually turn on these interaction settings
and none should be checked by default."* CreatorPost shipped `checked` on all three.

- `public/dashboard.html` — dropped the `checked` attribute from `#tiktok-allow-comment`,
  `#tiktok-allow-duet`, `#tiktok-allow-stitch` (~L692–706), and stopped `resetForm()`
  re-checking them (was `el.checked = true`, now `false`, ~L1811).
- `docs/tiktok-direct-post-demo-video.md` Point 2 asserted the opposite of the guideline
  ("Default ON") — rewritten to default-OFF/explicit-opt-in, with the guideline quoted and the
  disabled/greyed-out requirement noted.

**Verified unchecked-by-default**, three independent ways:
1. `curl` of the live `creatorpost.app/dashboard` HTML shows the attribute gone.
2. The clip-2 recording script asserts `{comment: False, duet: False, stitch: False}` at
   runtime and would have aborted otherwise.
3. Visible on camera at clip 2 `0:41` — all three switches drawn in the off position.

## Content Sharing Guidelines re-review (fetched fresh, not inherited from the prior run)

Checked every requirement in the doc against the current app, not just the prior agent's list:

| requirement | state |
|---|---|
| Display creator nickname on the upload page | ✅ nickname + avatar from `creator_info` |
| Re-query `creator_info` when rendering the post page | ✅ on account selection |
| Privacy: no default, options from `privacy_level_options` | ✅ |
| Branded content cannot be private | ✅ `SELF_ONLY` cleared + disabled |
| Interaction settings: none pre-checked | ✅ **fixed this round (`d76af6a`)** |
| Interactions disabled in creator's app settings → disable + grey out the checkbox | ✅ already implemented (`dashboard.html` L1150-1155) — **not exercised on camera**, see risks |
| Commercial disclosure toggle defaults off | ✅ |
| "Your Brand" → 'Promotional content' prompt | ✅ |
| "Branded Content" → 'Paid partnership' prompt | ✅ |
| At least one option required when disclosure is on | ✅ this is the Point 3a error |
| Music Usage Confirmation declaration | ✅ shown and linked |
| Branded Content Policy added to the declaration when branded content is selected | ✅ |
| Notify that publishing takes a few minutes to process | ✅ already implemented, and it is the on-screen result at clip 3 `1:26` |
| Poll status API / handle webhooks | ✅ app polls and offers a manual recheck |

Nothing new was found beyond the toggle default. The two items the prior run had not
flagged — the grey-out rule and the processing notice — were both already correct.

## FINAL combined go / no-go — all three clips (2026-08-04)

# ✅ GO. Submit.

Every numbered requirement in TikTok's brief is covered by a delivered file, all three are
well under the size cap, and the specific defect that caused the last rejection is on camera
verbatim. Requirement coverage:

| brief requirement | clip | evidence |
|---|---|---|
| 1) User flow of TikTok authorization page | 1 | real `tiktok.com/v2/auth/authorize` consent screen, `creatorpost_dev` named + avatar, all six scopes, Continue pressed, redirect back, connected accounts 0→1 |
| 2) User flow to the Export/Post-to-TikTok page | 2 | composer → account select → `creator_info/query/` → full Direct Post panel |
| 3) User flow after the action is triggered | 3 | three Publish presses: two distinct enforced blocks, then a real Content Posting API submission and its real response |
| 4) Content Sharing Guidelines UX requirements | all | table above — every requirement checked against the live app; the one violation found was fixed (`d76af6a`) and is visible in clip 2 |

Honest read on strengths and weaknesses:

- **The thing that got us rejected last time is now unambiguous.** Point 3a is on camera in
  clip 3 at `0:28`, verbatim, in two places on screen, with the block, the fix and the clear.
  That is the strongest part of the submission.
- **The one real UX violation we were still shipping is fixed and visible.** Had we submitted
  the prior recording, a careful reviewer would have seen three pre-checked interaction
  toggles and could have rejected on that alone.
- **Clip 1 closes the browser-chrome gap where it mattered most.** The clip a reviewer
  scrutinises for authenticity is the one with a live URL bar, showing both `creatorpost.app`
  and the real `tiktok.com` authorize URL with our `client_key`.
- **Residual risks, stated plainly:**
  - ~~*The three clips are signed into two different CreatorPost accounts.*~~
    ✅ **RESOLVED 2026-08-04** by the clip 1 v2 re-shoot — all three clips are now signed into
    `cp-tiktok-demo@mattdonders.com` and show only `creatorpost_dev`.
  - *Clips 2 and 3 have no browser chrome.* Playwright captures the viewport only, so their
    domain is a burned-in caption rather than a visible URL bar. Mitigated, not eliminated, by
    clip 1 establishing the domain on camera.
  - *A ~1 s TikTok loading spinner in clip 1* before the consent screen paints. Self-resolving
    and visibly so; noted only for completeness.
  - *The grey-out rule is implemented but never demonstrated*, because `creatorpost_dev` has
    no interaction disabled in its account settings. Nothing to do about it without a second
    test account, and it's a minor point.
  - *The result is a draft, not a live post.* Clip 3 ends on the inbox/draft result because
    Direct Post isn't approved yet — necessarily circular, and normal for this stage, but a
    reviewer never sees a post land on the profile.
  - *Native `<select>` popups are OS-drawn and uncapturable*, so the privacy option list is
    expanded inline instead of shown as a real dropdown.

## Files

| file | what |
|---|---|
| `submission/clip1-oauth-authorization.mp4` | deliverable — requirement 1 |
| `submission/clip1-raw-oauth-v2.mov` | the owner's untouched screen recording — **source for the shipped clip 1** |
| `submission/clip1-raw-oauth.mov` | superseded v1 raw capture (owner's personal app account); kept for reference, not shipped |
| `submission/clip2-post-to-tiktok-flow.mp4` | deliverable — requirement 2 |
| `submission/clip3-after-post-triggered.mp4` | deliverable — requirement 3 |
| `record_clip2.py` / `record_clip3.py` | Playwright drivers (with compliance assertions) |
| `cp_common.py` | shared setup/interaction helpers |
| `record_oauth.js` | abandoned clip 1 automation driver — TikTok rejects transplanted cookies, superseded by the owner's own recording |
| `cookies.js` | Cookie-Editor → Playwright cookie transform (never prints values) |
| `probe_oauth.js` / `probe_session.js` | the diagnostics that proved the cookies are dead |
| `caption_lib.py` / `caption_clips.py` | caption plates + ffmpeg burn-in |
| `beats_clip2.json` / `beats_clip3.json` | beat timings, live API responses, final status |
| `raw_clip2/` `raw_clip3/` | untouched Playwright captures (no captions) |
| `verify/` | verification stills pulled from the finished MP4s |

Superseded by this file: `NOTES.md` (single-video plan; its timeline describes the discarded
first take `record.js`, not the delivered video).
