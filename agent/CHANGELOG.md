# Agent changelog

The text under each version heading becomes that GitHub release's body, which
is what the app shows as **"What's new"** on the *Box update available* card.

`scripts/release-agent.sh` extracts the section matching the AGENT version in
`couchsided.py` — not the tag, which is an app version — and **refuses to
publish** if there is no matching section.

Only the newest section is published. Boxes routinely skip several agent
versions between updates (2.9.38 straight to 2.9.41 here), so when a release
bundles more than one version, the top section must describe **everything a
user is getting**, not just the last change. That is deliberate:
before this file existed, the script wrote one hardcoded sentence — and only
when it had to *create* a release — so every agent release for months told users
the same thing regardless of what actually changed.

Write for the person holding the phone, not for the commit log. They are
deciding whether to press "Update now" on a machine across the room.

## 2.9.80

**Switch your audio output from the couch.** A new AUDIO OUTPUT card on the
Console tab lists the devices your box can play through — the TV over HDMI, a
Bluetooth speaker, the built-in output — and one tap moves the sound there,
including whatever is already playing. LAN-only like everything else; boxes
without PipeWire/PulseAudio simply don't show the card.

## 2.9.79

**Steer your Steam Big Picture menus from the phone.** With the remote-desktop
module installed, the Control screen now works in Game Mode too: tap a Big
Picture menu item on your phone and it selects there, with a D-pad + Select on the
toolbar as a fallback. (On the desktop it stays the full remote desktop.) Boxes
without the module, or in Game Mode without it, are unaffected.

## 2.9.78

**"Switch to Game Mode" works on the newest SteamOS.** On a Steam Machine, a
Legion Go S, or any box running a recent SteamOS build, the Couch button now
hands the box to Game Mode correctly instead of falling back to Big Picture (or
failing with an "Unable to open a connection to X" error). Your box's Game Mode
session is now recognised by the name current SteamOS ships it under.

**Smoother remote desktop (opt-in module).** For boxes with the remote-desktop
module installed, controlling the desktop from your phone is markedly more fluid:
reopening the view is instant, the picture stays low-latency under motion,
there's an on-screen keyboard, and a full-screen landscape "Remote Desktop" mode.
Boxes without the module are unaffected.

## 2.9.77

**OpenPuck firmware now comes straight from the source.** Flashing an OpenPuck
receiver fetches the firmware at flash time from the maintained OpenPuck build on
GitHub, verifies it (exact checksum + size + UF2 format) before writing a single
byte, and caches it so the next flash is instant. A copy is still seeded at
install time, so flashing works with the box offline. New: an optional "check for
newer firmware" — the box never installs a newer build on its own; you choose.

## 2.9.76

**Your whole library, instantly.** The Not-installed page used to fill in game
names through Steam's rate-limited store API, so a big library appeared a few
dozen games at a time (an 1101-app library showed 88 after days). The box now
reads the names Steam already keeps on disk and sends them with the list — every
game appears immediately, alphabetical and searchable, even with the internet
down. Genres and release years still fill in gradually for the filters.

## 2.9.75

**Utilities can now flash an OpenPuck receiver.** The OpenPuck utility gained a
Flash button: plug an nRF52840 board into the box (in its UF2 bootloader), press
Flash, and Couchside writes the OpenPuck firmware — the board reboots as a Steam
Controller 2 wireless receiver. The firmware is fetched and verified by the
installer, so flashing works with the box offline; the bootloader is kept, so you
can re-flash any time. HDMI-CEC detection is now honest about whether the box can
actually open the CEC device (so a permissions fix shows up), and the installer
adds a udev rule that grants that access. Needs the app that ships alongside this
agent.

## 2.9.74

**Utilities — one-click hardware helpers (new, opt-in).** Setup gains a Utilities
section that shows what your box can help with: flashing an nRF52840 board into an
OpenPuck Steam Controller receiver, and turning on HDMI-CEC so the box can power
your TV and switch inputs over the HDMI cable. This first release only *detects*
and reports status — it tells you when a board is plugged in and ready, or when a
CEC adapter is present — with the flashing and enabling actions to follow. It's
off by default; turn it on under Setup, and older apps don't show it at all.

