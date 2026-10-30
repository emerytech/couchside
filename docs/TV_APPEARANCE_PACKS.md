# TV appearance packs — isolated implementation, pending device acceptance

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

No physical SteamOS/Bazzite acceptance yet: Steam Machine mDNS and configured IP
were unreachable; owner will provide Bazzite details when home. No real machine
installation, input testing, package signing, push, merge, publication or emails.

Source worktrees:
- couchside-tv-appearance-packs-20261030 (agent and phone)
- couchside-decky-appearance-packs-20261030 (companion)
Local integration harness: /Users/temery/Developer/couchside-appearance-integration-20261030
Phone preview: http://127.0.0.1:8946/steam-themes
TV preview: http://127.0.0.1:8946/tv
The harness has real theme-file persistence but simulated hardware capabilities,
sample library and Decky browser shims. It cannot launch games or control a PC.
