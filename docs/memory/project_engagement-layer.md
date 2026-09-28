# Project: Engagement layer — "keep users coming back"

**Origin:** owner ask, 2026-09-28. Goal: turn Couchside's Steam/Play surface from a
one-shot remote into something with recurring reasons to open it — decision
aggregation plus retention hooks.

## Thesis
The Play/What-to-Play direction's value is **decision aggregation + retention**:
sync the user's library + wishlist, pull the Steam-adjacent data (compatibility,
pricing, time-to-beat, progress) into one per-game view, and answer *play now?* /
*is this sale worth it?*.

**Couchside's differentiator: the box.** Pure-companion apps are read-only advice.
Every Couchside pick/deal becomes a one-tap **launch / install on the couch
machine**, with now-playing + downloads awareness. Same brain, but ours has hands.
Build the aggregation, keep the box as the edge, and never adopt cloud accounts to
match a competitor feature — no-cloud is a selling point, not a gap.

## Already shipped (dedupe — do NOT rebuild)
- What-to-Play reco tab + persona + pull-to-refresh (= a "shuffle / pick for me")
- Playlog / bookmarks (= "bookmark lists / playlists") — SHIPPED
- Recently-played / jump-back-in rail; library stat tile + backlog
- ProtonDB / Steam Deck compat lookup + filter chips
- Deals row + Wishlist sale-watch (keyless Steam Storefront)
- Playtime week/month (#602) + achievements + level/profile card
- Now-playing card, launch confirm, open-downloads-on-box (box moat)

## Phase 0 — ITAD all-time-low (IN PROGRESS, branch feat/itad-price-check)
Opt-in IsThereAnyDeal key (mirrors the Steam key exactly: box-side 0600, masked,
never logged/returned, guide page + in-app link). Turns the existing Deals +
Wishlist rows from "-40%" into **"is this the lowest it's ever been?"** — an
all-time-low badge. Agent: fixed-host client (api.isthereanydeal.com), lookup/v1
(appid->uuid) + historylow/v1. New GET /api/itad/lows?appids=. Global data -> no
per-account cache. Key handling follows the Steam-key pattern. API docs:
docs.isthereanydeal.com. couchside.tv /itad-setup guide like /steam-setup.

## Phase 1 — Box-watched wishlist price-drop alerts (queued, owner-picked)
The retention engine, done the Couchside way. True background push needs a cloud
account/server — refused. Instead the **always-on box** polls wishlist prices on a
timer; the app surfaces "N wishlist games dropped / hit all-time low" on open
(badge) + an optional **local** notification (needs expo-notifications, NOT push).
No cloud, no account — the constraint becomes a differentiated feature. DESIGN
OPEN: where poll state lives (box endpoint /api/itad/watch?), scheduling a local
notification without a background server (on-open diff + expo-notifications local
schedule), opt-in + quiet-hours.

## Phase 2 — Home-screen widget (queued, owner-picked)
iOS/Android widget: tonight's pick or best current wishlist deal -> daily
re-engagement, earns a home-screen spot. Uses expo-widgets (already transitive in
the lock). Widget reads a small cached payload the app writes; tap -> Play tab.

## Phase 3 — Discover: in-app Steam store search (queued, owner-picked)
Search the Steam catalog inside Couchside -> per-game card (price, ATL, Proton/Deck,
time-to-beat, ownership) -> "Add to wishlist" or **"Install on box"**. Closes
browse->want->play without leaving the app. Keyless Steam Storefront search +
appdetails.

## Phase 4 — Per-game recommended settings (queued, owner-picked, lowest pri)
Community-sourced recommended graphics settings per game. Mostly useful on
Deck/handheld. Data source TBD (ToS review needed, like the earlier SteamDB
analysis — see [[steam-webapi-feature-roadmap]]).

## Constraints carried through every phase
Opt-in + degrade-closed; additive API only; no new CAP unless all six sites;
no cloud/accounts/analytics; box-side keys 0600 user-owned, masked, never logged;
fixed-host clients (no SSRF); reject-don't-sanitise; every new tab useLockOrientation.
Related: [[steam-webapi-feature-roadmap]], [[reco-play-tab-fleet-into-setup]].

## Phase M — couchside.tv marketing for the whole suite (owner ask 2026-09-28)
Showcase the Steam + engagement features on couchside.tv (repo ~/Developer/ets3d,
`npm run deploy`, stash other sites' WIP for a Couchside-only deploy). Market what's
LIVE now (What-to-Play, profile/now-playing card, playtime week/month, achievements,
deals + wishlist sale-watch, ProtonDB/Deck compat, Playlog) and add each new feature
(ITAD all-time-low, alerts, widget, Discover) as it ships. Likely a dedicated
"Steam companion" feature page/section + homepage callout + per-feature screenshots.
Keep gaming-first tone (see [[couchside-seo-marketing]]); bump the mock `service
2.9.x` string per release ([[couchside-site-polish-2026-09]]); NEVER name a competitor
on the public site or repo. Do the setup guides here too (/steam-setup exists;
/itad-setup lands with Phase 0).

## Phase C — Compliance (SHIP GATE, owner asked 2026-09-28)
**couchside.tv/privacy is already inaccurate for SHIPPED features, not just ITAD.**
It states "Couchside collects nothing... the app talks only to the service on your
own machine... nothing leaves" — but the shipped **Steam** integration has the box
call Valve with the user's SteamID + key (deals/wishlist hit the Steam storefront),
and **ProtonDB/Deck compat** sends a game id to ProtonDB + Valve from the phone.
ITAD adds a third external recipient (wishlist/deal appids -> IsThereAnyDeal).

Before any Steam/ITAD feature is marketed as shipped, update:
1. **Privacy policy** — add an "Optional integrations" section: each is OFF by
   default, user-enabled with their own key/consent; name the identifier that
   leaves and the recipient (SteamID->Valve; appids->ProtonDB/ITAD; locale country);
   reaffirm no Couchside server/account/analytics; link each third party's policy.
2. **App Store Privacy labels + Google Play Data Safety** — if they say "no data
   collected/shared," that's now wrong for users who enable these; disclose the
   optional third-party sharing. Mis-declaring risks review rejection / policy strikes.
3. **Terms** — clause: optional integrations need the user's own third-party
   account/key + agreement to that third party's terms; Couchside not responsible
   for third-party data practices/availability.
4. **ITAD API terms** — verify attribution requirement ("Powered by IsThereAnyDeal")
   + caching/affiliate rules. We use only the all-time-low number and link to the
   Steam page (no ITAD affiliate URLs), which keeps it clean — confirm attribution.
NOT legal advice; get a review if unsure. The store data-safety mismatch is the
concrete risk. Treat as a gate: code can land; do not mark shipped/market until done.