## 2.9.73

**Install a game you own but haven't downloaded.** Couchside can now list the
Steam games in your library that aren't on the box yet and start the download
from your phone. It reads the library your Steam client already cached on disk —
no Steam account, no API key, nothing leaves the box — and hands the install to
Steam itself, so it only ever installs a game you actually own. Needs the app
that ships alongside this agent; older apps simply don't show the new section.

## 2.9.72

**Per-game install size.** Each Steam game now reports how much disk it is
using, read straight out of Steam's own `appmanifest_*.acf`. The app pairs it
with playtime to answer the question you actually have when a drive fills up:
what is big, and which of it have I never played?

Costs nothing extra to collect — those manifests were already being read to
find your games in the first place. A game Steam has not measured yet reports
no size at all rather than a zero, because "0 GB" reads as free space that is
not free.

## 2.9.71

- **Fresh installs work again on a Steam Deck.** The installer stopped partway
  through on SteamOS — it tried to create a folder in a place SteamOS keeps
  read-only, and quit before the service was fully set up. It now puts that
  piece somewhere writable instead. Nothing to do on an existing install; this
  only affected setting up a new box.
- **Couchside's own log is no longer listed as a broken service.** On Windows
  the Console showed a permanent yellow `couchside-agent inactive/not-found`.
  It was never a service — it is there so its log shows up in the Logs tab —
  so it no longer pretends to be one. Requires the Windows service 0.4.5-win.
- **The app can now tell you what you've actually played.** The service reads
  the playtime Steam already records on your own machine, so the app can sort
  and filter your library by hours played and last played. It never leaves your
  box: no Steam account, no API key, nothing sent anywhere.
- **Update wrappers work again.** The helper looked for the flatpak and OS
  update commands in a folder the installer never wrote to, so both quietly
  reported "unavailable" on every box.

## 2.9.70

- **Big Picture on boxes that can't do Game Mode.** If your machine has Steam
  but isn't a Steam Deck / Bazzite-style setup, the couch control now opens
  **Steam Big Picture** on it instead of being missing entirely — tap to open,
  long-press to come back to the desktop. Boxes that can do the real Game Mode
  handoff are unaffected and keep it.
- **The Console shows the right OS name on Nobara** (and any distro that bakes
  its version into the name) — it was reading "Nobara Linux 43 … 43".
- **Uninstalling now removes everything**, including the privileged helper
  added in 2.9.69. Re-running the installer restores it.

## 2.9.69

- **Groundwork release: a safer way for Couchside to do its privileged work.**
  A small root-side helper now ships alongside the agent and takes over the
  boot-session steering that previously ran through sudo rules. You should
  notice nothing — every feature behaves exactly as before — but under the
  hood each privileged action is now a single named operation that is checked
  and refused unless it is exactly right, and a box whose login manager
  changes no longer needs the installer re-run to keep "Boots into" working.
  The old path remains as a fallback, so updating is safe on every box.
