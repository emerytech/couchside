# Couchside 2.9.81 release preparation — not published

Prepared 2026-10-31. Feature source: `24a9799fed1059f38d6754108187ab7235cdd80a`.
All required CI checks passed on that exact head. Its tree matches tested
portrait-fix source `f4bdcd6`; the proposed controller rename was reverted.
No merge, publishing, App Review submission or subscriber send is authorized
by this document.

## Proposed release notes

- Browse controller presets in a visual gallery with themed backgrounds and
  full-screen previews. Try controls locally before applying a layout.
- Add a one-handed Vampire Survivors preset and twelve additional themed beta
  game presets. Game-specific mappings remain subject to gameplay validation.
- Create personal copies of presets with controller button/trigger mappings
  and custom labels, saved separately for each paired box on the phone.
- Fit portrait PAD controls to narrow screens so the right-side buttons and
  stick remain visible. Keep the keyboard bar compact on small phones.
- Refresh the Decky manager with better-proportioned plugin cards, themed
  installation confirmations and improved store/version compatibility.
- Add optional validated TV appearance packs to the existing appearance tools.
- With an updated agent, open Steam's uninstall flow from an installed game's
  Launch card. Steam handles removal; a request is not proof of completion.

## Included source and compatibility

The feature source includes the appearance-pack branch, Decky device-preview
branch, expanded preset gallery, custom controls and narrow-screen fix.
Existing Xbox-compatible device identity, portrait input bindings and saved
app theme remain unchanged. Custom mappings apply to full-screen PAD only.
Keyboard bindings and timed macros are not implemented.
The uninstall endpoint is additive on Linux and Windows. Old agents omit the
per-game offer, so the app hides the action. Known installed IDs, explicit
confirmation and fresh idle manifests are required; no direct file deletion.

## Candidate matrix

| Component | Available evidence | Required before production |
| --- | --- | --- |
| App source | exact feature head above, green CI | review the full diff against main |
| Android Direct 2.9.80 (63) | signed artifact/map verified; upgrade/portrait fit passed; native custom copy, X-to-LT mapping, label, save without apply, apply and restart persistence passed | shared-output LT hold/release passed on hardware; remaining lifecycle/per-box isolation and final binary smoke |
| iOS 2.9.80 (288 internal preview) | cloud build from `80db266`; signature/version verified and installed in place, includes portrait fix | gallery/copy/save/apply, physical A-to-LT, normal release, PREFS release and background/resume passed; cold restart and per-box selection isolation passed; final store smoke pending |
| Google Play | prior code128 belongs to 2.9.80 | allocate a fresh code after checking Play; build and verify AAB/maps |
| Linux agent | source still declares2.9.135 with new Decky/uninstall changes | assign fresh version, test exact candidate and signed assets |
| Windows agent | source still declares0.4.14-win with uninstall addition | reconcile0.4.15-rc1 signing work separately; allocate version and test exact installer |
| Decky plugin | separate repository not changed by this task | verify compatibility/source and update bundled agent assets if required |

2.9.81 is the proposed mobile release version, not yet an allocated store
candidate. Recheck build-number availability before reserving final candidates.
Do not ship changed agents under their existing published versions.
Windows signing preparation remains a separate workstream; do not silently
include its updater/installer changes or claim SignPath approval.

Preview 288 is an internal device build, not an App Review submission. Earlier
287 was uploaded to TestFlight but does not contain the portrait fix. PR #658
required checks passed on `80db266`; the release branch remains draft.

## Acceptance gates

- On iPhone and Android, copy a preset, remap a button to a trigger, change its
  label, save/apply, restart and verify persistence and per-box isolation.
- Verify two controls mapped to the same output release independently, and all
  held input releases on rotation, background, preset changes and ordinary
  controller handoff. The previously deferred Pass-while-holding gesture stays
  deferred; it is not a new mandatory test.
- Verify final portrait layout on iPhone and a narrow Android; inspect short
  displays and larger text. Physical Android visual fit passed, gameplay did not.
- Check beta game mappings in actual gameplay before claiming game-specific
  certification; retain beta labels for unvalidated presets.
- Use an explicitly approved disposable Steam game for Linux/Windows uninstall
  cancel/confirm behavior and final library refresh. Never test on personal
  game files without identifying the disposable target first.
- Recheck Decky manager reconnect/catalog/install-confirmation behavior on
  matching agent candidates. Preserve prior evidence; repeat only for drift.
- Build final versioned iOS, Play and Direct artifacts from one reviewed source;
  verify identity/signatures/maps and install/update smoke the actual binaries.
- Prepare new agent packages, checksums, signatures and rollback artifacts;
  verify Windows install/startup if rebuilding its agent.

## Publication hold

No production release, main merge, public update manifest, website download,
store rollout or subscriber email has been performed for this release.
Subscriber email draft/approval is a separate manual step. Once acceptance
passes, present exact commits, artifacts, checksums and remaining limitations
for release authorization.

## Native input checkpoint — 2026-10-31

On iPhone preview 288, the mapped trigger returned to neutral on normal release
and before disconnect when opening PREFS. A repeated background test recorded
neutral before disconnect, reconnect after about five seconds, and a fresh
press/release after return. The first attempt lost its recording during a host
reboot and was not counted as instrumented evidence. Android Direct 63 also
passed independent releases of two controls mapped to the same trigger.
These results do not certify the remaining acceptance gates or final binaries.

## Persistence and integration checkpoint — 2026-10-31

iPhone preview 288 retained its selected custom mapping after an app-switcher
force-close and fresh launch. A second saved box kept Current controls; returning
to the original box restored the custom selection. The original Vampire
Survivors Right-hand/Moonlit ruins preset was restored after the check.

TypeScript and all 866 app/input tests passed on the candidate. Steam uninstall
auth/refusal tests, core dependency checks and protocol parity also passed.
Required GitHub checks passed on `b566e71`. These are source/preview checks;
final versioned release artifacts and real Steam uninstall acceptance remain
pending. No production version or release channel was changed.

## Candidate reservation and hardware checkpoint — 2026-10-31

Reserved mobile 2.9.81: iOS 289, Play 129 and Direct 64. App Store Connect's
latest uploaded build was 287, EAS's latest internal build was 288, and Play's
highest uploaded bundle was 128 when checked. No candidate was submitted.
The explicit release-candidate EAS profile keeps reserved build numbers fixed.

Linux agent 2.9.136 passed required CI at `f008577` and was installed on the
SteamOS test box with its prior agent backed up. Public ping, authenticated
status/library, unauthorized-status refusal and a fresh Decky catalog passed.
A native iPhone test cancelled uninstall without sending a request, then
opened Steam's own confirmation for an approved small game. Steam removed the
game and Couchside's installed library refreshed correctly. Windows uninstall
remains to verify on its actual candidate installer.

iPhone mapped-input rotation recorded the trigger returning to neutral and
a clean portrait A press/release afterward. Ordinary handoff worked in both
directions between iPhone and Android, with mapped trigger press/release after
each promotion. Original presets were restored on both phones. These checks
used preview binaries; final candidate binary smoke remains required.

Windows 0.4.15-win is reserved for the additive uninstall change on the existing
installer/build path. The separate 0.4.15-rc1 SignPath/updater experiment is not
included, and signing policy is unchanged for this candidate.
