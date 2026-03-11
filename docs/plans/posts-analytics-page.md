# Posts & Analytics Page — Implementation Plan

## Goal
Build a `/posts` page as a full post history + analytics view. The dashboard's "Recent Posts" section stays as-is (last 50, quick glance). This new page is the full history + stats view, and the foundation for a future content calendar.

## Stack Reminder
- Plain HTML/CSS/JS — no React, no build step
- All routes in `functions/[[route]].js`
- Static pages in `public/`
- Dark mode, Linear/Vercel aesthetic — match existing dashboard.html exactly

---

## Step 1 — Add Posts nav link to dashboard.html and account.html

In `dashboard.html`, find the empty `<ul></ul>` in the nav and add:
```html
<ul><li><a href="/posts">Posts</a></li></ul>
```

In `account.html`, add a Posts link alongside the existing Dashboard link in the nav `<ul>`.

The active page link gets `style="color:var(--text);font-weight:500"` — match the pattern already used in `account.html` for its own nav item.

---

## Step 2 — Modify `GET /api/posts` for cursor pagination + filters

**Current query** (in `functions/[[route]].js`):
```sql
SELECT p.*, a.display_name, a.avatar_url, a.platform_user_id, a.platform
FROM posts p
JOIN connected_accounts a ON p.account_id = a.id
WHERE p.user_id = ?
ORDER BY p.created_at DESC
LIMIT 50
```

**New behavior** — accept query params:
- `?cursor=<created_at>` — integer epoch, for DESC cursor pagination (`WHERE p.created_at < ?`)
- `?platform=tiktok|instagram|youtube` — optional filter
- `?account_id=<uuid>` — optional filter
- `?limit=<n>` — default 50, max 100

**Implementation pattern** (D1 uses positional `?` only — build conditionally):
```javascript
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
```

This is **backward-compatible** — dashboard.html continues to work with no params.

---

## Step 3 — Add `GET /api/posts/aggregate`

New endpoint, add below the existing `/api/posts` GET handler:

```javascript
app.get('/api/posts/aggregate', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'not_authenticated' }, 401);

  const { results } = await c.env.DB.prepare(`
    SELECT platform, status, COUNT(*) as count
    FROM posts
    WHERE user_id = ?
    GROUP BY platform, status
  `).bind(session.user_id).all();

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
```

No TikTok API calls — purely D1 counts. Views/likes totals get computed client-side after stats load.

---

## Step 4 — Extend `GET /api/posts/stats` with `?ids=`

When `?ids=<comma-separated-post-uuids>` is present, only fetch stats for those specific post UUIDs instead of the default `LIMIT 50` query. This keeps TikTok API calls bounded to visible rows only.

```javascript
// Near the top of the /api/posts/stats handler, replace the DB query:
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
```

---

## Step 5 — Create `public/posts.html`

### Page structure (top to bottom)

1. `<head>` — title "Posts & Analytics — CreatorPost", link to styles.css, page-scoped `<style>`
2. Nav — same pattern as dashboard.html; Posts link gets `style="color:var(--text);font-weight:500"` as active
3. `.posts-layout` wrapper (max-width 1100px, same padding as `.dash-layout`)
4. Page title: `<h2>Posts & Analytics</h2>`
5. Aggregate stats strip — 4 stat cards: Total Views, Total Posts, Avg Views, Best Post (linked); initially show `—`, populate after stats load
6. Filter/sort toolbar — platform pills + account dropdown + sort dropdown
7. Posts table
8. `<div id="load-more-sentinel">` — IntersectionObserver triggers next page
9. Empty state + loading state

### Page-scoped CSS needed
```css
.posts-layout { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem; }
.filter-bar { display: flex; gap: 0.75rem; margin-bottom: 1.25rem; align-items: center; flex-wrap: wrap; }
.platform-pill { /* inactive: btn-outline style; active: accent bg */ }
.posts-table { width: 100%; border-collapse: collapse; }
.posts-table th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border); }
.posts-table td { font-size: 0.875rem; padding: 0.65rem 0.5rem; vertical-align: middle; border-bottom: 1px solid var(--border); }
.caption-cell { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat-cell { font-variant-numeric: tabular-nums; text-align: right; color: var(--muted); }
.stat-cell.has-value { color: var(--text); }
/* Copy .stats-strip, .stat-item, .stat-num, .stat-label from dashboard.html */
/* Mobile: hide comments/shares columns below 768px */
@media (max-width: 768px) {
  .col-comments, .col-shares { display: none; }
}
```

