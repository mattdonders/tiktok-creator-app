/**
 * CreatorPost — TikTok OAuth Entry Point
 *
 * Redirects the user to TikTok's authorization page.
 * Reads TIKTOK_CLIENT_ID from environment so it works on both
 * sandbox (preview) and production deployments automatically.
 */

export async function onRequestGet({ request, env }) {
  const clientId = env.TIKTOK_CLIENT_ID;

  if (!clientId) {
    return new Response("App not configured yet. Check back soon.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const origin      = new URL(request.url).origin;
  const redirectUri = `${origin}/callback`;
  const state       = crypto.randomUUID();

  const params = new URLSearchParams({
    client_key:    clientId,
    response_type: "code",
    scope:         "user.info.basic,video.upload,video.publish",
    redirect_uri:  redirectUri,
    state,
  });

  return Response.redirect(
    `https://www.tiktok.com/v2/auth/authorize?${params}`,
    302
  );
}
