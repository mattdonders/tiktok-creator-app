/**
 * CreatorPost v2 — Hono catch-all router
 * Handles all dynamic routes: auth, API, OAuth
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono();

// ── Axiom logging ─────────────────────────────────────────────────────────────

function log(c, events) {
  if (!c.env.AXIOM_TOKEN || !c.env.AXIOM_DATASET) return;
  const body = (Array.isArray(events) ? events : [events])
    .map(e => JSON.stringify({ _time: new Date().toISOString(), ...e }))
    .join('\n');
  const p = fetch(`https://api.axiom.co/v1/datasets/${c.env.AXIOM_DATASET}/ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.AXIOM_TOKEN}`,
      'Content-Type': 'application/x-ndjson',
    },
    body,
  });
  c.executionCtx.waitUntil(p);
}

// Request logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  log(c, {
    type:     'request',
    method:   c.req.method,
    path:     new URL(c.req.url).pathname,
    status:   c.res.status,
    duration: Date.now() - start,
    country:  c.req.raw.cf?.country ?? null,
  });
});

// Error handler
app.onError((err, c) => {
  log(c, {
    type:    'error',
    message: err.message,
    stack:   err.stack,
    path:    new URL(c.req.url).pathname,
  });
  return c.json({ error: 'Internal Server Error' }, 500);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function newId() { return crypto.randomUUID(); }
function now()   { return Math.floor(Date.now() / 1000); }

const SESSION_TTL = 30 * 24 * 60 * 60;  // 30 days
const MAGIC_TTL   = 15 * 60;            // 15 minutes

async function getSession(c) {
  const sid = getCookie(c, 'cp_session');
  if (!sid) return null;
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?'
  ).bind(sid, now()).first();
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

  log(c, { type: 'event', event: 'tiktok_connected', user_id: userId, open_id: tokenData.open_id });
  return c.redirect('/dashboard');
});

// ── DEBUG — temporary profile inspection endpoint ─────────────────────────────

app.get('/api/debug/tiktok-profile', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const account = await c.env.DB.prepare(
    'SELECT access_token, platform_user_id FROM connected_accounts WHERE user_id = ? LIMIT 1'
  ).bind(session.user_id).first();

  if (!account) return c.json({ error: 'no account found' }, 404);

  const res  = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,username',
    { headers: { Authorization: `Bearer ${account.access_token}` } }
  );
  const data = await res.json();
  return c.json({ http_status: res.status, tiktok_response: data });
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

  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(session.user_id).first();

  const accounts = await c.env.DB.prepare(
    'SELECT id, platform, platform_user_id, display_name, avatar_url FROM connected_accounts WHERE user_id = ?'
  ).bind(session.user_id).all();

  return c.json({ user, accounts: accounts.results });
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
    SELECT p.*, a.display_name, a.avatar_url, a.platform_user_id
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
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,username',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return { user: data.data?.user ?? {}, raw: data };
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

// ── Export for Cloudflare Pages ───────────────────────────────────────────────

export const onRequest = (context) => {
  return app.fetch(context.request, context.env, context);
};
