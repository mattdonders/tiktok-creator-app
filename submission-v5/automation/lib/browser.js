// Generic browser-capture helper. No product/scenario knowledge lives here —
// this is reusable across any project that needs a deterministic, recorded
// Playwright walkthrough driven from a persistent, interactively-logged-in
// browser profile (so no passwords/cookies ever pass through automation or chat).
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Launches (or reuses) a persistent Chromium profile at `profileDir`.
 * The first time, the caller is expected to log in manually (headed) — after
 * that, the same profile carries the session across runs until it expires.
 *
 * @param {object} opts
 * @param {string} opts.profileDir - absolute path to the persistent profile
 * @param {boolean} [opts.headless=false]
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {string} [opts.recordVideoDir] - if set, Playwright records webm video of the context to this dir
 */
async function launchProfile({ profileDir, headless = false, viewport = { width: 1440, height: 900 }, recordVideoDir }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport,
    recordVideo: recordVideoDir ? { dir: recordVideoDir, size: viewport } : undefined,
  });
  return context;
}

/**
 * Opens a page, navigates to `url`, and waits (polling) until `isLoggedIn(page)`
 * resolves true or `timeoutMs` elapses. Intended for the one-time interactive
 * login handoff: the caller launches headed, this waits for the human to finish.
 */
async function waitForInteractiveLogin(page, { url, isLoggedIn, timeoutMs = 5 * 60 * 1000, pollMs = 2000 }) {
  await page.goto(url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page).catch(() => false)) return true;
    await page.waitForTimeout(pollMs);
  }
  return false;
}

/** Small typed assertion helper — throws with a clear label so a bad capture fails loudly. */
async function assertState(label, fn) {
  let ok;
  try {
    ok = await fn();
  } catch (err) {
    throw new Error(`ASSERTION ERRORED [${label}]: ${err.message}`);
  }
  if (!ok) throw new Error(`ASSERTION FAILED [${label}]`);
  console.log(`  ✓ ${label}`);
}

async function closeContext(context) {
  await context.close();
}

/** Launches a plain (non-persistent) browser context — for one-off probes/tests. */
async function launchFreshContext({ headless = false, viewport = { width: 1440, height: 900 } } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport });
  return { browser, context };
}

/**
 * Converts a Cookie-Editor-style JSON export (array of
 * {domain, name, value, path, expirationDate, httpOnly, secure, sameSite})
 * into Playwright's addCookies() shape. Generic — no site-specific knowledge.
 */
function loadCookiesFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const sameSiteMap = {
    no_restriction: 'None', unspecified: 'Lax', lax: 'Lax', strict: 'Strict',
    none: 'None', None: 'None', Lax: 'Lax', Strict: 'Strict',
  };
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? '/',
    expires: c.expirationDate ?? -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: sameSiteMap[c.sameSite] ?? 'Lax',
  }));
}

module.exports = {
  launchProfile, waitForInteractiveLogin, assertState, closeContext,
  launchFreshContext, loadCookiesFile, path,
};
