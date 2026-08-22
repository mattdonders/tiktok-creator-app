// Fresh post-OAuth desktop capture for the TikTok Direct Post resubmission.
// OAuth itself is NOT automated here (reuse docs/submission-videos/clip1) —
// this drives everything from an already-connected CreatorPost/TikTok state
// through the real submission, CreatorPost's own upload-result UI, AND the
// TikTok-web receipt notification (@creatorpost_dev, same persistent profile —
// no separate TikTok login needed, the profile already carries a valid
// TikTok session seeded via seed-tiktok-cookies.js).
//
// Paced for REVIEWER COMPREHENSION, not speed — every evidence-bearing state
// (identity, sync result, creator_info panel, privacy, toggles, disclosure,
// music consent, confirmation, upload result, TikTok notification) holds long
// enough for a human to read it, per engineering's checklist-driven pacing
// requirement. Forces CreatorPost light mode for visual continuity with the
// reused historical OAuth clip (also light mode).
//
// Usage:
//   node record-desktop-flow.js --dry-run   (stops before the real Publish click)
//   node record-desktop-flow.js             (performs the real submission)
//
// Requires a persistent profile already logged in to CreatorPost (see
// login-creatorpost.js) AND already carrying a valid TikTok web session (see
// seed-tiktok-cookies.js) — this script asserts identity, it never authenticates.
'use strict';

