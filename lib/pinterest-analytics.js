// Read-only Pinterest organic analytics support for owner-operated campaigns.
//
// This module deliberately keeps campaign analytics OUT of the publisher job table.
// It resolves one owned board alias against Pinterest's live board list, then reads
// that board's Pins with `pin_metrics=true`. The caller may persist dated snapshots
// outside CreatorPost. No Pinterest identifier or analytics payload is written here.

import { assertProductionUrl, PINTEREST_PRODUCTION_HOST, PINTEREST_PRODUCTION_PUID } from './pinterest-production.js';
import { listBoards } from './pinterest-publish.js';
import { resolveBoardMatch, BOARD_UNKNOWN_ALIAS } from './pinterest-boards.js';

const PINTEREST_PRODUCTION_API_BASE = `https://${PINTEREST_PRODUCTION_HOST}/v5`;
const MAX_PIN_PAGES = 10;

function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

function numericMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, metric] of Object.entries(value)) {
    if (typeof metric === 'number' && Number.isFinite(metric)) out[key] = metric;
  }
  return out;
}

export function sanitizePinForAnalytics(pin) {
  if (!pin || typeof pin.id !== 'string' || pin.id.length === 0) return null;
  const values = Array.isArray(pin.ai_disclosures?.values)
    ? pin.ai_disclosures.values.filter((value) => typeof value === 'string')
    : [];
  return {
    id: pin.id,
    created_at: optionalString(pin.created_at),
    link: optionalString(pin.link),
    title: optionalString(pin.title),
    alt_text: optionalString(pin.alt_text),
    ai_disclosures: values,
    pin_metrics: {
      '90d': numericMetrics(pin.pin_metrics?.['90d']),
      lifetime_metrics: numericMetrics(pin.pin_metrics?.lifetime_metrics),
    },
  };
}

// Pinterest's official List Pins on board endpoint. `pin_metrics=true` returns the
// fixed rolling-90-day and lifetime summaries while we discover Pin IDs/links.
// Pagination is bounded and every request is host-locked to api.pinterest.com.
export async function listBoardPinsWithMetrics(
  fetchImpl,
  accessToken,
  boardId,
  apiBase = PINTEREST_PRODUCTION_API_BASE,
) {
  const pins = [];
  let bookmark = null;
  for (let page = 0; page < MAX_PIN_PAGES; page++) {
    const url = new URL(`${apiBase}/boards/${encodeURIComponent(String(boardId))}/pins`);
    url.searchParams.set('page_size', '25');
    url.searchParams.set('pin_metrics', 'true');
    if (bookmark) url.searchParams.set('bookmark', bookmark);
    const target = url.toString();
    assertProductionUrl(target);
    const response = await fetchImpl(target, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`pin_list_status_${response.status}`);
    const body = await response.json();
    for (const item of body.items ?? []) {
      const pin = sanitizePinForAnalytics(item);
      if (pin) pins.push(pin);
    }
    bookmark = body.bookmark || null;
    if (!bookmark) break;
  }
  return pins;
}

export async function loadPinterestAnalyticsAccount(DB) {
  return DB.prepare(
    `SELECT id, access_token, token_expires_at
       FROM connected_accounts
      WHERE platform = 'pinterest' AND platform_user_id = ?
      LIMIT 1`,
  ).bind(PINTEREST_PRODUCTION_PUID).first();
}

// Returns a sanitized route-ready result. All network operations are GETs; errors
// use local categories and never include tokens or raw Pinterest response bodies.
export async function loadBoardPinAnalytics(deps, boardAlias) {
  const { DB, fetchImpl = fetch, aliasMap, nowSec } = deps;
  if (!aliasMap?.[boardAlias]) {
    return { ok: false, status: 400, error: BOARD_UNKNOWN_ALIAS };
  }

  const account = await loadPinterestAnalyticsAccount(DB);
  if (!account?.access_token ||
      (typeof account.token_expires_at === 'number' && account.token_expires_at <= nowSec)) {
    return { ok: false, status: 409, error: 'reconnect_required' };
  }

  let boards;
  try {
    boards = await listBoards(fetchImpl, account.access_token);
  } catch {
    return { ok: false, status: 502, error: 'board_list_failed' };
  }
  const match = resolveBoardMatch(boardAlias, boards, aliasMap);
  if (!match.ok) return { ok: false, status: 409, error: match.reason };

  let pins;
  try {
    pins = await listBoardPinsWithMetrics(fetchImpl, account.access_token, match.boardId);
  } catch {
    return { ok: false, status: 502, error: 'pin_analytics_read_failed' };
  }
  return {
    ok: true,
    status: 200,
    board_alias: boardAlias,
    board_name: aliasMap[boardAlias],
    captured_at: new Date(nowSec * 1000).toISOString(),
    count: pins.length,
    pins,
  };
}
