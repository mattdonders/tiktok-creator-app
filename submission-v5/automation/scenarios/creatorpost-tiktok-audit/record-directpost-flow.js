// Fresh Direct Post capture for the TikTok audit RE-submission (v7).
//
// Why this exists alongside record-desktop-flow.js: that script recorded the
// v6 cut, whose submission landed in /api/publish's silent Upload/Inbox
// fallback and was therefore completed inside the native TikTok app. TikTok
// rejected v6 for demonstrating Upload rather than Direct Post. Direct Post
// has since been confirmed working for this client while @creatorpost_dev is
// Private and the post privacy is Only Me / SELF_ONLY.
//
// This script drives the same, already-accepted compliance beats, then ends
// on a REAL Direct Post: "Posted to creatorpost_dev ✓" → Processing →
// Published → the same post on TikTok web's profile grid with TikTok's own
// lock badge → the post opened, showing 🔒 Private. It touches NO Inbox,
// notification panel, draft, or native-app step, and it ABORTS rather than
// record anything if the publish falls back to the Upload path.
//
// OAuth is not automated here — the accepted fresh-oauth-flow.mp4 is reused.
//
// Usage:
//   node record-directpost-flow.js --dry-run   (stops before the real Publish)
//   node record-directpost-flow.js             (performs the real submission)
//
// Requires a persistent profile already logged in to CreatorPost AND carrying
// a valid TikTok web session — this script asserts identity, never authenticates.
'use strict';

const { launchProfile, assertState, closeContext } = require('../../lib/browser');
const { normalizeToMp4, extractStill, probe } = require('../../lib/ffmpeg');
const cfg = require('./config');
const path = require('path');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');

// Distinctive substring of cfg.AUDIT_CAPTION — how we prove the post that
// shows up on TikTok web is the one this run just published, rather than any
// earlier post on the account.
const CAPTION_PROOF = 'CreatorPost review demo';
let video = null; // set inside main(); read by the .then() handler after context close

// Reviewer-comprehension dwell times (ms) — deliberately generous. Optimize
// for a human reading the screen, not for the shortest possible capture.
const DWELL = {
  identity: 4000,
  syncResult: 6000,
  panelOpen: 3000,
  privacyBlankState: 3500,
  privacyOptions: 2500,
  interactionToggles: 4000,
  disclosure: 3000,
  musicConsent: 3000,
  preview: 4000,
  toggleDemo: 1200,
  disclosureOptsOpen: 2500,
  disclosureValidationError: 3000,
  brandLabel: 3000,
  brandedContentLabel: 3500,
  brandedPrivacyRestriction: 3000,
  disclosureOff: 2000,
  privacySelected: 2500,
  confirmValidationError: 3000,
  postConfirm: 2500,
  uploadResult: 8000,
  processingStatus: 4000,
  recheckStatus: 4000,
  tiktokWebArrive: 3000,
  publishedStatus: 6000,
  gridLock: 6000,
  postDetail: 10000,
};

