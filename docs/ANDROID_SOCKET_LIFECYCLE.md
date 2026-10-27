# Android TCP cleanup preview

Publication remains on hold. This change is stacked on the TV-input preview
and does not update public downloads, update manifests, or store submissions.

## Observed failure

The physical Razr's Direct 44 crash report contains an uncaught
`IllegalArgumentException: No socket with id 1530`, from
`TcpSocketModule.end()` on the native library's executor. This predates Direct
45 and the new Windows-agent preview. JavaScript `try/catch` around `destroy()`
cannot catch an exception later thrown on that native worker.

`react-native-tcp-socket` 6.4.2 calls its throwing client lookup from queued
cleanup. When a failed/cancelled connection has no registered client at that
point, cleanup kills the process. An absent client is already closed for the
purpose of that cleanup request.

## Scope

The app's postinstall script changes only that Android cleanup lookup to close
an existing client, and otherwise do nothing. It does not change certificate
trust, pin verification, socket writes, discovery, permissions, or any iOS code.
This is not a general fix for every possible TCP lifecycle race.

The script accepts only version 6.4.2 and the exact reviewed method, is
idempotent, and stops installation if the dependency version or method changes.
Builds that deliberately disable npm lifecycle scripts must run
`node app/scripts/patch-tcp-socket-android.cjs` before compiling Android.
The dependency's MIT notices remain intact. Upstream source:
<https://github.com/Rapsssito/react-native-tcp-socket/blob/v6.4.2/android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketModule.java>.

## Validation

- A JVM harness executes the original and patched cleanup method using the
  library's two-worker executor/concurrent-map model. A client disappears while
  cleanup is queued: the original throws the recorded uncaught exception; the
  patched method completes without it. A live client still closes and an
  unrelated client is untouched.
- Source reversibility/idempotence and unknown source/version refusal passed.
- CI fetches only the exact TCP dependency into an isolated directory, without
  lifecycle scripts, then runs these checks against its real Java source.
- Direct 46 / 2.9.79 built from `e71d442`. The final release-signed APK's DEX
  contains the guarded cleanup method; this was checked in the actual artifact,
  in addition to the JVM regression and compiled Java class inspection.
- The final APK matches the physical Razr's installed release certificate. Its
  package and permissions are unchanged, and its launcher aliases include every
  alias shipped in Direct 45. It installed in place over 45, retaining the
  original first-install time, three saved boxes and unlocked license. Secure Steam-machine
  reconnection succeeded without re-pairing.
- Against the real securely paired Steam machine, 12 Pad background/resume
  cycles and eight rapid Setup/Pad round trips retained the same Android process
  and logged neither a fatal exception nor the missing-socket crash signature.
  This is bounded device validation, not proof that every possible race is gone.
- Native TV Inputs and Back from this build were accepted by the Steam agent.
  The owner was unavailable to watch the TV, so on-screen menu appearance and
  dismissal remain unverified.

Signed preview APK SHA-256:
`bd4cb4a0012b93a01349d4e6edad879aac3a14fb27f2fdd632352709e241ea78`.
The matching Hermes source map is archived privately with the build. No public
APK download, update manifest, store submission or release was changed.

Rollback is removal of the postinstall hook, patch script and associated tests,
followed by a fresh dependency install/rebuild. Never uninstall the phone app to
change preview versions or work around a signing mismatch.
