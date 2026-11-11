# Experimental game Pause / Resume — Linux preview

Status: private preview preparation. An internal iPhone 2.9.82(306) binary has been built over the shipped 2.9.82 source with Pause/Resume added, preserving Air Mouse/BG3/fling. Artifact version/signature/provisioning are verified; installation and actual gameplay acceptance remain pending. The Ad Hoc installer could not replace the existing store-installed app without deletion; preserve that app and use an App Store-signed internal TestFlight upgrade instead. Local TestFlight preparation is authorized, but the local SDK license prerequisite must be completed by the owner before compilation. No release or active-agent replacement has occurred. Windows is not implemented and does not advertise these controls.

## Behavior

Console's Gaming card and Launch's Now Playing card show Pause Game when the Linux agent explicitly offers it. Pause requires a confirmation describing the compatibility limits. The button changes to Resume Game while a journal exists; Close Game is disabled until the journal is resumed/cleared. The agent also refuses Close Game against any journal, so older apps cannot queue SIGTERM and cause an unexpected quit on Resume. Failed requests display a message and refresh the box's reported state. Older agents/Windows omit the optional field, so their existing UI is unchanged.

This stops execution in memory with SIGSTOP and resumes it with SIGCONT. It is not a save state, memory dump or checkpoint. RAM/VRAM remain allocated. It does not pause remote multiplayer servers or guarantee recovery across GPU/DRM/network timeouts, sleep or reboot. Save normally before testing. There is no automatic focus-loss, overlay, background or sleep pause in this version.

## Local opt-in (Linux only)

The desktop-account agent must run unprivileged on Linux with Python/kernel pidfd support. Nothing is enabled by default. The owner must deliberately configure specific offline games in the existing local config:

```json
{
  "allow_game_pause": true,
  "game_pause_appids": [424242]
}
```

424242 is a SYNTHETIC example, not a recommended game. Use the actual Steam AppId of an offline single-player game chosen for compatibility testing, preserving all other existing config keys. The list accepts up to 32 positive integer IDs. No API enables the feature or adds IDs. Disabling opt-in does not disable recovery of a journal already created.

## Protocol and safety

- Optional additive `game_pause` object on authenticated GET /api/gaming: available, has_record, paused, reason. No capability key or existing response field changed.
- Authenticated POST /api/game/pause and /api/game/resume accept NO body or query parameters. Client PIDs, app IDs, paths and arbitrary operations are rejected.
- The agent re-detects the running Steam reaper, validates its Steam AppId against the locally enabled list and rechecks its command line/identity. Only that reaper and its descendants may be stopped. Process groups are not signalled.
- pidfds hold stable kernel process references; procfs start ticks, UID, tracer state, protected service names/command lines and the agent's ancestor chain are checked. Root operation is refused. Already stopped/traced/protected or unreadable targets fail closed. Trees above 128 processes or that do not stabilize are refused with resume recovery attempted.
- The reaper is stopped first so its tree can stabilize. This differs from SDH-PauseGames' documented children-only design and requires real-game acceptance. No upstream code was copied.
- Private write-ahead journal /var/lib/couchside/game-pause.json: owner-only file, atomic replacement, fsync, boot ID and PID/start identity. Each target is journalled BEFORE SIGSTOP. A thread lock and a private nonblocking flock lease serialize daemon/CLI pause and recovery across processes. A failure attempts recovery; unresolved records remain for retry. Symlinks, wrong ownership, permissive modes and malformed records are refused.
- Resume never signals a reused PID or a record from an earlier boot. It checks that surviving recorded targets leave the stopped state before clearing the journal. An exited game is not recreated. Journal loss is not a save-game restore.
- Config opt-in is a compatibility choice, not detection of offline mode or anti-cheat. No automatic claim that a game is safe is made.

## Local recovery

From the SAME desktop user that runs the agent, execute the installed agent's Python entry point with `--resume-game`. This reads only its private journal, attempts Resume and exits; it does not start a server, rotate a token, read pairing credentials, or change config. Use the actual installed script location on that machine. Exit 0 means recovery completed/no journal; exit 1 means local review is still required.

Do not delete an unresolved journal or blindly signal numeric PIDs from an old record. Retain it until the recorded identities are checked and recovery completes.

## Reference comparison

SDH-PauseGames documents SIGSTOP/SIGCONT on Steam reaper children and optional focus-loss/overlay/system-suspend behavior: https://github.com/popsUlfr/SDH-PauseGames#readme . Couchside's implementation is independent, stdlib-only and uses authenticated phone actions plus a restart-recovery journal; it is not a fork or full feature-parity implementation.

## Validation and remaining gates

- Policy tests: default off/no client target arguments; protected/traced/already-stopped/foreign-user/reused identities; private journal ownership/mode/symlink handling; stale-boot and PID-reuse recovery; failed pause rollback and recovery-failure retention; local recovery CLI doesn't load configuration/pairing or start listeners.
- HTTP mock test: unauthorized calls fail, supplied bodies/queries are rejected without mutating state, Pause/Resume refresh game_pause.
- Real Linux acceptance harness: only a disposable owned process and child are stopped; heartbeat halts; a fresh import resumes from disk with opt-in off; heartbeat advances again and journal clears. It is not gameplay proof.
- Existing dependency, configuration, gaming-card, Close Game and protocol checks; app TypeScript and web export. CI runs the new suite on Linux.
- Still required: physical iPhone/Android acceptance, actual offline Steam/Proton game tests (video/audio/input after repeated resume), service-process restart/crash recovery, permissions on the installed state directory, and interactions with Steam/Decky pause tools. Windows implementation and acceptance are separate future work. No production enablement until those gates are reviewed.
