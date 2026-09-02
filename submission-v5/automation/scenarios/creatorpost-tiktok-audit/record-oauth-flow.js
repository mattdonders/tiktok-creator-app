// Real TikTok OAuth authorization capture for the resubmission video's opening
// clip — replaces the old segments/02b_oauth.mp4, which had captions burned
// into the raw recording (overlapping the UI). This script records CLEAN raw
// footage only; the caption band is composited on later, at final assembly.
//
// HUMAN-DRIVEN, NOT SCRIPTED CLICKS: earlier scripted-click versions kept
// breaking because TikTok's flow isn't deterministic run-to-run (it may show
// the full consent/permissions screen, or skip straight to a step-up "Verify
// it's really you" challenge) — a fixed click sequence can't react to that,
// and manual human intervention mid-script (e.g. typing a password by hand)
// breaks whatever the script was mid-assertion on. So this script does none
// of the clicking: it just opens the browser (recording video the whole
// time), prints instructions, and polls page.url() to detect a real
// round trip out to tiktok.com and back to CreatorPost — that's the signal
// used to declare success and finalize the video. No assertions on
// intermediate screen content, since that content isn't guaranteed.
//
// Precondition (owner-driven, not automated here): CreatorPost's authorization
// has already been revoked from the TikTok-side app-permissions UI for
// @creatorpost_dev, so /auth/tiktok is expected to produce a real, fresh
// TikTok consent screen instead of silently re-approving.
//
// This script never calls CreatorPost's /api/disconnect and never deletes
// anything — it only expects you to click /auth/tiktok (a real TikTok
// authorize redirect) yourself and lets the existing OAuth callback upsert
// the existing connected_accounts row (conflict target: user_id, platform,
// platform_user_id — same row id, same posts, per repeated read-only DB checks).
//
// IMPORTANT: run this from a normal, directly-attached terminal (not through
// an automation/tmux-hosted session) so the browser window can actually
// receive keyboard/mouse focus.
//
// Usage:
//   node record-oauth-flow.js
'use strict';

const { launchProfile, closeContext } = require('../../lib/browser');
const { normalizeToMp4, extractStill, probe } = require('../../lib/ffmpeg');
const cfg = require('./config');
const path = require('path');
const fs = require('fs');

const POLL_MS = 500;
const POST_RETURN_DWELL_MS = 4000; // let the reviewer read the post-reauth connected state before we stop recording
const MAX_WAIT_MS = 8 * 60 * 1000; // generous — you're driving this by hand, including a possible password step-up

async function main() {
  console.log('\n=== CreatorPost TikTok OAuth capture (HUMAN-DRIVEN) ===\n');

  const runVideoDir = path.join(cfg.RAW_VIDEO_DIR, 'oauth');
  fs.mkdirSync(runVideoDir, { recursive: true });

  const context = await launchProfile({
    profileDir: cfg.PROFILE_DIR,
    headless: false,
    recordVideoDir: runVideoDir,
  });

  await context.addInitScript(() => {
    try { localStorage.setItem('creatorpost-theme', 'light'); } catch (e) {}
  });

  const page = context.pages()[0] ?? await context.newPage();
  const video = page.video();

  let succeeded = false;

  try {
    await page.goto(cfg.DASHBOARD_URL, { waitUntil: 'networkidle' });
    console.log('Browser open and recording. Drive this by hand:');
    console.log('  1. Click "+ TikTok"');
    console.log('  2. Read through whatever TikTok shows (consent screen or verification step)');
    console.log('  3. Complete it (Continue, and password if TikTok asks for it)');
    console.log('  4. Wait for the return to the CreatorPost dashboard');
    console.log('\nThis script will detect the tiktok.com -> creatorpost.app round trip automatically and stop recording a few seconds after you land back on the dashboard. No need to tell it anything.\n');

    const deadline = Date.now() + MAX_WAIT_MS;
    let sawTikTok = false;

    while (Date.now() < deadline) {
      let url;
      try {
        url = page.url();
      } catch (e) {
        break; // page/context closed underneath us (e.g. you closed the window)
      }

      if (/tiktok\.com/.test(url)) {
        if (!sawTikTok) console.log('  ✓ left CreatorPost for tiktok.com');
        sawTikTok = true;
      } else if (sawTikTok && url.startsWith(cfg.BASE_URL)) {
        console.log('  ✓ back on CreatorPost after visiting tiktok.com — treating this as complete');
        succeeded = true;
        break;
      }

      await page.waitForTimeout(POLL_MS);
    }

    if (succeeded) {
      await page.waitForTimeout(POST_RETURN_DWELL_MS); // reviewer: read the post-reauth connected state
    } else {
      console.log('\nNo tiktok.com -> CreatorPost round trip detected within the time limit (or the window was closed early).');
    }
  } finally {
    await closeContext(context);
  }

  const raw = video ? await video.path() : null;
  if (!raw) {
    console.log('\nNo raw video was recorded — nothing to finalize.');
    return;
  }

  if (!succeeded) {
    console.log(`\nRaw (unfinalized) video preserved at: ${raw}`);
    console.log('Not normalizing to the final path since success wasn\'t detected — inspect the raw file, or rerun.');
    return;
  }

  normalizeToMp4(raw, cfg.OAUTH_VIDEO_PATH);
  const info = probe(cfg.OAUTH_VIDEO_PATH);
  console.log('Probe:', info);

  fs.mkdirSync(cfg.STILLS_DIR, { recursive: true });
  extractStill(cfg.OAUTH_VIDEO_PATH, 0.5, path.join(cfg.STILLS_DIR, 'oauth-start.png'));
  extractStill(cfg.OAUTH_VIDEO_PATH, info.duration / 2, path.join(cfg.STILLS_DIR, 'oauth-mid.png'));
  extractStill(cfg.OAUTH_VIDEO_PATH, Math.max(0, info.duration - 1), path.join(cfg.STILLS_DIR, 'oauth-end.png'));
  console.log(`\n✓ OAuth capture complete: ${cfg.OAUTH_VIDEO_PATH}`);
}

main().catch((err) => {
  console.error(`\n✗ OAUTH CAPTURE FAILED: ${err.message}`);
  process.exit(1);
});
