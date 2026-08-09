# Game backlog — "Now playing" + "Up next" queue

> **Status: SPEC (owner ask 2026-08-09).** Planned, not built. Roadmap entry:
> `docs/ROADMAP.md` → 📋 Planned → "Game backlog". App-only, additive, low risk.

## The ask

> "Sort games you are currently playing and add games you want to play next, to
> organize what you play next."
>
> Refined 2026-08-09: **"the playlog should be a separate page you can open to
> manage backlogs and order games from your library you want to play."**

Two lists the user curates from their library:
- **Now playing** — the handful they're actively in.
- **Up next** — an ordered queue of what to play after.

## Shape: a dedicated page (owner-decided 2026-08-09)

The backlog is its own **full page** ("Playlog" — working name), NOT a section bolted
onto the Launch tab. It's a management surface: **add games from your whole library,
order them, and manage the backlog.** Route it like the other subpages
(`app/app/theme-picker.tsx` / `licenses.tsx` — own header + back, `useLockOrientation('portrait')`).
Entry point: a row/button on the Launch tab (and/or Setup). This resolves the earlier
"Launch-tab section vs dedicated view" question in favour of a dedicated page from P1.

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

**P1 — The Playlog page (dedicated route) with an ordered "Up next".**
- New screen `app/app/playlog.tsx` (own header + back, `useLockOrientation('portrait')`),
  reached from a Launch-tab (and/or Setup) row. Lists the backlog in order, each entry
  tapping into the existing `GameSheet`.
- Give the store an order (array of keys, or `{key: rank}`); adding appends. Backward-
  compatible migration: existing (unordered) bookmarks seed the list in a stable order.
- Verify in the web harness: add 3 games, confirm order; reorder; press one → GameSheet.

**P2 — Add games from the whole library, + reorder on the page.**
- An "add from library" flow on the Playlog page: pick any owned/installed game to queue
  (a picker/search over the library the Launch tab + installable page already load).
- Drag-to-reorder (or up/down controls) for the queue.

**P3 — "Now playing" section on the page.**
- A section (top of the Playlog page) showing games with a recent `last_played` and/or
  non-trivial `playtime_min`, most-recent-first. Purely derived; no new state. Degrades to
  empty on an old agent that sends no playtime (say so, like GameSheet already does).

**P4 — (maybe) explicit per-game status.**
- playing / next / done / dropped, instead of the implicit "in the list == next". Only if
  the model proves too thin in use. Revisit after P1–P3 ship.

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
