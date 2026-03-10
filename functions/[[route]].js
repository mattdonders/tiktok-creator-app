/**
 * CreatorPost v2 — Hono catch-all router
 * Handles all dynamic routes: auth, API, OAuth
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono();

// ── Axiom logging ─────────────────────────────────────────────────────────────

function log(c, fields) {
  if (!c.env.AXIOM_TOKEN || !c.env.AXIOM_DATASET) return;
  const req_id  = c.get('req_id') ?? null;
  const user_id = c.get('log_user_id') ?? null;
  const event   = JSON.stringify({ _time: new Date().toISOString(), req_id, user_id, ...fields });
  const p = fetch(`https://api.axiom.co/v1/datasets/${c.env.AXIOM_DATASET}/ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.AXIOM_TOKEN}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: event,
  });
  c.executionCtx.waitUntil(p);
}

// Request logging middleware
app.use('*', async (c, next) => {
  const req_id = crypto.randomUUID().slice(0, 8);
  c.set('req_id', req_id);
  const start = Date.now();
  await next();
  // Attach user_id to request log if session was resolved during the request
  log(c, {
    type:    'request',
    method:  c.req.method,
    path:    new URL(c.req.url).pathname,
    status:  c.res.status,
    ms:      Date.now() - start,
    country: c.req.raw.cf?.country ?? null,
  });
});

// Error handler
app.onError((err, c) => {
  log(c, {
    type:    'error',
    event:   'unhandled_exception',
    message: err.message,
    stack:   err.stack,
    path:    new URL(c.req.url).pathname,
  });
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function newId() { return crypto.randomUUID(); }
function now()   { return Math.floor(Date.now() / 1000); }

async function hashKey(rawKey) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getApiKeySession(c) {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer cp_')) return null;
  const keyHash = await hashKey(auth.slice(7));
  const row = await c.env.DB.prepare(
    'SELECT id, user_id FROM api_keys WHERE key_hash = ?'
  ).bind(keyHash).first();
  if (!row) return null;
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run()
  );
  c.set('log_user_id', row.user_id);
  return { user_id: row.user_id };
}

const SESSION_TTL = 30 * 24 * 60 * 60;  // 30 days
const MAGIC_TTL   = 15 * 60;            // 15 minutes

async function getSession(c) {
  const sid = getCookie(c, 'cp_session');
  if (!sid) return null;
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?'
  ).bind(sid, now()).first();
  if (row) c.set('log_user_id', row.user_id);
  return row ?? null;
}

function sessionCookie(c, sid) {
  setCookie(c, 'cp_session', sid, {
    httpOnly: true, secure: true, sameSite: 'Lax',
    maxAge: SESSION_TTL, path: '/',
  });
}

// ── Auth — magic link ─────────────────────────────────────────────────────────

// POST /auth/send — send magic link email
app.post('/auth/send', async (c) => {
  const { email } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Invalid email' }, 400);
  }

  const token      = newId();
  const expires_at = now() + MAGIC_TTL;

  await c.env.DB.prepare(
    'INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)'
  ).bind(token, email.toLowerCase(), expires_at).run();

  const link = `${new URL(c.req.url).origin}/auth/verify?token=${token}`;

  await sendMagicLink(email, link, c.env);
  log(c, { type: 'event', event: 'magic_link_sent', email });

  return c.json({ ok: true });
});

// GET /auth/verify?token=xxx — consume magic link, create session
app.get('/auth/verify', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.redirect('/login?error=invalid');

  const link = await c.env.DB.prepare(
    'SELECT email, expires_at, used FROM magic_links WHERE token = ?'
  ).bind(token).first();

  if (!link) {
    log(c, { type: 'error', event: 'magic_link_invalid', reason: 'not_found' });
    return c.redirect('/login?error=expired');
  }
  if (link.used) {
    log(c, { type: 'error', event: 'magic_link_invalid', reason: 'already_used', email: link.email });
    return c.redirect('/login?error=expired');
  }
  if (link.expires_at < now()) {
    log(c, { type: 'error', event: 'magic_link_invalid', reason: 'expired', email: link.email });
    return c.redirect('/login?error=expired');
  }

  await c.env.DB.prepare('UPDATE magic_links SET used = 1 WHERE token = ?').bind(token).run();

  // Upsert user
  let user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(link.email).first();
  if (!user) {
    const id = newId();
    await c.env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .bind(id, link.email, now()).run();
    user = { id };
    log(c, { type: 'event', event: 'user_created', email: link.email });
  }

  // Create session
  const sid = newId();
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sid, user.id, now() + SESSION_TTL).run();

  sessionCookie(c, sid);
  return c.redirect('/dashboard');
});

// GET /auth/logout
app.get('/auth/logout', (c) => {
  deleteCookie(c, 'cp_session', { path: '/' });
  return c.redirect('/login');
});

// ── YouTube OAuth ─────────────────────────────────────────────────────────────

app.get('/auth/youtube', async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect('/login');

  if (!c.env.GOOGLE_CLIENT_ID) return c.text('YouTube not configured', 503);

  const origin      = new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback/youtube`;
  const state       = `${session.user_id}:${newId()}`;

  const params = new URLSearchParams({
    client_id:              c.env.GOOGLE_CLIENT_ID,
    redirect_uri:           redirectUri,
    response_type:          'code',
    scope:                  'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type:            'offline',
    prompt:                 'consent',
    state,
    include_granted_scopes: 'true',
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/callback/youtube', async (c) => {
  const code  = c.req.query('code');
  const state = c.req.query('state') ?? '';
  const error = c.req.query('error');

  if (error) {
    log(c, { type: 'error', event: 'youtube_oauth_error', reason: error });
    return c.redirect('/dashboard?error=' + encodeURIComponent(error));
  }
  if (!code) {
    log(c, { type: 'error', event: 'youtube_oauth_error', reason: 'no_code' });
    return c.redirect('/dashboard?error=no_code');
  }

  const userId = state.split(':')[0];
  if (!userId) {
    log(c, { type: 'error', event: 'youtube_oauth_error', reason: 'invalid_state' });
    return c.redirect('/dashboard?error=invalid_state');
  }

  const origin      = new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback/youtube`;

  let tokenData;
  try {
    tokenData = await exchangeGoogleCode(code, redirectUri, c.env);
  } catch (err) {
    log(c, { type: 'error', event: 'youtube_token_exchange_failed', message: err.message, user_id: userId });
    return c.redirect('/dashboard?error=token_failed');
  }

  let channel = {};
  try {
    const result = await fetchYouTubeChannel(tokenData.access_token);
    channel = result.channel;
    log(c, { type: 'event', event: 'youtube_channel_fetched', user_id: userId, channel_title: channel.title ?? null });
  } catch (err) {
    log(c, { type: 'error', event: 'youtube_channel_fetch_failed', message: err.message, user_id: userId });
  }

  const accountId  = newId();
  const expiresAt  = tokenData.expires_in ? now() + tokenData.expires_in : null;

  try {
    await c.env.DB.prepare(`
      INSERT INTO connected_accounts
        (id, user_id, platform, platform_user_id, display_name, avatar_url, access_token, refresh_token, token_expires_at, created_at)
      VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, platform, platform_user_id) DO UPDATE SET
        display_name     = excluded.display_name,
        avatar_url       = excluded.avatar_url,
        access_token     = excluded.access_token,
        refresh_token    = CASE WHEN excluded.refresh_token IS NOT NULL THEN excluded.refresh_token ELSE connected_accounts.refresh_token END,
        token_expires_at = excluded.token_expires_at
    `).bind(
      accountId, userId,
      channel.id ?? null,
      channel.title ?? null,
      channel.avatar_url ?? null,
      tokenData.access_token,
      tokenData.refresh_token ?? null,
      expiresAt,
      now()
    ).run();
  } catch (err) {
    log(c, { type: 'error', event: 'youtube_connect_failed', message: err.message, user_id: userId });
    return c.redirect('/dashboard?error=db_failed');
  }

  log(c, { type: 'event', event: 'youtube_connected', user_id: userId, channel_id: channel.id ?? null, granted_scope: tokenData.scope ?? null });
  return c.redirect('/dashboard');
});

// ── Instagram OAuth ────────────────────────────────────────────────────────────

app.get('/auth/instagram', async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect('/login');

  if (!c.env.INSTAGRAM_APP_ID) return c.text('Instagram not configured', 503);

  const origin      = new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback/instagram`;
  const state       = `${session.user_id}:${newId()}`;

  const params = new URLSearchParams({
    client_id:     c.env.INSTAGRAM_APP_ID,
    redirect_uri:  redirectUri,
    scope:         'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments,instagram_business_manage_messages',
    response_type: 'code',
    state,
  });

  return c.redirect(`https://api.instagram.com/oauth/authorize?${params}`);
});

app.get('/callback/instagram', async (c) => {
  const code  = c.req.query('code');
  const state = c.req.query('state') ?? '';
  const error = c.req.query('error');

  if (error) {
    log(c, { type: 'error', event: 'instagram_oauth_error', reason: error });
    return c.redirect('/dashboard?error=' + encodeURIComponent(error));
  }
  if (!code) {
    log(c, { type: 'error', event: 'instagram_oauth_error', reason: 'no_code' });
    return c.redirect('/dashboard?error=no_code');
  }

  const userId = state.split(':')[0];
  if (!userId) {
    log(c, { type: 'error', event: 'instagram_oauth_error', reason: 'invalid_state' });
    return c.redirect('/dashboard?error=invalid_state');
  }

  const origin      = new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback/instagram`;

  // Exchange code for short-lived token
  let tokenData;
  try {
    tokenData = await exchangeInstagramCode(code, redirectUri, c.env);
  } catch (err) {
    log(c, { type: 'error', event: 'instagram_token_exchange_failed', message: err.message, user_id: userId });
    return c.redirect('/dashboard?error=token_failed');
  }

  // Exchange short-lived for long-lived (60 days)
  let longToken = { access_token: tokenData.access_token, expires_in: 3600 };
  try {
    longToken = await exchangeInstagramLongLived(tokenData.access_token, c.env);
  } catch (err) {
    log(c, { type: 'error', event: 'instagram_longlived_failed', message: err.message, user_id: userId });
  }

  // Fetch profile
  let profile = {};
  try {
    profile = await fetchInstagramProfile(longToken.access_token);
  } catch (err) {
    log(c, { type: 'error', event: 'instagram_profile_fetch_failed', message: err.message, user_id: userId });
  }

  // Use app-scoped 'id' from /me (NOT tokenData.user_id which is Facebook-linked)
  // Required for graph.instagram.com API calls — matches faceless-instagram reference impl
  const igUserId  = String(profile.id ?? tokenData.user_id ?? '');
  const expiresAt = longToken.expires_in ? now() + longToken.expires_in : null;
  const accountId = newId();

  try {
    await c.env.DB.prepare(`
      INSERT INTO connected_accounts
        (id, user_id, platform, platform_user_id, display_name, avatar_url, access_token, token_expires_at, created_at)
      VALUES (?, ?, 'instagram', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, platform, platform_user_id) DO UPDATE SET
        display_name     = excluded.display_name,
        avatar_url       = excluded.avatar_url,
        access_token     = excluded.access_token,
        token_expires_at = excluded.token_expires_at
    `).bind(
      accountId, userId,
      igUserId,
      profile.name ?? null,
      profile.profile_picture_url ?? null,
      longToken.access_token,
      expiresAt,
      now()
    ).run();
  } catch (err) {
    log(c, { type: 'error', event: 'instagram_connect_failed', message: err.message, user_id: userId });
    return c.redirect('/dashboard?error=db_failed');
  }

  log(c, { type: 'event', event: 'instagram_connected', user_id: userId, ig_user_id: igUserId });
  return c.redirect('/dashboard');
});

// ── API — YouTube upload session ───────────────────────────────────────────────

app.post('/api/youtube/upload-session', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { account_id, title, description = '', privacy_status = 'private', file_size, mime_type = 'video/mp4' } = await c.req.json().catch(() => ({}));

  if (!account_id || !title || !file_size) {
    return c.json({ error: 'Missing required fields: account_id, title, file_size' }, 400);
  }

  const account = await c.env.DB.prepare(
    'SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(account_id, session.user_id, 'youtube').first();

  if (!account) {
    log(c, { type: 'error', event: 'youtube_upload_failed', reason: 'account_not_found', account_id, user_id: session.user_id });
    return c.json({ error: 'Account not found' }, 404);
  }

  // Refresh access token if expired
  let accessToken = account.access_token;
  if (account.token_expires_at && account.token_expires_at < now() + 60) {
    try {
      const refreshed = await refreshGoogleToken(account.refresh_token, c.env);
      accessToken     = refreshed.access_token;
      await c.env.DB.prepare(
        'UPDATE connected_accounts SET access_token = ?, token_expires_at = ? WHERE id = ?'
      ).bind(accessToken, now() + refreshed.expires_in, account_id).run();
    } catch (err) {
      log(c, { type: 'error', event: 'youtube_token_refresh_failed', message: err.message, account_id });
      return c.json({ error: 'token_revoked' }, 401);
    }
  }

  const metadata = {
    snippet: {
      title:       title.slice(0, 100),
      description: description.slice(0, 5000),
      categoryId:  '22',
    },
    status: {
      privacyStatus:              privacy_status,
      selfDeclaredMadeForKids:    false,
    },
  };

  const origin = new URL(c.req.url).origin;
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method:  'POST',
      headers: {
        'Authorization':           `Bearer ${accessToken}`,
        'Content-Type':            'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(file_size),
        'X-Upload-Content-Type':   mime_type,
        'Origin':                  origin,
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    log(c, { type: 'error', event: 'youtube_upload_failed', reason: 'init_failed', status: initRes.status, message: errText, user_id: session.user_id });
    if (initRes.status === 401) return c.json({ error: 'token_revoked' }, 401);
    return c.json({ error: 'Failed to initialize YouTube upload' }, 500);
  }

  const uploadUrl = initRes.headers.get('Location');

  // Save post record
  const postId = newId();
  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, created_at)
    VALUES (?, ?, ?, 'youtube', ?, 'processing', ?)
  `).bind(postId, session.user_id, account_id, title, now()).run();

  log(c, { type: 'event', event: 'youtube_upload_initiated', user_id: session.user_id, account_id, post_id: postId });
  return c.json({ upload_url: uploadUrl, post_id: postId });
});

// POST /api/youtube/complete — called by browser after direct upload finishes
app.post('/api/youtube/complete', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { post_id, video_id } = await c.req.json().catch(() => ({}));
  if (!post_id) return c.json({ error: 'Missing post_id' }, 400);

  await c.env.DB.prepare(
    'UPDATE posts SET status = ?, publish_id = ? WHERE id = ? AND user_id = ?'
  ).bind('published', video_id ?? null, post_id, session.user_id).run();

  log(c, { type: 'event', event: 'youtube_upload_complete', user_id: session.user_id, post_id, video_id: video_id ?? null });
  return c.json({ ok: true });
});

// ── API — Instagram upload ─────────────────────────────────────────────────────

const IG_GRAPH = 'https://graph.instagram.com/v21.0';

// Best-effort cleanup of expired R2 temp videos (called opportunistically)
async function cleanupExpiredR2(bucket) {
  try {
    const listed = await bucket.list({ prefix: 'ig-temp/' });
    const expired = listed.objects.filter(obj => {
      const at = parseInt(obj.customMetadata?.cleanup_at ?? '0', 10);
      return at > 0 && at < Date.now();
    });
    if (expired.length) await Promise.all(expired.map(obj => bucket.delete(obj.key)));
  } catch { /* best-effort */ }
}

