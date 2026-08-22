// CreatorPost/TikTok-specific constants for this scenario only.
// Nothing generic (browser/ffmpeg) should ever import from this file.
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');

module.exports = {
  BASE_URL: 'https://creatorpost.app',
  DASHBOARD_URL: 'https://creatorpost.app/dashboard',
  ACCOUNT_URL: 'https://creatorpost.app/account',
  LOGIN_URL: 'https://creatorpost.app/login',
  // Kept for the standalone verify/inspect scripts (manual session checks) —
  // record-desktop-flow.js no longer navigates here; TikTok-web proof is
  // captured separately on iOS.
  TIKTOK_WEB_URL: 'https://www.tiktok.com/@creatorpost_dev',

  EXPECTED_CREATORPOST_EMAIL: 'cp-tiktok-demo@mattdonders.com',
  EXPECTED_TIKTOK_HANDLE: 'creatorpost_dev',

  AUDIT_VIDEO_PATH: path.join(ROOT, '..', 'audit-content', 'creatorpost-audit-test-clip-neutral.mp4'),
  AUDIT_CAPTION: 'CreatorPost review demo — original test content, August 2026. #creatorpost',

  PROFILE_DIR: path.join(ROOT, '.browser-profile', 'creatorpost-tiktok-audit'),
  TIKTOK_COOKIES_FILE: path.join(REPO_ROOT, '.secrets', 'tiktok-cookies.json'),
  RAW_VIDEO_DIR: path.join(ROOT, 'out', 'raw'),
  FINAL_VIDEO_PATH: path.join(ROOT, 'out', 'fresh-desktop-flow.mp4'),
  STILLS_DIR: path.join(ROOT, 'out', 'stills'),
};
