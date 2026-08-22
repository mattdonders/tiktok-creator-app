// One-time interactive login: opens a real, headed browser window against the
// persistent profile and waits for the owner to click their magic-link email
// and land on /dashboard. No password/token is ever typed into automation.
// Run once (or whenever the cp_session cookie has expired); after that,
// record-desktop-flow.js reuses the same profile headlessly-or-headed.
'use strict';

const { launchProfile, waitForInteractiveLogin, closeContext } = require('../../lib/browser');
const cfg = require('./config');

(async () => {
  console.log(`Opening a browser window at ${cfg.LOGIN_URL}`);
  console.log(`Log in as ${cfg.EXPECTED_CREATORPOST_EMAIL} — click the magic link from your email.`);
  console.log('This script waits (up to 5 minutes) until it sees /dashboard load.\n');

  const context = await launchProfile({ profileDir: cfg.PROFILE_DIR, headless: false });
  const page = context.pages()[0] ?? await context.newPage();

  const ok = await waitForInteractiveLogin(page, {
    url: cfg.LOGIN_URL,
    isLoggedIn: async (p) => p.url().startsWith(cfg.DASHBOARD_URL),
  });

  if (ok) {
    console.log('\n✓ Logged in — session saved in the persistent profile.');
  } else {
    console.log('\n✗ Timed out waiting for login. Re-run this script when ready.');
  }

  await closeContext(context);
  process.exit(ok ? 0 : 1);
})();