- Re-run the installer (or use the app's update button) to get the helper;
  a quick agent-only update works too and simply keeps the previous behaviour.

## 2.9.68

- **The Console now shows which OS your box runs**, under the service version —
  "Bazzite 43", "CachyOS rolling", "SteamOS 3.8.21". Handy when you have more
  than one box, and the first thing worth knowing in a bug report.

## 2.9.67

The "Boots into" setting was breaking your box's own session switching. It
isn't any more.

- **Switching to the desktop works again.** If you had ever set "Boots into",
  Couchside left a file on the box telling it which session to start — and
  because every switch to the desktop is really the box logging in again, that
  file overruled the switch and sent you straight back to Game Mode. It broke
  **Steam's own "Switch to Desktop" button** too, which made it look like your
  distro was at fault. The setting now writes that file only while the box is
  shutting down, so nothing of ours is in the way while you are using it.

- **A switch that doesn't happen no longer says it worked.** Leaving Game Mode
  reported success as soon as the box accepted the request, without checking
  where you actually ended up. It waits and tells you the truth now.

- **Every GPU is reported, not just the first one.** On a machine with two —
  a laptop with an integrated chip and a discrete card — Couchside picked
  whichever came first, which was usually the integrated one, and showed its
  small memory carve-out as if it were your graphics card. Both now appear,
  with their own temperature and memory.

## 2.9.66

Machines that aren't SteamOS or Bazzite get features they should have had all
along, and one setting stops pretending to work.

- **"Boots into" works on newer KDE login screens.** KDE is moving from SDDM to
  plasmalogin, and CachyOS handheld images already ship it. On those boxes the
  card appeared, said "unknown", and quietly did nothing — every change was
  written to a folder the machine does not have. It now finds the login manager
  your box actually runs and writes where that manager reads, so the setting
  takes effect on the next boot.

- **"Restart session" aims at the right service.** The fix-a-black-screen button
  was hardcoded to SDDM. On a box running something else it either failed or,
  worse, could have started a second login manager on top of your live session.

- **Couch Mode, the desktop controls and the controller shortcut show up on more
  machines.** They were offered based on the name in your box's OS file, so a
  CachyOS or ChimeraOS machine carrying exactly the same session tooling as a
  Steam Deck was refused for its name alone. Couchside now checks whether the
  box can actually make the switch.

- **A box whose login manager can't be identified hides the boot setting**
  instead of showing one that silently does nothing. A missing control is
  better than one that lies.

## 2.9.65

Three fixes, all found by testing against real boxes rather than reading code.

- **"Return to Game Mode" no longer appears when you are already in Game Mode.**
  Tapping it there did more than nothing: it quietly changed what your box boots
  into, and it could restart the session out from under a running game. The
  button is still there when you are on the desktop, which is when it makes
  sense. If a Game Mode session ever wedges, the app can still restart it.

- **Storage no longer shows the same drive twice.** On Bazzite the card listed
  `/home` and `/var` as two separate disks with identical numbers, so a 464 GB
  drive read as though you had nearly a terabyte. They are two names for one
  filesystem, and now they count once. Steam Decks were never affected.

- **Custom Steam machines can read their boot setting again.** On boxes that use
  greetd instead of SDDM, asking the box which mode it starts in failed outright,
  so the "Boots into" card never loaded. It answers now.

## 2.9.64

The Couchside Player arrives — an optional, experimental add-on.

- **Streaming services, driven from your phone.** Install the Couchside Player
  add-on and a new tile appears in Game Mode that opens Netflix, YouTube, Max,
  Hulu, Disney+ and the rest on the TV. Pick a service from the phone, send it a
  link, or search a title without typing on the TV — the box opens that
  service's own results. Play, pause, skip and mute all work from the phone
  while it plays.
- **A home screen on the TV.** The tile has its own picker with a proper
  highlight you can move with the swipe pad, for when the phone is not the thing
  in your hand.
- **It is EARLY.** Expect rough edges. Streaming sites still need the trackpad
  rather than the d-pad — they do not let a remote move a highlight, which is a
  limitation of those sites rather than something we can change from outside.
  Switching services can also leave the TV showing the previous screen; stop and
  pick again if that happens.
- **Entirely opt-in.** Re-run the installer and say yes, or pass `--player`.
  A box that never asks for it is unchanged, and the app hides the whole feature
  on any box without it.

Also in this release:

- **"Boots into" no longer quietly reverts.** SteamOS and Bazzite both ship a
  script that writes the same login setting Couchside was writing — and its file
  took priority over ours, so anything that ran it (switching to Desktop from the
  phone, or Couch Mode) put the setting back without telling you. Ours now takes
  priority and survives. Setting it still never disturbs the session you are in;
  it applies at the next boot.

## 2.9.63

A boot-session fix for Bazzite, and early groundwork for other kinds of box.

- **Fixed: "Boots into → Desktop" could leave a Bazzite box at the login
  screen.** It pointed the automatic login at a desktop session that exists on
  SteamOS but not on Bazzite, so the box stopped at the password prompt and then
  came up in Game Mode anyway — and if your Couchside service runs under your own
  login, it would not start until you signed in, so the phone lost the box. The
  box now uses a desktop session it has confirmed is installed, and refuses to
  change the setting at all if it cannot find one. **This is the part of this
  release that is tested and working.**
- **Groundwork, ALPHA — boxes that do not use SDDM.** The box can now identify
  which login manager it runs, and there is early support for setting the boot
  session on **greetd** (common on Arch/CachyOS gamescope builds and ChimeraOS).
  **This has not been tested on a real greetd machine yet** — it is written
  ahead of proper support rather than proven, so treat it as experimental and
  expect it may not work. GDM and LightDM are recognised but not supported at
  all yet; on those the setting simply will not appear.
- If greetd support does run, your existing configuration is preserved and a
  backup is saved beside it, and anything that cannot be changed safely is left
  alone rather than risking your boot.

## 2.9.62

Fixes "Boots into: Desktop" on Bazzite.

- **Setting your box to boot into Desktop could leave it at the login screen.**
  It pointed the automatic login at a desktop session name that exists on
  SteamOS but not on Bazzite, so the box stopped at the password prompt instead
  and then came up in Game Mode anyway. If your box also runs the Couchside
  service under your own login, it would not have started until you signed in —
  so the phone lost the box. The box now checks which desktop sessions are
  actually installed and uses one of those, and refuses to change the setting at
  all if it cannot find one, rather than leaving you locked out.
- If you hit this, the setting is repaired automatically the next time you set
  it; no need to touch the box.

## 2.9.61

Small fixes to the pairing screen and to updating.

- **The "get the app" code now opens a page with just the two store links** —
  App Store and Google Play, nothing else. It used to drop you on the middle of
  the website, which is a lot to wade through when you are stood in front of the
  TV holding a phone.
- **Updating no longer restarts your other Decky plugins.** Every update used to
  reload Decky Loader whether or not the Couchside panel had actually changed,
  which restarted everything else you have installed alongside it. Now it only
  happens when the panel is genuinely new.

## 2.9.60

Your box now tells the app more about itself, and box-software updates finish cleanly.

- **What it's actually sending the TV.** The box reports its live resolution and
  refresh rate, plus HDR and VRR state, the monitor's own name, and which speaker
  is playing — the new Display / Audio panel on the Console tab, once your app
  updates to match. It reads the real signal, not what the box was asked for, so
  it won't tell you HDR is on when the panel is showing SDR.
- **Updating box software no longer hangs.** Updating your flatpaks from the phone
  used to sit on "Updating…" when an app couldn't be updated (an end-of-life
  runtime, say) — now the box reports when the update itself finishes, so the
  card completes and an OS update behind it isn't left waiting.

