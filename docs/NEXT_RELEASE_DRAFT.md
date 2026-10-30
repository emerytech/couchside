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
Installed owner previews are cloud iPhone277 from `ad73a5a` and Direct55 from
`159ec3f`. Direct55 contains an unsuccessful experimental held-input handoff
fix. That experiment has been removed from the current source; Direct55 remains
installed until the next preview. The owner deferred this edge case as non-blocking.
The Fabric host-ref correction is included. Rotate/PREFS, settings return, Auto
and Exit passed on Direct54. Physical iPhone277 Rotate/PREFS landing and both
phones' held-button background/reconnect checks passed on the Windows preview.
#651 defensive version fallback is separate
and optional; it is not included. #637 was superseded; do not merge it. #645's
standalone PR conflicts with its old base, but its exact head is already an
ancestor of this combined source. Do not merge duplicate feature branches.

| Component | Current candidate source/config | Final-release action |
| --- | --- | --- |
| App version | 2.9.79 | Confirm after cross-session scope freeze |
| iOS configured build | 277, reserved for Rotate/PREFS acceptance preview | Final release remains separate |
| Physical iPhone QA build | 277, cloud source ad73a5a | Owner-only installed; saved connection/unlock retained; physical Rotate/PREFS and held-button background/reconnect passed |
| Android Store configured code | 127 | Reconcile latest reservations, then allocate fresh code |
| Android Direct configured code | 55, source 159ec3f | Installed in place with matching Direct signer and original first-install time; active Linux pairing retained; held-input handoff limitation deferred by owner; experimental fix removed from current source |
| Linux agent configured version | 2.9.135, source 02e81f6 | Privately installed on an owner Linux laptop; no published release or update-manifest change |
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
- Current local app/hook suite after removing the experiment: 825 passed; TypeScript passed. Earlier upload policy/copy
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

Corrected Settings acceptance reservations: iOS277 / Direct54. Direct53 is
reserved by the separate optional appearance demo; it is not part of this build.

### Corrected artifact checkpoint — 2026-10-30

- Source `ad73a5a`: 13/13 CI checks passed; TypeScript and 825 app tests pass.
- EAS cloud iPhone277 installed with original/owner signatures, unchanged owner
  entitlements and identical JS bundle verified; connection and unlock retained.
- Direct54 installed with signer continuity, matching APK/map checksums and
  verified Hermes bundle association; source maps retained privately.
- Android UI acceptance: manual Rotate, native PREFS reveal, return to locked PAD,
  Auto and Exit passed. Offline saved profile used for chrome checks to avoid
  competing with iPhone control. These are not new Windows gameplay/hold tests.
- The following physical checkpoint supersedes the corrected iPhone shortcut
  deferral. Appearance demo source remains isolated and is not integrated here.
  No publication.

### Physical lifecycle and Linux preview checkpoint — 2026-10-30

- iPhone277: owner confirmed manual Rotate and upright PREFS landing at Pad
  Layout. Windows recorded X held continuously for 4.16 seconds, then neutral.
- iPhone277: owner confirmed control returned after holding X, going Home and
  reopening PAD. Windows recorded a continuous 7.09-second X segment, release
  to neutral, then a fresh A press and release after return.
- Direct54: owner confirmed background/reconnect returned normally. Android
  blocked a Home swipe while another finger was held, so the authorized ADB
  Home key was used. Windows recorded a 13.18-second X segment, neutral, then
  fresh A presses and releases. This validates lifecycle cancellation, not the
  blocked Android gesture itself or upgraded-tool charging in a game.
- Basic phone control handoff passed; handoff while an input is held remains
  separate. Broader final-artifact acceptance remains open.
- Linux2.9.135 privately replaced an older laptop agent after a protected
  backup and isolated mock authentication smoke. Live verified HTTPS status,
  unauthenticated refusal and unchanged pairing/configuration/TLS identity passed.
  Helper and service files were retained byte-for-byte; rollback is available.
  This is not full Linux phone/gameplay or installer acceptance.
- Focused Linux dependency, protocol parity, CEC tests and compilation passed.
  Temporary Windows observers and the scoped test firewall exception were
  removed. No release, store submission, public manifest change or email.

### Native Linux pairing and preferences release — 2026-10-30

- iPhone 277 and Direct 54 each added a separate Linux test box using the existing
  owner-authorized pairing. Native reachability and authenticated status both
  passed against agent 2.9.135; both showed the encrypted connection indicator
  and connected virtual Xbox controller. Existing saved boxes were retained.
- iPhone 277: owner confirmed Rotate followed by PREFS opens upright at Pad
  Layout. A read-only observer of only the agent's virtual Xbox device recorded
  X held continuously for 6.84 seconds, then all buttons and axes neutral before
  device teardown. This confirms release for this native preferences transition.
- At this checkpoint, held-input phone handoff, native Linux uploads and broader
  final-binary/gameplay acceptance remained pending; later results appear below. The earlier recorder expired without capturing X;
  only the successful repeat is counted here. No release or subscriber email.

### PAD handoff while holding a control — candidate fix

Native Direct 54 testing found Pass could not be tapped while X remained held.
The eventual pass after release was neutral, but does not pass this acceptance
case. PAD Pass/Keep now follow their own touch identifier and activate only
when that finger ends inside the same button. Drag-out, cancel, re-layout and
request replacement discard the gesture. Pass retires PAD callbacks and sends
neutral input before granting control; ordinary non-PAD press handling is retained.

TypeScript and all 834 app tests pass, including nine decision-touch regression
cases. Source `159ec3f` passed all 13 CI checks. Direct55 was built and installed
in place with signer continuity, unchanged first-install time, and verified APK,
Hermes bundle and source-map checksums. iPhone277 still lacks this fix. Physical
held-input handoff acceptance remains pending; automated checks do not certify it.

Direct55 native encrypted foreground upload to the Linux candidate passed with
a synthetic 64 KiB file and an exact destination hash match. The same fixture
failed before sending any bytes on Direct54 while its connection was stale; the
agent still answered verified HTTPS locally. Success after the app upgrade/restart
does not establish that the handoff change fixed that separate connection issue.
The initial failure remains a follow-up. No release or subscriber email.


### Held-input handoff deferred by owner — 2026-10-30

The owner physically retested Direct55 and reported Pass still blocked while X
was held. The attempted touch-handler change and its experiment-specific tests
were removed, restoring the previously tested Pass/Keep implementation. The
shared PAD multi-touch foundation and Rotate/PREFS changes remain intact.
Direct55 stays allocated and installed; do not reuse its version code or claim
its binary contains this revert.

The owner explicitly considers simultaneous gameplay input and Pass unnecessary
and non-blocking. Release the gameplay controls before tapping Pass. Normal
handoff and neutral input cleanup still matter; this deferred gesture is not a
passed test. The read-only Linux observer was stopped; its final observed state
was neutral. No release or subscriber send is authorized.
