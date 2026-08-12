#!/usr/bin/env python3
"""Fullscreen pairing-PIN launch resolver (_pin_kiosk_argv).

Run: python3 tests/test_pair_kiosk.py

The pairing PIN page must open FULLSCREEN on the box so a user can read the code
off a TV. On a desktop-session box the agent is a system service with only a
partial session env, so a bare xdg-open silently failed and the PIN never showed
— a hard stop for pairing (fixed by launching a --kiosk browser inside the user's
systemd session). This pins the browser->argv mapping: a flatpak default browser
(reverse-DNS .desktop id) -> `flatpak run <id> --kiosk`, a system browser -> its
binary --kiosk, and anything that isn't a known browser -> None (fall back to a
windowed xdg-open; the PIN still shows). The actual launch is hardware-verified.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


URL = "http://localhost:8787/pair"


def have_all(_x):
    return True


def have_none(_x):
    return False


def have_set(names):
    return lambda x: x in names


# flatpak default browser (reverse-DNS id) -> flatpak run <id> --kiosk
check("flatpak firefox -> flatpak run --kiosk",
      cs._pin_kiosk_argv(URL, "org.mozilla.firefox.desktop", have=have_set({"flatpak"})),
      ["flatpak", "run", "org.mozilla.firefox", "--kiosk", URL])
check("flatpak chromium -> flatpak run --kiosk",
      cs._pin_kiosk_argv(URL, "org.chromium.Chromium.desktop", have=have_set({"flatpak"})),
      ["flatpak", "run", "org.chromium.Chromium", "--kiosk", URL])

# system browser (plain id) -> <binary> --kiosk
check("system firefox -> firefox --kiosk",
      cs._pin_kiosk_argv(URL, "firefox.desktop", have=have_set({"firefox"})),
      ["firefox", "--kiosk", URL])
check("google-chrome -> google-chrome --kiosk",
      cs._pin_kiosk_argv(URL, "google-chrome.desktop", have=have_set({"google-chrome"})),
      ["google-chrome", "--kiosk", URL])
check("brave -> brave-browser --kiosk",
      cs._pin_kiosk_argv(URL, "brave-browser.desktop", have=have_set({"brave-browser"})),
      ["brave-browser", "--kiosk", URL])

# a flatpak id but flatpak binary absent -> None (fall through, no bad argv)
check("flatpak firefox but no flatpak binary -> None",
      cs._pin_kiosk_argv(URL, "org.mozilla.firefox.desktop", have=have_none),
      None)

# not a browser at all -> None (windowed fallback)
check("non-browser default (kate) -> None",
      cs._pin_kiosk_argv(URL, "org.kde.kate.desktop", have=have_all), None)
check("empty default -> None", cs._pin_kiosk_argv(URL, "", have=have_all), None)

# a known browser name but its binary isn't present -> None (no unlaunchable argv)
check("system firefox but binary missing -> None",
      cs._pin_kiosk_argv(URL, "firefox.desktop", have=have_none), None)

# url is passed through verbatim (agent-built, never interpolated into a shell)
weird = "http://localhost:8787/pair"
check("url is the last argv element, verbatim",
      cs._pin_kiosk_argv(weird, "firefox.desktop", have=have_set({"firefox"}))[-1], weird)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all pair-kiosk tests passed")
