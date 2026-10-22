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
