# OpenPuck release candidate

Prepared 2026-11-04. Scope approved in this chat: OpenPuck integration and the
Android connection fix. PR #663 is the feature candidate. This document does not
publish a release or reserve store build numbers.

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
OpenPuck logic and TypeScript checks pass. Physical host-switch acceptance of the
rebuilt APK is still pending.

## Remaining release checks

- Complete native Android offline-host to Legion switching on the rebuilt APK.
- Complete iPhone layout and lifecycle acceptance for the new receiver controls.
- Review the final diff against current main and rerun required exact-head CI.
- Allocate fresh app/store and changed-agent versions after checking live release
  state. The last checked public app was 2.9.81 and Linux agent was 2.9.136;
  preview package versions are not production release reservations.
- Build final signed distribution artifacts, verify hashes/maps and perform
  install/update smoke checks. The Thor side-by-side APK is debug-signed QA only.

## Separate workstreams

Ports verification/recovery (PR #662), Windows signing and installer rehearsal,
Computer Connect proposals, and additional Ports candidates are excluded from
this release. Existing features already shipped in 2.9.81 remain the baseline.
Standalone utility downloads and packing inserts are separate website artifacts.
No subscriber email is part of this release preparation.