app.post('/api/instagram/upload', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: 'Invalid form data' }, 400); }

  const videoFile = formData.get('video');
  const caption   = (formData.get('caption') ?? '').slice(0, 2200);
  const accountId = formData.get('account_id');

  if (!videoFile || typeof videoFile === 'string') {
    return c.json({ error: 'No video file provided' }, 400);
  }

  const account = await c.env.DB.prepare(
    'SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(accountId, session.user_id, 'instagram').first();

  if (!account) {
    log(c, { type: 'error', event: 'instagram_upload_failed', reason: 'account_not_found', account_id: accountId, user_id: session.user_id });
    return c.json({ error: 'Account not found' }, 404);
  }

  const accessToken = account.access_token;
  const igUserId    = account.platform_user_id;

  if (!igUserId) {
    log(c, { type: 'error', event: 'instagram_upload_failed', reason: 'no_ig_user_id', account_id: accountId, user_id: session.user_id });
    return c.json({ error: 'Instagram user ID not found — try reconnecting your account' }, 400);
  }

  const videoBytes = await videoFile.arrayBuffer();
  const videoSize  = videoBytes.byteLength;

  if (videoSize > MAX_FILE_SIZE) return c.json({ error: 'File too large (max 50MB)' }, 413);

  if (!c.env.MEDIA_BUCKET || !c.env.R2_PUBLIC_URL) {
    log(c, { type: 'error', event: 'instagram_upload_failed', reason: 'storage_not_configured', user_id: session.user_id });
    return c.json({ error: 'Storage not configured — contact support' }, 503);
  }

  // Opportunistic cleanup of expired temp videos
  c.executionCtx.waitUntil(cleanupExpiredR2(c.env.MEDIA_BUCKET));

  // Step 1: Upload video to R2 for temporary hosting
  const r2Key     = `ig-temp/${newId()}/${videoFile.name || 'video.mp4'}`;
  const cleanupAt = String(Date.now() + 24 * 60 * 60 * 1000); // 24h TTL

  try {
    await c.env.MEDIA_BUCKET.put(r2Key, videoBytes, {
      httpMetadata:   { contentType: videoFile.type || 'video/mp4' },
      customMetadata: { cleanup_at: cleanupAt },
    });
  } catch (err) {
    log(c, { type: 'error', event: 'instagram_upload_failed', reason: 'r2_put_failed', message: err.message, user_id: session.user_id });
    return c.json({ error: 'Failed to store video for upload' }, 500);
  }

  const videoUrl = `${c.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${r2Key}`;

  // Step 2: Create Reels container with video_url
  // NOTE: video_url is the only supported method for Instagram Login tokens.
  // Must use form-encoded body (not JSON) — confirmed from working reference implementation.
  const initParams = new URLSearchParams({
    media_type:    'REELS',
    video_url:     videoUrl,
    caption,
    share_to_feed: 'true',
    access_token:  accessToken,
  });
  const initRes = await fetch(`${IG_GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:   initParams.toString(),
  });

  if (!initRes.ok) {
    const errText = await initRes.text();
    c.executionCtx.waitUntil(c.env.MEDIA_BUCKET.delete(r2Key));
    log(c, { type: 'error', event: 'instagram_upload_failed', reason: 'container_init_failed', status: initRes.status, message: errText, ig_user_id: igUserId, user_id: session.user_id });
    return c.json({ error: 'Failed to initialize Instagram upload' }, 500);
  }

  const initData = await initRes.json();
  if (initData.error) {
    c.executionCtx.waitUntil(c.env.MEDIA_BUCKET.delete(r2Key));
    log(c, { type: 'error', event: 'instagram_upload_failed', reason: 'container_init_api_error', message: initData.error.message, code: initData.error.code, ig_user_id: igUserId, user_id: session.user_id });
    return c.json({ error: initData.error.message ?? 'Instagram init failed' }, 500);
  }

  const containerId = initData.id;

  // Save post record
  const postId = newId();
  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, publish_id, created_at)
    VALUES (?, ?, ?, 'instagram', ?, 'processing', ?, ?)
  `).bind(postId, session.user_id, accountId, caption, containerId, now()).run();

  log(c, { type: 'event', event: 'instagram_upload_initiated', user_id: session.user_id, account_id: accountId, post_id: postId, container_id: containerId });
  return c.json({ container_id: containerId, post_id: postId, r2_key: r2Key });
});

