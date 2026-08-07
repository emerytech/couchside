# Per-game themes — the app dresses for the game that is running (owner ask 2026-08-07)

> **Status: SPEC ONLY, future work.** Owner: *"in the future can we build out
> themes for different games so when the app detects a certain game is playing
> it applies that theme. a good pilot for this would be vampire survivor and
> megabonk."*

## Mechanism (all pieces exist)

1. **Detection is already shipped.** The agent reports the running game
   (appid + label) on the status/gaming payloads the app already polls. No new
   endpoint, no new capability, nothing client-supplied reaches the agent —
   the appid flows box → phone, and the theme is a pure app-side lookup.
2. **Theming is already an architecture.** `useTheme`/`useThemedStyles` and the
   Palette type (see memory: theming-architecture, branch feat/theming). A game
   theme = a Palette override (accent, card, glow) applied while that appid is
   the running game, reverting on exit. The pad surfaces (LandscapePad, MovePad,
   the vertical mode) are the primary canvas — they already take every colour
   from the theme hook.
3. **Registry: a frozen app-internal map** `appid -> PaletteOverride`, exactly
   the allowlist shape the project uses everywhere. Unknown appid = default
   theme, never a fetch. No remote theme delivery in v1 (that would be a
   content-injection surface); themes ship in the app binary.

## Pilot

- **Vampire Survivors (appid 1794680):** gold-on-dark, red accents.
- **Megabonk:** appid + palette TBD — and the same hardware session should
  answer the OPEN question from project_movement-mode.md (does it need manual
  aim / a right stick?). One evening on bazzite covers both.

## Open questions

- Flash risk: theme swap mid-session must not re-render the pad mid-gesture
  (palette changes rebuild themed styles — verify the PanResponders survive, or
  gate the swap on no-touch).
- Does the theme apply app-wide or only to pad/immersive surfaces? Lean: pad
  surfaces only in v1 — the Console staying stable is a feature.
- Interaction with the unshipped feat/theming branch (user-selectable themes):
  game themes should layer ON TOP of the user's base theme choice, not fight it.
