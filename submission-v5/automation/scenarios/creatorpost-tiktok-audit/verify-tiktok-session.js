// Lightweight visual check: opens the REAL persistent automation profile
// (the one record-desktop-flow.js uses) against TikTok web and leaves the
// window open for you to look around — no assertions, no recording, no
// timers. Confirms the seeded session actually renders logged-in UI before
// committing to the full dry-run.
//
// Usage: node verify-tiktok-session.js
// Press Enter in this terminal when you're done looking, to close cleanly.
'use strict';

const { launchProfile, closeContext } = require('../../lib/browser');
const cfg = require('./config');

(async () => {
  console.log(`Opening the persistent automation profile at ${cfg.TIKTOK_WEB_URL}`);
  console.log('Look around — check the notifications page, TikTok Studio, whatever you want to confirm.');
  console.log('Press Enter here when you\'re done to close the browser.\n');

  const context = await launchProfile({ profileDir: cfg.PROFILE_DIR, headless: false });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(cfg.TIKTOK_WEB_URL, { waitUntil: 'domcontentloaded' });

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  await closeContext(context);
  process.exit(0);
})();
