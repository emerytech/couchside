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

## Release-candidate verification — 2026-10-23

Draft PR #643 combines the Windows HTTPS/discovery work, the native keyboard
batching fix, and the caret watcher from PR #637. It deliberately excludes the
separate Player/receiver prototype. PR #637 must not be merged separately after
the combined candidate lands. No public release or store submission has occurred.

The installed Windows 0.4.14 agent's executable Python definitions match this
candidate; its module documentation now records the PyCA exception. Existing
pairing, certificate identity and configuration were retained during testing.

Physical-device checks used TestFlight 2.9.78 (269) and Android Direct
2.9.78 (44), against a disposable, non-elevated Windows text field. Both phones
passed rapid typing, repeated backspace, append, select-all/clear and retype.
The iPhone also passed Greek Unicode input. An accented-character attempt was
inconclusive: Mirroring did not insert the character into the phone's own field;
Windows matched the phone field. This is not evidence of accented-input support
or a Windows input failure. A manual phone-keyboard accent test remains useful.
One later attempt ran while the phone was on Home and was discarded; refocusing
Couchside and repeating clear/retype passed. No arbitrary desktop typing was used.

The caret watcher was observed opening the native phone keyboard when the
disposable Windows field gained focus. Its PR tests cover foreground changes,
caret/OSK probes and change-only publication. Pure Windows definitions are
unchanged from the installed preview; only the relevant app paths from the
broader internal phone builds are included in this candidate.

Validation: 785 app/hook tests, TypeScript, six dependency-policy tests, caret
tests and eight HTTPS transport tests passed locally. GitHub checks passed for
Windows and Ubuntu transport, Apple and Android native transport, app input,
compile and smoke. The scoped dependency guard permits only the six reviewed
PyCA imports inside Windows `_tls_identity`; Linux and QR remain stdlib-only.

At this checkpoint, packaging and installer-upgrade checks were pending; their
results are recorded below. Keep this an ordinary-user agent: typing into elevated
applications is unsupported.

## Installer upgrade and background execution — 2026-10-23

The actual installer backend was run on the signed-in Windows test PC, upgrading
the Python preview to the packaged executable. The final run used
`-KeepHibernate -NoElevated -FromInstaller`; its normal firewall path was enabled.
The scheduled task starts the exact packaged candidate with Limited privileges.
Token, configuration, TLS certificate and private key hashes and their file ACLs
all match the pre-upgrade snapshot. Existing TLS advertisements are unchanged.
Both physical phones reconnected using their saved pairings, with all three
previously saved boxes still listed on each device. No phone app was reinstalled
or reset during this agent upgrade.

Testing found that the previous console-subsystem executable opened a terminal
despite running from a scheduled task. Release builds now use the GUI subsystem;
`build.ps1 -Console` retains a deliberate debugging option. The rotating log works
with absent stdout/stderr, covered by the existing log regression suite. The final
executable has PE subsystem 2 and the running agent owns no top-level window.

The installer also creates a program-scoped UDP discovery rule on the configured
port, restricted to LocalSubnet and the same selected firewall profiles. It is
removed on uninstall. This avoids the first-launch broad app-access prompt.
Only the two auto-created executable query rules from this test were removed;
the product installer does not override a user's explicit firewall blocks.

Packaged-agent HTTPS status and gamepad/upload capabilities passed, and a
75,776-byte synthetic HTTPS upload matched its destination SHA-256 and was removed.
The Razr then passed native typing and backspace through the windowless executable
into the disposable Windows field. The extra packaged-iPhone typing attempt was
interrupted by a device/app switch; its saved-pairing reconnection check passed.
The private backup retains the original agent, task XML and identity/config files
with user/SYSTEM-only directory access. Rollback restores the original agent/task
without rewriting pairing data. The Inno Setup wrapper compiled successfully in
the standalone Windows repository's CI; its interactive wizard/UAC flow was not
retested here. No clean installation or reboot/logon-cycle claim is implied.

Tested executable source: `d491c10` (standalone mirror `6bc50dd`). SHA-256:
`62252edb3019aff5f2e9a0a6b6a8316197185af548440e802f3b9d70a393a37d`.
This windowless artifact supersedes the earlier console preview. Publication
still requires the normal reviewed merge, release signing and distribution steps.

## Administrator-window input boundary

On the physical TV, normal Windows desktop input and the cursor were verified.
Alt-Tab then selected elevated RTSS, and Windows refused the normal-privilege
agent's input. The agent stayed running, with no held modifier keys. A temporary
administrative recovery task minimized RTSS and was removed afterward.

The blocked-input message now distinguishes an administrator window from an
inactive/RDP session and a lock/security prompt. It changes no permissions and
does not attempt to control administrator windows or UAC. The owner chose to keep
the agent at normal privileges. This warning needs a rebuilt agent executable;
changing the source alone does not update the installed binary.

The administrator warning fits the existing phone banner. A regression test
verifies that repeated refusals retain the holder/socket and that the next
successful input clears the warning without reconnecting. The foreground-token
query was also run in a normal interactive Windows session and correctly reported
the normal desktop as non-elevated.