// Item 7 (unaudited Direct Post semantics): unaudited Direct Post clients are
// restricted to private/SELF_ONLY-like visibility by TikTok. CreatorPost must
// not select Public merely to make the demo look stronger, so the automation
// always picks the MOST RESTRICTIVE privacy option actually offered by
// creator_info for this account, never the first/loosest one. `excludeValue`
// lets the caller rule out a value that's currently disabled in the DOM
// (e.g. SELF_ONLY while Branded Content is selected).
async function pickMostRestrictivePrivacy(page, excludeValue) {
  const RESTRICTIVENESS_ORDER = ['SELF_ONLY', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE'];
  const values = await page.locator('#tiktok-privacy option:not([disabled])').evaluateAll(
    (opts) => opts.map((o) => o.value).filter(Boolean)
  );
  const candidates = values.filter((v) => v !== excludeValue);
  const pick = RESTRICTIVENESS_ORDER.find((v) => candidates.includes(v)) || candidates[0];
  if (pick) await page.selectOption('#tiktok-privacy', pick);
  return pick;
}

async function main() {
  console.log(`\n=== CreatorPost fresh DIRECT POST capture (${DRY_RUN ? 'DRY RUN' : 'REAL SUBMISSION'}) ===\n`);

  if (!fs.existsSync(cfg.AUDIT_VIDEO_PATH)) {
    throw new Error(`Audit asset not found: ${cfg.AUDIT_VIDEO_PATH}`);
  }

  const runVideoDir = path.join(cfg.RAW_VIDEO_DIR, DRY_RUN ? 'directpost-dry-run' : 'directpost-final');
  fs.mkdirSync(runVideoDir, { recursive: true });

  const context = await launchProfile({
    profileDir: cfg.PROFILE_DIR,
    headless: false,
    recordVideoDir: runVideoDir,
  });

  // Force CreatorPost light mode on every page load in this context, for
  // visual continuity with the reused (light-mode) historical OAuth clip.
  // Demo continuity/polish only — not a product requirement, so this sets
  // localStorage rather than touching product code.
  await context.addInitScript(() => {
    try { localStorage.setItem('creatorpost-theme', 'light'); } catch (e) {}
  });

  const page = context.pages()[0] ?? await context.newPage();
  video = page.video();

  try {
    // 1. Connected CreatorPost state
    await page.goto(cfg.DASHBOARD_URL, { waitUntil: 'networkidle' });
    await assertState('CreatorPost light mode forced', async () => {
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      return theme === 'light';
    });
    await assertState('signed in as expected CreatorPost account', async () => {
      const text = await page.locator('#nav-account a[href="/account"]').innerText();
      return text.trim() === cfg.EXPECTED_CREATORPOST_EMAIL;
    });
    await assertState('at least one TikTok account connected', async () => {
      const label = await page.locator('#accounts-bar-label').innerText();
      return /tiktok/i.test(label) && !/no accounts connected/i.test(label);
    });
    await page.waitForTimeout(DWELL.identity); // reviewer: read connected identity

    // 2-3. Sync Posts — this single backend call drives BOTH user.info.stats
    // (follower_count) and video.list (imported/skipped) together. Note: the
    // account page's .acct-row follower badge can NEVER show this — /api/me's
    // SELECT (functions/[[route]].js) omits follower_count entirely, so the
    // DB write from sync is never re-read into the page. The one-time sync
    // status message (#status-msg) is the only real UI surface for
    // user.info.stats + video.list right now — that's what we assert on and
    // hold on screen, truthfully. Zero followers / zero posts, if that's what
    // the real account returns, is a real result — never fabricated.
    await page.goto(cfg.ACCOUNT_URL, { waitUntil: 'networkidle' });
    const syncBtn = page.locator('button[id^="sync-btn-"]').first();
    await assertState('Sync Posts button present', async () => await syncBtn.isVisible().catch(() => false));
    await syncBtn.click();
    await page.waitForTimeout(3000);
    await assertState('Sync Posts completed with follower + video data (user.info.stats + video.list)', async () => {
      const text = await page.locator('#status-msg').innerText().catch(() => '');
      return /synced/i.test(text) && /followers/i.test(text);
    });
    await page.waitForTimeout(DWELL.syncResult); // reviewer: read the real sync result (stats + video.list)

    // 4. Return to post composer
    await page.goto(cfg.DASHBOARD_URL, { waitUntil: 'networkidle' });

    // 5. Select the NEW final audit asset
    await page.setInputFiles('#video-input', cfg.AUDIT_VIDEO_PATH);
    await assertState('expected audit asset selected', async () => {
      const fname = await page.locator('#preview-filename').innerText().catch(() => '');
      return fname.includes(path.basename(cfg.AUDIT_VIDEO_PATH));
    });

    // Brief video preview playback — do this now, right after upload, while
    // we're still at the top of the page. The TikTok panel below (account
    // select through disclosure demo) is a one-way scroll down from here;
    // playing the preview first means we never have to scroll back up past
    // the toggles to get to it.
    await page.locator('#video-preview').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.getElementById('video-preview')?.play().catch(() => {}));
    await page.waitForTimeout(DWELL.preview);
    await page.evaluate(() => document.getElementById('video-preview')?.pause());

    // 6. Enter the final audit caption
    await page.fill('#caption', cfg.AUDIT_CAPTION);

    // 7. Select creatorpost_dev
    const tiktokCheckbox = page.locator('.acct-cb[data-platform="tiktok"]').first();
    await assertState('TikTok account checkbox present', async () => await tiktokCheckbox.isVisible());
    await tiktokCheckbox.check();

    // 8. Wait for creator_info-backed TikTok UI
    await assertState('TikTok panel opened', async () => {
      await page.locator('#tiktok-panel').waitFor({ state: 'visible', timeout: 15000 });
      return true;
    });
    await assertState('no creator_info load error', async () => {
      return !(await page.locator('#tiktok-info-error').isVisible().catch(() => false));
    });
    await page.waitForTimeout(DWELL.panelOpen); // reviewer: see the creator_info-backed panel appear

    // ─── Content Sharing UX evidence (PM matrix, Aug-4-parity requirements) ───
    // Item 1/2: creator nickname/avatar rendered live from creator_info for
    // the selected TikTok account.
    await assertState('creator identity visible (creator_info)', async () => {
      await page.locator('#tiktok-creator-identity').waitFor({ state: 'visible', timeout: 10000 });
      const name = await page.locator('#tiktok-creator-name').innerText();
      return name.toLowerCase().includes(cfg.EXPECTED_TIKTOK_HANDLE);
    });

    // Item 3: no privacy level preselected; options come from TikTok's live
    // privacy_level_options (never hardcoded — see dashboard.html:1146).
    await assertState('no privacy level preselected', async () => {
      return (await page.locator('#tiktok-privacy').inputValue()) === '';
    });
    await page.waitForTimeout(DWELL.privacyBlankState); // reviewer: dwell on the initial blank privacy state before it's touched
    await assertState('privacy options loaded live from creator_info', async () => {
      const count = await page.locator('#tiktok-privacy option').count();
      return count > 0;
    });
    await page.waitForTimeout(DWELL.privacyOptions); // reviewer: read the live creator_info-driven privacy list

    // Select the truthful final privacy level now — needed so the later
    // disclosure-choice validation attempt (item 6) fails for the reason
    // we're demonstrating (missing brand choice), not for missing privacy.
    // Item 7 / PM final decision: CreatorPost is still an unaudited Direct
    // Post client, so the real submission must use Only Me/SELF_ONLY, never
    // Public — pickMostRestrictivePrivacy already orders SELF_ONLY first,
    // but we assert the literal value here rather than just "non-empty" so
    // this requirement can't silently regress if creator_info's option list
    // ever changes shape.
    await pickMostRestrictivePrivacy(page, null);
    await assertState('final privacy level is Only Me / SELF_ONLY (unaudited Direct Post restriction)', async () => {
      return (await page.locator('#tiktok-privacy').inputValue()) === 'SELF_ONLY';
    });
    await page.waitForTimeout(DWELL.privacySelected); // reviewer: read the explicit privacy selection

    // Item 4: Comment/Duet/Stitch default OFF, then visibly demonstrate
    // manual creator opt-in by turning each on, then back off. These are
    // checkbox-hack toggle switches (dashboard.html:210 — the real <input>
    // is opacity:0/0x0, the visible+clickable control is the sibling
    // .toggle-slider), so we click the slider, not the input directly.
    await assertState('Comment/Duet/Stitch default OFF', async () => {
      const comment = await page.locator('#tiktok-allow-comment').isChecked();
      const duet    = await page.locator('#tiktok-allow-duet').isChecked();
      const stitch  = await page.locator('#tiktok-allow-stitch').isChecked();
      return !comment && !duet && !stitch;
    });
    await page.waitForTimeout(DWELL.interactionToggles); // reviewer: read all three toggles OFF

    // Interactions the creator has turned off in their own TikTok settings come
    // back *_disabled from creator_info and CANNOT be opted into — @creatorpost_dev
    // is Private, so TikTok reports duet_disabled/stitch_disabled true. Demo the
    // manual opt-in only on the ones TikTok actually allows, and assert the rest
    // render as unavailable (TikTok Content Sharing Guidelines item 14) rather
    // than as ordinary off switches.
    const unavailable = [];
    for (const id of ['tiktok-allow-comment', 'tiktok-allow-duet', 'tiktok-allow-stitch']) {
      if (await page.locator(`#${id}`).isDisabled()) { unavailable.push(id); continue; }
      const slider = page.locator(`#${id} ~ .toggle-slider`);
      await slider.click();
      await page.waitForTimeout(DWELL.toggleDemo);
      await slider.click();
    }
    console.log(`  Interactions disabled by TikTok for this creator: ${unavailable.join(', ') || '(none)'}`);
    if (unavailable.length) {
      await assertState('TikTok-disabled interactions render as unavailable, with a reason', async () => {
        for (const id of unavailable) {
          const row = page.locator(`#${id}`).locator('xpath=ancestor::div[contains(@class,"tt-toggle-row")][1]');
          const greyed = await row.evaluate((el) => el.classList.contains('tt-toggle-unavailable'));
          const note   = await row.locator('.tt-toggle-note').innerText().catch(() => '');
          if (!greyed || !/turned off in your tiktok account settings/i.test(note)) return false;
        }
        return true;
      });
      await page.waitForTimeout(DWELL.interactionToggles); // reviewer: read the unavailable interactions + reason
    }
    await assertState('interaction toggles reset OFF after opt-in demo', async () => {
      const comment = await page.locator('#tiktok-allow-comment').isChecked();
      const duet    = await page.locator('#tiktok-allow-duet').isChecked();
      const stitch  = await page.locator('#tiktok-allow-stitch').isChecked();
      return !comment && !duet && !stitch;
    });


    // Item 5: commercial-content disclosure default OFF.
    await assertState('commercial disclosure default OFF', async () => {
      return !(await page.locator('#tiktok-disclosure-toggle').isChecked());
    });
    await page.waitForTimeout(DWELL.disclosure); // reviewer: read disclosure OFF

    // Item 10: Music Usage Confirmation declaration/link, in its base
    // (non-branded) state.
    await assertState('Music Usage Confirmation link visible', async () => {
      return await page.locator('#tiktok-consent-text a', { hasText: /music usage/i }).isVisible().catch(() => false);
    });
    await page.waitForTimeout(DWELL.musicConsent); // reviewer: read the Music Usage Confirmation link

    // Item 5 (cont.): turn disclosure ON, reveal Your Brand / Branded
    // Content choices.
    await page.locator('#tiktok-disclosure-toggle ~ .toggle-slider').click();
    await assertState('disclosure options revealed', async () => {
      return await page.locator('#disclosure-opts').isVisible();
    });
    await page.waitForTimeout(DWELL.disclosureOptsOpen); // reviewer: read Your Brand / Branded Content options

    // The disclosure-opts panel expanding grows the page past the fixed
    // recording viewport, pushing #submit-btn out of frame even though the
    // DOM-level assertions below (isDisabled/isVisible) don't check scroll
    // position and pass regardless. Scroll it into view now so the disabled
    // button + its guidance are actually visible in the recorded video for
    // the whole disclosure demo — subsequent .check()/.uncheck() calls on
    // the nearby checkboxes won't re-scroll since they're already in view
    // from this position.
    await page.locator('#submit-btn').scrollIntoViewIfNeeded();

    // Item 2 (PM correction, replaces the old "SELF_ONLY option disabled
    // while Branded Content selected" pattern): privacy is still Only Me at
    // this point (selected earlier), so the compliant single behavior is to
    // disable the "Branded content" checkbox itself with a visible
    // explanation — the incompatible combination is never entered, so there
    // is no accept-then-reject error path.
    await assertState('Branded content checkbox disabled while privacy is Only Me', async () => {
      return await page.locator('#tiktok-brand-content').isDisabled();
    });
    await assertState('visible explanation shown for the Branded content restriction', async () => {
      return await page.locator('#tiktok-privacy-restriction-note').isVisible().catch(() => false);
    });
    await page.waitForTimeout(DWELL.brandedPrivacyRestriction); // reviewer: see Branded content disabled + the visible explanation

    // Item 6: with disclosure ON and neither choice selected, Publish is
    // proactively DISABLED (dashboard.html updateSubmitBtn()/
    // disclosureNeedsBrandChoice()) with explanatory guidance visible —
    // not merely rejected after a click. We assert the disabled+guidance
    // state directly rather than clicking, since a disabled button can't
    // be clicked.
    await assertState('Publish disabled + guidance shown (disclosure ON, no brand choice)', async () => {
      const disabled = await page.locator('#submit-btn').isDisabled();
      const visible  = await page.locator('#disclosure-validation').isVisible().catch(() => false);
      return disabled && visible;
    });
    await assertState('disabled Publish button carries an explanatory hover title', async () => {
      const title = await page.locator('#submit-btn').getAttribute('title');
      return !!title && title.length > 0;
    });
    await page.waitForTimeout(DWELL.disclosureValidationError); // reviewer: read the blocking guidance

    // Item 7: select Your Brand, show Promotional content labeling, and
    // confirm Publish re-enables once a brand choice is made.
    await page.locator('#tiktok-brand-organic').check();
    await assertState('"Your brand" labeled as Promotional content', async () => {
      const text = await page.locator('#disclosure-label').innerText().catch(() => '');
      return /promotional content/i.test(text);
    });
    await assertState('Publish re-enabled once a brand choice is made', async () => {
      return !(await page.locator('#submit-btn').isDisabled());
    });
    await page.waitForTimeout(DWELL.brandLabel); // reviewer: read the Promotional content label

    // Item 8: switch to Branded Content, show Paid partnership labeling and
    // reference to the Branded Content Policy. Branded Content requires a
    // non-private privacy level (Item 2 above), so temporarily move off
    // Only Me to demonstrate it — the truthful Only Me choice is restored
    // before the real submission (Item 11/re-confirm below).
    await page.locator('#tiktok-brand-organic').uncheck();
    await pickMostRestrictivePrivacy(page, 'SELF_ONLY');
    await assertState('privacy temporarily switched off Only Me to demo Branded Content', async () => {
      const value = await page.locator('#tiktok-privacy').inputValue();
      return value !== '' && value !== 'SELF_ONLY';
    });
    await assertState('Branded content checkbox enabled once privacy is not Only Me', async () => {
      return !(await page.locator('#tiktok-brand-content').isDisabled());
    });
    await page.waitForTimeout(DWELL.privacySelected); // reviewer: read the temporary privacy switch
    await page.locator('#tiktok-brand-content').check();
    await page.locator('#submit-btn').scrollIntoViewIfNeeded(); // keep it in frame after the checkbox interactions above
    await assertState('"Branded content" labeled as Paid partnership', async () => {
      const text = await page.locator('#disclosure-label').innerText().catch(() => '');
      return /paid partnership/i.test(text);
    });
    await assertState('Branded Content Policy referenced in consent text', async () => {
      return await page.locator('#tiktok-consent-text a', { hasText: /branded content policy/i }).isVisible().catch(() => false);
    });
    await assertState('Music Usage Confirmation still referenced alongside Branded Content Policy', async () => {
      return await page.locator('#tiktok-consent-text a', { hasText: /music usage/i }).isVisible().catch(() => false);
    });
    await page.waitForTimeout(DWELL.brandedContentLabel); // reviewer: read Paid partnership label + policy link

    // Item 9 (cont.): "Your brand" and "Branded content" are independent
    // checkboxes and can both be checked at once (self-promotion AND a paid
    // partnership in the same post) — confirm that combined state gets its
    // own label plus the combined policy declaration, not just the Branded
    // Content-only text.
    await page.locator('#tiktok-brand-organic').check();
    await page.locator('#submit-btn').scrollIntoViewIfNeeded(); // keep it in frame after the checkbox interaction above
    await assertState('both-selected state labeled as combined disclosure', async () => {
      const text = await page.locator('#disclosure-label').innerText().catch(() => '');
      return /promotional content and paid partnership/i.test(text);
    });
    await assertState('combined policy declaration shown (Branded Content Policy + Music Usage Confirmation)', async () => {
      const text = await page.locator('#tiktok-consent-text').innerText().catch(() => '');
      return /branded content policy/i.test(text) && /music usage/i.test(text);
    });
    await page.waitForTimeout(DWELL.brandedContentLabel); // reviewer: read the combined label + combined policy declaration
    await page.locator('#tiktok-brand-organic').uncheck();

    // Item 11: the audit content is genuinely non-commercial — return
    // disclosure OFF before the actual submission. Uncheck Branded Content
    // first so the SELF_ONLY restriction and label clear cleanly.
    await page.locator('#tiktok-brand-content').uncheck();
    await page.locator('#tiktok-disclosure-toggle ~ .toggle-slider').click();
    await assertState('disclosure returned OFF before real submission', async () => {
      const checked = await page.locator('#tiktok-disclosure-toggle').isChecked();
      const optsOpen = await page.locator('#disclosure-opts').isVisible();
      return !checked && !optsOpen;
    });
    await page.waitForTimeout(DWELL.disclosureOff);

    // Re-confirm SELF_ONLY is still the selected privacy level before the
    // real submission. Privacy was temporarily switched off Only Me above to
    // demo Branded Content (Item 8) — explicitly re-pick SELF_ONLY now
    // (Branded Content is already unchecked, so the checkbox restriction no
    // longer applies). PM final decision: the real CreatorPost-side
    // submission must use Only Me, never Public, since CreatorPost is still
    // an unaudited Direct Post client.
    await assertState('final privacy level is Only Me / SELF_ONLY before submission', async () => {
      let value = await page.locator('#tiktok-privacy').inputValue();
      if (value !== 'SELF_ONLY') {
        await pickMostRestrictivePrivacy(page, null);
        value = await page.locator('#tiktok-privacy').inputValue();
      }
      return value === 'SELF_ONLY';
    });

    // Item 12: attempt Publish BEFORE checking the explicit per-post
    // confirmation checkbox, capture the blocking error, then check it.
    await page.locator('#submit-btn').click();
    await assertState('blocking post-confirm validation error shown', async () => {
      const status = await page.locator('#upload-status').innerText().catch(() => '');
      return /confirm you want to publish/i.test(status);
    });
    await page.waitForTimeout(DWELL.confirmValidationError); // reviewer: read the blocking confirm error

    await page.locator('#tiktok-post-confirm').check();
    await assertState('post-confirm checkbox checked', async () => {
      return await page.locator('#tiktok-post-confirm').isChecked();
    });
    await page.waitForTimeout(DWELL.postConfirm); // reviewer: read the explicit confirmation

    let submitted;
    if (DRY_RUN) {
      console.log('\n--dry-run: stopping before Publish. No submission was made.');
      submitted = false;
    } else {
      // 13. Trigger the real submission.
      await page.locator('#submit-btn').click();
      await page.waitForTimeout(5000);

      // 14. DIRECT POST GATE — fail loudly on the Upload/Drafts fallback.
      //
      // /api/publish (functions/[[route]].js) silently falls back to
      // TIKTOK_INBOX_INIT_URL when video/init fails, and the dashboard then
      // renders "Uploaded to <acct> ✓ (check TikTok Drafts…)" instead of
      // "Posted to <acct> ✓". The v6 audit cut shipped exactly that fallback
      // and was rejected for demonstrating Upload rather than Direct Post.
      // A capture that lands in the fallback is worthless for this
      // submission, so abort the run rather than record it.
      const statusText = (await page.locator('#upload-status').innerText().catch(() => '')).trim();
      console.log(`  Upload result text: "${statusText}"`);
      await assertState('CreatorPost reported a DIRECT POST result (not the Upload/Drafts fallback)', async () => {
        if (/draft|uploaded to/i.test(statusText)) {
          console.error('\n  ✗ Direct Post fell back to the Upload/Inbox path. Aborting — do NOT use this capture.');
          return false;
        }
        return /^posted to /i.test(statusText);
      });
      // 15. Post card: Processing → Published, on CreatorPost's own status
      // pill. pollStatus() (dashboard.html) polls /api/publish every 10s for
      // up to ~5 min; PUBLISH_COMPLETE flips the pill to "published", while
      // SEND_TO_USER_INBOX would flip it to "inbox" (another fallback tell).
      //
      // Read the pill BEFORE the reviewer dwell: a SELF_ONLY post can finish
      // processing inside ~10s, so a dwell first can miss the Processing
      // state entirely. Either Processing or an already-flipped Published is
      // a correct Direct Post; only inbox/failed are disqualifying.
      const newPost = page.locator('.post-item').first();
      await newPost.waitFor({ state: 'attached', timeout: 15000 });
      const firstPill = (await newPost.locator('.post-status').getAttribute('class').catch(() => '')) ?? '';
      console.log(`  Post card status pill: class="${firstPill}"`);
      await assertState('post card entered Processing (or already flipped to Published)', async () => {
        if (/\binbox\b|\bfailed\b/.test(firstPill)) return false;
        return /\bprocessing\b|\bpublished\b/.test(firstPill);
      });

      // Recent Posts sits below the fold at 1440x900 — without this the
      // reviewer never actually sees the status pill in the recording.
      await newPost.scrollIntoViewIfNeeded();
      await page.waitForTimeout(DWELL.uploadResult);      // reviewer: read the result banner + card
      await page.waitForTimeout(DWELL.processingStatus);  // reviewer: read the status pill

      await assertState('post card reaches Published (never inbox/failed)', async () => {
        for (let i = 0; i < 24; i++) {           // up to ~4 min
          const cls = await newPost.locator('.post-status').getAttribute('class').catch(() => '');
          if (/\bpublished\b/.test(cls ?? '')) return true;
          if (/\binbox\b|\bfailed\b/.test(cls ?? '')) {
            console.error(`\n  ✗ post resolved to a non-published state (class="${cls}"). Aborting.`);
            return false;
          }
          await newPost.scrollIntoViewIfNeeded().catch(() => {});
          const recheck = newPost.locator('button[title="Recheck status"]');
          if (await recheck.isVisible().catch(() => false)) await recheck.click();
          await page.waitForTimeout(10000);
        }
        return false;
      });
      await page.waitForTimeout(DWELL.publishedStatus); // reviewer: read the Published state

      // 16. TikTok-web proof, same persistent profile (real @creatorpost_dev
      // session). NO Inbox/notification panel is touched here — the whole
      // point of this recut is that the post appears directly on the profile
      // grid without any native completion step.
      await page.goto(cfg.TIKTOK_WEB_URL, { waitUntil: 'domcontentloaded' });
      await assertState('TikTok web reachable while logged in as @creatorpost_dev', async () => {
        const cookies = await page.context().cookies('https://www.tiktok.com');
        return cookies.some(c => c.name === 'sessionid' && c.value);
      });
      await assertState('profile grid rendered', async () => {
        await page.locator('[data-e2e="user-post-item"]').first().waitFor({ state: 'visible', timeout: 30000 });
        return true;
      });
      await page.waitForTimeout(DWELL.tiktokWebArrive); // reviewer: see the logged-in profile

      // The newest grid tile must be the post just published, and must carry
      // TikTok's own private/lock badge (svg.private) — SELF_ONLY visibility
      // rendered by TikTok, not by CreatorPost.
      const firstTile = page.locator('[data-e2e="user-post-item"]').first();
      await assertState('newest grid tile is the post just published from CreatorPost', async () => {
        for (let i = 0; i < 12; i++) {
          const alt = await firstTile.locator('img').first().getAttribute('alt').catch(() => '');
          if (alt && alt.includes(CAPTION_PROOF)) { console.log(`  Tile alt: "${alt}"`); return true; }
          await page.waitForTimeout(10000);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.locator('[data-e2e="user-post-item"]').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        }
        return false;
      });
      await assertState('newest grid tile carries TikTok\'s private/lock badge', async () => {
        return await firstTile.locator('svg.private').isVisible().catch(() => false);
      });
      await firstTile.scrollIntoViewIfNeeded();
      await page.waitForTimeout(DWELL.gridLock); // reviewer: read the locked tile on the grid

      // 17. Open that same post — detail view carries "🔒 Private" next to
      // the handle plus the caption submitted from CreatorPost.
      await firstTile.locator('a').first().click();
      await assertState('post detail view shows the CreatorPost caption', async () => {
        await page.waitForTimeout(6000);
        const body = await page.locator('body').innerText().catch(() => '');
        return body.includes(CAPTION_PROOF);
      });
      await assertState('post detail view shows Private visibility', async () => {
        const body = await page.locator('body').innerText().catch(() => '');
        return /private/i.test(body);
      });
      await page.waitForTimeout(DWELL.postDetail); // reviewer: hold on the open, private post

      submitted = true;
    }

    return submitted;

  } finally {
    // End desktop recording
    await closeContext(context);
  }
}

