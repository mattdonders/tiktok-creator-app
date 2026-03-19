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
    'SELECT user_id, expires_at FROM sessions WHERE id = ? AND expires_at > ?'
  ).bind(sid, now()).first();
  if (row) {
    c.set('log_user_id', row.user_id);
    // Rolling session: reset cookie max-age on every request
    sessionCookie(c, sid);
    // Extend DB expiry if less than 15 days remain
    const refreshThreshold = now() + (SESSION_TTL / 2);
    if (row.expires_at < refreshThreshold) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
          .bind(now() + SESSION_TTL, sid).run()
      );
    }
  }
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
    c.executionCtx.waitUntil(sendWelcomeEmail(link.email, c.env));
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
    scope:         'user.info.basic,user.info.profile,user.info.stats,video.upload,video.publish,video.list',
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
      (id, user_id, platform, platform_user_id, display_name, avatar_url, username, access_token, refresh_token, token_expires_at, created_at)
    VALUES (?, ?, 'tiktok', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, platform, platform_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      avatar_url   = excluded.avatar_url,
      username     = excluded.username,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at
  `).bind(
    accountId, userId,
    tokenData.open_id,
    profile.display_name ?? null,
    profile.avatar_url ?? null,
    profile.username ?? null,
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
    'DELETE FROM posts WHERE account_id = ? AND user_id = ?'
  ).bind(account_id, session.user_id).run();

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
    'SELECT id, platform, platform_user_id, display_name, avatar_url, username, token_expires_at FROM connected_accounts WHERE user_id = ?'
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
const TIKTOK_PHOTO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/content/init/';
const TIKTOK_STATUS_URL     = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const MAX_FILE_SIZE         = 50 * 1024 * 1024;

app.post('/api/publish', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: 'Invalid form data' }, 400); }

  const videoFile      = formData.get('video');
  const videoUrl       = formData.get('video_url') ?? null;
  const caption        = (formData.get('caption') ?? '').slice(0, 2200);
  const accountId      = formData.get('account_id');
  const scheduleTime   = formData.get('schedule_time') ?? null;
  const privacyLevel   = formData.get('privacy_level') ?? 'SELF_ONLY';
  const disableComment = formData.get('disable_comment') === 'true';
  const disableDuet    = formData.get('disable_duet') === 'true';
  const disableStitch  = formData.get('disable_stitch') === 'true';
  const brandContent   = formData.get('brand_content_toggle') === 'true';
  const brandOrganic   = formData.get('brand_organic_toggle') === 'true';

  const hasFile = videoFile && typeof videoFile !== 'string';
  const hasUrl  = typeof videoUrl === 'string' && videoUrl.startsWith('http');

  if (!hasFile && !hasUrl) return c.json({ error: 'No video file or URL provided' }, 400);

  // URL-based publish is restricted to @mattdonders.com accounts
  if (hasUrl && !hasFile) {
    const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
    if (!user?.email?.endsWith('@mattdonders.com')) return c.json({ error: 'URL publishing is not available' }, 403);
  }

  const account = await c.env.DB.prepare(
    'SELECT * FROM connected_accounts WHERE id = ? AND user_id = ?'
  ).bind(accountId, session.user_id).first();

  if (!account) {
    log(c, { type: 'error', event: 'publish_failed', reason: 'account_not_found', account_id: accountId, user_id: session.user_id });
    return c.json({ error: 'Account not found' }, 404);
  }

  let videoBytes, videoSize, sourceInfo;
  if (hasUrl) {
    sourceInfo = { source: 'PULL_FROM_URL', video_url: videoUrl };
  } else {
    videoBytes = await videoFile.arrayBuffer();
    videoSize  = videoBytes.byteLength;
    if (videoSize > MAX_FILE_SIZE) return c.json({ error: 'File too large (max 50MB)' }, 413);
    sourceInfo = { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: videoSize, total_chunk_count: 1 };
  }
  const postInfo = {
    title: caption, privacy_level: privacyLevel,
    disable_duet: disableDuet, disable_comment: disableComment, disable_stitch: disableStitch,
    video_cover_timestamp_ms: 1000,
  };
  if (brandContent || brandOrganic) {
    postInfo.brand_content_toggle = brandContent;
    postInfo.brand_organic_toggle = brandOrganic;
  }
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

  if (!hasUrl && upload_url) {
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
  const status  = data.data?.status;
  // Note: TikTok typo'd "publicaly" in their API response — this is intentional
  const videoId = data.data?.publicaly_available_post_id?.[0] ?? null;
  if (status === 'PUBLISH_COMPLETE' || status === 'DOWNLOAD_COMPLETE') {
    await c.env.DB.prepare('UPDATE posts SET status = ?, video_id = ? WHERE publish_id = ?')
      .bind('published', videoId, publish_id).run();
  } else if (status === 'SEND_TO_USER_INBOX') {
    await c.env.DB.prepare('UPDATE posts SET status = ? WHERE publish_id = ?')
      .bind('inbox', publish_id).run();
  } else if (status === 'FAILED') {
    await c.env.DB.prepare('UPDATE posts SET status = ? WHERE publish_id = ?')
      .bind('failed', publish_id).run();
  }

  return c.json(data.data ?? data);
});

// ── API — TikTok creator info ─────────────────────────────────────────────────

// GET /api/tiktok/creator_info?account_id=xxx
// Returns privacy options, interaction flags, max duration for the UI
app.get('/api/tiktok/creator_info', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const account_id = c.req.query('account_id');
  if (!account_id) return c.json({ error: 'Missing account_id' }, 400);

  const account = await c.env.DB.prepare(
    'SELECT access_token FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(account_id, session.user_id, 'tiktok').first();

  if (!account) return c.json({ error: 'Account not found' }, 404);

  const res = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
  });
  const data = await res.json();

  if (data.error?.code !== 'ok') {
    log(c, { type: 'error', event: 'creator_info_failed', account_id, error_code: data.error?.code });
    return c.json({ error: data.error?.message ?? 'Failed to fetch creator info' }, 502);
  }

  return c.json(data.data ?? {});
});

// ── API — hashtag sets ────────────────────────────────────────────────────────

app.get('/api/hashtag-sets', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, hashtags, created_at FROM hashtag_sets WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(session.user_id).all();
  return c.json(results);
});

app.post('/api/hashtag-sets', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const { name, hashtags } = await c.req.json().catch(() => ({}));
  if (!name?.trim())     return c.json({ error: 'Name is required.' }, 400);
  if (!hashtags?.trim()) return c.json({ error: 'Hashtags are required.' }, 400);
  const id = newId();
  await c.env.DB.prepare(
    'INSERT INTO hashtag_sets (id, user_id, name, hashtags, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, session.user_id, name.trim(), hashtags.trim(), now()).run();
  return c.json({ id, name: name.trim(), hashtags: hashtags.trim() });
});

app.delete('/api/hashtag-sets/:id', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  await c.env.DB.prepare(
    'DELETE FROM hashtag_sets WHERE id = ? AND user_id = ?'
  ).bind(c.req.param('id'), session.user_id).run();
  return c.json({ ok: true });
});

// ── API — AI caption generator ───────────────────────────────────────────────

app.post('/api/ai/caption', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'AI not configured' }, 503);

  const { description, platforms, existing_caption } = await c.req.json().catch(() => ({}));
  if (!description?.trim()) return c.json({ error: 'Please describe your video first.' }, 400);

  const platformList = Array.isArray(platforms) && platforms.length
    ? platforms.join(', ')
    : 'TikTok';

  const userContent = [
    `Video description: ${description.trim()}`,
    existing_caption?.trim() ? `Draft caption (refine this): ${existing_caption.trim()}` : null,
    `Target platform(s): ${platformList}`,
  ].filter(Boolean).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         c.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      temperature: 0,
      system: `You are a social media caption writer for short-form video creators.
Write a caption based ONLY on what the user describes. Do not invent facts, claims, statistics, or details that are not explicitly provided.
Guidelines:
- TikTok/Instagram: punchy opening hook, 3-5 relevant hashtags at the end, conversational tone, max ~300 chars before hashtags
- YouTube: slightly longer, SEO-friendly phrasing, 2-3 hashtags
- If multiple platforms, write one caption that works across all of them
- Always put a blank line between the caption body and the hashtags
- Never use em-dashes (--) or en-dashes. Use a comma or period instead.
- Return ONLY the caption text. No explanations, no alternatives, no quotes around the output.`,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    log(c, { type: 'error', event: 'ai_caption_failed', status: res.status, error: data?.error?.message });
    return c.json({ error: 'Caption generation failed — try again.' }, 502);
  }

  const caption = data.content?.[0]?.text?.trim() ?? '';
  log(c, { type: 'event', event: 'ai_caption_generated', platforms: platformList });
  return c.json({ caption });
});

// ── API — posts history ───────────────────────────────────────────────────────

app.get('/api/posts', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const cursor     = c.req.query('cursor');
  const platform   = c.req.query('platform');
  const account_id = c.req.query('account_id');
  const limit      = Math.min(parseInt(c.req.query('limit') ?? '50'), 100);

  const conditions = ['p.user_id = ?'];
  const params     = [session.user_id];

  if (platform)   { conditions.push('p.platform = ?');   params.push(platform); }
  if (account_id) { conditions.push('p.account_id = ?'); params.push(account_id); }
  if (cursor)     { conditions.push('p.created_at < ?'); params.push(parseInt(cursor)); }

  params.push(limit);

  const { results } = await c.env.DB.prepare(`
    SELECT p.*, a.display_name, a.avatar_url, a.platform_user_id, a.platform
    FROM posts p
    JOIN connected_accounts a ON p.account_id = a.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.created_at DESC
    LIMIT ?
  `).bind(...params).all();

  return c.json(results);
});

app.get('/api/posts/aggregate', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const platform   = c.req.query('platform');
  const account_id = c.req.query('account_id');

  const conditions = ['user_id = ?'];
  const params     = [session.user_id];
  if (platform)   { conditions.push('platform = ?');   params.push(platform); }
  if (account_id) { conditions.push('account_id = ?'); params.push(account_id); }

  const { results } = await c.env.DB.prepare(`
    SELECT platform, status, COUNT(*) as count
    FROM posts
    WHERE ${conditions.join(' AND ')}
    GROUP BY platform, status
  `).bind(...params).all();

  const by_platform = {};
  const by_status   = {};
  let total = 0;

  for (const row of results) {
    by_platform[row.platform] = (by_platform[row.platform] ?? 0) + row.count;
    by_status[row.status]     = (by_status[row.status]     ?? 0) + row.count;
    total += row.count;
  }

  return c.json({ by_platform, by_status, total });
});

// DELETE /api/posts/:id
app.delete('/api/posts/:id', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    'DELETE FROM posts WHERE id = ? AND user_id = ?'
  ).bind(id, session.user_id).run();
  if (!result.meta.changes) return c.json({ error: 'Not found' }, 404);
  log(c, { type: 'event', event: 'post_deleted', post_id: id, user_id: session.user_id });
  return c.json({ ok: true });
});

// POST /api/posts/:id/fetch-caption — dev only, re-fetches oEmbed caption for a published TikTok post
app.post('/api/posts/:id/fetch-caption', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user?.email?.endsWith('@mattdonders.com')) return c.json({ error: 'forbidden' }, 403);

  const postId = c.req.param('id');
  const post = await c.env.DB.prepare('SELECT video_id FROM posts WHERE id = ? AND user_id = ?')
    .bind(postId, session.user_id).first();
  if (!post?.video_id) return c.json({ error: 'Post not found or no video_id' }, 404);

  try {
    const oe     = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/video/${post.video_id}`)}`);
    const data   = await oe.json();
    const caption = data.title ?? '';
    if (!caption) return c.json({ caption: '' });
    await c.env.DB.prepare('UPDATE posts SET caption = ? WHERE id = ?').bind(caption, postId).run();
    return c.json({ caption });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/posts/seed — dev only (@mattdonders.com), seeds a published post from a TikTok URL
app.post('/api/posts/seed', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user?.email?.endsWith('@mattdonders.com')) return c.json({ error: 'forbidden' }, 403);

  const { tiktok_url, account_id, caption } = await c.req.json().catch(() => ({}));
  if (!tiktok_url || !account_id) return c.json({ error: 'tiktok_url and account_id required' }, 400);

  let resolvedUrl = tiktok_url;
  if (!tiktok_url.includes('/video/')) {
    // Short URL — follow redirect to get full URL
    const r = await fetch(tiktok_url, { method: 'HEAD', redirect: 'follow' });
    resolvedUrl = r.url;
  }
  const match = resolvedUrl.match(/video\/(\d+)/);
  if (!match) return c.json({ error: 'Could not extract video ID from URL' }, 400);
  const video_id = match[1];

  const account = await c.env.DB.prepare(
    'SELECT id FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(account_id, session.user_id, 'tiktok').first();
  if (!account) return c.json({ error: 'Account not found' }, 404);

  // Fetch caption from oEmbed if not provided
  let resolvedCaption = caption ?? '';
  if (!resolvedCaption) {
    try {
      const oe = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(resolvedUrl)}`);
      const oeData = await oe.json();
      resolvedCaption = oeData.title ?? '';
    } catch { /* best effort */ }
  }

  const postId = newId();
  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, video_id, created_at)
    VALUES (?, ?, ?, 'tiktok', ?, 'published', ?, ?)
  `).bind(postId, session.user_id, account_id, resolvedCaption, video_id, now()).run();

  return c.json({ ok: true, post_id: postId, video_id });
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

async function refreshTikTokToken(refreshToken, env) {
  const body = new URLSearchParams({
    client_key:    env.TIKTOK_CLIENT_ID,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`TikTok refresh error: ${await res.text()}`);
  return res.json();
}

async function fetchTikTokProfile(accessToken) {
  const res  = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,username',
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

async function sendWelcomeEmail(email, env) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'CreatorPost <noreply@creatorpost.app>',
      to:      email,
      subject: 'Welcome to CreatorPost',
      html:    `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
          <h2 style="color:#7c3aed">Welcome to CreatorPost 🎉</h2>
          <p>You're in! CreatorPost lets you publish videos to TikTok, YouTube, and Instagram from one dashboard.</p>
          <p>Get started by connecting your accounts:</p>
          <a href="https://creatorpost.app/account" style="display:inline-block;background:#7c3aed;color:#fff;padding:0.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:600;margin:1rem 0">
            Connect your accounts
          </a>
          <p style="color:#888;font-size:0.875rem">Questions? Reply to this email or reach out at matt@mattdonders.com</p>
        </div>
      `,
    }),
  }).catch(() => {}); // best-effort
}

// ── API — post stats ─────────────────────────────────────────────────────────

app.get('/api/posts/stats', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  // Get published TikTok posts that have a resolved video_id
  const idsParam = c.req.query('ids');
  let results;

  if (idsParam) {
    const ids = idsParam.split(',').filter(Boolean).slice(0, 100);
    const placeholders = ids.map(() => '?').join(',');
    ({ results } = await c.env.DB.prepare(`
      SELECT p.id, p.video_id, a.access_token
      FROM posts p
      JOIN connected_accounts a ON p.account_id = a.id
      WHERE p.user_id = ? AND p.video_id IS NOT NULL AND p.platform = 'tiktok'
        AND p.id IN (${placeholders})
      ORDER BY p.created_at DESC
    `).bind(session.user_id, ...ids).all());
  } else {
    ({ results } = await c.env.DB.prepare(`
      SELECT p.id, p.video_id, a.access_token
      FROM posts p
      JOIN connected_accounts a ON p.account_id = a.id
      WHERE p.user_id = ? AND p.video_id IS NOT NULL AND p.platform = 'tiktok'
      ORDER BY p.created_at DESC
      LIMIT 50
    `).bind(session.user_id).all());
  }

  if (!results.length) return c.json({});

  // Group by access_token — each account needs its own API call
  const byToken = {};
  for (const row of results) {
    if (!byToken[row.access_token]) byToken[row.access_token] = [];
    byToken[row.access_token].push(row);
  }

  const debug = c.req.query('debug') === '1';
  const statsMap = {}; // keyed by post UUID
  const debugInfo = [];
  for (const [token, rows] of Object.entries(byToken)) {
    const videoIds = rows.map(r => r.video_id);
    // TikTok video/query max is 20 IDs per request — batch accordingly
    for (let i = 0; i < videoIds.length; i += 20) {
      const batch = videoIds.slice(i, i + 20);
      const res  = await fetch('https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body:    JSON.stringify({ filters: { video_ids: batch } }),
      });
      const data = await res.json();
      if (debug) debugInfo.push({ video_ids_sent: batch, tiktok_response: data });
      for (const v of data.data?.videos ?? []) {
        const row = rows.find(r => r.video_id === v.id);
        if (row) statsMap[row.id] = {
          views:    v.view_count    ?? 0,
          likes:    v.like_count    ?? 0,
          comments: v.comment_count ?? 0,
          shares:   v.share_count   ?? 0,
        };
      }
    }
  }

  if (debug) return c.json({ statsMap, debug: debugInfo });
  return c.json(statsMap);
});

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

app.get('/api/v1/stats', async (c) => {
  const session = await getApiKeySession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const { results } = await c.env.DB.prepare(`
    SELECT p.id, p.video_id, p.caption, p.status, p.created_at,
           a.id AS account_id, a.display_name AS account, a.access_token,
           a.follower_count, a.follower_count_updated_at
    FROM posts p
    JOIN connected_accounts a ON p.account_id = a.id
    WHERE p.user_id = ? AND p.video_id IS NOT NULL AND p.platform = 'tiktok'
    ORDER BY p.created_at DESC
    LIMIT 100
  `).bind(session.user_id).all();

  if (!results.length) return c.json([]);

  // Group by access_token for batched TikTok API calls
  const byToken = {};
  for (const row of results) {
    if (!byToken[row.access_token]) byToken[row.access_token] = [];
    byToken[row.access_token].push(row);
  }

  // Fetch live stats from TikTok
  const statsMap = {}; // keyed by video_id
  for (const [token, rows] of Object.entries(byToken)) {
    const videoIds = rows.map(r => r.video_id);
    for (let i = 0; i < videoIds.length; i += 20) {
      const batch = videoIds.slice(i, i + 20);
      const res  = await fetch('https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body:    JSON.stringify({ filters: { video_ids: batch } }),
      });
      const data = await res.json();
      for (const v of data.data?.videos ?? []) {
        statsMap[v.id] = { views: v.view_count ?? 0, likes: v.like_count ?? 0, comments: v.comment_count ?? 0, shares: v.share_count ?? 0 };
      }
    }
  }

  const posts = results.map(({ access_token, ...r }) => ({
    post_id:        r.id,
    video_id:       r.video_id,
    account_id:     r.account_id,
    account:        r.account,
    follower_count:            r.follower_count ?? null,
    follower_count_updated_at: r.follower_count_updated_at ?? null,
    caption:        r.caption,
    status:         r.status,
    created_at:     r.created_at,
    stats:          statsMap[r.video_id] ?? null,
  }));

  return c.json(posts);
});

app.post('/api/v1/publish', async (c) => {
  const session = await getApiKeySession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: 'Invalid form data' }, 400); }

  const videoFile          = formData.get('video');
  const videoUrl           = formData.get('video_url') ?? null;
  const caption            = (formData.get('caption') ?? '').slice(0, 2200);
  const accountId          = formData.get('account_id') ?? null;
  const accountName        = formData.get('account') ?? null;
  const platform           = formData.get('platform') ?? 'tiktok';
  const coverTimestampRaw  = formData.get('video_cover_timestamp_ms');
  const coverTimestampMs   = coverTimestampRaw !== null ? parseInt(coverTimestampRaw, 10) : null;

  if (!videoFile && !videoUrl) return c.json({ error: 'Provide video file or video_url' }, 400);

  // Look up account by id or display_name
  const account = accountId
    ? await c.env.DB.prepare('SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?').bind(accountId, session.user_id, platform).first()
    : await c.env.DB.prepare('SELECT * FROM connected_accounts WHERE display_name = ? AND user_id = ? AND platform = ?').bind(accountName, session.user_id, platform).first();

  if (!account) return c.json({ error: 'Account not found' }, 404);

  const hasFile = videoFile && typeof videoFile !== 'string';
  let videoBytes = null;
  let videoSize  = 0;
  if (hasFile) {
    videoBytes = await videoFile.arrayBuffer();
    videoSize  = videoBytes.byteLength;
  }

  const postInfo = {
    title: caption, privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_duet: false, disable_comment: false, disable_stitch: false,
    video_cover_timestamp_ms: (coverTimestampMs !== null && !isNaN(coverTimestampMs)) ? coverTimestampMs : 1000,
  };

  // Try FILE_UPLOAD first (TikTok processes faster than PULL_FROM_URL).
  // Falls back to PULL_FROM_URL via R2 if TikTok rejects the FILE_UPLOAD init.
  let sourceInfo = hasFile
    ? { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: videoSize, total_chunk_count: 1 }
    : { source: 'PULL_FROM_URL', video_url: videoUrl };

  let initRes  = await fetch(TIKTOK_INIT_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body:    JSON.stringify({ post_info: postInfo, source_info: sourceInfo }),
  });
  let initData = await initRes.json();

  // FILE_UPLOAD init failed — fall back to PULL_FROM_URL via R2
  if (hasFile && sourceInfo.source === 'FILE_UPLOAD' && (!initRes.ok || initData.error?.code !== 'ok')) {
    log(c, { type: 'event', event: 'api_publish_file_upload_fallback', tiktok_error: initData.error?.code, tiktok_message: initData.error?.message, user_id: session.user_id });
    const r2Key  = `api-uploads/${newId()}/${videoFile.name || 'video.mp4'}`;
    await c.env.MEDIA_BUCKET.put(r2Key, videoBytes, {
      httpMetadata:   { contentType: videoFile.type || 'video/mp4' },
      customMetadata: { cleanup_at: String(Date.now() + 24 * 60 * 60 * 1000) },
    });
    sourceInfo = { source: 'PULL_FROM_URL', video_url: `${c.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${r2Key}` };
    initRes    = await fetch(TIKTOK_INIT_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body:    JSON.stringify({ post_info: postInfo, source_info: sourceInfo }),
    });
    initData   = await initRes.json();
  }

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

  const { publish_id, upload_url } = initData.data;

  // PUT video bytes directly to TikTok for FILE_UPLOAD
  if (sourceInfo.source === 'FILE_UPLOAD' && upload_url) {
    const uploadRes = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type':   videoFile.type || 'video/mp4',
        'Content-Range':  `bytes 0-${videoSize - 1}/${videoSize}`,
        'Content-Length': String(videoSize),
      },
      body: videoBytes,
    });
    if (!uploadRes.ok) {
      log(c, { type: 'error', event: 'api_publish_failed', reason: 'upload_put_failed', upload_status: uploadRes.status, user_id: session.user_id });
      return c.json({ error: 'Video upload to TikTok failed' }, 500);
    }
  }

  const postId = newId();
  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, publish_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
  `).bind(postId, session.user_id, account.id, platform, caption, publish_id, now()).run();

  log(c, { type: 'event', event: 'api_publish', platform, account_id: account.id, user_id: session.user_id, inbox: usedInbox, source: sourceInfo.source });

  return c.json({ publish_id, post_id: postId, inbox: usedInbox, source: sourceInfo.source });
});

