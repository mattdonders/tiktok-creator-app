/**
 * GET /api/logout
 * Clears HttpOnly session cookies server-side and redirects to /connect.
 */
export async function onRequestGet() {
  const headers = new Headers();
  headers.append("Set-Cookie", "cp_token=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
  headers.append("Set-Cookie", "cp_open_id=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
  headers.append("Set-Cookie", "cp_refresh=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
  headers.set("Location", "/connect");
  return new Response(null, { status: 302, headers });
}
