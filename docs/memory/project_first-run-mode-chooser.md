# First-run mode chooser — "gaming box" vs "remote only" (owner ask 2026-08-04)

> Owner: "we need to build a first time download tutorial that allows the user to select
> gaming mode or remote only mode."

## 1. What it is

One full-screen chooser, shown ONCE on a truly fresh install, before the tabs render
anything. Two big cards:

- **"I have a gaming machine"** — Steam Deck / Bazzite box / gaming PC. Continues into the
  EXISTING funnel unchanged: Setup, the SetupProgress sweep, PIN pairing. Sets nothing.
- **"I just have a smart TV"** — sets `remoteOnlyMode: true` and lands on Setup with the
  TV card (`DirectTvSetup`) as the job to do. The Remote tab takes over from there.

Below both: a small "decide later" escape that just goes to Setup — a chooser you cannot
skip is a wall, and the measured funnel problem (launch baseline: ~20 installs, ~0 paired)
is people bouncing, not people choosing wrong.

## 2. Why a chooser at all

The zero-box Setup screen today opens with "Couchside needs a small service running on the
box you want to control" — which is a dead end for the no-box user the remote-only mode was
built for. They currently have to scroll past an installer tutorial that does not apply to
them to find the "NO GAMING BOX?" card. The chooser routes each audience to its own first
step instead of making one audience read the other's instructions.

## 3. Mechanics (decided by reading the code, not preference)

- **Where it mounts:** a `Stack.Screen` route (`app/onboarding.tsx`) beside `(tabs)` in the
  root layout — NOT inside the tab navigator, so the tab bar does not render behind it and
  the tab layout's own redirects cannot race it.
- **What triggers it:** the one-shot redirect in `app/(tabs)/_layout.tsx` (the same effect
  that today routes an empty fleet to Setup) gains one earlier branch:
  `!onboardingDone && boxes.length === 0 && tvs.length === 0` → `/onboarding`.
- **Why the empty-state guards:** an UPGRADING user must never see it. Anyone with a box or
  a TV already answered the question by having one; the pref alone can't carry this because
  it defaults false for every existing install.
- **The flag:** `onboardingDone: boolean` pref (prefs.ts, three edit sites), set true on ANY
  exit from the chooser — either card, the skip link, and the hardware back button on
  Android (a re-shown chooser after a deliberate back-out is a nag).
- **Remote-only card exit:** `setPref('remoteOnlyMode', true)` then `router.replace` to
  Setup. It must NOT go to the Remote tab: the empty-remote state points at Setup anyway,
  so going there directly saves a bounce. The gaming card exits to Setup with the mode off.
  BOTH exits confirm the pref write completed before navigating — the tab layout reads
  `remoteOnlyMode` to decide which tabs exist, and navigating before the write lands would
  flash the wrong tab bar.

## 4. Copy rules

- The remote-only card names what works TODAY ("Roku TVs now; LG, Samsung, Google TV need a
  Couchside box") — same honesty rule as DirectTvSetup, and the same claim-lockstep caveat:
  no real Roku has been driven yet, so in-app copy stays capability-shaped and store copy
  stays silent about Roku entirely until hardware verification.
- The gaming card does not say "recommended". The chooser exists precisely because neither
  audience is the default.

## 5. Verification plan

- Harness: fresh localStorage → chooser appears; each card pressed → correct landing +
  correct pref state (read the blob, not the screen); reload → chooser does NOT reappear
  (both because the pref is set and — separately — because a box/TV exists; test each guard
  alone). Existing-user simulation: seed a box, clear the pref → chooser must NOT appear.
- Device-only: Android hardware back from the chooser; safe-area at the top card.

## 6. Status

- 2026-08-04: spec written mid-build (iOS 115 compiling — app source frozen until it
  finishes, so the chooser is NOT in build 115). Implementation next session or after the
  115 submit completes.