// POST /api/v1/publish/photo — publish a photo carousel to TikTok
app.post('/api/v1/publish/photo', async (c) => {
  const session = await getApiKeySession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const { account_id, caption, images, music_id } = await c.req.json().catch(() => ({}));

  if (!account_id)                         return c.json({ error: 'account_id required' }, 400);
  if (!caption)                            return c.json({ error: 'caption required' }, 400);
  if (!Array.isArray(images) || !images.length) return c.json({ error: 'images must be a non-empty array of URLs' }, 400);
  if (images.length > 35)                  return c.json({ error: 'TikTok supports a maximum of 35 images per carousel' }, 400);

  const account = await c.env.DB.prepare(
    'SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(account_id, session.user_id, 'tiktok').first();
  if (!account) return c.json({ error: 'Account not found' }, 404);

  // Proxy any images not hosted on creatorpost.app through R2
  // (TikTok requires domain verification for PULL_FROM_URL — creatorpost.app is already verified)
  const finalImages = await Promise.all(images.map(async (url) => {
    try {
      if (new URL(url).hostname.endsWith('creatorpost.app')) return url;
    } catch { /* invalid URL — let TikTok reject it */ return url; }
    const imgRes  = await fetch(url);
    if (!imgRes.ok) throw new Error(`Failed to fetch image ${url}: ${imgRes.status}`);
    const imgBuf  = await imgRes.arrayBuffer();
    const ext     = url.split('?')[0].split('.').pop() || 'jpg';
    const r2Key   = `photo-uploads/${newId()}.${ext}`;
    await c.env.MEDIA_BUCKET.put(r2Key, imgBuf, {
      httpMetadata:   { contentType: imgRes.headers.get('content-type') || 'image/jpeg' },
      customMetadata: { cleanup_at: String(Date.now() + 24 * 60 * 60 * 1000) },
    });
    return `${c.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${r2Key}`;
  }));

  const post_info = {
    description:     caption.slice(0, 4000),  // photo posts use description (max 4000), not title (max 90)
    privacy_level:   'PUBLIC_TO_EVERYONE',
    disable_comment: false,
    auto_add_music:  !music_id,
    ...(music_id ? { music_id: String(music_id) } : {}),
  };

  const source_info = {
    source:            'PULL_FROM_URL',
    photo_cover_index: 0,
    photo_images:      finalImages,
  };

  // Try DIRECT_POST first — falls back to MEDIA_UPLOAD (inbox) if not approved yet
  let initRes  = await fetch(TIKTOK_PHOTO_INIT_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body:    JSON.stringify({ post_info, source_info, media_type: 'PHOTO', post_mode: 'DIRECT_POST' }),
  });
  let initData  = await initRes.json();
  let usedInbox = false;

  if (!initRes.ok || initData.error?.code !== 'ok') {
    log(c, { type: 'event', event: 'api_publish_photo_direct_post_failed', tiktok_error: initData.error?.code, tiktok_message: initData.error?.message, user_id: session.user_id });
    // auto_add_music is DIRECT_POST only — strip it for MEDIA_UPLOAD fallback
    const { auto_add_music: _, ...post_info_inbox } = post_info;
    initRes   = await fetch(TIKTOK_PHOTO_INIT_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body:    JSON.stringify({ post_info: post_info_inbox, source_info, media_type: 'PHOTO', post_mode: 'MEDIA_UPLOAD' }),
    });
    initData  = await initRes.json();
    usedInbox = true;
  }

  if (!initRes.ok || initData.error?.code !== 'ok') {
    log(c, { type: 'error', event: 'api_publish_photo_failed', tiktok_error: initData.error?.code, tiktok_message: initData.error?.message, user_id: session.user_id });
    return c.json({ error: initData.error?.message ?? 'TikTok photo init failed', tiktok_raw: initData }, 500);
  }

  const { publish_id } = initData.data;

  const postId = newId();
  await c.env.DB.prepare(`
    INSERT INTO posts (id, user_id, account_id, platform, caption, status, publish_id, created_at)
    VALUES (?, ?, ?, 'tiktok', ?, 'processing', ?, ?)
  `).bind(postId, session.user_id, account.id, caption.slice(0, 2200), publish_id, now()).run();

  log(c, { type: 'event', event: 'api_publish_photo', account_id: account.id, user_id: session.user_id, image_count: images.length, inbox: usedInbox });

  return c.json({ ok: true, publish_id, post_id: postId, inbox: usedInbox });
});

