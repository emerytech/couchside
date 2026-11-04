# Ports download and job contract

Implementation checkpoint: November 3, 2026. Held for review and native acceptance;
no version bump or release is implied.

## Trust and executable dependencies

The agent's fixed catalog and `ports/index.json` pin **size and SHA-256 for every
executable dependency**. A phone submits a known port ID only. The bbport recipe
now runs the reviewed `setup.sh`, with `steam_shortcut.py`, `uninstall.sh` and the
runtime AppImage supplied locally. It never executes recursive `bootstrap.sh`.
The reviewed setup skips downloading when the verified runtime is already placed
at its fixed destination. Source/destination overrides inherited through BBPORT
variables are cleared and replaced by the fixed recipe. The entire dependency
set verifies before any downloaded script runs or the installed runtime changes.

Downloads stream to a private staging directory with exact byte bounds, a deadline,
and constant-memory hashing. Redirects must remain HTTPS on the explicit GitHub
release-host list. A remotely downloaded checksum cannot replace a catalog pin.
Any mismatch removes the partial download and fails the job before execution.
Runtime placement uses a temporary file plus atomic replacement; setup receives
only the verified local dependencies. No game files are downloaded by this recipe.

Pins were reviewed against the published `couchside-bbport` release November 3.
All four files, including the 423,868,960-byte runtime, were downloaded through the
new verifier and matched the catalog. Script hashes also matched GitHub asset
digests; the runtime digest matched both the GitHub digest and published sidecar.
The downloaded setup was inspected to establish its no-download/local-helper
contract. Those downloads were not executed during this verification.
Updating the release assets without a corresponding reviewed catalog change will
cause a verification failure. Review the whole dependency closure when updating
any recipe; do not restore recursive unverified bootstrapping.

## Independent job lifetime and restart recovery

`ports_run` records a claim atomically under a POSIX file lock, then starts a fixed
transient **user** service, `couchside-ports-job.service`. The same single-file
agent supplies an internal `--ports-worker` entry point. It starts neither the API
server nor token loading. The worker refuses root, looks up the fixed recipe,
holds the job lock for its lifetime, and writes a terminal outcome atomically.
As described in the [systemd-run documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html), a transient service is managed independently.
A separate user unit is necessary: detaching a subprocess alone does not escape
`couchside.service`'s default systemd control-group termination on restart.

Job metadata lives in a private per-user state directory, not in process-global
Popen/PID state. GET reads the atomic record and bounded log tail. If the lock is
free but a record still says running, the agent reconciles against the fixed user
unit. An inactive unit after the bounded launch window becomes interrupted, never
successful. An unavailable user bus or corrupt record blocks competing work and
reports recovery pending. A launch timeout retains the claim because systemd may
already have started it. No automatic second install/remove is attempted.
After proven interruption, only that job's staging directory is removed. A live
worker's files are never cleaned by the reconnecting agent. Successful/failed
workers clean their own staging directories. Existing terminal records survive
agent restart and carry the original job identity.

This requires a functioning systemd user manager for the desktop user. There is
no fallback to a child inside the agent's cgroup and no new root permission or
sudo command. If the user manager is unavailable, launching fails closed. Status
uncertainty must be inspected on the box before manually clearing a job record;
never clear it merely to get past the concurrency guard.

## App polling and reconnect

The Ports screen and Setup card each use one focused polling chain. Successful
idle polls use 30 seconds; active jobs and connection errors use two seconds.
Refresh, blur/background and a new box invalidate outstanding replies. A delayed
reply or error from the old generation cannot overwrite current data or create a
second timer. Returning to the foreground immediately reconciles with the box.
No poll, refresh or reconnect retries a state-changing POST.

A temporary connection failure preserves known status, shows reconnect feedback,
and disables mutation controls. Old-agent 404/null hides the Setup entry; it is
separate from an offline/error state. A pending confirmation is rejected if the
selected box changes before confirmation. All rows are blocked while any job or
uncertain recovery is active. Optional new job fields remain additive for older
clients and agents.

## Validation and remaining acceptance

Automated tests cover exact hashes/sizes, missing pins, disallowed redirects,
changed dependencies preventing execution, fixed launch argv, authentication,
unknown IDs, opt-in, concurrent requests, launch ambiguity, unavailable bus,
corrupt state, terminal persistence, a real independent worker process, killed
worker reconciliation and staging cleanup. Poller tests use delayed promises and
controlled timers for host changes, refresh races, background/return, error
recovery, successive jobs, busy-to-idle cadence and old-agent null responses.

A local exported-app fixture exercised Details, confirmation Cancel, synthetic
install progress/completion and removal. Pausing its backend, reloading the app,
then resuming it produced the reconnect banner and automatic completed-job
reconciliation. No second mutation was sent. This fixture installs no game.

Before release, exercise the real systemd user-service launch and agent-service
restart on a supported Linux desktop. Then test actual native phones and a
specifically approved disposable install/remove target, preserving player files
and settings. A synthetic process and browser fixture do not certify that device
acceptance, game launch, Steam shortcuts or real runtime installation.