## 2.9.58

Choose which mode your box starts in.

- **Boots into: Game Mode, Desktop, or Last used.** A new card at the top of the
  Actions tab. The switches below it have always been one-shot — they change
  what is on screen now and the box still comes back up however it was set. This
  is the setting that actually decides that.
- Works on Bazzite as well as SteamOS. They do it in completely different ways
  under the hood, so boxes that can't do it simply don't show the card.

## 2.9.57

Your streaming apps now show up in the phone's Launch tab.

- **Netflix, Hulu, Disney+, Prime Video, Max — and anything else you have added
  to Steam yourself.** Until now the Launch tab only listed games you had
  installed through Steam, which on a SteamOS or Bazzite box leaves out almost
  everything you actually watch. Streaming services, EmuDeck's launchers, a
  browser shortcut, Waydroid — all of those are "non-Steam shortcuts", and the
  phone could not see any of them. On the box this was tested on, that was 5
  things listed out of 36 that were really there.
- Tap one and it opens on the TV exactly as it would if you had picked the tile
  with a controller — same app, same window, so you stay signed in.
- Nothing to set up. If you have no shortcuts, the Launch tab looks exactly as
  it did before.

## 2.9.56

Send files to the box from your phone — and the screen preview works again.

- **Send a file to your box.** A new card on the Console tab: pick anything on
  your phone — a ROM, a save, a PDF, a photo — and it lands in
  `~/Downloads/Couchside` on the box. Big files are fine; they stream straight
  across rather than being held in memory. On the desktop, **Show on box** opens
  that folder on the TV so you can get at what you just sent.
