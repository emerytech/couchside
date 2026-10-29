# Keyboard and native upload follow-up — 2026-10-29

Test-only work. No release or store submission is authorized by these results.

## Device observations before these patches

- Physical iPhone typing against the Windows preview matched the owner's input.
- Android rapid typing, replacement and Backspace reached Windows correctly.
- One Android Return inserted an extra blank line. Pad and Desktop had both
  keypress and submit handlers dispatching Return.
- Automated iPhone Mirroring burst typing produced repeated characters; slow
  individual characters worked. The physical-phone comparison did not reproduce
  that corruption. Its cause remains untraced; Windows injection was not changed.
- The Android device was on Direct build 51, not the previously tested build 48.
  Its source provenance still needs reconciliation before release sign-off.
- Earlier small and 8 MiB native iPhone encrypted uploads passed exact hashes.
- A 128 MiB attempt followed by Home failed with ERR_UPLOAD_FAILED. Windows had
  neither a completed destination nor a partial file at readback. The progress
  observer itself timed out, so there is no time series proving when it failed.
  Do not attribute the failure conclusively to background suspension.

## Scoped patches

- Return is dispatched only from the single-line input's submit event.
- Desktop keyboard diffs update their baseline synchronously before sending,
  including resets, so events arriving before React renders do not duplicate text.
- iOS pinned uploads request a bounded UIApplication background execution lease.
  Completion, cancellation and expiration end the lease. Expiration cancels the
  current transfer; retry requires selecting the file again and a new ticket.
- Upload errors expose only static text and, when available, a numeric URL-loading
  error code. Native error URLs, userInfo and localized descriptions remain private.
- This is an in-process grace period, not indefinite background transfer or
  recovery after force-quitting. Pin checks, one-use tickets, redirect rejection,
  response limits and the absence of HTTP fallback remain unchanged.

## Checks and remaining gates

- Keyboard batching/Return and gamepad lifecycle/reconnect: 29 tests passed.
- TypeScript typecheck and 21 upload policy tests passed.
- Swift typecheck against the iPhoneOS SDK and a full unsigned native iOS
  Release build passed. The compiled app is not signed or installed on a phone.
- Real TLS transport fixtures pass correct-pin binary transfer, wrong-pin refusal
  before HTTP, plaintext refusal, one-use tickets, redirects, bounded responses,
  disconnection, cancellation, read timeout and recovery. These run on macOS and
  do not exercise UIKit background expiration.
- Repeat foreground and active-background uploads on a signed physical iPhone
  build, recording server progress while the app remains at Home and verifying
  the destination's size and SHA-256. Also verify safe error reporting, retry,
  and Return exactly once on both phones. These device gates remain open.


## Physical iPhone follow-up: local owner-only build 273.1

A signed ad hoc copy of source `27c0490` was installed in place on the owner's
registered iPhone. Version 2.9.79 (273.1) is a local artifact metadata override,
not an App Store/TestFlight build or an app.json version reservation. The existing
certificate was reused with a single-device profile; the installed app's exact
entitlement set, including multicast and default keychain behavior, was retained.
Four saved boxes, the live work-PC pairing and the Early Adopter unlock survived.
A controlled restart to load the new binary generated an expected inferred
closed-unexpectedly entry; no spontaneous crash was observed in this test.

- **Foreground PASS:** the synthetic 128 MiB file arrived with exactly 134217728
  bytes and matching SHA-256. The server reported about 59 seconds for the upload.
- **Active background continuation observed, completion FAIL:** the owner went
  Home immediately after sending started. After that confirmation, 29 samples
  recorded growth from 45 MiB to 61 MiB. Home was also visually confirmed before
  reopening Couchside. The transfer then expired at roughly 30 seconds; the app
  displayed the explicit background-time-expired message, and the partial file
  was removed without publishing a completed destination.
- Reading Windows directory metadata alone initially reported zero bytes during
  writing. A read-only open-handle length measurement provided actual progress.
- The recorder was stopped and the exact temporary firewall test rule removed;
  original firewall rules were retained.

The bounded grace period is working, but is insufficient for this large upload.
Do not mark the long-background-transfer release gate passed. Keep large uploads
in the foreground until a separately reviewed design preserves the current pin,
scoped-ticket and redirect protections. In particular, Apple's background URL
sessions always follow redirects, so simply switching configurations would change
an existing security guarantee. See [Apple's background transfer limitations](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).
Phone single-Return retesting remains pending; the event-handler regressions pass.
No release, main merge, store submission or subscriber email.
