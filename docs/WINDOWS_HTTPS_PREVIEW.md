# Windows HTTPS/file-transfer preview

The matching preview branch in emerytech/couchside-windows is
`codex/windows-https-uploads`. The product monorepo remains source of truth;
agent, installer, and executable-build changes are mirrored in both repositories.
No release tag or production deployment is part of this change.

Windows agent 0.4.13 adds an HTTPS listener (HTTP port + 1), on-box pairing
fingerprints, public-certificate endpoint, and HTTPS-only streamed file drops.
Existing pairing tokens, configuration and HTTP controls remain unchanged.
Existing phones must upgrade/pair securely to benefit from encryption.
Uploads never fall back to HTTP and never overwrite existing files.

Dependencies: cryptography==46.0.7 creates the RSA certificate; TLS sockets and
file transfer use Python stdlib. The executable build bundles PyCA. Python
installation installs the same version. Keys are restricted to user/SYSTEM
and preserved across restarts. Unreadable keys are never silently replaced.

Files land in the signed-in user's Downloads/Couchside folder. Windows device
names, ADS, traversal and invalid characters are rejected. A private temporary
file is published atomically without clobbering existing destinations. Two
concurrent transfers, 8 GiB per-file cap, free-space reserve, bounded workers
and read/handshake deadlines limit resource use.

Tests on macOS and real Windows: pinned TLS connection, persistent identity,
legacy controls, auth rejection, malformed/oversized uploads, unsafe Windows
filenames, interrupted-file cleanup, ticket replay and idle TLS responsiveness.
Live Windows transfer: 28,672,000 bytes, SHA-256 matched, approximately 1.05s.
All 16 HTTPS status requests passed alongside eight idle TLS peers; max 37ms.
iPhone secure pairing and green-lock/file-upload-capability UI verified.
Pinned WSS upgrade passed, with existing Android holder respected.
Native iPhone file-picker upload passed: the existing 65-byte Couchside test
file arrived in Downloads/Couchside and the app displayed the secure receipt.
Hands-on input while Android owns the controller remains pending.
GitHub transport tests passed on Windows and Ubuntu; main-repository CI passed.

Rollback on the test PC uses the saved prior agent and removes only the preview
HTTPS firewall rule; token/config files are not replaced. Installer uninstall
removes the HTTPS rule without deleting uploaded user files.

## Windows discovery/status compatibility

The discovery reply is observed arriving from the router even when the probe
is sent directly to the PC. Agent 0.4.14 advertises its primary LAN address,
using the on-box pairing address rather than the VPN return interface.
The app treats this as a hint only: it accepts a private literal, verifies
HTTP agent identity/version and any advertised TLS fingerprint, then lists
the verified endpoint. Duplicate datagrams and late async results are bounded.
Old agents without the new address field retain the verified source fallback.

The Console guard now checks the core memory/load/disk values it dereferences;
CPU-frequency and OS metadata remain optional, as defined by the protocol.
It accepts Windows and older Linux payloads without inventing measurements and
continues to reject incomplete/error-shaped responses.

Tests: 772 app tests passed before the final lifecycle additions; eight targeted
compatibility tests cover relay address verification, pin/identity mismatch,
unsafe hints, old-agent fallback, duplicate replies, late scan completion,
Windows/older Linux status and malformed core data. TypeScript passes.
The live relayed-UDP-to-verified-HTTP check selects the actual PC address.
An internal build is required for these app changes; production is unchanged.

### Internal iPhone build 268 verification (2026-10-22)

Built from integrated source `fca8ae0385fe2c69add6bb2f86d2868a191f2670`,
retaining the prior Player preview work. The signed 2.9.78 (268) IPA passed
multicast entitlement and native HTTPS module checks and is in the existing
internal TestFlight group; no public release was submitted.

On the physical iPhone 17 Pro Max using Mirroring:

- Updating 267 to 268 retained both saved boxes and secure pairing.
- Windows 0.4.14 displayed its hostname, service version, memory, disks and
  live vitals instead of the previous persistent connecting placeholder.
- Scan found the Windows agent at its verified LAN address, not the forwarded
  UDP source/router address. Selecting the result reached the PC PIN flow.
  No duplicate pairing was saved during this check.
- Switching to the existing SteamOS box loaded its live console, then the
  existing Windows connection remained available.

Integrated CI run 39871389670 passed compile, smoke, app-input, and both
Windows/Ubuntu transport jobs. Two pre-existing Player tests need TypeScript
to transpile mocked native imports; CI now supplies that compiler in an
isolated temporary prefix rather than installing the Expo dependency tree.

