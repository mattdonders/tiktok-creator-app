/**
 * POST /api/publish
 * Initializes a TikTok video upload and proxies the file to TikTok.
 *
 * Expects multipart form data:
 *   - video: File
 *   - caption: string
 *   - schedule_time: ISO string (optional — if present, schedules the post)
 */

const TIKTOK_INIT_URL        = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const TIKTOK_INBOX_INIT_URL  = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const TIKTOK_STATUS_URL      = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const MAX_FILE_SIZE     = 50 * 1024 * 1024; // 50 MB

export async function onRequestPost({ request }) {
  const token = getCookie(request, "cp_token");
  if (!token) {
    return Response.json({ error: "not_connected" }, { status: 401 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const videoFile    = formData.get("video");
  const caption      = (formData.get("caption") ?? "").slice(0, 2200);
  const scheduleTime = formData.get("schedule_time") ?? null;

  if (!videoFile || typeof videoFile === "string") {
    return Response.json({ error: "No video file provided" }, { status: 400 });
  }

  const videoBytes = await videoFile.arrayBuffer();
  const videoSize  = videoBytes.byteLength;

  if (videoSize > MAX_FILE_SIZE) {
    return Response.json({ error: "File too large (max 50MB)" }, { status: 413 });
  }

  // ── Step 1: Initialize upload ──────────────────────────────────────────────
  const sourceInfo = {
    source:            "FILE_UPLOAD",
    video_size:        videoSize,
    chunk_size:        videoSize,
    total_chunk_count: 1,
  };

  const postInfo = {
    title:                    caption,
    privacy_level:            "SELF_ONLY",
    disable_duet:             false,
    disable_comment:          false,
    disable_stitch:           false,
    video_cover_timestamp_ms: 1000,
  };

  if (scheduleTime) {
    const ts = Math.floor(new Date(scheduleTime).getTime() / 1000);
    postInfo.scheduled_publish_time = ts;
  }

  // Try direct post first; fall back to inbox (draft) if account isn't eligible
  let initRes = await fetch(TIKTOK_INIT_URL, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ post_info: postInfo, source_info: sourceInfo }),
  });

  let initData = await initRes.json();
  let usedInbox = false;

  if (!initRes.ok || initData.error?.code !== "ok") {
    console.error("Direct post failed, trying inbox:", JSON.stringify(initData));
    // Fall back to inbox/draft — fewer account eligibility requirements
    initRes = await fetch(TIKTOK_INBOX_INIT_URL, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ source_info: sourceInfo }),
    });
    initData = await initRes.json();
    usedInbox = true;
  }

  if (!initRes.ok || initData.error?.code !== "ok") {
    console.error("TikTok init error:", JSON.stringify(initData));
    return Response.json(
      { error: initData.error?.message ?? "Failed to initialize upload", tiktok_code: initData.error?.code, tiktok_raw: initData },
      { status: 500 }
    );
  }

  const { publish_id, upload_url } = initData.data;

  // ── Step 2: Upload video file ──────────────────────────────────────────────
  const uploadRes = await fetch(upload_url, {
    method:  "PUT",
    headers: {
      "Content-Type":   "video/mp4",
      "Content-Range":  `bytes 0-${videoSize - 1}/${videoSize}`,
      "Content-Length": String(videoSize),
    },
    body: videoBytes,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error("Upload error:", uploadRes.status, errText);
    return Response.json({ error: "Video upload failed" }, { status: 500 });
  }

  return Response.json({ publish_id, scheduled: !!scheduleTime, inbox: usedInbox });
}

// ── GET /api/publish?publish_id=xxx — check status ────────────────────────────
export async function onRequestGet({ request }) {
  const token      = getCookie(request, "cp_token");
  const publish_id = new URL(request.url).searchParams.get("publish_id");

  if (!token) return Response.json({ error: "not_connected" }, { status: 401 });
  if (!publish_id) return Response.json({ error: "Missing publish_id" }, { status: 400 });

  const res = await fetch(TIKTOK_STATUS_URL, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id }),
  });

  const data = await res.json();
  return Response.json(data.data ?? data);
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") ?? "";
  const match  = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
