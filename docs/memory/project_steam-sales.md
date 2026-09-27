# Project: Track Steam store sales + alert on a watched game's discount

**Status:** 📋 Planned (user request 2026-09-26). Net-new — no price/sale/wishlist entry
exists (the only ROADMAP grep hit is "wholesale"). Captured via a dedupe+assess pass
against ROADMAP + memory + code.

**The honest gates, recorded first:**
1. **Price VIEWING is nearly free; the sale ALERT is the hard part.** Viewing reuses a
   shipped, keyless internet path. The alert runs headlong into the recurring wall
   below and needs native deps the app has deliberately avoided.
2. **The alert cannot be a guaranteed push.** Couchside has NO server and NO reliable
   background execution — deliberately. Verified: `app/package.json` has NEITHER
   `expo-notifications` NOR any background-fetch / task-manager package (only
   `expo-clipboard`). The wall is stated in code at `hooks/useDownloadWatch.ts:13-16`
   ("a true push would need a server this product deliberately does not run") and in
   ROADMAP **Install a game you own but have not downloaded** ("the app cannot notify —
   no server, no background"). The most that is possible on SDK 57 / RN 0.86: a native
   background-task package does an **OS-throttled, unreliable best-effort wake** (no
   guaranteed interval, does not run if the app is force-killed, worst on iOS) that
   polls the watch list's prices **app-side** and fires a **LOCAL** notification on a
   detected discount. Ship the alert as explicitly **best-effort** copy, or not at all.
3. **The AGENT gains ZERO outbound path.** All internet is app-side. The agent must
   never fetch `store.steampowered.com`.

## Why (the problem this answers)

User ask: "tracking steam store sales and setup notifications when a game goes on sale
that you are watching." Show current Steam price + discount % for owned/installed games
and a watch list, and alert when a watched game drops. The reliable core (price viewing
+ an in-app "on sale now" list) stands alone; the alert is a best-effort extra.

## Price VIEWING is nearly free — the plumbing is shipped and keyless

- `price_overview` (`initial` / `final` / `discount_percent` / `final_formatted` /
  `currency`) rides in the **SAME** `appdetails` payload the app ALREADY fetches and
  caches for name/type — `steamStoreParse.ts:41` notes extras "ride in the SAME
  appdetails payload … so it costs no extra request." It is simply **not parsed today**
  → a net-new field on `parseAppDetails`. **No Steam Web API key.**
- Work: add the `price` field; surface a "-N%" badge + price on game tiles and in
  `GameSheet`, with a buy deep-link via `lib/steamLinks.ts`; reuse the opt-in
  `compatLookups` pref (same host, `store.steampowered.com`).
- **CAVEATS:**
  - **Split the cache.** Price changes daily; the current **30-day TTL**
    (`steamStore.ts`) is right for static name/type but WRONG for price — it would
    surface expired sale prices. Price needs a **separate short-TTL cache** (hours).
  - `price_overview` is **region/currency-specific** (IP-geolocated absent an explicit
    `&cc=`). Fine for one phone; note it.
  - Stay polite against Valve's ~200-requests/5-min cap when refreshing a watch list.

## LAN-only split (never violate)

- ALL of this is **app-side**. The AGENT never fetches `store.steampowered.com` — its
  only existing outbound URLs are agent-chosen and non-client-steered (self-update,
  Decky store, OpenPuck firmware). This feature adds **ZERO** agent network path.
- The agent already supplies the LOCAL appid lists the app resolves
  (`_installed_appids` / `_installable_appids`); price is not on the box's disk and the
  box never fetches it.

## Phases

- **Phase 1 — price viewing (reliable, no new deps).** Add the `price` field to
  `parseAppDetails` + a split short-TTL price cache; render a "-N%" badge + price on
  tiles and in `GameSheet` with a buy deep-link; gate on the existing opt-in
  `compatLookups` pref (off by default). Harness-PRESS the buy control (§6).
- **Phase 2 — watch list + "on sale now".** An app-local watch-list store (which games
  the user is watching) and an in-app "on sale now" view that shows current discounts
  for the watch list. Still no new native deps.
- **Phase 3 — best-effort sale alert (opt-in, honestly labeled).** Add
  `expo-notifications` + a background-task package + a permission prompt + a dev-client
  rebuild. A best-effort background wake polls the watch list's prices app-side and
  fires a LOCAL notification on a detected discount. Ship ONLY with honest "best-effort,
  may be delayed, never a guaranteed push" copy. If that honesty is unacceptable, ship
  Phases 1–2 and stop.

## Dedupe / related

Net-new — do NOT confuse with the "Notifications" slug in **Find the missing Steam
settings slugs** (a deep-link into Steam's own client settings page, unrelated to price
alerts) or the app's Fleet-units "watchlist". Extends the app-side keyless `appdetails`
path shipped for **Install a game you own but have not downloaded** and the opt-in fetch
pattern from **Library triage** (`project_library-triage.md`: "the APP fetches metadata,
never the box"). **ToS:** prefer the already-vetted keyless `appdetails` over scraping
IsThereAnyDeal / SteamDB — library-triage Phase 3 was DROPPED for scraping HowLongToBeat,
the precedent for vetting any third-party price/deal source first. Background / no-server
surfaces are also the theme of **Apple Watch + desktop widgets**.