app.get('/api/instagram/status', async (c) => {
  const session     = await getSession(c);
  const containerId = c.req.query('container_id');
  const accountId   = c.req.query('account_id');

  if (!session)     return c.json({ error: 'not_authenticated' }, 401);
  if (!containerId) return c.json({ error: 'Missing container_id' }, 400);

  const account = await c.env.DB.prepare(
    'SELECT access_token FROM connected_accounts WHERE id = ? AND user_id = ?'
  ).bind(accountId, session.user_id).first();

  if (!account) return c.json({ error: 'Account not found' }, 404);

  const params = new URLSearchParams({ fields: 'status_code,status', access_token: account.access_token });
  const res    = await fetch(`${IG_GRAPH}/${containerId}?${params}`);
  const data   = await res.json();
  return c.json(data);
});

app.post('/api/instagram/publish', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { container_id, account_id, post_id, r2_key } = await c.req.json().catch(() => ({}));
  if (!container_id || !account_id) return c.json({ error: 'Missing container_id or account_id' }, 400);

  const account = await c.env.DB.prepare(
    'SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(account_id, session.user_id, 'instagram').first();

  if (!account) return c.json({ error: 'Account not found' }, 404);

  const publishParams = new URLSearchParams({
    creation_id:  container_id,
    access_token: account.access_token,
  });
  const res  = await fetch(`${IG_GRAPH}/${account.platform_user_id}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:   publishParams.toString(),
  });
  const data = await res.json();

  if (!res.ok || data.error) {
    log(c, { type: 'error', event: 'instagram_publish_failed', message: data.error?.message, code: data.error?.code, user_id: session.user_id, account_id });
    return c.json({ error: data.error?.message ?? 'Failed to publish' }, 500);
  }

  // Clean up temp R2 video now that it's been ingested by Instagram
  if (r2_key && c.env.MEDIA_BUCKET) {
    c.executionCtx.waitUntil(c.env.MEDIA_BUCKET.delete(r2_key));
  }

  if (post_id) {
    await c.env.DB.prepare('UPDATE posts SET status = ?, publish_id = ? WHERE id = ? AND user_id = ?')
      .bind('published', data.id ?? container_id, post_id, session.user_id).run();
  }

  log(c, { type: 'event', event: 'instagram_published', user_id: session.user_id, account_id, media_id: data.id, post_id: post_id ?? null });
  return c.json({ ok: true, media_id: data.id, post_id });
});

// ── TikTok OAuth ──────────────────────────────────────────────────────────────

// GET /auth/tiktok — redirect to TikTok
app.get('/auth/tiktok', async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect('/login');

  const clientId = c.env.TIKTOK_CLIENT_ID;
  if (!clientId) return c.text('TikTok not configured', 503);

  const origin      = new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback`;
  const state       = `${session.user_id}:${newId()}`;

  const params = new URLSearchParams({
    client_key:    clientId,
    response_type: 'code',
    scope:         'user.info.basic,video.upload,video.publish',
    redirect_uri:  redirectUri,
    state,
  });

  return c.redirect(`https://www.tiktok.com/v2/auth/authorize?${params}`);
});

// GET /auth/tiktok/callback
app.get('/callback', async (c) => {
  const code  = c.req.query('code');
  const state = c.req.query('state') ?? '';
  const error = c.req.query('error');

  if (error) {
    log(c, { type: 'error', event: 'tiktok_oauth_error', reason: error });
    return c.redirect('/dashboard?error=' + encodeURIComponent(error));
  }
  if (!code) {
    log(c, { type: 'error', event: 'tiktok_oauth_error', reason: 'no_code' });
    return c.redirect('/dashboard?error=no_code');
  }

  const userId = state.split(':')[0];
  if (!userId) {
    log(c, { type: 'error', event: 'tiktok_oauth_error', reason: 'invalid_state' });
    return c.redirect('/dashboard?error=invalid_state');
  }

  const origin      = new URL(c.req.url).origin;
  const redirectUri = `${origin}/callback`;

  // Exchange code for tokens
  let tokenData;
  try {
    tokenData = await exchangeTikTokCode(code, redirectUri, c.env);
  } catch (err) {
    console.error('Token exchange failed:', err);
    log(c, { type: 'error', event: 'tiktok_token_exchange_failed', message: err.message, user_id: userId });
    return c.redirect('/dashboard?error=token_failed');
  }

  // Fetch profile
  let profile = {};
  try {
    const result = await fetchTikTokProfile(tokenData.access_token);
    profile = result.user;
    log(c, { type: 'event', event: 'tiktok_profile_fetched', user_id: userId, display_name: profile.display_name ?? null, avatar_url: profile.avatar_url ?? null, tiktok_error: result.raw?.error?.code ?? null, tiktok_error_message: result.raw?.error?.message ?? null });
  } catch (err) {
    console.error('Profile fetch failed:', err);
    log(c, { type: 'error', event: 'tiktok_profile_fetch_failed', message: err.message, user_id: userId });
  }

  // Upsert connected account
  const accountId = newId();
  try {
  await c.env.DB.prepare(`
    INSERT INTO connected_accounts
      (id, user_id, platform, platform_user_id, display_name, avatar_url, access_token, refresh_token, token_expires_at, created_at)
    VALUES (?, ?, 'tiktok', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, platform, platform_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      avatar_url   = excluded.avatar_url,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at
  `).bind(
    accountId, userId,
    tokenData.open_id,
    profile.display_name ?? null,
    profile.avatar_url ?? null,
    tokenData.access_token,
    tokenData.refresh_token ?? null,
    tokenData.expires_in ? now() + tokenData.expires_in : null,
    now()
  ).run();
  } catch (err) {
    console.error('DB upsert failed:', err);
    log(c, { type: 'error', event: 'tiktok_connect_failed', message: err.message });
    return c.redirect('/dashboard?error=db_failed');
  }

  log(c, { type: 'event', event: 'tiktok_connected', user_id: userId, open_id: tokenData.open_id, granted_scope: tokenData.scope ?? null });
  return c.redirect('/dashboard');
});

// ── API — disconnect account ──────────────────────────────────────────────────

app.post('/api/disconnect', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { account_id } = await c.req.json().catch(() => ({}));
  if (!account_id) {
    log(c, { type: 'error', event: 'disconnect_failed', reason: 'missing_account_id', user_id: session.user_id });
    return c.json({ error: 'Missing account_id' }, 400);
  }

  await c.env.DB.prepare(
    'DELETE FROM connected_accounts WHERE id = ? AND user_id = ?'
  ).bind(account_id, session.user_id).run();

  log(c, { type: 'event', event: 'account_disconnected', account_id, user_id: session.user_id });
  return c.json({ ok: true });
});

