// One-shot test: does TikTok accept a cookie export from your normal browser
// inside an automated context? Historically (Aug 4 work) the answer was no —
// TikTok binds session cookies to the originating browser/device fingerprint
// and rejects transplants. This probes that WITHOUT touching the real
// automation profile, and without ever printing cookie values.
//
// Setup (you do this part — nothing here ever sees your password):
//   1. In your NORMAL, already-logged-in TikTok browser, export cookies for
//      tiktok.com (e.g. the "Cookie-Editor" extension's "Export" as JSON).
//   2. Save that JSON to: <repo root>/.secrets/tiktok-cookies.json
//      (this path is gitignored — confirmed, see .gitignore)
//   3. Run: node probe-tiktok-cookies.js
'use strict';

const { launchFreshContext, loadCookiesFile } = require('../../lib/browser');
const cfg = require('./config');
const fs = require('fs');

(async () => {
  if (!fs.existsSync(cfg.TIKTOK_COOKIES_FILE)) {
    console.error(`No cookie file found at ${cfg.TIKTOK_COOKIES_FILE}`);
    console.error('Export cookies for tiktok.com from your normal browser and save them there first.');
    process.exit(1);
  }

  const cookies = loadCookiesFile(cfg.TIKTOK_COOKIES_FILE);
  console.log(`Loaded ${cookies.length} cookies from file (values not printed).`);

  const { browser, context } = await launchFreshContext({ headless: false });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // Same diagnostic the Aug 4 work used: this endpoint returns a real user
  // object when the session is valid, and {message:"error"} when it's not.
  const res = await page.goto('https://www.tiktok.com/passport/web/account/info/', { waitUntil: 'domcontentloaded' });
  const body = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(body); } catch { json = null; }

  const valid = !!(json && json.message !== 'error' && (json.data ?? json.user));
  console.log('\npassport/web/account/info/ response message:', json?.message ?? '(unparseable)');

  if (valid) {
    console.log('✓ COOKIES ACCEPTED — session appears valid in this automated context.');
    console.log('  Next: run login-tiktok.js is no longer needed; the persistent profile can be seeded from this context instead.');
  } else {
    console.log('✗ COOKIES REJECTED — same failure mode as the Aug 4 OAuth attempts (device/browser-bound session).');
    console.log('  Recommendation: fall back to manual capture for the TikTok-web notification beat.');
  }

  await browser.close();
  process.exit(valid ? 0 : 1);
})();
