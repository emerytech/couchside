# Project: App Store listing revamp + fresh screenshots

**Status:** 📋 Planned (recon + plan done 2026-07-23; nothing generated or published yet).
**Goal:** replace the stale build-65/2.9.12-era listing (copy + screenshots) with one that
reflects the current app (reactor skin, TV control, gaming/battery cards, Fleet, PIN pairing),
and fix a live licensing violation while we're in there.

App: Apple id **6786884115**, bundle `com.ets3d.rescueremote`, seller Taylor Emery. Live version
**2.9.21**. Also Google Play `com.ets3d.rescueremote`.

> Do NOT publish (screenshots or copy) to App Store Connect without explicit maintainer go-ahead —
> it's a public-content change. `scripts/asc-submit.py` is the upload path; leave it until sign-off.

---

## 1. Findings (verified 2026-07-23)

**Live listing was really fetched** (iTunes Lookup API + apps.apple.com HTML), not inferred.
- Title `Couchside — Remote` · Subtitle `Remote console for your HTPC` · Free · 5.0 (1 rating).
- **Screenshots are stale:** 5 iPhone (6.9″, 1284×2778) + 5 iPad (12.9″, 2048×2732), asset
  filenames `ios65-*` / `ipad13-*` = **build 65 / v2.9.12 era**. Set = Swipe, Console, Actions,
  Gamepad, Launch. Shows NONE of: TV control, screen preview, battery, gaming/now-playing card,
  Fleet, or the reactor skin as it renders now. (Screenshot content read from Apple asset
  FILENAMES + template dims; pixels not downloaded — reconfirm what's actually live before assuming.)
- **LICENSING VIOLATION in the live copy:** PRIVATE BY DESIGN says "The whole project — app and
  agent — is open source." App is source-available (PolyForm Noncommercial); only agent is MIT.
  Correct to "open-source agent, source-available app." The "agent… free and open source" line is fine.
- **Pairing copy drift:** live copy still leads with "prints a QR code, scan it" + "manual
  host/port/token entry works too" — but product has PIN-paired since 2.9.3; the 6-digit PIN isn't
  mentioned.

**Feature gap** (shipped but absent from the listing): smart-TV control (LG webOS + Google/Android
TV), live screen preview, Couch Mode handoff, now-playing/gaming card + close-game, box battery +
power profile, Fleet/multi-box, Steam settings shortcuts + Steam search, Prefs depth, Stream-from-PC,
reactor skin. (2026-07-23 update: the formerly-unreleased set — update hub, Prefs
find-as-you-type, drag trail, on-box pairing tutorial, app-update check — shipped in **v2.9.22**;
see §6.2.)

**Tooling:** no fastlane/snapshot/screenshot gear in repo — build from scratch. `scripts/web-dev.sh
[port]` renders app UI against `--mock` in a browser but CANNOT do touch/WS (no Pad/Remote/Gamepad),
status bar, or safe-area, and is web-render not native — good for **preview mockups only, not final
store assets**. Store metadata `.md` drafts are gitignored/absent in the worktree, so the **live
listing is the source of truth**.

---

## 2. Apple screenshot spec (current 2026, re-verify before submit)

- **Masters to shoot:** iPhone **6.9″ = 1320×2868** (also accepts 1290×2796 / 1260×2736) and, since
  the app runs on iPad, iPad **13″ = 2064×2752** (also 2048×2732). Everything smaller **auto-scales**
  from these — "provide only the highest resolution required; they scale down." Only 6.9″ + 13″ are
  mandatory.
- **Count:** 1–10 per size. **Framing:** device bezel NOT required and NOT forbidden — raw native-px
  captures are the norm; composed marketing frames are allowed IF the file matches exact px dims and
  shows the real UI in use (Guideline 2.3.3: not just title/splash/login).
- **Overlays/captions ALLOWED** on screenshots (2.3.3) — marketing headlines/callouts over the real
  UI are fine. (Stricter 2.3.4 video rule does not apply to stills.)
- **File:** PNG/JPEG, RGB, **no alpha/transparency**, flat sRGB.
- Uncertainty: required iPhone width has crept 1242→1290→1320; treat 1320×2868 / 2064×2752 as safest
  masters, re-verify the two Apple help URLs before a submission.

---

## 3. Shot-list (ordered narrative; first 2 are the pre-"more" hook)

| # | Screen | Caption headline | Data source |
|---|--------|------------------|-------------|
| 1 | **Console** (reactor skin, gaming card filled) | "See your box, even when the TV is black" | mock |
| 2 | **Pad — landscape gamepad** (green "connected") | "Your phone is the controller" | native+box |
| 3 | **Pad — Remote** (RemoteView, keys+text) | "A living-room remote, reinvented" | native+mock TV |
| 4 | **Launch** (real Steam cover grid + 1 download) | "Start any game from the couch" | **REAL box** |
| 5 | **Fleet** (2–3 breathing tiles, 1 DOWN) | "One app runs your whole fleet" | mock, ≥2 boxes |
| 6 | **Header power/TV dropdown** (RemotePowerBar) | "Wake it, sleep it, switch the input" | mock |
| 7 | **Actions** (impact-grouped runbook) | "Fix it without a keyboard" | mock |
| 8 | **Setup pairing** (Scan + 6-digit PIN) *or* Smart TV brand row | "Pair in seconds — no IP typing" | native |

Trim to ~5–6 if desired; keep 1–4 as the core. iPad set mirrors iPhone 1:1, re-shot at iPad res.

Per-screen mock/nav detail: see the workflow synth (task `wpjwvfx5s` output) — each entry has exact
`--mock` state and how to make the screen look populated.

---

## 4. Copy draft (starting point — gated on build-target + TV-line decisions in §6)

- **Title (≤30):** `Couchside — HTPC Remote`  *(live is `Couchside — Remote`; ASO change, confirm)*
- **Subtitle (≤30):** `Remote, controller & console`  *(live is `Remote console for your HTPC`)*
- **Promo (≤170):** Turn your phone into the console, controller, and remote for your living-room
  Linux gaming PC. LAN-only, no cloud, no accounts. Free 7-day trial, pay once.
- **Keywords (≤100):** `steamos,bazzite,steam deck,gamepad,controller,tv remote,systemd,linux,dashboard,gamescope,kodi`
- **Description:** full draft in the synth (task output §synth.storePage.description). Sections:
  LIVE CONSOLE · FIX IT WITHOUT A KEYBOARD · READ THE LOGS & SEE THE SCREEN · LAUNCH GAMES ·
  VIRTUAL GAME CONTROLLER · LIVING-ROOM REMOTE & TV CONTROL · YOUR WHOLE FLEET · EASY PAIRING (PIN) ·
  PRIVATE BY DESIGN (**licensing fixed**) · TRY FREE 7 DAYS PAY ONCE · REQUIREMENTS.
- **What's-New:** the synth's draft is TV-led, but **v2.9.22 already shipped a whatsnew**
  (`app/changelogs/whatsnew-en-US.txt`, update-hub-led: box updates from phone, pairing tutorial,
  Prefs search, app-update check, Close Game fix, drag trail). If the revamp rides the 2.9.22
  submission, the store What's-New is that shipped text — don't invent a competing one; the
  TV-control story belongs in the evergreen DESCRIPTION, not What's-New.

---

## 5. Visual direction

Align every frame to the shipping **reactor** skin (`app/lib/skin/reactor.tsx`, `DEFAULT_SKIN`) so
store ≈ app. Near-black charcoal bg (not pure #000), let neon core glow + top-lit bevels show; skin
accent/blue for CTAs, semantic red reserved for danger/offline only. One benefit-led headline per
shot, same position (top third), condensed geometric sans, near-white + faint accent underline;
headline only, no body. Same hostname `couchside-box` + same believable data across shots = reads as
one session. Landscape frame for the gamepad shot only; portrait for the rest. Capture the animation
at mid-glow, not a dark trough.

---

## 6. Open decisions (BLOCK generation — see §7)

1. **TV control in the copy = crosses the marketing-lockstep line.** `marketing-expansion-plan`
   gates broadened TV/universal-remote copy to ship in lockstep with the feature's public marketing;
   current listing claims NO TV control. Publishing TV copy flips that switch. If yes: keep the
   rescue-console wedge as the headline (identity-dilution risk), name ONLY shipped backends (LG
   webOS + Google/Android TV) — Samsung/Roku/Hisense stay out until their backends ship (App Review
   2.3.1).
2. **Build target — RESOLVED 2026-07-23: v2.9.22 (cut overnight, tag exists).** app 2.9.22,
   iOS build 76 / vc 59 (autoIncrement ran = EAS builds happened), floors were vc≥56 / iOS≥76.
   Everything previously listed as "on main unreleased" (update hub, app-update check, Prefs
   filter, drag trail, pairing tutorial) is IN 2.9.22. App Store live is still 2.9.21 (iTunes
   lookup, 07-23), so build 76 is TestFlight and/or App Review — **open sub-question: has build
   76 been submitted to App Store review?** If not, the revamp (screenshots + copy) should ride
   the 2.9.22 submission. Post-tag commits are agent-only (2.9.48/2.9.49) → main's app code ==
   the 2.9.22 app, so the Simulator batch can build straight from main.
3. **Real box for the Launch (+ optional Now-Playing) hero.** `--mock` Steam covers are flat
   solid-color placeholders and look bad; the Launch hero wants a real box with a real Steam library.
   MPRIS Now-Playing has no mock at all. Stage a LAN box or drop those shots.
4. **Capture method.** iOS **Simulator** (native build) recommended — it animates the reactor skin,
   drives touch+WS, renders exact device px. Web harness only for non-touch previews, never final.
5. **Baked-in caption overlays vs raw screens** (both Apple-legal). Overlays recommended for conversion.
6. **Play parity.** Android capture blocked (maintainer's folding Razr inner display goes black when
   folded) — reuse composed iOS frames for Play (looser specs) or use a Mac Android emulator.
7. **Licensing fix everywhere.** Fix "whole project is open source" in the App Store copy AND mirror
   to README / couchside.tv per the update-all-surfaces rule.

---

## 7. Capture method + commands (iOS Simulator primary)

```
xcrun simctl list devices available | grep -Ei 'Pro Max|iPad Pro'
xcrun simctl boot 'iPhone 17 Pro Max'        # native 1320x2868 = 6.9" master
xcrun simctl boot 'iPad Pro 13-inch (M4)'    # native 2064x2752 = 13" master
python3 agent/couchsided.py --mock --host 127.0.0.1 --port 8781 --token shotlist-mock
cd app && npx expo run:ios --device 'iPhone 17 Pro Max'   # then add box @127.0.0.1:8781
# Launch real covers + Now-Playing: add a REAL LAN box instead of mock, same session
xcrun simctl io booted screenshot --type=png ~/Desktop/couchside-01-console.png
# rotate to landscape (Cmd+Right) before the gamepad capture
scripts/web-dev.sh 8099    # web fallback for non-touch preview mockups ONLY
```

**Blockers:** mock Steam covers bad (use real box); MPRIS card has no mock; web harness can't do
touch/WS/status-bar; Wake-on-LAN button only renders with an OFFLINE box; Simulator can't exercise
IAP (fine, paywall not in the set); re-verify Apple dims before submit.

**Batch plan:** batch 1 = non-touch screens (Console/Fleet/Actions/Header/Setup) can be previewed via
web harness now to lock composition, then re-shot native. Batch 2 = touch screens
(Pad/Remote/Gamepad) + real-cover Launch need Simulator/device + a real box on the Mac.

---

## 7.5 Web-harness preview sweep — MEASURED 2026-07-23 (browser, mock agent 2.9.47)

Decisions locked by maintainer: **TV control goes in the copy · target a fresh release off main ·
real box stages the Launch hero · previews shot via harness now, finals on Simulator.**

Composition previews captured for: Console (reactor skin, full gaming card), header power/TV
dropdown, Actions, Launch (top cards + grid), Fleet (2 live + 1 down), Setup/Boxes. Findings that
change the final shoot:

1. **Recon claim FALSIFIED: mock DOES serve Now Playing.** M83 "Midnight City" MPRIS card renders
   live in --mock (agent log: `mpris: available`). The "no mock branch" claim in §6.3 is wrong for
   agent 2.9.47. Album art is a black square though — a real box playing real media still makes the
   better frame.
2. **Mock Steam covers confirmed flat solid-color tiles** (seen, not assumed) — Launch hero MUST be
   a real box. Mock's PLAYING NOW / DOWNLOADING 28% / STREAM FROM PC (emery-pc + offline hosts)
   cards all render well and could composite over a real grid.
3. **Fleet tile names come from the AGENT's reported hostname**, not the app-side box name — two
   mock boxes both render "couchside-box". The Fleet shot needs genuinely distinct real boxes
   (inventory has them). DOWN tile renders "DOWN · last seen never" red-bordered — for the store
   frame prefer a box that has been seen ("last seen 2h ago").
4. **Entitlement state leaks into shots:** Setup shows an "Enjoying Couchside? Unlock for $4.99 —
   Trial ended" signpost in this build state. Final screenshots must be captured **in-trial or
   unlocked** — no "Trial ended" text in store assets.
5. Reactor skin breathing = capture-timing matters: first frame caught the dim trough, later frames
   mid-glow (CPU sparkline green, UPTIME halo). On Simulator, take bursts and pick mid-glow.
6. Mock Actions list is sparse (5 entries: Restart Decky / Pair a controller / Restart Session /
   Reboot / Power Off) — grouping story reads fine, but a real box shows a fuller set.
7. Harness quirks (browser-preview only, none affect Simulator finals): viewport resize needs a
   reload to re-layout; app column renders at a fixed width with dead space at larger sizes.
8. **Realistic fleet names rig (built + proven 2026-07-23, maintainer asked for real device
   names).** Scratchpad `fleetmock/`: three sed-patched agent copies (only change:
   `"hostname": "couchside-box"` at couchsided.py:3351 → `bazzite` / `taylor-steamdeck` /
   `lenovodesktop`) on :8101-8103, plus `proxy-multi.py` — a variant of scripts/web-dev-proxy.py
   that routes /api by BEARER TOKEN so all three appear as distinct live boxes at ONE origin
   (:8099). App-side boxes: same host:port, tokens tok-bazzite/tok-deck/tok-lenovo, plus a dead
   `legion-go` @10.255.255.1 for the red DOWN tile. Fleet + box-switcher dropdown both render the
   real names. NOTHING committed to the repo — rig lives in the session scratchpad; recreate with
   the same sed + proxy for the Simulator finals (Simulator reaches 127.0.0.1, so this same rig
   solves Fleet names for the native shoot too — real boxes still preferred for authentic IPs).
   Nit for finals: dead tile reads "last seen never" — pre-seed one successful probe so it reads
   "last seen Nh ago".
9. **Browser-pane gotcha:** when the pane is backgrounded, `document.visibilityState === 'hidden'`
   → RNW AppState 'background' → the Fleet tick deliberately pauses (shipped battery behavior, not
   a bug) and tiles stick at "probing…". Workaround for harness shoots: override
   `document.visibilityState`/`document.hidden` to visible + dispatch `visibilitychange`.

## 8. Provenance

Recon workflow `appstore-revamp-recon` (run `wf_9717af20-6e6`, task `wpjwvfx5s`), 2026-07-23.
4 parallel readers + synth; the `tooling` reader errored (schema retry cap) and was recovered inline.
Full synth (per-screen mock states, full description text, all device dims) in the task output file.