// ── API — user ────────────────────────────────────────────────────────────────

app.get('/api/me', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const user = await c.env.DB.prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    .bind(session.user_id).first();

  const accounts = await c.env.DB.prepare(
    'SELECT id, platform, platform_user_id, display_name, avatar_url FROM connected_accounts WHERE user_id = ?'
  ).bind(session.user_id).all();

  return c.json({ user, accounts: accounts.results });
});

// ── API — profile ─────────────────────────────────────────────────────────────

app.patch('/api/profile', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { display_name } = await c.req.json().catch(() => ({}));
  if (typeof display_name !== 'string') return c.json({ error: 'Missing display_name' }, 400);

  const trimmed = display_name.trim().slice(0, 50);
  await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?')
    .bind(trimmed || null, session.user_id).run();

  log(c, { type: 'event', event: 'profile_updated', user_id: session.user_id });
  return c.json({ ok: true, display_name: trimmed || null });
});

// ── API — publish ─────────────────────────────────────────────────────────────

const TIKTOK_INIT_URL       = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const TIKTOK_INBOX_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const TIKTOK_STATUS_URL     = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const MAX_FILE_SIZE         = 50 * 1024 * 1024;

app.post('/api/publish', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: 'Invalid form data' }, 400); }

  const videoFile    = formData.get('video');
  const caption      = (formData.get('caption') ?? '').slice(0, 2200);
  const accountId    = formData.get('account_id');
  const scheduleTime = formData.get('schedule_time') ?? null;

  if (!videoFile || typeof videoFile === 'string') {
    return c.json({ error: 'No video file provided' }, 400);
  }

  const account = await c.env.DB.prepare(
    'SELECT * FROM connected_accounts WHERE id = ? AND user_id = ?'
  ).bind(accountId, session.user_id).first();

  if (!account) {
    log(c, { type: 'error', event: 'publish_failed', reason: 'account_not_found', account_id: accountId, user_id: session.user_id });
    return c.json({ error: 'Account not found' }, 404);
  }

  const videoBytes = await videoFile.arrayBuffer();
  const videoSize  = videoBytes.byteLength;
  if (videoSize > MAX_FILE_SIZE) return c.json({ error: 'File too large (max 50MB)' }, 413);

  const sourceInfo = {
    source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: videoSize, total_chunk_count: 1,
  };
  const postInfo = {
    title: caption, privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_duet: false, disable_comment: false, disable_stitch: false,
    video_cover_timestamp_ms: 1000,
  };
  if (scheduleTime) {
    postInfo.scheduled_publish_time = Math.floor(new Date(scheduleTime).getTime() / 1000);
  }

  // Try direct post, fall back to inbox
  let initRes = await fetch(TIKTOK_INIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ post_info: postInfo, source_info: sourceInfo }),
  });
  let initData  = await initRes.json();
  let usedInbox = false;

  if (!initRes.ok || initData.error?.code !== 'ok') {
    initRes   = await fetch(TIKTOK_INBOX_INIT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ source_info: sourceInfo }),
    });
    initData  = await initRes.json();
    usedInbox = true;
  }

  if (!initRes.ok || initData.error?.code !== 'ok') {
    const tiktokCode = initData.error?.code;
    const isTokenError = initRes.status === 401 || ['access_token_invalid', 'access_token_expired'].includes(tiktokCode);
    log(c, { type: 'error', event: 'publish_failed', reason: isTokenError ? 'token_revoked' : 'tiktok_init_failed', tiktok_error: tiktokCode, tiktok_message: initData.error?.message, user_id: session.user_id, account_id: accountId });
    if (isTokenError) return c.json({ error: 'token_revoked', account_id: accountId }, 401);
    return c.json({ error: initData.error?.message ?? 'Failed to initialize upload', tiktok_raw: initData }, 500);
  }

  const { publish_id, upload_url } = initData.data;

  const uploadRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      'Content-Length': String(videoSize),
    },
    body: videoBytes,
  });

  if (!uploadRes.ok) {
    log(c, { type: 'error', event: 'publish_failed', reason: 'upload_put_failed', upload_status: uploadRes.status, user_id: session.user_id, account_id: accountId });
    return c.json({ error: 'Video upload failed' }, 500);
  }

  // Save post to DB
  const postId = newId();
  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, publish_id, scheduled_at, created_at)
    VALUES (?, ?, ?, 'tiktok', ?, ?, ?, ?, ?)
  `).bind(
    postId, session.user_id, accountId, caption,
    scheduleTime ? 'scheduled' : 'processing',
    publish_id,
    scheduleTime ? Math.floor(new Date(scheduleTime).getTime() / 1000) : null,
    now()
  ).run();

  return c.json({ publish_id, post_id: postId, scheduled: !!scheduleTime, inbox: usedInbox });
});

app.get('/api/publish', async (c) => {
  const session    = await getSession(c);
  const publish_id = c.req.query('publish_id');
  const accountId  = c.req.query('account_id');

  if (!session)    return c.json({ error: 'not_authenticated' }, 401);
  if (!publish_id) return c.json({ error: 'Missing publish_id' }, 400);

  const account = await c.env.DB.prepare(
    'SELECT access_token FROM connected_accounts WHERE id = ? AND user_id = ?'
  ).bind(accountId, session.user_id).first();

  if (!account) return c.json({ error: 'Account not found' }, 404);

  const res  = await fetch(TIKTOK_STATUS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id }),
  });
  const data = await res.json();

  // Update post status in DB if complete/failed
  const status = data.data?.status;
  if (status === 'PUBLISH_COMPLETE' || status === 'DOWNLOAD_COMPLETE') {
    await c.env.DB.prepare('UPDATE posts SET status = ? WHERE publish_id = ?')
      .bind('published', publish_id).run();
  } else if (status === 'FAILED') {
    await c.env.DB.prepare('UPDATE posts SET status = ? WHERE publish_id = ?')
      .bind('failed', publish_id).run();
  }

  return c.json(data.data ?? data);
});

// ── API — posts history ───────────────────────────────────────────────────────

app.get('/api/posts', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const posts = await c.env.DB.prepare(`
    SELECT p.*, a.display_name, a.avatar_url, a.platform_user_id, a.platform
    FROM posts p
    JOIN connected_accounts a ON p.account_id = a.id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
    LIMIT 50
  `).bind(session.user_id).all();

  return c.json(posts.results);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function exchangeTikTokCode(code, redirectUri, env) {
  const body = new URLSearchParams({
    client_key:    env.TIKTOK_CLIENT_ID,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  redirectUri,
  });
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`TikTok token error: ${await res.text()}`);
  return res.json();
}

async function fetchTikTokProfile(accessToken) {
  const res  = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return { user: data.data?.user ?? {}, raw: data };
}

async function exchangeGoogleCode(code, redirectUri, env) {
  const params = new URLSearchParams({
    code,
    client_id:     env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  if (!res.ok) throw new Error(`Google token error: ${await res.text()}`);
  return res.json();
}

async function refreshGoogleToken(refreshToken, env) {
  const params = new URLSearchParams({
    client_id:     env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  if (!res.ok) throw new Error(`Google refresh error: ${await res.text()}`);
  return res.json();
}

async function fetchYouTubeChannel(accessToken) {
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('mine', 'true');
  const res  = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const data = await res.json();
  const item = data.items?.[0];
  return {
    channel: {
      id:         item?.id ?? null,
      title:      item?.snippet?.title ?? null,
      avatar_url: item?.snippet?.thumbnails?.high?.url ?? item?.snippet?.thumbnails?.default?.url ?? null,
    },
    raw: data,
  };
}

async function exchangeInstagramCode(code, redirectUri, env) {
  const body = new URLSearchParams({
    client_id:     env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type:    'authorization_code',
    redirect_uri:  redirectUri,
    code,
  });
  const res = await fetch('https://api.instagram.com/oauth/access_token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) throw new Error(`Instagram token error: ${await res.text()}`);
  return res.json(); // { access_token, token_type, expires_in, permissions, user_id }
}

async function exchangeInstagramLongLived(shortToken, env) {
  const params = new URLSearchParams({
    grant_type:    'ig_exchange_token',
    client_secret: env.INSTAGRAM_APP_SECRET,
    access_token:  shortToken,
  });
  const res = await fetch(`https://graph.instagram.com/access_token?${params}`);
  if (!res.ok) throw new Error(`Instagram long-lived token error: ${await res.text()}`);
  return res.json(); // { access_token, token_type, expires_in }
}

