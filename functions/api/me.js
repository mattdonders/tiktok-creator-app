/**
 * GET /api/me
 * Returns the connected TikTok user's profile info.
 */

export async function onRequestGet({ request }) {
  const token = getCookie(request, "cp_token");
  if (!token) {
    return Response.json({ error: "not_connected" }, { status: 401 });
  }

  const res = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,username",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const data = await res.json();
  if (!res.ok || data.error?.code !== "ok") {
    return Response.json({ error: "token_expired" }, { status: 401 });
  }

  return Response.json(data.data?.user ?? {});
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
