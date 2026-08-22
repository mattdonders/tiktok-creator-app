// Seeds the REAL persistent automation profile (the one record-desktop-flow.js
// uses) with the cookies already validated by probe-tiktok-cookies.js. Run
// this once the probe reports ACCEPTED — after this, login-tiktok.js is no
// longer needed for that profile.
'use strict';

const { launchProfile, loadCookiesFile, closeContext } = require('../../lib/browser');
const cfg = require('./config');
const fs = require('fs');

(async () => {
  if (!fs.existsSync(cfg.TIKTOK_COOKIES_FILE)) {
    console.error(`No cookie file found at ${cfg.TIKTOK_COOKIES_FILE}`);
    process.exit(1);
  }

  const cookies = loadCookiesFile(cfg.TIKTOK_COOKIES_FILE);
  console.log(`Loaded ${cookies.length} cookies from file (values not printed).`);

  const context = await launchProfile({ profileDir: cfg.PROFILE_DIR, headless: false });
  await context.addCookies(cookies);
  const page = context.pages()[0] ?? await context.newPage();

  const res = await page.goto('https://www.tiktok.com/passport/web/account/info/', { waitUntil: 'domcontentloaded' });
  const body = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  const valid = !!(json && json.message !== 'error' && (json.data ?? json.user));

  if (valid) {
    console.log('✓ Persistent automation profile now has a valid TikTok session.');
  } else {
    console.log('✗ Cookies did not validate in the persistent profile (different fingerprint than the probe context).');
    console.log('  Falling back to manual capture for the TikTok-web beat is the safer path.');
  }

  await closeContext(context);
  process.exit(valid ? 0 : 1);
})();
