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

## 2.9.43

Storage now reports how full a drive really is. It was dividing by space you
cannot actually use, so a nearly-full drive could read several points low.

Game drives appear too — a Steam Deck's SD card was invisible before.

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