// ── API — TikTok sync (dev only) ──────────────────────────────────────────────

// Shared sync logic — used by both dev UI and v1 API endpoints
async function runTikTokSync(c, user_id, account_id) {
  const account = await c.env.DB.prepare(
    'SELECT id, access_token FROM connected_accounts WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(account_id, user_id, 'tiktok').first();
  if (!account) return { error: 'Account not found', status: 404 };

  // Fetch follower count (requires user.info.stats scope — graceful fallback)
  let followerCount = null;
  try {
    const uRes  = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=follower_count,display_name', {
      method:  'GET',
      headers: { Authorization: `Bearer ${account.access_token}` },
    });
    const uData = await uRes.json();
    followerCount = uData.data?.user?.follower_count ?? null;
    if (followerCount !== null) {
      await c.env.DB.prepare('UPDATE connected_accounts SET follower_count = ?, follower_count_updated_at = ? WHERE id = ?')
        .bind(followerCount, now(), account_id).run();
    }
  } catch { /* scope not granted yet — skip */ }

  // Paginate through video list
  let cursor = 0, hasMore = true, imported = 0, skipped = 0;
  const importedVideoIds = [];
  while (hasMore) {
    const res = await fetch(
      'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url',
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body:    JSON.stringify({ max_count: 20, cursor }),
      }
    );
    // TikTok returns video id as int64; JSON.parse loses precision on large ints — wrap as strings first
    const rawText  = await res.text();
    const safeText = rawText.replace(/:(\s*)(\d{16,})/g, ':"$2"');
    const data     = JSON.parse(safeText);
    if (data.error?.code !== 'ok') {
      log(c, { type: 'error', event: 'tiktok_sync_video_list_failed', tiktok_error: data.error?.code, tiktok_message: data.error?.message, account_id, user_id });
      break;
    }

    const videos = data.data?.videos ?? [];
    hasMore      = data.data?.has_more ?? false;
    cursor       = data.data?.cursor   ?? 0;

    for (const v of videos) {
      const caption  = v.video_description || v.title || v.description || '';
      const videoId  = String(v.id ?? '');
      const createAt = v.create_time ?? now();

      // First, try to claim an existing processing post for this account that has no video_id yet
      // (e.g. a photo post or video that was published via our API but never had its video_id resolved)
      // Preserve existing caption if non-empty; only fill in if blank.
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts SET
          video_id = ?,
          status   = 'published',
          caption  = CASE WHEN caption = '' OR caption IS NULL THEN ? ELSE caption END
        WHERE id = (
          SELECT id FROM posts
          WHERE user_id = ? AND account_id = ? AND video_id IS NULL AND status IN ('processing', 'inbox')
          ORDER BY ABS(created_at - ?) ASC
          LIMIT 1
        )
        AND NOT EXISTS (SELECT 1 FROM posts WHERE user_id = ? AND video_id = ?)
      `).bind(videoId, caption, user_id, account_id, createAt, user_id, videoId).run();

      if (updateResult.meta.changes > 0) { imported++; importedVideoIds.push(videoId); continue; }

      // No matching processing post — insert as new if not already present
      const insertResult = await c.env.DB.prepare(`
        INSERT INTO posts (id, user_id, account_id, platform, caption, status, video_id, created_at)
        SELECT ?, ?, ?, 'tiktok', ?, 'published', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM posts WHERE user_id = ? AND video_id = ?)
      `).bind(newId(), user_id, account_id, caption, videoId, createAt, user_id, videoId).run();

      if (insertResult.meta.changes > 0) { imported++; importedVideoIds.push(videoId); }
      else skipped++;
    }

    if (!hasMore || videos.length === 0) break;
  }

  return { ok: true, imported, skipped, follower_count: followerCount, video_ids: importedVideoIds };
}

// POST /api/tiktok/backfill-usernames — dev only (@mattdonders.com), fetches username for all connected TikTok accounts
app.post('/api/tiktok/backfill-usernames', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user?.email?.endsWith('@mattdonders.com')) return c.json({ error: 'forbidden' }, 403);

  const { results } = await c.env.DB.prepare(
    `SELECT id, access_token FROM connected_accounts WHERE user_id = ? AND platform = 'tiktok'`
  ).bind(session.user_id).all();

  const updated = [], failed = [];
  for (const acc of results) {
    try {
      const { user: profile } = await fetchTikTokProfile(acc.access_token);
      if (profile.username) {
        await c.env.DB.prepare('UPDATE connected_accounts SET username = ? WHERE id = ?')
          .bind(profile.username, acc.id).run();
        updated.push({ id: acc.id, username: profile.username });
      } else {
        failed.push({ id: acc.id, reason: 'no username returned' });
      }
    } catch (err) {
      failed.push({ id: acc.id, reason: err.message });
    }
  }

  return c.json({ ok: true, updated, failed });
});

// POST /api/tiktok/sync-posts — dev only (@mattdonders.com)
app.post('/api/tiktok/sync-posts', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user?.email?.endsWith('@mattdonders.com')) return c.json({ error: 'forbidden' }, 403);

  const { account_id } = await c.req.json().catch(() => ({}));
  if (!account_id) return c.json({ error: 'account_id required' }, 400);

  const result = await runTikTokSync(c, session.user_id, account_id);
  if (result.error) return c.json({ error: result.error }, result.status);
  log(c, { type: 'event', event: 'tiktok_sync', user_id: session.user_id, account_id, ...result });
  return c.json(result);
});

// POST /api/v1/sync — pipeline endpoint (Bearer cp_... auth)
app.post('/api/v1/sync', async (c) => {
  const session = await getApiKeySession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const { account_id } = await c.req.json().catch(() => ({}));
  if (!account_id) return c.json({ error: 'account_id required' }, 400);

  const result = await runTikTokSync(c, session.user_id, account_id);
  if (result.error) return c.json({ error: result.error }, result.status);
  log(c, { type: 'event', event: 'tiktok_sync_v1', user_id: session.user_id, account_id, ...result });
  return c.json(result);
});

// ── Cron: refresh expiring tokens ────────────────────────────────────────────

async function refreshExpiredInstagramTokens(env) {
  // Instagram long-lived tokens expire in 60 days — refresh when < 10 days remain
  const threshold = now() + (10 * 86400);
  const { results } = await env.DB.prepare(
    `SELECT id, access_token FROM connected_accounts
     WHERE platform = 'instagram' AND access_token IS NOT NULL
       AND token_expires_at IS NOT NULL AND token_expires_at < ?`
  ).bind(threshold).all();

  let refreshed = 0;
  for (const account of results) {
    try {
      const res = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${account.access_token}`
      );
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      await env.DB.prepare(
        'UPDATE connected_accounts SET access_token = ?, token_expires_at = ? WHERE id = ?'
      ).bind(data.access_token, data.expires_in ? now() + data.expires_in : null, account.id).run();
      refreshed++;
    } catch (err) {
      console.error(`Instagram token refresh failed for ${account.id}:`, err.message);
    }
  }
  return refreshed;
}

