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
controls. The new iPhone preset, physical multi-touch and upgraded-tool holds
remain acceptance gates. Steam Machine mapping verification is owner-deferred;
its earlier X/Y result is not a reason to swap the client mappings globally.

Android background-progress notifications are not implemented in this candidate.
Tailscale transfer follow-up is deferred by the owner and is not a release gate.
A long memory soak is explicitly deferred. Background upload continuation does
not promise recovery after force-quit or process termination.

## Internal release preparation

Working app source: `codex/ios-secure-background-upload-20261029`, runtime review
head `1e343a35b9d4bffa1c0d344094a1a9d9a5cedbe3`. Includes #649, #650, #652, #653
and current main through `efdb432`. #651 defensive version fallback is separate
and optional; it is not included. #637 was superseded; do not merge it. #645's
standalone PR conflicts with its old base, but its exact head is already an
ancestor of this combined source. Do not merge duplicate feature branches.

| Component | Current candidate source/config | Final-release action |
| --- | --- | --- |
| App version | 2.9.79 | Confirm after cross-session scope freeze |
| iOS configured build | 274, reserved for EAS acceptance preview | Final release build remains separate |
| Physical iPhone QA build | 273.3, source d67f482 | Local-only; not a store submission or the new message-copy build |
| Android Store configured code | 127 | Reconcile latest reservations, then allocate fresh code |
| Android Direct configured code | 48 | Private 51 source 1c0c68a is reconciled; use a higher final code |
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
