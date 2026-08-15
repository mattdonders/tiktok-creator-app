// Pinterest board alias resolution (Phase B, Rev 2 design §7). Pure and
// dependency-free.
//
// The manifest carries a LOCAL board alias we own — never a Pinterest board_id.
// At execution the alias is mapped (via the local config below, data we own) to an
// expected board NAME, which is matched against Pinterest's LIVE board list. We
// require EXACTLY ONE case-insensitive name match; the resolved board_id is used in
// memory and discarded. Zero or multiple matches → the caller routes the job to
// needs_review. We never guess and never auto-create a board.

// Local alias → expected Pinterest board name. This is CreatorPost config we own,
// NOT a cache of Pinterest data. Keep it small; add aliases as boards are created.
export const PINTEREST_BOARD_ALIASES = {
  'home-maintenance':    'Home Maintenance Troubleshooting',
  'aging-in-place':      'Aging-in-Place Upgrade Cards',
  'lawn-troubleshooting': 'Lawn & Yard Troubleshooting',
};

// Resolution reason codes (map to local error_category on needs_review).
export const BOARD_UNKNOWN_ALIAS   = 'unknown_board_alias';     // alias not in our config
export const BOARD_UNRESOLVED_ZERO = 'board_alias_unresolved';  // 0 live matches
export const BOARD_UNRESOLVED_MULTI = 'board_alias_ambiguous';  // >1 live matches

// Pure: resolve a local alias against a live board list.
//   aliasMap:  { alias -> expectedName }  (defaults to PINTEREST_BOARD_ALIASES)
//   boardList: array of Pinterest boards [{ id, name, ... }]
// Returns { ok:true, boardId } on exactly one case-insensitive name match, else
// { ok:false, reason }. Never throws on unknown alias / no match — those are
// classified outcomes, not errors.
export function resolveBoardMatch(alias, boardList, aliasMap = PINTEREST_BOARD_ALIASES) {
  const expectedName = aliasMap?.[alias];
  if (typeof expectedName !== 'string' || expectedName.length === 0) {
    return { ok: false, reason: BOARD_UNKNOWN_ALIAS };
  }
  const wanted = expectedName.trim().toLowerCase();
  const matches = (Array.isArray(boardList) ? boardList : []).filter(
    (b) => typeof b?.name === 'string' && b.name.trim().toLowerCase() === wanted,
  );
  if (matches.length === 1) return { ok: true, boardId: matches[0].id };
  if (matches.length === 0) return { ok: false, reason: BOARD_UNRESOLVED_ZERO };
  return { ok: false, reason: BOARD_UNRESOLVED_MULTI };
}