async function refreshExpiredTikTokTokens(env) {
  const threshold = now() + 86400; // accounts expiring within 24 hours
  const { results } = await env.DB.prepare(
    `SELECT id, refresh_token FROM connected_accounts
     WHERE platform = 'tiktok' AND refresh_token IS NOT NULL
       AND token_expires_at IS NOT NULL AND token_expires_at < ?`
  ).bind(threshold).all();

  let refreshed = 0;
  for (const account of results) {
    try {
      const data = await refreshTikTokToken(account.refresh_token, env);
      await env.DB.prepare(
        'UPDATE connected_accounts SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?'
      ).bind(
        data.access_token,
        data.refresh_token ?? account.refresh_token,
        data.expires_in ? now() + data.expires_in : null,
        account.id
      ).run();
      refreshed++;
    } catch (err) {
      console.error(`TikTok token refresh failed for ${account.id}:`, err.message);
    }
  }
  return refreshed;
}

// ── Cron endpoint (called by external cron, e.g. cron-job.org every 6h) ──────
// POST /api/cron/refresh-tokens
// Header: Authorization: Bearer <CRON_SECRET>

app.post('/api/cron/refresh-tokens', async (c) => {
  const secret = c.env.CRON_SECRET;
  if (!secret) return c.json({ error: 'not_configured' }, 503);
  const auth = c.req.header('Authorization') ?? '';
  if (auth !== `Bearer ${secret}`) return c.json({ error: 'unauthorized' }, 401);

  const [tiktok, instagram] = await Promise.all([
    refreshExpiredTikTokTokens(c.env),
    refreshExpiredInstagramTokens(c.env),
  ]);
  log(c, { type: 'event', event: 'cron_token_refresh', tiktok, instagram });
  return c.json({ ok: true, tiktok, instagram });
});

// ── Export for Cloudflare Pages ───────────────────────────────────────────────

export const onRequest = (context) => {
  return app.fetch(context.request, context.env, context);
};
