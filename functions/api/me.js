/**
 * GET /api/me
 * Returns the connected TikTok user's profile info.
 */

export async function onRequestGet({ request }) {
  const token   = getCookie(request, "cp_token");
  const open_id = getCookie(request, "cp_open_id");

  if (!token) {
    return Response.json({ error: "not_connected" }, { status: 401 });
  }

  const res = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name,username",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const data = await res.json();

  if (!res.ok || data.error?.code !== "ok") {
    // Return the real TikTok error + open_id from cookie so dashboard can show something
    return Response.json(
      { error: "profile_unavailable", tiktok_error: data.error, open_id },
      { status: 200 }   // 200 so dashboard doesn't treat as "not connected"
    );
  }

  return Response.json(data.data?.user ?? {});
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") ?? "";
  const match  = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
