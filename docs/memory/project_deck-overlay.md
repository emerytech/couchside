# Project: Deck overlay — a Decky-free Game-Mode quick panel via gamescope

**Status:** 📋 Drafted 2026-09-24. NOT prototyped. The gamescope-overlay mechanism
below is asserted from general knowledge of gamescope/SteamOS, **NOT verified on
hardware** — Phase 0 exists precisely to prove it before a line of feature code is
written. Owner requested the spec (Discord/session 2026-09-24).

**The honest gate, recorded before anyone falls in love with this:** the entire
premise rests on ONE unproven claim — that gamescope's external-overlay atom will
(a) composite our own window *over* a running Game-Mode session AND (b) let that
window *grab trackpad + button input* while it is up, then hand input back to the
game when dismissed, on the gamescope build shipping in current SteamOS/Bazzite. If
the input-grab half does not work cleanly, this is not a quick panel — it is a static
picture over the game, and the feature is dead in this form. **Prototype (Phase 0)
BEFORE building anything.** Second gate: gamescope's overlay contract is far more
stable than Steam's CEF internals (that is the whole point — see KI-004), but it is
still Valve's evolving compositor, not zero-maintenance. We trade Decky's
break-every-Steam-update for a much rarer break-on-gamescope-change, not for
immortality. Say that plainly to users.

## Why (the problem this answers)

- **KI-004:** Decky Loader vanishes / breaks on every Steam CEF restart+update because
  it injects JS into Steam's *private, undocumented* frontend modules. Users churn off
  it. A quick panel that lives in Steam's frontend inherits that fragility.
- **Gatekeeping:** the official Decky store declines AI-assisted developers, so the
  smooth-discovery path is closed to us regardless of code quality.
- **Product fit:** Couchside's promise is "works when the TV is black." Depending on a
  fragile Steam-UI injection for the on-box panel is off-brand. The on-box control
  should be as robust as the systemd agent that already does the real work.

The answer: give Deck/SteamOS users an on-box quick panel that depends on **neither
Decky nor Steam's frontend**, and **defer to Decky when it is present and healthy** so
existing Decky users keep their button (coexistence, exactly like `install.sh` already
does — see the decky-installsh-coexist memory).

## Mechanism (the key idea)

Overlay at the **compositor** layer, never the Steam-UI layer.

- SteamOS/Bazzite Game Mode runs inside **gamescope** (Valve's nested Wayland
  compositor). Gamescope can draw an *external* window on top of the focused
  game/Steam via the **`GAMESCOPE_EXTERNAL_OVERLAY`** window atom set on an Xwayland
  window. Setting that atom (not hooking Steam's React) is the whole trick — a Steam
  update cannot break something it never touches.
- **The panel content = the console we already ship.** The agent already serves the
  full Couchside web console on `localhost`. The overlay is a borderless **kiosk
  browser window** (reuse the Player's existing Chromium-launch infra — see the
  couchside-player / player-degoogle memories) pointed at that localhost UI. Result:
  the Deck gets the *whole* console (same UI as the phone), not a cramped plugin
  panel. That alone beats Decky.
- **Toggle = a hotkey, not a Steam button.** Reuse the existing evdev/uinput input
  plumbing (the gamepad path) to watch for a configurable chord (avoid Steam-owned
  buttons) and toggle the overlay's visibility + input grab. No Steam involvement.
- **Launched in-session** by the agent via `systemd-run --user` in the Game-Mode
  session (the same mechanism the pairing-PIN kiosk launch already uses — see the
  pairing-pin-desktop-fix memory), as an **allowlisted subprocess**. The agent stays
  pure-stdlib single-file; the browser is a launched program, not agent code.

## Phases

- **Phase 0 — PROTOTYPE / make-or-break (do this first, on a real Deck).** In the
  Game-Mode gamescope session, launch a borderless Xwayland window, set
  `GAMESCOPE_EXTERNAL_OVERLAY`, and VERIFY BOTH directions on hardware: (1) it
  composites over a running game; (2) it can grab trackpad + button input while up and
  RELEASE it back to the game on dismiss. Observe both the shown and the hidden state.
  If input-grab does not work, STOP and reconsider (fallback ideas: a full-focus
  swap-to-window instead of a true overlay, which pauses the game — worse UX but still
  Decky-free). No feature code until Phase 0 passes.
- **Phase 1 — the panel window.** Kiosk browser → agent `localhost` console, launched
  in-session (`systemd-run --user`), allowlisted argv (no shell string, no client-supplied
  path — §3). Sizing/placement for the Deck screen.
- **Phase 2 — hotkey toggle.** evdev listener for a configurable chord; show/hide +
  grab/release. **Degrade-closed:** if the listener dies it must never leave a stuck
  input grab, and it must never match the agent's OWN virtual pad (the load-bearing
  filter from CLAUDE.md §4 — a matched self-pad would tear down input).
- **Phase 3 — Decky coexistence.** Detect Decky installed AND healthy → defer to the
  plugin (keep its Game-Mode button). Overlay is primary only when Decky is
  absent/broken. Reuse the install.sh Decky detection.
- **Phase 4 — install + config.** An `install.sh` path that sets up the overlay
  launcher + hotkey unit; `couchside overlay on|off|status` (box-side, marker-gated
  like `allow-decky`); a Utilities/Setup tenant to pick the hotkey chord.

## Constraints (CLAUDE.md — do not violate)

- **Agent stays pure-stdlib, single file.** The overlay browser is a *launched*,
  allowlisted program, never imported code.
- **Input path is safety-critical.** The hotkey listener touches the same evdev/uinput
  world as the gamepad path — the self-pad filter is load-bearing; a leaked grab or a
  matched virtual pad is a zero-tolerance bug. Lifecycle tests required (create → hold
  → hand off → reap), not just the happy path.
- **No new exec surface.** The panel only ever drives the *existing* allowlisted
  console over localhost — it introduces no arbitrary-exec path.

## Better than Decky (the pitch) + caveats

Better: survives Steam updates (compositor-level, no CEF hooks); full console instead
of a plugin panel; works on any gamescope session (SteamOS, Bazzite, Deck-likes); same
UI as the phone; no Decky store gatekeeping.

Caveats (set expectations): gamescope's overlay/input behavior can differ across
gamescope versions and launchers, and could change on a gamescope bump (rare vs Steam
CEF, not never); input focus/grab is the hard part (Phase 0); a true overlay that
grabs input while the game keeps running may not be achievable on every build — the
fallback is a focus-swap panel (game pauses), still Decky-free.

## Open questions to settle on hardware (Phase 0)

- Does `GAMESCOPE_EXTERNAL_OVERLAY` still composite + accept input on the current
  SteamOS 3.x / Bazzite gamescope? (assert-then-verify)
- Can we grab input without gamescope treating the overlay as the focused app (which
  would background the game)? Is there a gamescope keybind path better than a raw evdev
  chord?
- Which chord is safe (not claimed by Steam / not colliding with the gamepad path)?

**priority:** P2 (a real differentiator + the durable answer to KI-004; gated on Phase 0)
· **risk:** high until Phase 0 proves the overlay+input path · **affects:** agent
(launcher orchestration + hotkey listener), install.sh, a new in-session overlay
launcher, Utilities/Setup UI · **depends_on:** Phase 0 hardware validation on a Deck ·
**related:** KI-004, [[decky-installsh-coexist]], [[pairing-pin-desktop-fix]],
[[couchside-player-phase0]], project_decky-manager.md, project_bazzite-ujust.md.