const { launchProfile, assertState, closeContext } = require('../../lib/browser');
const { normalizeToMp4, extractStill, probe } = require('../../lib/ffmpeg');
const cfg = require('./config');
const path = require('path');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');
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
  tiktokWebArrive: 2000,
  notificationPanel: 2500,
  notificationRead: 10000,
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
  console.log(`\n=== CreatorPost fresh desktop capture (${DRY_RUN ? 'DRY RUN' : 'REAL SUBMISSION'}) ===\n`);

  if (!fs.existsSync(cfg.AUDIT_VIDEO_PATH)) {
    throw new Error(`Audit asset not found: ${cfg.AUDIT_VIDEO_PATH}`);
  }

  const runVideoDir = path.join(cfg.RAW_VIDEO_DIR, DRY_RUN ? 'dry-run' : 'final');
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
    // Item 7: pick the MOST RESTRICTIVE option offered, not the first one —
    // unaudited Direct Post must not be shown posting as Public.
    await pickMostRestrictivePrivacy(page, null);
    await assertState('a privacy level is explicitly selected', async () => {
      return (await page.locator('#tiktok-privacy').inputValue()) !== '';
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

    for (const id of ['tiktok-allow-comment', 'tiktok-allow-duet', 'tiktok-allow-stitch']) {
      const slider = page.locator(`#${id} ~ .toggle-slider`);
      await slider.click();
      await page.waitForTimeout(DWELL.toggleDemo);
      await slider.click();
    }
    await assertState('interaction toggles reset OFF after opt-in demo', async () => {
      const comment = await page.locator('#tiktok-allow-comment').isChecked();
      const duet    = await page.locator('#tiktok-allow-duet').isChecked();
      const stitch  = await page.locator('#tiktok-allow-stitch').isChecked();
      return !comment && !duet && !stitch;
    });

    // Item 14: interactions disabled in the creator's own TikTok settings
    // must render greyed-out (dashboard.html:1150-1155, gated on
    // creator_info's comment_disabled/duet_disabled/stitch_disabled). The
    // creatorpost_dev account exposes no disabled interactions, so this rule
    // is NOT DEMONSTRABLE WITH CURRENT ACCOUNT — logged, not faked.
    console.log('  [not demonstrable] disabled-interaction greying — creatorpost_dev exposes no disabled interactions');

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
    // reference to the Branded Content Policy.
    await page.locator('#tiktok-brand-organic').uncheck();
    await page.locator('#tiktok-brand-content').check();
    await page.locator('#submit-btn').scrollIntoViewIfNeeded(); // keep it in frame after the checkbox interactions above
    await assertState('"Branded content" labeled as Paid partnership', async () => {
      const text = await page.locator('#disclosure-label').innerText().catch(() => '');
      return /paid partnership/i.test(text);
    });
    await assertState('Branded Content Policy referenced in consent text', async () => {
      return await page.locator('#tiktok-consent-text a', { hasText: /branded content policy/i }).isVisible().catch(() => false);
    });
    await page.waitForTimeout(DWELL.brandedContentLabel); // reviewer: read Paid partnership label + policy link

    // Item 9: while Branded Content is selected, Private/Only Me (SELF_ONLY)
    // is cleared and disabled (dashboard.html:1218-1225) — AND a visible,
    // user-facing explanation is shown next to the privacy field, not just
    // the disabled <option> itself (a disabled option alone doesn't explain
    // WHY it disappeared).
    await assertState('Only Me privacy option disabled while Branded Content selected', async () => {
      const opt = page.locator('#tiktok-privacy option[value="SELF_ONLY"]');
      if (await opt.count() === 0) return true; // account's privacy_level_options doesn't even offer SELF_ONLY
      return await opt.isDisabled();
    });
    await assertState('visible explanation shown for the Only Me restriction', async () => {
      const opt = page.locator('#tiktok-privacy option[value="SELF_ONLY"]');
      if (await opt.count() === 0) return true; // nothing to explain if this account never offers SELF_ONLY
      return await page.locator('#tiktok-privacy-restriction-note').isVisible().catch(() => false);
    });
    await page.waitForTimeout(DWELL.brandedPrivacyRestriction); // reviewer: see Only Me disabled + the visible explanation

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

    // Re-confirm a truthful privacy level is still selected. Selecting
    // Branded Content earlier can clear a SELF_ONLY choice back to empty
    // (dashboard.html:1223-1225) — if that happened, explicitly pick the
    // most restrictive option again now rather than submitting with privacy
    // unset (Branded Content is already unchecked above, so SELF_ONLY is no
    // longer disabled — item 7 still applies: never fall back to Public).
    await assertState('a privacy level is explicitly selected before submission', async () => {
      let value = await page.locator('#tiktok-privacy').inputValue();
      if (!value) {
        await pickMostRestrictivePrivacy(page, null);
        value = await page.locator('#tiktok-privacy').inputValue();
      }
      return value !== '';
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
      // 13. Trigger the real submission
      await page.locator('#submit-btn').click();
      await page.waitForTimeout(4000);

      // 14. Capture Direct Post/Upload-fallback result truthfully. This must
      // NEVER be portrayed as a successful Direct Post — video.publish/Direct
      // Post is restricted while the audit is pending; whatever this actually
      // says (Direct Post success, or Upload/Drafts fallback) is reported as-is.
      const statusText = await page.locator('#upload-status').innerText().catch(() => '');
      console.log(`  Upload result text: "${statusText.trim()}"`);
      await assertState('upload result received', async () => statusText.trim().length > 0);
      await page.waitForTimeout(DWELL.uploadResult); // reviewer: read the real upload result

      // Item 13: TikTok processing/upload notice on the post card itself,
      // plus manual recheck-status behavior. The submitted post is always
      // unshifted to the front of the list (dashboard.html:1737), so the
      // first .post-item is the one just created.
      const newPost = page.locator('.post-item').first();
      await assertState('post card shows TikTok processing status', async () => {
        const cls = await newPost.locator('.post-status').getAttribute('class').catch(() => '');
        return /processing|inbox|published/.test(cls ?? '');
      });
      await page.waitForTimeout(DWELL.processingStatus); // reviewer: read the processing/inbox status

      const recheckBtn = newPost.locator('button[title="Recheck status"]');
      if (await recheckBtn.isVisible().catch(() => false)) {
        await recheckBtn.click();
        await page.waitForTimeout(DWELL.recheckStatus); // reviewer: see the manual recheck round-trip
      } else {
        console.log('  [info] recheck control not shown — post already resolved (published/failed) by the time we checked');
      }

      // 15-17. TikTok web receipt — same persistent profile, already carries a
      // valid TikTok session (seeded via seed-tiktok-cookies.js), so no
      // separate login is needed here. Real selectors confirmed via
      // inspect-tiktok-nav.js: the inbox panel is already in the DOM on page
      // load (hidden), revealed by clicking [data-e2e="inbox-icon"].
      await page.goto(cfg.TIKTOK_WEB_URL, { waitUntil: 'domcontentloaded' });
      await assertState('TikTok web reachable while logged in as @creatorpost_dev', async () => {
        const cookies = await page.context().cookies('https://www.tiktok.com');
        return cookies.some(c => c.name === 'sessionid' && c.value);
      });
      await page.waitForTimeout(DWELL.tiktokWebArrive); // reviewer: see the logged-in TikTok profile

      await page.locator('[data-e2e="inbox-icon"]').click();
      await assertState('notification inbox panel opened', async () => {
        await page.locator('[data-e2e="inbox-notifications"]').waitFor({ state: 'visible', timeout: 10000 });
        return true;
      });
      await page.waitForTimeout(DWELL.notificationPanel);

      // The exact notification copy is unverified until a real submit has
      // happened at least once (this account had 0 notifications pre-submit,
      // per inspect-tiktok-nav.js) — we match on "creatorpost" as the one
      // word we can be confident of; log the real text either way so the
      // literal copy (e.g. "Your content from CreatorPost is ready") gets
      // confirmed from the actual reviewer capture rather than assumed.
      await assertState('TikTok web notification references CreatorPost', async () => {
        const list = page.locator('[data-e2e="inbox-list"]');
        for (let i = 0; i < 6; i++) {
          const text = await list.innerText().catch(() => '');
          if (/creatorpost/i.test(text)) {
            console.log(`  Notification text: "${text.trim()}"`);
            return true;
          }
          await page.waitForTimeout(5000);
        }
        return false;
      });
      await page.waitForTimeout(DWELL.notificationRead); // reviewer: read the notification

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
      ? path.join(cfg.RAW_VIDEO_DIR, 'dry-run-normalized.mp4')
      : cfg.FINAL_VIDEO_PATH;

    normalizeToMp4(raw, out);
    const info = probe(out);
    console.log('Normalized capture:', out, info);

    fs.mkdirSync(cfg.STILLS_DIR, { recursive: true });
    const prefix = DRY_RUN ? 'dry-run' : 'final';
    extractStill(out, 1, path.join(cfg.STILLS_DIR, `${prefix}-start.png`));
    extractStill(out, Math.max(1, Math.floor(info.duration / 2)), path.join(cfg.STILLS_DIR, `${prefix}-mid.png`));
    console.log(`Verification stills written to ${cfg.STILLS_DIR}`);
  })
  .catch((err) => {
    console.error('\n✗ CAPTURE FAILED:', err.message);
    process.exit(1);
  });
