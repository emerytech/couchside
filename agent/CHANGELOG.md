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

## 2.9.47

Update your box's operating system from the phone too, on SteamOS and Bazzite.
Same one-time opt-in as app updates (`couchside allow-system-updates on`). An
OS update is staged and applies on the next reboot — the app tells you that
plainly rather than pretending it finished.

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
