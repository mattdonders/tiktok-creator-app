// One-time interactive login to TikTok web, in the SAME persistent profile
// used for CreatorPost — a real login performed by the owner, not a cookie
// transplant (that route was already proven unreliable in the Aug 4 work).
// Needed only for the final "TikTok web notification" beat of the capture.
'use strict';

const { launchProfile, waitForInteractiveLogin, closeContext } = require('../../lib/browser');
const cfg = require('./config');

(async () => {
  console.log(`Opening a browser window at https://www.tiktok.com/login`);
  console.log(`Log in as @${cfg.EXPECTED_TIKTOK_HANDLE}.`);
  console.log('This script waits (up to 5 minutes) until it sees the notifications page load logged in.\n');

  const context = await launchProfile({ profileDir: cfg.PROFILE_DIR, headless: false });
  const page = context.pages()[0] ?? await context.newPage();

  const ok = await waitForInteractiveLogin(page, {
    url: 'https://www.tiktok.com/login',
    // URL-based checks are unreliable here — TikTok can show a logged-out
    // /notifications page (or an inline login modal) without ever putting
    // "/login" in the URL. Check for the real session cookie instead.
    isLoggedIn: async (p) => {
      const cookies = await p.context().cookies('https://www.tiktok.com');
      const session = cookies.find(c => c.name === 'sessionid' && c.value);
      return !!session;
    },
  });

  if (ok) {
    console.log('\n✓ Logged in to TikTok web — session saved in the persistent profile.');
  } else {
    console.log('\n✗ Timed out waiting for login. Re-run this script when ready.');
  }

  await closeContext(context);
  process.exit(ok ? 0 : 1);
})();
