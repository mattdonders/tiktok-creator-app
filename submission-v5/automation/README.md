# Audit-content capture automation

Deterministic Playwright + ffmpeg tooling for producing fresh desktop-flow
recordings for product review/demo artifacts. This is **audit-production
infrastructure, not product architecture** — it lives outside `functions/`
and `public/`, has no runtime dependency on CreatorPost, and is not deployed.

## Layout

```
lib/                          generic, reusable — no product knowledge
  browser.js                  persistent-profile launch, interactive-login wait, assertState()
  ffmpeg.js                   normalize raw capture → mp4, extract stills, ffprobe
scenarios/
  creatorpost-tiktok-audit/   CreatorPost/TikTok-specific — selectors, copy, beats
    config.js                 URLs, expected identities, file paths
    login-creatorpost.js      one-time interactive magic-link login
    login-tiktok.js           one-time interactive TikTok web login
    record-desktop-flow.js    the actual beat-by-beat driver + assertions
```

`lib/` has zero knowledge of CreatorPost, TikTok, or this audit — it only
knows "launch a persistent browser profile," "wait for a human to finish
logging in," "assert a condition or fail loudly," and "normalize/verify a
video capture." To reuse this for another project (e.g. a Puck Passport/HGB
demo), copy `lib/` as-is and write a new `scenarios/<name>/` directory with
that project's URLs, selectors, and beats.

## Why a persistent profile instead of cookie transplant

TikTok has previously rejected transplanted session cookies outright (see
`docs/submission-videos/SUBMISSION-NOTES.md`). Instead, the owner logs in
**once**, interactively, in a real headed browser window tied to a
persistent Chromium profile on disk (`.browser-profile/`, gitignored). Every
later run reuses that same profile and its real session — no credentials
ever pass through a script, a config file, or chat.

## Usage

```bash
npm install                 # once
npx playwright install chromium   # once, if not already cached

npm run login:creatorpost   # opens a browser — click your magic link, then it closes itself
npm run login:tiktok        # opens a browser — log into TikTok web, then it closes itself

npm run record:dry          # full walkthrough, all assertions, stops before Publish
npm run record               # same, but performs the real submission
```

Output lands in `out/` (gitignored): raw Playwright `.webm` captures under
`out/raw/`, the normalized `out/fresh-desktop-flow.mp4`, and verification
stills under `out/stills/`.

## Scope

This scenario automates the **post-OAuth** flow only (connected state →
stats → sync → composer → submit → TikTok-web receipt). OAuth itself is not
automated — TikTok's consent screen is reused from the existing, real
`docs/submission-videos/clip1-oauth-authorization.mp4`, and the final iOS
completion is recorded manually by the owner (no iOS automation exists).