This is targeted compatibility evidence, not a claim of exhaustive device,
VPN, router, or controller-input coverage. The earlier native iPhone upload
and pinned HTTPS transfer checks are recorded above.

### Follow-up control and transfer checks (2026-10-22)

On iPhone 268, a right swipe moved Steam focus to the next game, and tapping
Select opened its details without launching the game. On Razr Direct 42,
requesting control displayed the iPhone Keep/Pass prompt; accepting Pass
activated the Android ViGEm controller. The Android Windows-key button
opened Windows Start. Both clients retained secure pairing.

Fast Android text entry exposed a client-side batching bug: native change
events could diff against the previous render's text and repeat characters.
The keyboard now advances its ref synchronously before forwarding each delta,
and all local-clear paths reset that baseline. Three source-handler tests
exercise queued React state, duplicate events, paste, replacement, deletion,
and clear/retype. Full local app/hook suite: 800 passed; TypeScript passed.
This fix is committed for the next app build; it is NOT in installed iOS 268
or Direct 42, and its physical-device verification remains pending.

Repeated live Windows transfer check: 28,672,000-byte HTTPS upload completed
in 3,018.5 ms and matched SHA-256. Duplicate names, plaintext upload and
single-use ticket replay remained rejected. With eight idle TLS peers, all
16 status requests succeeded (median 26.7 ms, max 33.3 ms). These are local
network measurements, not general performance guarantees.

The next native iPhone upload is paused at Apple's Mirroring authentication
prompt. Razr native file-picker upload remains pending reliable navigation
to Console. Neither is counted as a new completed phone upload test.

### Native phone uploads completed (2026-10-22)

After owner authentication, iPhone 268 selected the disposable
`couchside-https-interruption.txt` through the native Files picker. Windows
received 16,777,216 bytes. SHA-256 matched the original iCloud Drive test file:
`341aacac661ccb210720bedaa9ead5d668fe5ea41a73532fc147c71e34040df1`.

Razr Direct 42 selected `couchside-android-windows-test.bin` through Android's
OPEN_DOCUMENT picker. Windows received 1,310,720 bytes; SHA-256 matched the
prepared test payload:
`e92df7e0136e8d408d2b23dc818a9ab32aa5b284df7a8c9dd84c67d5229c47db`.
The signed/pinned native HTTPS upload path was used on both phones. Existing
Windows files were not overwritten. These two disposable files were retained
for inspection in the user's Windows Downloads/Couchside folder.

Android mirror coordinate targeting was unreliable; the owner opened Console
and the picker, and keyboard focus/Enter selected the verified test payload.
This limitation is not evidence of an app tab-touch failure. An unrelated
installer prompt encountered during targeting was canceled; no APK was
installed and no security permission changed.

These checks complete the two pending native upload checks above. Direct 42
still predates the Console status fix and keyboard batching fix, so a fresh
Android preview remains necessary to verify those changes physically.

### Follow-up previews 269 / Direct 44 (2026-10-22)

Frozen source: `145d128` on `codex/windows-compat-preview-268`, including
the keyboard baseline fix, discovery endpoint verification, and optional
Windows status-field compatibility. Existing Player, themes/Theme Studio,
lighting, receiver controls and license public key were retained.

- Direct 44: compiled on Gandalf under `/tank/build-storage`; signed with the
  established Direct certificate. APK/native module, manifest alias, scheme,
  license-key and Hermes/source-map checks passed. SHA-256:
  `6e11cfc5a4cb6386cb70efca559b6a83311546d5fff953829b25777f722797dc`.
- Installed Direct 44 over physical Razr build 42 using an in-place ADB update;
  no uninstall. Verified installed versionCode 44, retained secure Windows
  pairing, and working live Windows Console status. Keyboard fix device
  validation remains pending reliable mirror input.
- iOS 269: signed multicast entitlement/profile and bundle identity verified;
  retained feature checks passed. IPA SHA-256:
  `2875df78eb17ddb9cdb1a96d37f4a8cce761e8e6b5ede04bfa179094eb388ffa`. Apple accepted upload delivery
  `f063056d-75a6-4be8-a023-aa6c63d1c872`; at this checkpoint it is still
  awaiting appearance/processing in App Store Connect. This is an internal
  preview, not an App Store review submission or public release.

Build scripts, manifests, source provenance, native-module and icon provenance,
checksums and private build logs are saved locally in the preview artifact
folder. Secrets, signing keys, Claude files and private logs were not committed.
