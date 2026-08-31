// Account-scoped, read-only TikTok analytics loader.
//
// The access token is read from D1 and used only inside this module. Returned
// objects are allowlisted and never contain token material or raw upstream data.

export const TIKTOK_ANALYTICS_VIDEO_FIELDS = Object.freeze([
  'id',
  'create_time',
  'video_description',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
  'duration',
  'is_aigc',
]);

export const TIKTOK_ANALYTICS_ACCOUNT_FIELDS = Object.freeze([
  'open_id',
  'display_name',
  'username',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
]);

const API_ROOT = 'https://open.tiktokapis.com/v2';
const DEFAULT_MAX_COUNT = 20;
const MAX_COUNT = 20;

function countOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function textOrNull(value, maxLength = 2200) {
  if (typeof value !== 'string') return null;
  return value.slice(0, maxLength);
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeUpstreamCode(value) {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
  return normalized || 'unknown';
}

function isoFromUnix(value) {
  const seconds = countOrNull(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeTikTokAnalyticsQuery({ cursor, maxCount } = {}) {
  const normalizedMax = maxCount === undefined || maxCount === null || maxCount === ''
    ? DEFAULT_MAX_COUNT
    : Number(maxCount);
  const normalizedCursor = cursor === undefined || cursor === null || cursor === ''
    ? null
    : Number(cursor);

  if (!Number.isInteger(normalizedMax) || normalizedMax < 1 || normalizedMax > MAX_COUNT) {
    return { ok: false, status: 400, error: 'invalid_pagination' };
  }
  if (normalizedCursor !== null
      && (!Number.isSafeInteger(normalizedCursor) || normalizedCursor < 0)) {
    return { ok: false, status: 400, error: 'invalid_pagination' };
  }
  return { ok: true, cursor: normalizedCursor, max_count: normalizedMax };
}

export function sanitizeTikTokVideo(video) {
  const videoId = video?.id === undefined || video?.id === null ? null : String(video.id);
  return {
    video_id: videoId,
    published_at: isoFromUnix(video?.create_time),
    description: textOrNull(video?.video_description),
    views: countOrNull(video?.view_count),
    likes: countOrNull(video?.like_count),
    comments: countOrNull(video?.comment_count),
    shares: countOrNull(video?.share_count),
    duration_seconds: countOrNull(video?.duration),
    is_aigc: booleanOrNull(video?.is_aigc),
  };
}

function parseTikTokJson(text) {
  // TikTok video IDs exceed JavaScript's exact integer range. Quote only long
  // JSON integer values before parsing so IDs remain lossless strings.
  return JSON.parse(String(text).replace(/:(\s*)(\d{16,})/g, ':"$2"'));
}

async function readTikTokResponse(response) {
  try {
    return parseTikTokJson(await response.text());
  } catch {
    return null;
  }
}

function upstreamFailure(stage, response, payload) {
  return {
    ok: false,
    status: response?.status === 429 ? 429 : 502,
    error: `tiktok_${stage}_failed`,
    upstream_code: safeUpstreamCode(payload?.error?.code),
  };
}

export async function loadTikTokAccountAnalytics(
  { DB, fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000) },
  userId,
  accountId,
  query = {},
) {
  const page = normalizeTikTokAnalyticsQuery(query);
  if (!page.ok) return page;

  const account = await DB.prepare(`
    SELECT id, display_name, username, access_token, token_expires_at
    FROM connected_accounts
    WHERE id = ? AND user_id = ? AND platform = 'tiktok'
    LIMIT 1
  `).bind(accountId, userId).first();

  if (!account?.access_token) {
    return { ok: false, status: 404, error: 'account_not_found' };
  }
  if (account.token_expires_at && Number(account.token_expires_at) <= nowSec) {
    return { ok: false, status: 409, error: 'tiktok_reconnect_required' };
  }

  const headers = { Authorization: `Bearer ${account.access_token}` };
  const accountUrl = `${API_ROOT}/user/info/?fields=${TIKTOK_ANALYTICS_ACCOUNT_FIELDS.join(',')}`;
  let accountResponse;
  try {
    accountResponse = await fetchImpl(accountUrl, { headers });
  } catch {
    return { ok: false, status: 502, error: 'tiktok_user_info_failed', upstream_code: 'network_error' };
  }
  const accountPayload = await readTikTokResponse(accountResponse);
  if (!accountResponse.ok || accountPayload?.error?.code !== 'ok') {
    return upstreamFailure('user_info', accountResponse, accountPayload);
  }

  const listBody = { max_count: page.max_count };
  if (page.cursor !== null) listBody.cursor = page.cursor;
  const listUrl = `${API_ROOT}/video/list/?fields=${TIKTOK_ANALYTICS_VIDEO_FIELDS.join(',')}`;
  let listResponse;
  try {
    listResponse = await fetchImpl(listUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(listBody),
    });
  } catch {
    return { ok: false, status: 502, error: 'tiktok_video_list_failed', upstream_code: 'network_error' };
  }
  const listPayload = await readTikTokResponse(listResponse);
  if (!listResponse.ok || listPayload?.error?.code !== 'ok') {
    return upstreamFailure('video_list', listResponse, listPayload);
  }

  const upstreamUser = accountPayload?.data?.user ?? {};
  const videos = (listPayload?.data?.videos ?? [])
    .map(sanitizeTikTokVideo)
    .filter((video) => video.video_id !== null);

  return {
    ok: true,
    status: 200,
    observed_at: new Date(nowSec * 1000).toISOString(),
    account: {
      account_id: account.id,
      platform: 'tiktok',
      username: textOrNull(upstreamUser.username ?? account.username, 160),
      display_name: textOrNull(upstreamUser.display_name ?? account.display_name, 160),
      followers: countOrNull(upstreamUser.follower_count),
      following: countOrNull(upstreamUser.following_count),
      likes: countOrNull(upstreamUser.likes_count),
      video_count: countOrNull(upstreamUser.video_count),
    },
    page: {
      requested_cursor: page.cursor,
      returned_count: videos.length,
      has_more: Boolean(listPayload?.data?.has_more),
      next_cursor: countOrNull(listPayload?.data?.cursor),
      max_count: page.max_count,
    },
    videos,
    unavailable_fields: [
      'saves',
      'per_post_follows',
      'profile_views',
      'average_watch_time',
      'completion_rate',
      'traffic_source',
    ],
  };
}
