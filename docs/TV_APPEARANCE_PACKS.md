# TV appearance packs — isolated implementation and device checks

Optional packs extend the existing authenticated GET/POST `/api/steam/themes`.
The phone's Steam appearance and Theme Studio screens expose pack selection only
when `appearance_ready` is true. This requires the companion's `appearance: 1`
capability. Neither phone colors nor PAD controls change.

## Data and storage

`appearance` is null (original layout colors) or a version-1 object with name,
colors and backgrounds. Six mandatory colors are six-digit hex values:
background, surface, text, muted, accent, focus. Backgrounds may contain home,
library and settings: each is an integer angle 0–360 and 2–4 hex color stops.
No raw CSS, selectors, scripts, URLs or client file paths are accepted by the API.

Applying a pack upserts it by name into `appearance_packs` (maximum eight), using
the existing lock and atomic 0600 settings-file replacement. Null restores layout
colors and preserves the library. Disabling themes restores Steam. Omitting the
new fields preserves saved choices, including writes from older app versions.
Until a pack is saved, new keys are omitted from the on-disk JSON because older
Decky companions reject unknown keys. New clients tolerate absent fields. Pack
users need the matching agent and companion; downgrading the companion can cause
its strict schema to fall back to Steam. No versions or release assets changed.

## Import subset

Phone import accepts pasted PC5 color CSS as input data. It translates --c-bg,
--c-card, --c-text, --c-text-2, --c-accent, --c-ring-a and --g-art-default,
--g-library, --g-settings. Colors must be six-digit hex. Gradients must be simple
linear-gradient(angledeg, hex, hex[, hex, hex]). Other declarations are reported
as skipped; directives and escapes reject the import. This intentionally supports
less CSS than the browser-only prototype. No PC5 implementation or assets copied.
The phone preview shows colors; gradient preview is available on the TV picker.

## Verification and handoff

Agent route tests cover authentication, invalid data, companion capability gate,
real file persistence/permissions, eight-pack limit, named replacement, restoration,
legacy clients and preservation of the legacy on-disk schema before opt-in.
TypeScript/import checks, app typecheck, Expo web export, theme-format/installer/
protocol checks and companion regressions passed. Browser interactions used the
actual phone screens and companion renderer with sample games. Every layout was
rendered with Forest. Harbor import reported nine accepted and one skipped token;
Apply reached the TV, survived a local agent process restart, and layout-default
restore removed the appearance wrapper. Steam default handoff also worked.
Existing companion polling can take up to three seconds to reflect Apply.

Physical TV checks on 2026-10-30 used temporary matching agent/companion files:
SteamOS 3.8.16 with Decky 3.3.0, and Bazzite 44 with temporary Decky 3.3.1. Native
screen captures verified Forest/Harbor, default-color restore and Steam Home;
Bazzite additionally rendered every layout. Picker preview/Cancel/Apply, saved
pack retention across agent restarts, and gamepad-path focus were exercised.
The gamepad inputs used the actual agent connection, not a physical handset.

Hardware testing found and fixed two companion picker defects: previewing layout
defaults remounted the content and lost scroll/focus; the visually vertical pack
list declared row navigation, so Down skipped its choices. The stable opt-in
container and column navigation were verified on both machines. Default installs
without saved packs retain their original render tree.

Bazzite's original Decky 3.2.7-pre1 frontend failed before Couchside loaded on the
current Steam client; testing required a compatible loader. Original installations,
theme settings, pairing/configuration, and Bazzite loader were restored afterward.
Native phone import/Apply and release packaging remain separate checks. No game
was launched, and no signing, push, merge, publication or emails occurred.

Source worktrees:
- couchside-tv-appearance-packs-20261030 (agent and phone)
- couchside-decky-appearance-packs-20261030 (companion)
Local integration harness: /Users/temery/Developer/couchside-appearance-integration-20261030
Phone preview: http://127.0.0.1:8946/steam-themes
TV preview: http://127.0.0.1:8946/tv
The harness has real theme-file persistence but simulated hardware capabilities,
sample library and Decky browser shims. It cannot launch games or control a PC.
