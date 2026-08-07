# Library triage — "what in my library actually runs here, and can I finish it tonight?"

**Status (2026-08-06):** Phases 1 and 2 SHIPPED; Phase 3 dropped on legal grounds;
Phase 4 half shipped. Merged to main across PRs #362 and #366 in app 2.9.36, with the
agent-side playtime parser in 2.9.71.

| Phase | State | Evidence |
|---|---|---|
| 1 — filter what is on screen | **shipped**, minus saved presets | `app/lib/libraryFilter.ts`, `app/components/LibraryFilterSheet.tsx`, live count via `countLabel()`; playtime from `parse_localconfig_playtime()` in `agent/couchsided.py` (2.9.71) |
| 2 — compatibility | **shipped** | `app/lib/compat.ts` + `compatFetch.ts`, opt-in `compatLookups` pref, badges seen on real hardware |
| 3 — time to beat | **dropped** | see below; legal, not technical |
| 4 — triage actions | **shuffle only** | `pickRandom()`; bookmarks NOT built |

NOT BUILT: saved filter presets (phase 1), bookmarks (phase 4).

VERIFIED ON HARDWARE: compat badges and the confirm-sheet launch, on a real box.
NOT verified: the filter and shuffle controls themselves — they need a library of 8+
games to appear (`allLaunchers.length >= 8` in `app/app/(tabs)/launch.tsx`) and the box
used for testing has two, so both were only ever observed SKIPPING.
**Source inspiration:** DeckFilter (deckfilter.app), **driven on the owner's phone
2026-08-06** — the site 403s to fetch, so this is measured from the running app,
not from marketing copy.
**Owner framing:** opt-in, viewable from Couchside. App-side data; **the box is
never asked to phone out**, so the agent's LAN-only posture is unchanged.

---

## What DeckFilter actually is (measured, not inferred)

A **Steam Deck triage tool for a library you already own**. Not a social
network, not recommendations — a filter.

**The library card** carries four independent facts at a glance:
- Steam review band, top-left, coloured by sentiment ("Mixed" amber,
  "Overwhelmingly Positive" blue)
- **Your** playtime, top-right ("0h 24min")
- **ProtonDB tier** as a metal pill over the art — GOLD, PLATINUM
- A three-column HowLongToBeat row underneath: **STORY / STORY & EXTRAS /
  COMPLETION** in hours (15 / 21 / 45)

**The filter sheet is the product.** Deck Verified status (verified / playable /
unsupported / unknown, as four icon toggles), SteamOS Compatibility, Controller
Support (full / partial / kbm), Time to Beat, Tags, ProtonDB, Release Date,
Languages, Achievements, Steam Reviews, Library source, and three switches —
**Unplayed only, Unfinished only, Hide bookmarked**. Filters are saveable as
presets.

**The detail worth stealing outright:** the confirm button is a **live count** —
`SHOW 272 GAMES`. You watch the number fall as you narrow. It turns filtering
from a chore into the interaction itself.

Tabs: Library / Playlists / Wishlist / Discover / Settings.

---

## Why this fits Couchside far better than a generic dashboard

Couchside already targets **SteamOS / Bazzite / Steam Deck**. "Which of my games
run well on THIS machine" is the question its users already have.

**And Couchside can do the thing DeckFilter structurally cannot: launch it.**
DeckFilter ends at "this is Gold and takes 15 hours". Couchside ends at *tap →
it starts on the TV*. Filter to "runs great here, under 20 hours, never played",
then launch straight from the result. That is not a copy of DeckFilter; it is
the half it is missing.

The Launch tab is already most of the substrate: the box parses `appinfo.vdf`
for names, serves cover art over the LAN, and knows what is installed.

---

## Where each fact comes from — the architecture question

| Data | Source | Notes |
|---|---|---|
| Library, names, cover art, installed | **The box, already implemented** | No API key, no internet. Box owners get the library for free. |
| Your playtime | Box (Steam local config) or Steam Web API | Needs checking which the agent can already read. |
| **Deck Verified / SteamOS compatibility** | Valve, per-appid | Public endpoint; app-side. |
| **ProtonDB tier** | protondb.com | Public JSON per appid; app-side. |
| **HowLongToBeat hours** | howlongtobeat.com | No official API — scraping is fragile and its ToS needs reading before shipping, not after. |

**The rule: the APP fetches metadata, never the box.** The agent stays LAN-only
and gains no outbound network path. That keeps the product's central promise
exactly as it is today, and it is also why this is worth building at all.

**Opt-in, off by default, revocable.** Even app-side, this is the first time
Couchside reaches the public internet for user content. It needs a screen saying
what is requested (a list of appids, to Valve/ProtonDB), what is not (nothing
about you, no account), and one control that deletes every cached response.
Metadata should be cached hard — these values change rarely, and a filter that
re-fetches on every scroll is both slow and rude to free services.

**No Steam API key needed for the core case.** Unlike a generic "sync your Steam
account" dashboard, a box owner's library comes from their own machine. That
sidesteps the friction that would otherwise sink this (a Valve API key + a public
profile). Box-less remote-only users would need the key path — treat that as a
later phase, not the opening move.

---

## Phases

**Phase 1 — filter what is already on screen.** No network at all. Filter the
existing Launch library by what the box already knows: installed, playtime,
never-played. Ship the **live-count button** (`SHOW 272 GAMES`) and saved
presets. This is useful on day one and proves the interaction.

**Phase 2 — compatibility.** Deck Verified + ProtonDB per appid, fetched
app-side, cached, opt-in. The metal pill on the tile. Now "what runs well here"
is answerable.

**Phase 3 — time to beat. DROPPED 2026-08-06. Do not build this.**

The ToS review did not clear, and the answer is not ambiguous. HowLongToBeat is
Ziff Davis property, and its robots.txt states:

> Use of any robot, crawler, or other tool to scrape, harvest, extract, or
> retrieve any content on this website using automated means is prohibited
> without written permission from Ziff Davis. Prohibited uses include ... (4) any
> commercial purposes.

It also carries `Disallow: /api` — the exact path any integration would use.
Couchside is a paid app, so this is prohibited on three independent counts:
automated retrieval, the disallowed path, and commercial use.

**Routes that would make it legitimate**, if the feature is ever wanted enough:
1. Written permission from licensing@ziffdavis.com. That is the intended path —
   the robots.txt names the contact.
2. A different source. IGDB (Twitch/Amazon) publishes `game_time_to_beats`
   through an official, documented API. But it authenticates with a client
   id/secret, which cannot ship inside the app binary — it would need the proxy
   server this design has already rejected twice. So IGDB trades a legal
   problem for an architectural one.

Until one of those is true, the honest answer is that Couchside does not show
time-to-beat.

**Phase 4 — triage actions.** Unplayed / unfinished switches, bookmarks, and a
shuffle ("pick something for me") — which on Couchside means **it launches**.

---

## Open questions

1. **Can the agent already read playtime?** It parses `appinfo.vdf` for names;
   playtime lives in `localconfig.vdf`. If yes, Phase 1 gets richer with no
   network.
2. **HowLongToBeat has no official API.** Check terms before building on it;
   Phase 3 is the one phase that might be dropped for legal rather than
   technical reasons.
3. **Non-Steam launchers** (Epic/GOG/Xbox on the Windows agent) have no
   ProtonDB/Deck equivalent — the tile must degrade to "no data" rather than
   implying incompatibility.
4. **Where does it live?** Probably filtering *inside* the Launch tab rather than
   a new tab — the value is that the filtered result is launchable, and a
   separate dashboard tab would break that adjacency.
