// Opens the persistent CreatorPost/TikTok profile in a headed browser and
// leaves it open for manual, human-driven interaction (e.g. completing
// TikTok's "Verify it's really you" step). No automation, no assertions, no
// auto-close — the process just idles until killed.
'use strict';

const { launchProfile } = require('../../lib/browser');
const cfg = require('./config');

(async () => {
  const context = await launchProfile({
    profileDir: cfg.PROFILE_DIR,
    headless: false,
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(cfg.DASHBOARD_URL, { waitUntil: 'networkidle' });
  console.log('Browser open for manual use. Leave this running; Ctrl+C to close when done.');
  await new Promise(() => {}); // idle forever
})();
