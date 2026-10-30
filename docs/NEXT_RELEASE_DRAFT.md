# Next release draft — not published

Prepared 2026-10-29. This is a working draft; final versions and custom PAD
scope require a frozen, reviewed candidate. No release or subscriber send is
authorized by this file.

## Customer-facing draft

- Improve secure Windows discovery and connections, with encrypted file
  transfers and clearer guidance when administrator windows block remote input.
- On iOS 26, keep user-started encrypted uploads running in the background with
  system progress, cancellation, and a clear completion indicator. Older iOS
  versions retain foreground sending with a limited background allowance.
- Show understandable upload cancellation and retry messages.
- Improve keyboard event ordering and prevent duplicate Return dispatch.
- Fix an Android connection-cleanup crash and update the native runtime to
  address the Hermes memory regression.
- Add compatible HDMI-CEC source selection and paired-TV input-menu controls.
  Available controls depend on the box and TV.
- Add an optional, dismissible newsletter invitation with signup still available
  from Account. Newsletter release digests remain manually approved.
- Prevent iOS password autofill from replacing a box's pairing token.

## Pending scope — do not advertise as shipped

Custom PAD game modes: #654 source e90aac9, now merged into main as 8782046,
is integrated on `codex/presets-release-preview-20261029` for acceptance testing.
Windows gameplay mappings passed on the Razr preset and existing iPhone default
controls. The new iPhone275 shared PAD preview also passed physical overlap and
independent-release checks, and an owner-confirmed Stardew gameplay session.
Upgraded-tool charging and remaining lifecycle/final-binary gates stay separate. Steam Machine mapping verification is owner-deferred;
its earlier X/Y result is not a reason to swap the client mappings globally.

Android background-progress notifications are not implemented in this candidate.
Tailscale transfer follow-up is deferred by the owner and is not a release gate.
A long memory soak is explicitly deferred. Background upload continuation does
not promise recovery after force-quit or process termination.

## Internal release preparation

Working app source: `codex/presets-release-preview-20261029`, held draft #655.
Includes #649, #650, #652, #653, preset source #654 and the shared PAD follow-up.
Installed cloud iPhone276 and Direct52 source is `1c6d76c`. Manual Rotate passed
on both devices. Native testing found that PREFS opened the category without
revealing Pad Layout; the Fabric host-ref correction needs rebuilt acceptance. #651 defensive version fallback is separate
and optional; it is not included. #637 was superseded; do not merge it. #645's
standalone PR conflicts with its old base, but its exact head is already an
ancestor of this combined source. Do not merge duplicate feature branches.

| Component | Current candidate source/config | Final-release action |
| --- | --- | --- |
| App version | 2.9.79 | Confirm after cross-session scope freeze |
| iOS configured build | 276, reserved for Rotate/PREFS acceptance preview | Final release remains separate |
| Physical iPhone QA build | 276, cloud source 1c6d76c | Owner-only installed; Settings scroll correction pending |
| Android Store configured code | 127 | Reconcile latest reservations, then allocate fresh code |
| Android Direct configured code | 52, reserved for shared-PAD/Rotate/PREFS preview | Verify signer and in-place upgrade from private51; final release remains separate |
| Linux agent configured version | 2.9.134 | Already published in v2.9.78; changed source needs a new version, provisionally 2.9.135 |
| Windows agent source version | 0.4.14-win | Confirm final source and release-number availability before packaging |

The Windows runtime file byte-matches the separate Windows combined-preview
branch at `beb0fd7`. Both copies have SHA-256
`7e60b52a9997d53548143ec168832a45aa7dbc59ee458f40b47e03a22e7a3dfc`.
Previously tested Windows artifacts were built from `5c96b4d`; installer
upgrade and post-login startup passed on VM and physical hardware. Do not
confuse documentation-only commits with rebuilt binaries.

### Checks and device evidence

- Before the current polish/main-sync/test-harness follow-up, #649, #650 and #653
  each had 13 passing checks. #652 had 12 passes and one Android lifecycle
  harness failure: executor termination can precede the uncaught-error handler.
  The follow-up waits explicitly for that expected baseline handler; it does not
  change the TCP patch or suppress the assertion. Local isolated JVM test passed.
- Current local app/hook suite: 792 passed; TypeScript passed. Upload policy/copy
  subset: 24 passed. Agent dependency checks: 6 passed; CEC tests: 20 passed;
  Windows privilege/warning checks passed; agent Python compilation passed.
- Owner confirms keyboard acceptance complete. Do not reopen it based only on
  older notes. Final combined-build smoke testing still applies.
- Local iPhone 273.3: 128 MiB encrypted background completion, system Stop,
  partial-file removal and fresh background retry passed, with exact final
  byte/hash checks and owner-confirmed completion text at 100%.
- The new cancellation-copy change has local tests, not a new physical install.

### Final integration and build sequence

1. Complete acceptance of integrated custom PAD source e90aac9 and its gameplay evidence;
   review and integrate into a held candidate without publishing or merging main.
2. Direct 51 provenance is reconciled; reconcile installed Linux Player differences and all
   parallel build-number reservations. Keep existing features and signatures.
3. Freeze exact app/Linux/Windows source commits; run all final CI and parity
   checks. Reconcile old PRs without merging overlapping changes twice.
