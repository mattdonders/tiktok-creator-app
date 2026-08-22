// Read-only DOM inspector — no clicks, no state changes. Dumps every element
// with a data-e2e attribute (TikTok's own test-hook convention) plus the
// notification bell/panel region, so real selectors can be used in
// record-desktop-flow.js instead of guessed URLs/selectors.
'use strict';

const { launchProfile, closeContext } = require('../../lib/browser');
const cfg = require('./config');

(async () => {
  const context = await launchProfile({ profileDir: cfg.PROFILE_DIR, headless: false });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`https://www.tiktok.com/@${cfg.EXPECTED_TIKTOK_HANDLE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const dump = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-e2e]')];
    return nodes.map(n => ({
      tag: n.tagName,
      dataE2e: n.getAttribute('data-e2e'),
      text: n.textContent?.trim().slice(0, 60),
      aria: n.getAttribute('aria-label'),
    }));
  });

  console.log(`Found ${dump.length} [data-e2e] elements on the profile page:\n`);
  for (const d of dump) console.log(JSON.stringify(d));

  console.log('\nNow click the notifications bell in the sidebar yourself (like you just did), then press Enter here.');
  await new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', resolve); });

  const panelDump = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-e2e]')];
    return nodes.map(n => ({
      tag: n.tagName,
      dataE2e: n.getAttribute('data-e2e'),
      text: n.textContent?.trim().slice(0, 80),
    }));
  });
  console.log(`\nAfter opening the panel, ${panelDump.length} [data-e2e] elements:\n`);
  for (const d of panelDump) console.log(JSON.stringify(d));

  console.log('\nPress Enter again to close the browser.');
  await new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', resolve); });

  await closeContext(context);
  process.exit(0);
})();
