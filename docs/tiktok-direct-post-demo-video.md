# TikTok Direct Post API — Demo Video Script

**Purpose:** Demonstrate UX compliance with TikTok's Content Posting API guidelines
**Audience:** TikTok API review team
**Format:** Screen recording with narration (or clear on-screen captions)
**Length:** ~2–3 minutes — don't rush, let each step breathe

---

## Before You Record

- Use **desktop Chrome** — full screen, clean browser (hide bookmarks bar)
- Navigate to **creatorpost.app** and log in as a real account (not pipeline@)
- Have a short test video ready to select (doesn't need to post for real)
- Make sure all 4 TikTok accounts are connected so the UI looks populated
- Record at **1080p or higher**
- Speak clearly or use large on-screen text callouts for each point

---

## The 5 Points — In Order

TikTok's guidelines require these 5 items to be shown **sequentially**. Do not skip ahead or combine steps.

---

### Point 1 — Creator Info Query (Privacy Options)

**What to show:** The app calls `/v2/post/publish/creator_info/query/` before posting and uses the returned privacy settings to populate the privacy dropdown.

**On screen:**
1. Select a TikTok account in the account selector
2. Watch the privacy dropdown populate (or click into it)
3. Show the available privacy options (Public, Friends, Private — whatever TikTok returns for that account)

**Script:**
> "Before any post is submitted, CreatorPost calls TikTok's creator info endpoint to fetch the allowed privacy levels for this specific account. The privacy dropdown is dynamically populated from that API response — we never hardcode options."

---

### Point 2 — Comment, Duet & Stitch Toggles (Default ON)

**What to show:** All three interaction toggles are visible and **defaulted to ON** when the form loads. Then demonstrate that the user can turn them off.

**On screen:**
1. Scroll to the TikTok Settings panel (it expands when TikTok is selected)
2. Pause on the three toggles — Comment, Duet, Stitch — all checked/on
3. Click one toggle OFF, then back ON
4. Narrate that these default to enabled per TikTok's guidelines

**Script:**
> "The Comment, Duet, and Stitch interaction settings are shown to the user and default to enabled, as required by TikTok's guidelines. Users can turn any of these off before posting, but the default is always on."

---

### Point 3 — Commercial Disclosure (THE KEY ONE — spend the most time here)

**What to show:** The full disclosure interaction including: the toggle, both sub-options, the **validation error when nothing is selected**, and then a successful selection. TikTok support specifically called out Point 3a — you must show the error state.

**On screen:**
1. Scroll to the **Disclosure** toggle — show it in the OFF state
2. **Click it ON** — pause 2 seconds so the reviewer sees it activate
3. Show the two sub-options appear: **"Your Brand"** and **"Branded Content"** — both unchecked
4. **Click the Post button without selecting either checkbox** — this is the new required step
5. The inline error appears in red directly under the checkboxes: *"You need to indicate if your content promotes yourself, a third party, or both."* — **pause here, let it sit on screen for 3+ seconds**
6. Now click **"Your Brand"** — show the error message disappear
7. Narrate what "Your Brand" means
8. Uncheck "Your Brand", check **"Branded Content"** — narrate what it means
9. Leave "Branded Content" checked before moving on

**Script:**
> "CreatorPost includes the required Content Disclosure setting. When a user enables disclosure, two options appear: 'Your Brand' — for content that promotes your own business or personal brand — and 'Branded Content' — for paid partnerships where you received compensation to promote a third party."

> *(After clicking Post with nothing selected and the error appears):* "If the user tries to post without selecting an option, the app blocks submission and displays the required notification: 'You need to indicate if your content promotes yourself, a third party, or both.' The post cannot proceed until a selection is made."

> *(After selecting "Your Brand" and the error clears):* "Once a selection is made the validation clears and the user can continue. TikTok's promotional content policy is linked directly in this panel."

---

### Point 4 — Music Usage Consent Text

**What to show:** The consent text referencing TikTok's Music Usage Confirmation page is visible in the UI.

**On screen:**
1. Point to / highlight the music consent text below the disclosure section
2. Show that it contains a clickable link to TikTok's Music Usage Confirmation page
3. Click the link so the reviewer can see it goes to the correct TikTok URL

**Script:**
> "The posting form includes TikTok's required music usage consent language, with a direct link to TikTok's Music Usage Confirmation page. This is displayed to every user before they submit a post."

---

### Point 5 — Video Preview Before Posting

**What to show:** The user can preview their video in the app before it's submitted to TikTok.

**On screen:**
1. Drop a video file into the upload area (or select one)
2. Show the video preview rendering in the player
3. Play it briefly so it's clear it's a real preview, not a thumbnail
4. Then show the Post button — still available but only after preview loads

**Script:**
> "Before a user can post, a full video preview is shown directly in the app. The video plays in context so creators can review their content before it's submitted to TikTok. The post action is only available after the video has loaded and can be previewed."

---

## Closing Shot

Pan back to show the full posting form with all elements visible:
- Account selector
- Caption field
- Privacy dropdown (populated)
- Interaction toggles (Comment, Duet, Stitch)
- Disclosure toggle + sub-options
- Music consent text
- Video preview
- Post button

**Script:**
> "All five required UX elements from TikTok's Content Posting API guidelines are present in CreatorPost's posting flow: creator info query for privacy options, interaction toggles defaulting to on, commercial content disclosure with both sub-options, music usage consent, and video preview. Thank you for reviewing."

---

## Recording Tips

- **Pause 2–3 seconds** on each element before moving on — reviewers watch at 1x speed
- **Zoom in** on toggles and dropdowns when interacting with them — small UI elements are hard to see
- Use **on-screen text callouts** (like "Point 3: Content Disclosure") if not narrating
- Don't let the recording exceed **3 minutes** — keep it tight
- Export as **MP4, 1080p minimum**

---

## Submission Strategy

This is the **third submission**. In the notes field, reference the support ticket response directly:

> *"Previous rejection and subsequent support ticket identified Point 3a specifically — the validation message when Content Disclosure is enabled but no option is selected. This has been implemented. The demo video shows: (1) disclosure toggled on with no selection, (2) post attempted, (3) required error message displayed — 'You need to indicate if your content promotes yourself, a third party, or both.' — (4) selection made, error clears, post proceeds. All 5 points are demonstrated in order."*

**If rejected again after this**, open a support ticket immediately and escalate:
- Attach the support email where they specified Point 3a
- Include a timestamp in the video showing exactly when the error message appears
- State that the exact required string from their own guidelines is now implemented verbatim
- Ask to be escalated to a senior reviewer