main()
  .then(async (submitted) => {
    console.log(`\n${DRY_RUN ? 'DRY RUN' : 'REAL RUN'} complete. submitted=${submitted}`);

    // Resolve the EXACT raw file this run produced — not a directory scan,
    // which previously picked up stale .webm files from earlier attempts
    // (random hex filenames sort unpredictably relative to recency).
    const raw = video ? await video.path() : null;
    if (!raw || !fs.existsSync(raw)) { console.log('No raw capture found to normalize.'); return; }
    const out = DRY_RUN
      ? path.join(cfg.RAW_VIDEO_DIR, 'directpost-dry-run-normalized.mp4')
      : cfg.DIRECTPOST_VIDEO_PATH;

    normalizeToMp4(raw, out);
    const info = probe(out);
    console.log('Normalized capture:', out, info);

    fs.mkdirSync(cfg.STILLS_DIR, { recursive: true });
    const prefix = DRY_RUN ? 'directpost-dry-run' : 'directpost-final';
    extractStill(out, 1, path.join(cfg.STILLS_DIR, `${prefix}-start.png`));
    extractStill(out, Math.max(1, Math.floor(info.duration / 2)), path.join(cfg.STILLS_DIR, `${prefix}-mid.png`));
    console.log(`Verification stills written to ${cfg.STILLS_DIR}`);
  })
  .catch((err) => {
    console.error('\n✗ CAPTURE FAILED:', err.message);
    process.exit(1);
  });
