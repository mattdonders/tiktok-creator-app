/**
 * TikTok-web proof tail, captured on its own.
 *
 * The full record-directpost-flow.js run publishes AND proves; but TikTok's
 * bot heuristics threw an interstitial CAPTCHA over the post-detail view a few
 * seconds after the automated tile click, which is unusable in an audit
 * artifact. This script re-captures ONLY the proof tail — profile grid ->
 * locked tile -> open post -> hold — with slower, more human-like pacing, so
 * the ending can be cut in cleanly. It publishes nothing and mutates nothing.
 *
 * If a CAPTCHA appears anyway, the run aborts rather than record it.
 */
const { launchProfile, assertState, closeContext } = require('../../lib/browser');
const { normalizeToMp4 } = require('../../lib/ffmpeg');
const cfg = require('./config');
const path = require('path');
const fs = require('fs');

const CAPTION_PROOF = 'CreatorPost review demo';
const RAW_DIR = path.join(cfg.RAW_VIDEO_DIR, 'tiktok-tail');
const OUT = path.join(path.dirname(cfg.RAW_VIDEO_DIR), 'fresh-tiktok-tail.mp4');

// A CAPTCHA is a hard stop: it means TikTok flagged the automation, and any
// footage from that point on shows a challenge dialog rather than the post.
async function assertNoCaptcha(page, where) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/drag the puzzle piece|verify to continue|security check/i.test(body)) {
    throw new Error(`TikTok CAPTCHA appeared at: ${where}`);
  }
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const context = await launchProfile({
    profileDir: cfg.PROFILE_DIR,
    recordVideoDir: RAW_DIR,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();

  try {
    console.log('\n=== TikTok-web proof tail (no publishing) ===\n');

    await page.goto(cfg.TIKTOK_WEB_URL, { waitUntil: 'domcontentloaded' });
    await assertState('logged in as @creatorpost_dev', async () => {
      const cookies = await page.context().cookies('https://www.tiktok.com');
      return cookies.some(c => c.name === 'sessionid' && c.value);
    });
    await assertState('profile grid rendered', async () => {
      await page.locator('[data-e2e="user-post-item"]').first().waitFor({ state: 'visible', timeout: 30000 });
      return true;
    });
    await page.waitForTimeout(5000);      // reviewer: see the logged-in profile
    await assertNoCaptcha(page, 'profile grid');

    const firstTile = page.locator('[data-e2e="user-post-item"]').first();
    await assertState('newest grid tile is the CreatorPost Direct Post', async () => {
      const alt = await firstTile.locator('img').first().getAttribute('alt').catch(() => '');
      console.log(`  Tile alt: "${alt}"`);
      return !!alt && alt.includes(CAPTION_PROOF);
    });
    await assertState('newest grid tile carries TikTok\'s private/lock badge', async () =>
      await firstTile.locator('svg.private').isVisible().catch(() => false));

    // Human-ish pacing: hover, dwell, then click.
    await firstTile.scrollIntoViewIfNeeded();
    await firstTile.hover();
    await page.waitForTimeout(7000);      // reviewer: read the locked tile

    await firstTile.locator('a').first().click();
    await page.waitForTimeout(9000);      // let the detail view fully settle
    await assertNoCaptcha(page, 'post detail view');

    await assertState('post detail shows the CreatorPost caption', async () => {
      const body = await page.locator('body').innerText().catch(() => '');
      return body.includes(CAPTION_PROOF);
    });
    await assertState('post detail shows Private visibility', async () => {
      const body = await page.locator('body').innerText().catch(() => '');
      return /private/i.test(body);
    });
    await page.waitForTimeout(12000);     // reviewer: hold on the open, private post
    await assertNoCaptcha(page, 'end of hold');

    return true;
  } finally {
    await closeContext(context);
  }
}

main()
  .then(async () => {
    const webm = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.webm'))
      .map(f => path.join(RAW_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    await normalizeToMp4(webm, OUT);
    console.log(`\n✓ tail captured: ${OUT}`);
    process.exit(0);
  })
  .catch(err => {
    console.error(`\n✗ TAIL CAPTURE FAILED: ${err.message}`);
    process.exit(1);
  });
