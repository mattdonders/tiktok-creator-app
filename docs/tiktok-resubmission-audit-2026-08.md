# CreatorPost Direct Post Resubmission Audit (2026-08)

Audit performed against TikTok Developer Support's resubmission checklist for
escalated audit reference `20260805013205`. Source materials audited: the 4th
resubmission clips in `docs/submission-videos/` (recorded 2026-08-04) and the
current `functions/[[route]].js` implementation as of HEAD `1b09c6e`.

## 1. Repository / implementation state
- Branch `main`, HEAD `1b09c6e09d33a61d420d68dc8bbd8e9d99bfe1ba` (2026-08-15).
- Working tree clean of CreatorPost/TikTok changes.
- Direct Post implementation lives in `functions/[[route]].js`: OAuth (~L1132
  scope string, ~L1216 token exchange), `creator_info` query (~L1477), video
  publish (~L1292 dashboard path, ~L2263 pipeline path), photo publish
  (~L2437), status polling (`TIKTOK_STATUS_URL`), video/list sync (~L1783,
  2007-2263).

## 2. Requested TikTok scopes
`user.info.basic, user.info.profile, user.info.stats, video.upload,
video.publish, video.list` (functions/[[route]].js:1132). All six map to real
shipped functionality. No unnecessary scopes identified.

| Scope | Functionality | Demonstrable on camera |
|---|---|---|
| user.info.basic | connected-account identity | Yes — shown throughout |
| user.info.profile | display name/avatar/handle | Yes — shown throughout |
| user.info.stats | follower count | Yes, but **not shown** in 4th-submission clips |
| video.upload | inbox/draft fallback publish path | Yes — this is what clip 3 shows |
| video.publish | Direct Post (unapproved, so falls back to inbox automatically) | Circular — can't show a live post pre-approval |
| video.list | Sync Posts / Posts & Analytics | Yes, but **not shown** in 4th-submission clips |

## 3. Current-product compliance matrix
Nearly all requirements PASS: OAuth, identity display, privacy options (live
from `creator_info`, never hardcoded), interaction toggles (default OFF),
commercial disclosure + validation, video preview, explicit per-post
confirmation, success/status polling. One structural gap: the app cannot
currently produce a live profile post because Direct Post is unapproved —
every real call today resolves to TikTok's inbox/drafts (`SEND_TO_USER_INBOX`),
not a public post.

## 4. Previous-demo compliance matrix
Basis: `docs/submission-videos/SUBMISSION-NOTES.md` (4th resubmission,
recorded 2026-08-04 — high-confidence but not certain match to reference
`20260805013205`). Most items CLEAR (branding, domain, OAuth, privacy,
disclosure, confirmation, submission). Gaps: `user.info.stats`/`video.list`
never exercised on camera; no explanation of what CreatorPost is or who it's
for; demo never navigates to TikTok to show the resulting content — this was
already self-documented as a known limitation in `SUBMISSION-NOTES.md`.

## 5. Final TikTok proof
**Confirmed gap.** Clip 3 ends on CreatorPost's own success toast, never on
TikTok itself. Not declared the definitive root cause of any rejection (TikTok
never named one) — but it's the clearest miss against the latest checklist.

## 6. Product purpose / audience clarity
`public/index.html` already states clearly what CreatorPost is (scheduling/
auto-publish tool) and who it's for (creators/agencies managing multiple
channels). The gap is that this story was never carried into the video, not
that the product lacks one.

## 7. Product changes required
**None.** All gaps are demo-only (show unused scopes, add framing narration,
navigate to TikTok to show the result) or documentation-only (explain in
writing why the flow currently lands in drafts pre-approval).

## 8. Proposed new demo shot list (original, superseded by the follow-up prep doc)
See the follow-up recording-plan report (delivered in-conversation
2026-08-20) for the finalized 13-shot sequence, scope-to-shot matrix, and
voice-over script.

## 9. Recommendation
Original: **PORTAL/SCOPE DECISION REQUIRED FIRST** — whether to re-record
ending on the inbox/drafts state with a written chicken-and-egg explanation,
or ask TikTok support first. **Superseded 2026-08-20**: product owner decided
not to wait on Support; recommendation updated to
**READY TO RECORD NEW DEMO — NO CODE CHANGE** pending the three items below.

## 10. Decisions needed from product owner
1. Final-proof strategy — resolved 2026-08-20: re-record now, using the
   Upload flow (TikTok Inbox/draft → creator completes on TikTok →
   profile-visible post), annotated accurately as Upload, not Direct Post.
2. Music usage consent link — verified 2026-08-20: **PRESENT**, rendered at
   `public/dashboard.html:745` (default state) and dynamically updated at
   `:1234`/`:1236` when disclosure toggles change, linking to TikTok's real
   Music Usage Confirmation page. No longer ambiguous.
3. Voice-over vs. captions-only — resolved 2026-08-20: voice-over +
   selective on-screen annotations, per the follow-up recording plan.
