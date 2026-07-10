# Capability-adaptive UI

The app shows exactly the UI a box can back, and nothing else. A headless
server (no virtual gamepad, no Steam) automatically loses its gaming tabs; an
HTPC keeps them; a mixed fleet flips per selected box. This is not a "mode" and
carries no branding — it is the same probe-and-appear philosophy the app has
used since 2.5 (TV strip, media card, screen preview), promoted to a first-class
capability summary.

Decision (2026-07-09): no separate product, no "server mode" naming anywhere in
code, UI, or marketing. Couchside runs on any systemd Linux machine (README has
said so all along); this work just makes the UI honest about it. Any homelab
outreach later is a screenshots-and-post exercise, not a build.

## How it works

1. **Agent detects at boot** — `set_caps` (agent/couchsided.py and
   agent/win/couchsided-win.py) snapshots six booleans from the existing
   availability detectors:

   | cap | Linux | Windows |
   |---|---|---|
   | `gamepad` | /dev/uinput writable | ViGEmClient.dll loads |
   | `steam` | Steam root with steamapps/ | steam.exe present |
   | `media` | session bus + busctl (MPRIS) | SMTC |
   | `tv` | RS-232 panel / CEC / soft volume | panel / cec_bridge / soft |
   | `screen` | gamescope or spectacle + downscaler | GDI |
   | `power_schedule` | /dev/rtc0 writable | waitable timers |

2. **Rides the status heartbeat** — `caps` on `/api/status` (agent >= 2.8.2).
   No extra round-trips; the app also skips the per-feature probe requests
   (`/api/media`, `/api/screen`, `/api/downloads`, `/api/power/schedule`) when
   caps says the feature is absent (`probeGated`, app/lib/api.ts).

3. **Persisted per box** — the status poll learns `caps` onto the Box record
   (app/components/RemotePowerBar.tsx), same pattern as the Wake-on-LAN MAC
   learner, so gating is correct on the first frame of the next launch.
   Responses are tagged with the box they were fetched for (`forBox`) so a
   stale poll snapshot can never be attributed to another box (this class of
   bug previously caused a write ping-pong between the per-tab bar instances —
   "Maximum update depth exceeded" — caught live on the simulator).

4. **Tabs follow caps** — app/app/(tabs)/_layout.tsx: `caps.gamepad === false`
   hides Pad, `caps.steam === false` hides Launch (`href: null`), and a bounce
   effect moves the user to Console if they were on a now-hidden tab.
   Undefined caps (old agent, never connected) hides nothing — never hide UI
   on a guess. Caps is a hint, not authority: live ops still verify (the
   gamepad WS connect is ground truth).

## Status

- **Done** — caps summary in both agents (2.8.2 / 0.3.1-win), typed +
  cached + probe-skipping app client, per-box persistence, tab gating with
  bounce, `forBox` response tagging. Verified: mock + real agents over HTTP,
  web build (Expo web + stubs), and on-device iOS simulator with a live
  mixed fleet (server stub + HTPC mock), including box switching in both
  directions and a cold-start no-error check.
- **Done** — Fleet tab (app/app/(tabs)/fleet.tsx): per-box status polling
  (useFleetStatus, modeled on useBoxOnlineStatus), tiles with hostname /
  temp / load / mem / DOWN + last-seen, tap = switch active box + land on
  Console. Tab bar entry hidden with fewer than 2 boxes so single-box users
  keep a clean bar.
- **Done** — configurable watchlist: agent-side config (`units[]` in
  /etc/couchside/config.json) was already fully documented in
  agent/README.md with examples; the Console UNITS card now carries a hint
  pointing at it. An authed `/api/config/units` write route (edit the
  watchlist from the app) remains a follow-up — config.json is deliberately
  root-owned, so in-app editing needs a route on the agent, not a file write.

## Deferred

- **couchside-docker** — container ps/start/stop/restart/logs. Pattern:
  root-owned fixed-argument wrapper at /etc/couchside/couchside-docker
  (mirror of the couchside-journal wrapper, couchside-decky/main.py). sudoers
  grants ONLY the wrapper; the wrapper validates subcommand allowlist +
  container-name charset + clamped log lines, then execs docker. Never a
  wildcard docker sudoers rule (docker group ~= root). Agent grows
  /api/containers routes; app grows a containers screen.
- **couchside-systemctl** — same wrapper pattern for arbitrary per-unit
  systemctl (start/stop/restart any validated unit), replacing today's
  fixed-action sudoers entries for user-defined units.
- **Metrics history / sparklines** — Console and Fleet are point-in-time.
- **/api/config/units write route** — see above.

## Done since: stale-poll reset (was deferred)

usePoll now takes a `resetKey` (the poll target's identity, `hostKey(settings)`
= host:port). On key change it clears data/error in the same render (no stale
frame), discards in-flight results fetched for the old key (generation guard),
and refires for the new target. All 13 active-box poll sites pass it; the
LogsPanel journal keys on box + selected unit and dropped its manual
refresh-on-unit-change effect.

The hook also exposes `dataKey` — which key the current `data` was fetched
under. Render-time consumers that mutate refs from poll data MUST gate on it:
when resetKey changes, React discards the in-progress render pass but still
finishes executing it with the OLD target's data visible, and ref writes from
that doomed pass persist. ScreenPreview's sticky "ever supported" ref was
re-poisoned exactly this way (found live on the simulator; a bare
`if (probe.data)` after the per-box reset). Effects are immune (they run only
after commit); bare render-time ref writes are not.
