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
