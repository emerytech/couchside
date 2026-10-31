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
At that stage native phone import/Apply and release packaging remained separate
checks. No game was launched, and no signing, push, merge, publication or emails
occurred during those TV-only checks.

### Private iPhone preview 280 — 2026-10-30

With owner approval, EAS internal/ad-hoc build
`93b1f169-a838-4a8d-bb20-0a6584a7bfae` produced 2.9.80 (280) from app/agent
head `f007219`; companion head was `e287354`. The existing ad-hoc profile was
refreshed to include the already-declared multicast entitlement. Signature,
embedded profile, entitlement and registered-device inclusion were verified;
installation on the iPhone 17 Pro Max was confirmed through device metadata.
The earlier build 279 failed signing and was not installed. Repository version
files were restored after EAS's automatic build-number changes.

Native iPhone Mirroring checks passed Forest preview without a server write,
Cancel to original preview, Apply to Bazzite, persistence across agent restart,
and Restore layout colors followed by Apply (appearance null, saved Forest
retained). Steam default wrote enabled=false. A native Bazzite screen capture
confirmed the Forest launcher. The subsequent color-restore capture showed
Steam's controller overlay, so that capture does not prove the default-colored
launcher. Five saved boxes remained, and before/after portrait PAD and SWIPE
screens retained their existing styling and controls. This was appearance
validation, not a gameplay or full input regression test.

Native CSS import remains open: Mirroring paste did not insert text, while typed
double hyphens became smart punctuation. The importer safely rejected the altered
input without changing the active pack. A successful native import/Apply is not
claimed; follow up on code-input smart punctuation and actual on-phone paste.
The first post-install launch showed an unexpected-close banner without a
captured app error; its origin was not established, and no repeat occurred during
the observed session. Check a clean launch and diagnostics before release sign-off.

Bazzite's original agent, companion, Decky binary/version/settings, configuration
and pairing-token hashes all matched after rollback; both services were active,
and the originally absent theme file was again absent. The phone retains the
authorized private build 280. Steam Machine was unavailable in this session.
Nothing was submitted to TestFlight or a store, pushed, merged, released, or emailed.
Evidence: `couchside-appearance-integration-20261030/iphone-checks` next to the
source worktree. Release packaging, native import and the launch check remain gates.

### Import follow-up

Commit `16c4b9f` adds a user-initiated Paste control using the existing
expo-clipboard dependency. Available iOS devices use UIPasteControl for literal
text; other platforms use a themed Paste CSS action. No clipboard is read on
mount. Empty or oversized text leaves the existing field intact. The CSS field
disables autocorrection, capitalization, spellchecking and smart insertion.
Smart-dash declarations are rejected with guidance to paste the original text;
they are never normalized into valid input. Server validation is unchanged.

Typecheck, 37 importer/crash-log tests and Expo web export passed. Local browser
interaction verified literal Paste/Preview (nine accepted, one skipped), smart
punctuation rejection including mixed valid/altered input, oversized/empty paste,
and Cancel. EAS internal build `79ee2005-424f-4397-9e3e-17cc30a1b75c` finished;
the signed 2.9.80 (281) artifact and registered-device profile were verified and
installed, and device metadata confirmed build 281. Native import/Apply and clean
launch remain pending: the owner locked the iPhone, but Mirroring then reported
the Mac was locked. No TV components were changed during this follow-up. These
web results do not substitute for its physical iPhone import/Apply check.

### Native iPhone 281 acceptance — 2026-10-30

After Mirroring reconnected, build 281 opened without the unexpected-close banner.
A synthetic Harbor fixture was copied in iPhone Safari and pasted through the
native Paste control (iOS requested Allow Paste). Preview accepted all nine
supported declarations and skipped the one unsupported declaration. API reads
confirmed Preview and Cancel left appearance null and the saved-pack list empty.
Explicit Apply saved the exact structured colors/gradients as Harbor iPhone,
without enabling a launcher. Apply Couchside then enabled it; a native Bazzite
capture confirmed the Harbor launcher. The pack survived an agent restart.
Restore layout colors plus Apply cleared appearance while retaining the saved
pack; Steam default then wrote enabled=false. The color-reset capture showed a
different screen, so only the API state proves that reset in this session.

A second clean launch (Home, dismiss the backgrounded app in the app switcher,
reopen) also showed no unexpected-close banner. The app error count stayed at
three. The newest entry observed before testing was timestamped 18:33, before
installation of previews 280/281. Its complete details could not be read reliably
through Mirroring, so the original cause remains unconfirmed; no crash-detection
logic was changed or logs cleared. This is a passed observed launch check, not
proof against every possible native crash.

Bazzite's original agent, companion, loader binary/version/settings, configuration
and pairing-token hashes matched after rollback, both services were active, and
the originally absent theme file was absent again. Test settings and components
were archived under the existing staging directory with the 281 suffix. The
test-only clipboard server was stopped. The iPhone retains private build 281.
No game was launched or save changed. Nothing was pushed, merged, submitted to
TestFlight/a store, released or emailed. Native import/Apply is now verified;
release packaging and final release review remain separate gates.
Evidence: iphone-checks/import-preview-281.png, import-cancel-281.png,
iphone-harbor-281.jpg, startup-281.png and relaunch-281.png in the integration
folder listed below.

Source worktrees:
- couchside-tv-appearance-packs-20261030 (agent and phone)
- couchside-decky-appearance-packs-20261030 (companion)
Local integration harness: /Users/temery/Developer/couchside-appearance-integration-20261030
Phone preview: http://127.0.0.1:8946/steam-themes
TV preview: http://127.0.0.1:8946/tv
The harness has real theme-file persistence but simulated hardware capabilities,
sample library and Decky browser shims. It cannot launch games or control a PC.