- **The screen preview is fixed.** If you had ever switched between Game Mode
  and the desktop, the preview would quietly stop updating — a stale picture, or
  nothing at all, taking about nine seconds to give up each time. It was aiming
  at the session you had left, which sticks around after it ends. The box now
  checks whether that session is genuinely still running, so the preview follows
  you between Game Mode and the desktop.
- **Preview frames arrive about 2.4x faster** — roughly two seconds down to
  under one — so the Screen card feels far less sluggish.
- **Windows: pairing from the app works.** Tapping your PC in "Scan for boxes"
  used to fail with *unauthorized* — the PC had no way to show you a PIN, so the
  only ways in were the QR page or typing the token by hand. Now it shows a
  six-digit PIN on the PC's own screen, same as a Steam Deck.
- **Windows: a fix for the missing Pad tab.** Some `.exe` installs shipped
  without the driver file the virtual controller needs, so the box reported no
  gamepad support and the app hid the Pad tab entirely. Builds can no longer be
  made that way. If your Pad tab is missing, reinstall with the current
  `CouchsideSetup.exe`.
- Coming from before 2.9.53, you also get: the trackpad no longer goes dead
  after the phone sits idle, and on Windows your Epic, GOG and Xbox / Game Pass
  games appear next to Steam.

## 2.9.53

The trackpad stays alive — and on Windows, your whole game library shows up.

- **No more dead mouse after the phone sits idle.** If the app was in the
  background (or the phone locked, or you switched to Desktop mode), the
  connection could go quiet and the box would quietly drop it — you'd come back
  to a green "connected" dot and a trackpad that moved nothing, and the only fix
  was force-quitting the app. The box now keeps the link awake itself, and your
  first swipe rebuilds the connection if it did die. Pointer, keyboard, and
  controller all recover on their own.
- **Windows: Epic, GOG, and Xbox / Game Pass games now appear** next to your
  Steam library, in the same cover grid — tap one and it starts on the TV. The
  Launch tab also shows up on a PC that has no Steam installed at all.
- **Windows: a double-click installer.** `CouchsideSetup.exe` sets the service
  up without pasting anything into PowerShell. Grab it from
  <https://couchside.tv/windows>.

## 2.9.52

A smoother first pairing on the box's own screen.

- **The pairing screen now comes up in front.** On a desktop (non–Game Mode)
  install it could open *behind* the terminal window, leaving you staring at the
  install log instead of the QR. It now raises itself to the front so the code
  and the 6-digit PIN are right there.
- **One code to get the app, not two.** The "get Couchside on your phone" step
  shows a single QR that opens the download page for both the App Store and
  Google Play — scan it and pick your store on the phone, instead of aiming the
  camera at the right one of two codes.

## 2.9.51

Updating the box from your phone now finishes on its own — and tells you if it
doesn't.

- **The box's update screen shows when an update didn't finish**, instead of
  spinning forever. It says the box is still on the old version and how to retry.
- **App-triggered updates now restart the service cleanly** on boxes installed as
  a system service — including boxes that also have Decky installed, which the
  first version of this fix missed. On an existing box, re-run the installer once
  (in a terminal) to enable it; after that, phone updates finish on their own.

## 2.9.50

Two fixes for updating the box from your phone.

- **The box's update screen now tells you if an update didn't finish**, instead
  of spinning forever. If it stalls, it says the box is still on the old version
  and how to retry.
- **App-triggered updates now finish on more boxes.** On a box installed as a
  system service, an update could quietly stop after downloading the new agent —
  leaving the old one running — because it had no way to restart the service
  without a password. It now restarts cleanly. On an existing box, re-run the
  installer once (in a terminal) to enable this; after that, phone updates finish
  on their own.

## 2.9.49

Desktop PCs no longer show a phantom battery. If you had a wireless controller
paired, its charge could appear as the machine's own battery — a desktop
reading "On battery 15%" when it has no battery at all. The box now only reports
its own pack, never a controller, mouse, or headset.