async function fetchInstagramProfile(accessToken) {
  const params = new URLSearchParams({ fields: 'id,name,profile_picture_url', access_token: accessToken });
  const res    = await fetch(`https://graph.instagram.com/me?${params}`);
  const data   = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data; // { id, name, profile_picture_url }
}

async function sendMagicLink(email, link, env) {
  if (!env.RESEND_API_KEY) {
    console.log(`[DEV] Magic link for ${email}: ${link}`);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'CreatorPost <noreply@creatorpost.app>',
      to:      email,
      subject: 'Your CreatorPost login link',
      html:    `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
          <h2 style="color:#7c3aed">CreatorPost</h2>
          <p>Click the link below to sign in. This link expires in 15 minutes.</p>
          <a href="${link}" style="display:inline-block;background:#7c3aed;color:#fff;padding:0.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:600;margin:1rem 0">
            Sign in to CreatorPost
          </a>
          <p style="color:#888;font-size:0.875rem">If you didn't request this, you can ignore this email.</p>
        </div>
      `,
    }),
  });
}

// ── API Keys ──────────────────────────────────────────────────────────────────

app.post('/api/keys', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { label } = await c.req.json().catch(() => ({}));

  const bytes  = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const rawKey  = `cp_${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const keyHash = await hashKey(rawKey);
  const prefix  = rawKey.slice(0, 12); // "cp_" + 9 chars for display

  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(newId(), session.user_id, keyHash, prefix, label ?? null, now()).run();

  return c.json({ key: rawKey, prefix, label: label ?? null });
});

app.get('/api/keys', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { results } = await c.env.DB.prepare(
    'SELECT id, key_prefix, label, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(session.user_id).all();

  return c.json(results);
});

app.delete('/api/keys/:id', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  await c.env.DB.prepare(
    'DELETE FROM api_keys WHERE id = ? AND user_id = ?'
  ).bind(c.req.param('id'), session.user_id).run();

  return c.json({ ok: true });
});

// ── Public API v1 (Bearer key auth) ──────────────────────────────────────────

app.get('/api/v1/accounts', async (c) => {
  const session = await getApiKeySession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const { results } = await c.env.DB.prepare(
    'SELECT id, platform, display_name, platform_user_id FROM connected_accounts WHERE user_id = ? ORDER BY platform, display_name'
  ).bind(session.user_id).all();

  return c.json(results);
});

app.post('/api/v1/publish', async (c) => {
  const session = await getApiKeySession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: 'Invalid form data' }, 400); }

  const videoFile   = formData.get('video');
  const videoUrl    = formData.get('video_url') ?? null;
  const caption     = (formData.get('caption') ?? '').slice(0, 2200);
  const accountId   = formData.get('account_id') ?? null;
  const accountName = formData.get('account') ?? null;
  const platform    = formData.get('platform') ?? 'tiktok';

  if (!videoFile && !videoUrl) return c.json({ error: 'Provide video file or video_url' }, 400);

  // Look up account by id or display_name
  const account = accountId
    ? await c.env.DB.prepare('SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?').bind(accountId, session.user_id, platform).first()
    : await c.env.DB.prepare('SELECT * FROM connected_accounts WHERE display_name = ? AND user_id = ? AND platform = ?').bind(accountName, session.user_id, platform).first();

  if (!account) return c.json({ error: 'Account not found' }, 404);

  // Resolve video URL — upload file to R2 if needed
  let finalVideoUrl = videoUrl;
  if (videoFile && typeof videoFile !== 'string') {
    const videoBytes = await videoFile.arrayBuffer();
    const r2Key = `api-uploads/${newId()}/${videoFile.name || 'video.mp4'}`;
    await c.env.MEDIA_BUCKET.put(r2Key, videoBytes, {
      httpMetadata:   { contentType: videoFile.type || 'video/mp4' },
      customMetadata: { cleanup_at: String(Date.now() + 24 * 60 * 60 * 1000) },
    });
    finalVideoUrl = `${c.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${r2Key}`;
  }

  // TikTok: PULL_FROM_URL (no chunked upload needed)
  const sourceInfo = { source: 'PULL_FROM_URL', video_url: finalVideoUrl };
  const postInfo   = {
    title: caption, privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_duet: false, disable_comment: false, disable_stitch: false,
    video_cover_timestamp_ms: 1000,
  };

  let initRes = await fetch(TIKTOK_INIT_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body:    JSON.stringify({ post_info: postInfo, source_info: sourceInfo }),
  });
  let initData  = await initRes.json();
  let usedInbox = false;

  if (!initRes.ok || initData.error?.code !== 'ok') {
    initRes = await fetch(TIKTOK_INBOX_INIT_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body:    JSON.stringify({ source_info: sourceInfo }),
    });
    initData  = await initRes.json();
    usedInbox = true;
  }

  if (!initRes.ok || initData.error?.code !== 'ok') {
    const tiktokCode = initData.error?.code;
    log(c, { type: 'error', event: 'api_publish_failed', platform, tiktok_error: tiktokCode, user_id: session.user_id });
    return c.json({ error: initData.error?.message ?? 'TikTok init failed', tiktok_raw: initData }, 500);
  }

  const { publish_id } = initData.data;
  const postId = newId();

  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, publish_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
  `).bind(postId, session.user_id, account.id, platform, caption, publish_id, now()).run();

  log(c, { type: 'event', event: 'api_publish', platform, account_id: account.id, user_id: session.user_id, inbox: usedInbox });

  return c.json({ publish_id, post_id: postId, inbox: usedInbox });
});

// ── Export for Cloudflare Pages ───────────────────────────────────────────────

export const onRequest = (context) => {
  return app.fetch(context.request, context.env, context);
};
