# OpenPuck release candidate

Prepared 2026-11-04. Scope: OpenPuck integration, Android connection recovery, and owner-approved
Ports Beta / experimental with verification and recovery fixes from PR #662.
Release branch: codex/openpuck-release-2.9.82. This document does not publish a release.

## Proposed release notes

- Read OpenPuck firmware, identity and controller connection information from
  Actions on a connected Linux or Windows computer.
- Run a connection check and pair a USB-connected controller with confirmation
  and read-back verification on both devices.
- Put a responsive sealed receiver into update mode and use the existing
  firmware flashing controls. Complete writes and USB reboot confirmation are
  required before a flash is counted as successful.
- Keep receiver tools compact with collapsible sections and Couchside-themed
  controls.
- Bound Android native TCP connection and TLS negotiation waits so attempts to
  an unavailable computer cannot indefinitely occupy both connection workers.

## Validation

Linux and Windows hardware acceptance is recorded in
`openpuck-device-integration.md`. Native Android acceptance on AYN Thor, source
6f95d79, passed inspection, confirmed pairing, firmware reinstall and wireless
diagnostics (20/20 samples before and after flashing) against the Windows preview
agent. Pairing records were preserved. This is input-stream validation, not a
certification of every controller input or game.

The Android connection regression reproduces two stalled TLS handshakes blocking
a healthy host on the dependency's two-worker executor. The patched native code
times out and closes those attempts, allowing the healthy host to connect.
Certificate pinning remains unchanged. Automated regression, codec/connection,
OpenPuck logic and TypeScript checks pass. Physical host-switch acceptance passed on Thor using source a42e1f5: the
offline Windows preview entry displayed Secure link down, then selecting Legion
restored live Console and Actions data without restarting the app. Device logs
confirmed native attempts expired after 4000 ms. The preview APK SHA-256 is
`194f7033048dde96e35248555bfc55cdfbab43f0f21656df13b4c9aba61ff6c4`.

## Remaining release checks

- Complete iPhone layout and lifecycle acceptance for the new receiver controls.
- Review the final diff against current main and rerun required exact-head CI.
- Allocate fresh app/store and changed-agent versions after checking live release
  state. The last checked public app was 2.9.81 and Linux agent was 2.9.136;
  preview package versions are not production release reservations.
- Build final signed distribution artifacts, verify hashes/maps and perform
  install/update smoke checks. The Thor side-by-side APK is debug-signed QA only.

## Separate workstreams

Windows signing and installer rehearsal, Computer Connect proposals, and
additional Ports candidates are excluded from this release. Existing features already shipped in 2.9.81 remain the baseline.
Standalone utility downloads and packing inserts are separate website artifacts.
No subscriber email is part of this release preparation.

## Coordinated 2.9.82 release chain

Live state checked November 4: App Store 2.9.81 (289) READY_FOR_SALE; Play
production 2.9.81 (129) completed, highest uploaded bundle 129; EAS latest iOS
build 289; Direct latest numbered APK 64; Linux 2.9.136; Windows 0.4.15-win.

| Component | Reserved candidate | Delivery and checks |
| --- | --- | --- |
| iPhone/iPad | 2.9.82 (290) | EAS release-candidate, cloud distribution build; verify IPA/signature; TestFlight/device acceptance; App Review with manual release |
| Google Play | 2.9.82 (130) | Signed AAB, verify package/upload certificate and matching map; internal/device acceptance, then production |
| Android Direct | 2.9.82 (65) | Existing Direct package/key; archive APK/map; preserve launcher aliases; in-place upgrade; publish numbered APK and checksums before update manifest |
| Linux agent | 2.9.137 | Stdlib source, signed complete asset set; Linux runtime and Ports restart checks; preserve pairing/config; publish before mobile feature announcement |
| Windows agent | 0.4.16-win | Existing installer workflow, matching monorepo source, install/upgrade smoke; no SignPath experiment |
| Decky | assess bundled agent | Keep plugin behavior unchanged; if bundled agent requires refresh, package and verify the exact 2.9.137 source with a new plugin version |
| macOS agent | no new package planned | Device tools explicitly unavailable; standalone OpenPuck Utility remains available |

Ports is labelled Beta / experimental in Setup and its manager. Its executable
downloads require pinned size and SHA-256 verification. Installs remain opt-in on
the Linux box. A beta label does not waive verification, auth or recovery tests.
Real Linux service-restart and native install/remove acceptance remain required;
use disposable fixtures and preserve existing game files/saves.

Publication order:
1. Freeze source, run exact-head CI, verify native candidates and rollback assets.
2. Stage GitHub notes/assets and store metadata; record binary identities/hashes.
3. Publish verified signed agent assets and Windows/Decky packages as applicable.
4. Release Direct and submit the exact store candidates; track each channel separately.
5. Update website download links and Direct manifest only after assets are fetchable.
6. Advance Play update checker only after production availability; mark iOS public
   only after App Store availability. Preserve pending labels during store review.
7. Verify public downloads, signatures, version endpoints, marketing pages,
   OpenPuck setup/utility/PDF links and installed-upgrade behavior.
8. Prepare a newsletter digest from actually published changes; sending requires
   separate authorization and is not triggered by release commands.

Marketing copy must explain that mobile OpenPuck tools operate through the
updated Linux/Windows service; the free standalone utility also supports macOS.
Do not imply that the phone flashes a USB board attached directly to the phone.

Combined local acceptance: TypeScript, all 881 app tests, 21 Ports job tests,
Ports catalog parity, OpenPuck device/auth/refusal suites and utilities pass.
Final binary checks and exact-head CI remain distinct from these source tests.
