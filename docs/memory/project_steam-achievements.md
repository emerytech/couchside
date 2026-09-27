# Project: View + share your Steam achievements

**Status:** 📋 Planned (user request 2026-09-26). Net-new — no achievement code
exists anywhere in the repo (verified). Captured via a dedupe+assess pass against
ROADMAP + memory + code.

**The honest gates, recorded first:**
1. **The parser is the risk, not the plumbing.** Achievement definitions and unlock
   state live in Steam's **proprietary, undocumented binary KeyValues** files. The
   format can and does drift across Steam client updates. The parser MUST fail closed
   (return "unavailable", never raise) and be **fixture-tested on real hardware** with
   fixtures copied VERBATIM (§6). Phase 0 is a hardware spike to reverse-engineer the
   layout BEFORE any feature code — and it must observe BOTH a game with unlocks AND a
   game with none / no file (§11 observe both states).
2. **The data is a PARTIAL, possibly-stale client cache.** Only games the user has
   actually LAUNCHED have these files. Owned-but-never-launched games must read
   "no data", never "0 achievements". State is a cache synced when online; a game
   played on another machine/offline can be stale → surface "as of last sync", never a
   confident wrong count.
3. **Global rarity % is NOT on disk.** It is Web-API/store data. So it is an APP-side,
   opt-in, off-by-default fetch (same bucket + privacy note as compat lookups). The
   **agent never fetches it.** Everything the AGENT does is a local disk read.

## Why (the problem this answers)

User ask: "viewing and sharing steam achievements." A per-game view of unlocked/locked
achievements with count + %, unlock dates, and on-disk icons, plus a share-out (text
now, a visual showcase card later), and an optional global-rarity %. It extends the
"know your library from the couch" theme (playtime, reco, backlog) with the one social
signal Steam users care about most — without breaking the LAN-only, no-cloud model.

## The data is LOCAL — no key, no internet

Verified locations (SteamOS/Linux layout; the agent already reads this tree):
- **Definitions:** `~/.steam/steam/appcache/stats/UserGameStatsSchema_<appid>.bin`
  — the achievement schema (ids, display names, icons, total count).
- **Per-user state:** `UserGameStats_<accountid>_<appid>.bin`
  — `data.AchievementTimes` = `{achievement_index: unix_ts}`; a present index = unlocked
  and dated, absent = locked. Total from the schema → count/% computable **offline**.
- Both are **binary KeyValues**, the same family the agent already parses in
  `_appinfo_bvdf` (agent/couchsided.py:11256) — pure `struct`, no new import.
- The `accountid` correlates with the `userdata/<uid>` the agent already reads
  (`_localconfig_paths`, agent/couchsided.py:10769).
- **Icons are on disk** too → served over the LAN like the existing Steam cover art,
  never fetched from the internet.

## LAN-only split (never violate — CLAUDE.md §3)

- The **AGENT** does LOCAL reads only: a new read-only, token-authed
  `GET /api/steam/achievements?appid=<n>`, returning additive probe-and-appear fields.
- **§3 allowlist gate:** the client-supplied appid is **looked up**, never interpolated
  — against the set of appids that actually have a `UserGameStatsSchema_*.bin` on disk
  (that on-disk set IS the allowlist, same shape as the shipped `_installable_appids`
  enumeration). Numeric-only; the resolved path must be **contained** under
  `appcache/stats`; anything absent is a **404**, never a pass-through.
- **Degrade closed:** any parse failure returns unavailable/empty, never raises.
- The optional **global rarity %** is APP-side, opt-in, off by default (reuses the
  shipped `lib/compat.ts` / `compatFetch.ts` internet-opt-in infra). The agent never
  touches the network.

## Share

- **Text share works TODAY** with React Native's built-in `Share` (pattern already in
  `components/CrashLogCard.tsx`) — ship it first, it is free.
- A **visual showcase-card image** is net-new: `react-native-view-shot` to capture a
  rendered card → PNG, then share the file (RN `Share` url / `expo-sharing`) + a
  dev-client rebuild. `app/package.json` has neither today (only `expo-clipboard`).

## Phases

- **Phase 0 — hardware spike (BEFORE any feature code).** On a real SteamOS/Bazzite
  box, reverse-engineer the `UserGameStatsSchema_*` + `UserGameStats_*` layout and
  capture VERBATIM fixtures. Observe BOTH a game with unlocks AND one with none / no
  file. Deliverable: fixtures + a documented format, or a "not viable" finding.
- **Phase 1 — the LAN-only endpoint.** `GET /api/steam/achievements?appid=`, allowlist-
  gated as above, additive fields, degrade-closed. Tests: happy path + auth failure +
  non-allowlisted appid refused (nothing runs) + the partial-cache "no data" case.
- **Phase 2 — the app view.** Per-game unlocked/locked list, count + %, unlock dates,
  on-disk icons. Harness-PRESS it (§6), don't just render.
- **Phase 3 — share.** Text share first (free), then the visual showcase card
  (adds `react-native-view-shot` + a dev-client rebuild).
- **Phase 4 — (optional) global rarity.** App-side, opt-in, off by default, reusing the
  compat-lookup internet-opt-in infra + privacy note. The agent never fetches it.

## Dedupe / related

Net-new. NOT the achievement-**EVENTS** hook punted under **SignalBar-style reactive /
ambient LED modes** (ROADMAP:588 — a real-time LED trigger with "no clean non-Decky
hook"); static VIEWING of already-earned achievements from the stats cache is a
different, untried path. "Achievements" also appears only as an unbuilt DeckFilter facet
in **Library triage** (`project_library-triage.md`). The optional rarity fetch follows
the app-side-internet opt-in precedent set by **Install a game you own but have not
downloaded** and the library-triage compat lookups (the rule: the APP fetches metadata,
never the box).
