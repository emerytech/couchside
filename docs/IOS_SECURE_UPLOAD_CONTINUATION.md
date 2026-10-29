# Secure iOS upload continuation

## Transport and lifecycle are separate

The transport remains the existing in-process pinned HTTPS uploader. It checks the
paired RSA key before sending request headers or file bytes, rejects redirects,
uses one-use scoped tickets, caps replies and never falls back to HTTP.

An iOS 26 continued-processing task lets that same transport continue after the
user goes Home. This avoids changing to a background URL session, which always
follows redirects and would therefore change a current security guarantee.
The OS shows progress and provides cancellation through its system activity.

This is permission to keep processing, not a detached transfer daemon. It does
not promise recovery after force-quit, process termination, loss of connectivity
or the system withdrawing its task grant. There is no automatic replay of a POST
or reuse of an upload ticket. On failure the user selects the file again.

## Admission and fallback

- A selected file is the initiating user action. Requests are submitted while
  the app is foregrounded, with `.fail` rather than queueing an expiring ticket.
- One fixed app-prefixed identifier is permitted in app.json and registered only
  once per process. No endpoint, filename, saved pin or ticket appears in it or in
  the system activity.
- The native uploader waits for admission before starting. A five-second fallback
  preserves foreground sending if the launch callback is unexpectedly delayed.
- Upon grant, the uploader ends the short UIKit allowance and uses the longer
  continued-processing task. Byte progress reserves its last unit until the box
  acknowledges success.
- Older iOS, missing configuration, denied registration and rejected submission
  retain the previous bounded foreground path. This fallback does not claim
  reliable large-file background completion.

## Completion, cancellation and stale callbacks

All task lifecycle operations run on the main queue. URLSession response parsing
stays on its serial delegate queue. Success, cancellation and expiration finish
the OS task once; expiration also cancels the network operation. Cancellation
while waiting for admission releases the module's active-upload slot.

A cancelled request awaiting its launch callback retains one callback-free
retired owner. Until its callback arrives, newer uploads use the foreground
fallback. A late grant completes the retired task as failed and cannot attach to
a newer upload. This bounded fail-safe avoids ambiguous reuse of the fixed task
identifier. A running task releases its owner immediately upon completion.

## Validation

The actual coordinator runs against injected scheduler/task boundaries in
`tests/upload-continuation/main.swift`. Cases cover grants, progress, registration
and submission failure, overlapping calls, cancellation before grant, expiration,
duplicate/late callbacks and reuse. The config check verifies that the real native
identifier matches app.json. The pinned transport's real TLS fixture suite remains
required, including wrong pins, plaintext and redirect refusal.

Signed-device gates: transfer beyond the old 30-second limit with Home visibly
active and server-side byte growth; exact final size/SHA-256 before app resume;
system-activity cancellation and staging cleanup; retry; saved boxes/pairing/unlock
continuity; and foreground behavior when continued processing is unavailable.
Do not equate compilation, unit tests or an accepted request with a device pass.

No agent API or dependency change. No release is authorized by this design.

References: [Apple continued processing](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados/),
[background URL session limitations](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).

## Owner device check (2026-10-29)

Local test-only build 273.2 completed a 128 MiB encrypted upload to the
Windows preview. Owner screenshots show Home Screen activity advancing from
8 percent to a completion checkmark. Server readback confirmed 134,217,728
bytes and an exact SHA-256 match to the synthetic source. This verifies this
background completion attempt; it does not establish force-quit recovery.

The tested build retained a stale 99-percent subtitle despite its completion
checkmark. A follow-up updates the successful activity title to “Transfer complete”
and its subtitle to “Encrypted transfer · 100%” before marking the task complete.
Local owner-only build 273.3 verified the follow-up on a physical iPhone. The
owner confirmed “Transfer complete” and 100 percent while Couchside was
backgrounded. Server-side samples recorded about 60 seconds of active sending;
the final 134,217,728-byte file matched the source SHA-256 exactly, with no
staging parts remaining. The completion-display polish is complete.

The temporary device-test firewall rule was removed and original rules retained.
System-activity cancellation, cancellation cleanup/retry, and the remaining device
gates above are still pending. Release and submission remain on hold.
