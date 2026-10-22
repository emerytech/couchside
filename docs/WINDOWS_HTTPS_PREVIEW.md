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
Manual phone/controller and native-picker verification remains pending.

Rollback on the test PC uses the saved prior agent and removes only the preview
HTTPS firewall rule; token/config files are not replaced. Installer uninstall
removes the HTTPS rule without deleting uploaded user files.