4. Allocate fresh versions/build codes only after the freeze. Build iOS, Android
   Store/Direct, Windows and Linux candidates from the documented source. Android
   builds on Gandalf must remain under /tank/build-storage with its guard wrapper.
5. Verify upgrades retain boxes, pairing and unlock state; smoke-test controls,
   custom PAD transitions/mappings/holds, uploads and background resume on final
   artifacts. Preserve existing driver setup and normal Windows privileges.
6. Decide Windows signing/distribution. SignPath application is separate work;
   do not claim acceptance, signed artifacts or Store compatibility yet.
7. Prepare hashes, signed agent assets, notes and rollback details for owner
   review. Main merges, public downloads/manifests, store submissions and release
   publication require fresh owner approval. Subscriber sends require separate
   approval even after software release.

## Preset acceptance preview checkpoint

2026-10-29: combined app/hook suite 804 passed and TypeScript passed after the
clean preset merge. Keyboard Return dispatch was retained. EAS cloud preview
uses iOS build 274, app version 2.9.79; this is not the final version allocation.
Cloud archive audit excluded private handoffs, operational notes, credentials,
local test identities and generated output. Build policy remains EAS cloud first.
Source/build identity and device results will be recorded after artifact verification.

### Shared PAD acceptance follow-up (held)

The first combined iOS274 acceptance attempt exposed independent-finger input
failure and hidden connection/ownership status in immersive PAD. It is not a
completed preset acceptance gate. The follow-up uses one data-driven native PAD
touch router for Current landscape/portrait, Stardew and MOVE. It preserves each
layout's stick/button policies, keeps existing output gates, aggregates shared
button holds and cancels pending timers atomically. Full-screen recovery leaves
Exit visible. Other modes and agent protocols are unchanged.

Pure-router cases cover overlap in both orders, both release orders, two sticks,
shared A holds, face rolling, opposite D-pad directions, QAM/click timing,
cleanup, stale callbacks, actual preset geometry and displaced final releases.
Physical overlap, portrait hit registration/animation, two sticks, triggers,
sliding, rotation, background/reconnect and handoff remain acceptance gates on a
new native preview. No public release or subscriber-send authorization exists.

Shared PAD follow-up: TypeScript and 824 app/hook tests passed, including 20
shared-router tests. The StarDesk comparison session independently reviewed
cancellation/measurement; findings were addressed. Reserve iOS275 for the next
EAS-cloud owner-only acceptance preview; version remains2.9.79. Android/store
and agent version allocations are unchanged. Native touch acceptance is pending.

### iPhone275 physical input checkpoint

Cloud artifact source02e667d, app2.9.79(275), installed in place using the existing
owner-only signing profile after verifying the cloud signature, bundle identity,
JavaScript hash and unchanged owner entitlements. All13 source CI checks passed.
The owner confirmed Stardew movement+X, Current landscape dual sticks, and
Current portrait movement+X worked independently. Windows XInput recordings
confirmed overlap and independent releases, with neutral observed afterward.
The Stardew record includes a5.108-second X hold; this is input transport proof,
not upgraded-tool charging gameplay proof or5seconds of uninterrupted dual hold.

Still pending: physical rotation/background/reconnect and handoff, face/D-pad
slides, triggers/chrome under holds, final Android shared-handler build/device
acceptance, and smoke testing the final release binaries. These partial results
do not complete the whole release gate. No release/submission/email.

### PAD Rotate and preferences shortcuts (held)

Portrait PAD adds Rotate in the shoulder gap; the existing orientation lock
requests landscape without a physical turn. Auto resumes sensor rotation, and
Exit returns to portrait. Current/Stardew horizontal PAD adds a preferences
button beside Exit. It reveals Setup → Prefs → PAD Layout, including when a
previous search or folded section would hide it; Controller theme sits beside
Control presets. Navigation/rotation revoke old output callbacks, release held
inputs and remount the touch plane so held fingers cannot transfer to new controls.
Settings reflows are re-aligned until the first user gesture. No new protocol,
dependency, agent runtime or saved preset/theme default. Native shortcut/return
acceptance remains pending; the installed iPhone275 predates these controls.

Shortcut checks: TypeScript and825 app/hook tests pass. Independent read-only
review drove one-use navigation requests and narrow-screen touch bounds. Browser
presses verified Current/Stardew PREFS, portrait reflow alignment, folded/search
recovery, ordinary Setup-category persistence, theme selection and return with
the selected preset retained. Browser Rotate is hidden because its orientation
API is a no-op; native Rotate is only shown with a full44dp shoulder gap. Native
orientation, held-input navigation and phone return acceptance remain pending.

Owner requested both new test previews: iOS276 through EAS cloud (no submit),
Direct Android52 on guarded Gandalf tank storage. Version2.9.79 retained; Play127
unchanged. Artifact identity/signature checks and physical acceptance follow the
builds; this reservation is not a claim of completion, installation or release.

### Native shortcut correction (held)

Both 276 and Direct52 installed in place with signing continuity; Direct first-install
time retained. Manual Rotate worked on both. Native Settings measurement failed
because Fabric rejects the legacy numeric node handle. Use the scroll content host
ref on native and retain the DOM fallback on web. TypeScript and 825 tests pass;
rebuild and native settings acceptance remain separate. No publication authorized.
