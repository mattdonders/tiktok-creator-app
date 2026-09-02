// Manual-navigation session PLUS a secure password relay for TikTok's
// "Verify it's really you" step-up screen. The browser opens headed and the
// human drives all navigation/clicks by hand (dashboard -> +TikTok -> consent
// -> Continue -> Verify it's really you -> choose Password) exactly like
// open-manual-session.js. The only difference: once a password-type input
// appears on the page, this script pops a native macOS dialog (hidden input)
// for the human to type their TikTok password into directly. That value is
// piped straight into the page field via Playwright and is NEVER logged,
// printed, or returned to the calling process's stdout — it only ever exists
// inside this Node process's memory for the few milliseconds between the
// dialog resolving and the page.fill() call, then it's discarded.
//
// Usage:
//   node verify-with-password.js
'use strict';

const { execFile } = require('child_process');
const { launchProfile } = require('../../lib/browser');
const cfg = require('./config');

function promptForPasswordViaMacDialog() {
  return new Promise((resolve, reject) => {
    const script = 'text returned of (display dialog "Enter your TikTok account password. It goes directly into the browser field and is never logged." with title "TikTok Verification (local only — not seen by Claude)" default answer "" with hidden answer)';
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(new Error('Password prompt cancelled or failed'));
      resolve(stdout.replace(/\n$/, ''));
    });
  });
}

// Set REAL_CHROME=1 to use the real installed Chrome (fresh profile) instead
// of Playwright's bundled Chrome-for-Testing binary + the existing logged-in profile.
const useRealChrome = process.env.REAL_CHROME === '1';

(async () => {
  const context = await launchProfile(useRealChrome
    ? { profileDir: cfg.REALCHROME_PROFILE_DIR, headless: false, channel: 'chrome' }
    : { profileDir: cfg.PROFILE_DIR, headless: false });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(cfg.DASHBOARD_URL, { waitUntil: 'networkidle' });
  if (useRealChrome) {
    console.log('Browser open (real Chrome channel, fresh profile — you will need to log into CreatorPost and TikTok in this window).');
  } else {
    console.log('Browser open (Chrome for Testing, existing logged-in profile).');
  }
  console.log('Navigate manually (log in if needed, click +TikTok, proceed through consent, Continue, then choose "Use password" on the Verify screen).');
  console.log('Watching for a password field to appear...');

  const pwField = page.locator('input[type="password"]').first();
  await pwField.waitFor({ state: 'visible', timeout: 10 * 60 * 1000 });
  console.log('Password field detected — opening secure system dialog now.');

  let pw;
  try {
    pw = await promptForPasswordViaMacDialog();
  } catch (e) {
    console.log('Password entry cancelled. Nothing was typed. Browser remains open for manual retry.');
    return;
  }

  await pwField.click();
  await pwField.fill(pw);
  pw = null; // discard reference immediately after use

  console.log('Password filled into the field. Review it on screen, then submit manually (or the visible submit/verify button can be clicked by hand).');
  console.log('This script will keep the browser open; press Ctrl+C here when done.');
  await new Promise(() => {}); // idle forever
})();