### Table columns
| Caption | Platform | Account | Date | Status | Views | Likes | Comments | Shares |
- Caption: truncated, linked to TikTok if `video_id` present (same pattern as dashboard)
- Platform: colored badge (same PLATFORM_LABEL/BG/COLOR constants)
- Stats: show `—` for non-TikTok or inbox posts (no video_id)

### JS data flow

```javascript
const STATS_CACHE_KEY = 'cp_post_stats';  // shared with dashboard
const STATS_CACHE_TTL = 15 * 60 * 1000;
let cursor = null;
let loading = false;
let hasMore = true;
let activeFilters = { platform: null, account_id: null };
let allRenderedPostIds = [];  // track for stats fetch

async function init() {
  const [me, aggregate] = await Promise.all([
    fetch('/api/me').then(r => r.json()),
    fetch('/api/posts/aggregate').then(r => r.json()),
  ]);
  if (!me.user) { window.location.href = '/login'; return; }
  renderNav(me);
  renderAggregate(aggregate);  // shows post counts, views = "—" until stats load
  await loadPage();            // first page of posts
  await loadStats();           // fill stat cells + update aggregate views
  setupIntersectionObserver();
}

async function loadPage() {
  if (loading || !hasMore) return;
  loading = true;
  const params = new URLSearchParams({ limit: 50 });
  if (cursor)                    params.set('cursor', cursor);
  if (activeFilters.platform)    params.set('platform', activeFilters.platform);
  if (activeFilters.account_id)  params.set('account_id', activeFilters.account_id);
  const posts = await fetch(`/api/posts?${params}`).then(r => r.json());
  if (posts.length < 50) hasMore = false;
  if (posts.length > 0)  cursor = posts[posts.length - 1].created_at;
  appendRows(posts);
  allRenderedPostIds.push(...posts.map(p => p.id));
  loading = false;
}

async function loadStats() {
  const cached = JSON.parse(localStorage.getItem(STATS_CACHE_KEY) ?? 'null');
  let stats;
  if (cached && (Date.now() - cached.ts) < STATS_CACHE_TTL) {
    stats = cached.data;
  } else {
    // Only fetch stats for TikTok posts with video_id currently rendered
    const ids = allRenderedPostIds.join(',');
    const res = await fetch(`/api/posts/stats?ids=${ids}`);
    if (!res.ok) return;
    stats = await res.json();
    // Merge into existing cache
    const existingData = cached?.data ?? {};
    localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      data: { ...existingData, ...stats },
    }));
  }
  fillStatCells(stats);
  updateAggregateViews(stats);
}

// Filter pill click → reset and reload
function setFilter(key, value) {
  activeFilters[key] = value;
  cursor = null;
  hasMore = true;
  allRenderedPostIds = [];
  document.querySelector('#posts-tbody').innerHTML = '';
  loadPage().then(loadStats);
}

// IntersectionObserver on sentinel
function setupIntersectionObserver() {
  const sentinel = document.getElementById('load-more-sentinel');
  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadPage().then(loadStats);
  }, { rootMargin: '200px' }).observe(sentinel);
}
```

---

## Important Notes / Gotchas

- **D1 positional params only** — always build `conditions[]` and `params[]` arrays in parallel
- **Stats are TikTok-only** — Instagram/YouTube rows always show `—`; don't show loading state for them
- **Inbox posts** have no `video_id` — always show `—` for stats, never a spinner
- **`cp_post_stats` cache is shared** with dashboard.html — merging new stats into it benefits both pages
- **TikTok video/query max 20 IDs** — already batched in the stats endpoint, no change needed
- **Do NOT add `/posts` to `_routes.json`** — it must be served as a static file by Cloudflare Pages
- **Token expiry**: if a connected account token is expired, that account's stats silently return empty — acceptable behavior for now
- **`created_at` cursor collisions**: if two posts share the exact same `created_at` second (possible for seeded data), a row could be skipped at page boundary. Not worth fixing in v1.
- **`publicaly_available_post_id`** — TikTok's intentional typo; stored as `video_id` in DB

## Files to Touch
1. `functions/[[route]].js` — Steps 2, 3, 4
2. `public/dashboard.html` — Step 1 (nav link)
3. `public/account.html` — Step 1 (nav link)
4. `public/posts.html` — Step 5 (new file)