## 2.9.48

The first-pairing screen now helps you get the app, and it opens reliably from
Desktop Mode.

- **The pairing screen shows App Store and Google Play QR codes** — if you don't
  have Couchside on your phone yet, scan one to install it, then scan the big
  code to pair. No hunting through a store.
- **The guide now actually opens after a Desktop-Mode install.** On SteamOS's
  KDE desktop it was silently failing to launch a browser, so nothing appeared;
  it now opens a real browser full-screen (Firefox, Chrome, Chromium, Brave, or
  Edge — whichever you have).

## 2.9.47

Update your whole box from the couch, plus a friendlier first pairing.

- **Update your Flatpak apps and your operating system from the phone** (SteamOS
  and Bazzite), together or one at a time. Since system updates need root, it's
  a one-time opt-in you turn on at the box — `couchside allow-system-updates on`
  — which spells out exactly what it grants. An OS update is staged and applies
  on the next reboot; the app says so plainly instead of pretending it finished.
- **A fresh install now shows a short guide right on the box's screen** — open
  the app, scan, tap this box — that turns into the pairing PIN the moment you
  start. And a device on your network can no longer pop that pairing screen onto
  your TV over and over.
- **Closing the running game from your phone actually closes it now** — the
  button used to report success while the game kept running.

## 2.9.46

Update your box's Flatpak apps from the phone. If your apps are system-wide
(most are), run `couchside allow-system-updates on` on the box once — it
explains exactly what it grants — and the app can then update them for you.
Without it, only your per-user apps update.

Everything in 2.9.45 below is also new if you're coming from older:

## 2.9.45

Fresh installs now show a short animated guide on the box's own screen —
open the app, Scan, tap this box — that turns into the pairing PIN the moment
you start. No more staring at a finished terminal wondering what to do next.

Also closes a small nuisance: a device on your network could pop the pairing
screen onto your TV on repeat. It can't anymore.

## 2.9.44

Closing a game from the phone now actually closes it. The button reported
success without stopping anything.

## 2.9.43

Storage now reports how full a drive really is. It was dividing by space you
cannot actually use, so a nearly-full drive could read several points low.

Game drives appear too — a Steam Deck's SD card was invisible before.

The GPU no longer looks like it has half a gigabyte. Handhelds share memory
with the system, and only the small dedicated slice was being reported — it now
shows the whole pool, plus how busy the GPU actually is.

Memory now shows swap in use and, when the box is actually struggling, how much
time it spends stalled waiting on memory — the thing you feel as stutter, which
a used-percentage does not tell you.

Handhelds also show current power draw and the machine's power profile — and
while charging, how long until the battery is full.

You can close the running game from your phone. The Gaming card shows what is
playing and how long it has been on, with a button to quit it.

Game cover art now appears on Android. It never has — the phone was quietly
dropping the credential on image requests, so every tile fell back to a plain
card.

While the box updates itself, the app now shows what it is actually doing, and
the box's own screen shows an update page so you are not staring at a frozen TV.

## 2.9.42

Adds the box-side half of the app's new Steam search button.

## 2.9.41

Poster art now appears for games that were showing a blank card. Recent Steam
files its artwork somewhere the box was not looking, so it was on your machine
the whole time — nothing is downloaded.

Handhelds report their own battery: charge, whether you are on AC, and how long
is left.

New "Send keys instead of a controller" option in the app. Steam navigates the
same way, but the box stops announcing a controller every time you connect — so
a game already running cannot lose player one to your phone.

## 2.9.40

Handhelds now report their own battery. The Console tab shows charge, whether
you're on AC, and how long you have left.

## 2.9.39

New "Send keys instead of a controller" option. Steam navigates the same way,
but the box stops announcing a controller every time you connect — so a game
that's already running can't lose player one to your phone.

## 2.9.38

Couch Mode now restores the exact audio device it moved, instead of guessing at
one by name. Disk readings no longer count the same drive twice.

## 2.9.37

Signed agent assets for install.sh / `couchside update`.
