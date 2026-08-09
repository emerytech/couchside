# Game backlog — "Now playing" + "Up next" queue

> **Status: SPEC (owner ask 2026-08-09).** Planned, not built. Roadmap entry:
> `docs/ROADMAP.md` → 📋 Planned → "Game backlog". App-only, additive, low risk.

## The ask

> "Sort games you are currently playing and add games you want to play next, to
> organize what you play next."

Two lists the user curates from their library:
- **Now playing** — the handful they're actively in.
- **Up next** — an ordered queue of what to play after.

## Principle: extend, don't reinvent

Couchside already has the pieces; this is composition, not new infrastructure.
- **Bookmark** already exists in `components/GameSheet.tsx` (toggle via
  `hooks/useLibraryMarks` → `toggleBookmarked` / `isBookmarked`, keyed by
  `bookmarkKey(launcher)`). It is "a note-to-self about this game." **"Up next" is a
  curated, *ordered* view over bookmarks.**
- **Launch** already works — a tile taps into `GameSheet` → PLAY → `steam://rungameid`
  on the box. The backlog does not change launching.
- **Recency/among facts** — `GameSheet` already shows `last_played` and `playtime_min`
  (agent ≥ 2.9.71). "Now playing" is a sort/filter over those, no new data.
- **App-side state** — persistence follows `lib/prefs.ts` / `hooks/useLibraryMarks`
  (SecureStore native / localStorage web). **No agent change is needed to start.**

## OPEN QUESTION (resolve with owner before P1)

Is **"Up next" the same set as bookmarks** (bookmark == "I want to play this next"),
or a **separate list**? This decides the data model:
- **Same (simplest, spec's default):** add an *order* to the existing bookmark store;
  "Up next" = bookmarks in that order. One store, one mental model.
- **Separate:** a new `upNext` ordered store distinct from bookmarks. More flexible
  (bookmark = "interested someday" vs up-next = "queued"), more surface.

Everything below assumes **bookmark == up-next** pending confirmation.

## Phases

**P1 — Ordered "Up next" over bookmarks.**
- Give the bookmark store an order (array of keys, or `{key: rank}`); `toggleBookmarked`
  appends on add. Backward-compatible migration: existing unordered bookmarks seed the
  list in any stable order.
- A Launch-tab section (or a Setup/Launch subpage) listing bookmarked games in order,
  each tapping into the existing `GameSheet`.
- Verify in the web harness: bookmark 3 games, confirm they appear in "Up next" in add
  order; press one → GameSheet opens.

**P2 — "Now playing" auto-section.**
- A section above "Up next" showing games with a recent `last_played` (e.g. within N days)
  and/or non-trivial `playtime_min`, sorted most-recent-first. Purely derived; no new
  state. Degrades to empty on an old agent that sends no playtime (say so, like GameSheet
  already does).

**P3 — Reorder + dedicated view.**
- Drag-to-reorder (or up/down controls) for "Up next". A dedicated Backlog screen
  (route like `theme-picker`/`licenses`) if the Launch-tab section gets crowded; lock
  orientation portrait like every non-Pad screen (there is a source-reading CI guard —
  `useLockOrientation('portrait')`).

**P4 — (maybe) explicit per-game status.**
- playing / next / done / dropped, instead of the implicit bookmark==next. Only if the
  two-list model proves too thin in use. Revisit after P1–P3 ship.

## Constraints / guardrails

- **App-only.** No new agent endpoint or capability for P1–P3. If a later phase wants
  cross-device sync (backlog follows you between phones), that is a NEW agent-side store
  and a separate spec — do not smuggle it in here.
- **Testing:** app UI → drive in the web harness and PRESS the controls (CLAUDE.md §6),
  not just render. New screen → orientation-policy guard applies.
- **No scope creep into recommendations/automation.** This is manual curation; "play next
  suggestions" is a different, later idea.

## Related

Memory: `openpuck-utilities-idea` sibling note first captured this. Existing primitives:
`hooks/useLibraryMarks`, `lib/libraryFilter` (`bookmarkKey`), `components/GameSheet.tsx`.
