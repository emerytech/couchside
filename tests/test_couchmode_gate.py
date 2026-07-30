#!/usr/bin/env python3
"""Who is OFFERED Couch Mode — the capability probe that replaced a distro name.

Run: python3 tests/test_couchmode_gate.py

THE BUG (owner-reported, 2026-07-30). The Couch Mode toggle never appeared on a
CachyOS deckify box. Nothing was broken there: MEASURED live on that machine
(10.1.1.235, ID=cachyos / ID_LIKE=arch, kernel 7.1.5-1-cachyos-deckify),

    gamescope               /usr/bin/gamescope
    steamos-session-select  /usr/bin/steamos-session-select
    kscreen-doctor          /usr/bin/kscreen-doctor
    wpctl                   /usr/bin/wpctl
    connected output        card1-eDP-1
    sessions installed      gamescope-session.desktop, plasma.desktop

...and its `steamos-session-select` takes the same gamescope/plasma verbs the
agent sends, through a polkit rule granted allow_any=yes (no password prompt).
The box could do the handoff in every way that matters. It was refused by
`_is_steamos_like()`, which grepped /etc/os-release for the literal strings
"steamos" or "bazzite" — so the distro's NAME, not its ability, decided. That
one check also gated the `desktop` capability and the guide-button hold, so
three features vanished together on every capable non-Valve-branded box
(CachyOS deckify, ChimeraOS, Arch running the deckify packaging).

The replacement asks what the switch needs: the four tools, plus BOTH switch
targets really installed — somewhere to fling to (gamescope-session.desktop)
and something to come back to (a known desktop session). The second half is the
KI-038 lesson applied to a gate instead of a write: a command existing does not
mean the thing it switches to does.

Both directions are exercised here, with controls in each — a probe you have
only seen say yes is not verified (CLAUDE.md §11.2/§11.3).
"""
import importlib.util
import os
import sys
import tempfile

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


def session_dir(names):
    """A fake /usr/share/wayland-sessions holding exactly `names`."""
    d = tempfile.mkdtemp()
    for n in names:
        with open(os.path.join(d, n), "w") as f:
            f.write("[Desktop Entry]\nExec=/bin/true\n")
    return d


# Session sets copied from the real boxes.
CACHYOS = ["gamescope-session.desktop", "plasma.desktop"]          # 10.1.1.235
BAZZITE = ["gamescope-session.desktop", "gamescope-session-steam.desktop",
           "plasma.desktop", "plasma-steamos-wayland-oneshot.desktop",
           "plasma-steamos-oneshot.desktop"]                       # 10.1.1.60
STEAMOS = ["gamescope-session.desktop", "plasma.desktop", "plasmax11.desktop"]
# Bazzite publishes GNOME variants too, and they carry "bazzite" in os-release
# so the OLD gate said yes to them. Plasma is absent; the desktop cluster must
# NOT depend on it (see _desktop_session_installed).
BAZZITE_GNOME = ["gamescope-session.desktop", "gamescope-session-steam.desktop",
                 "gnome.desktop", "gnome-xorg.desktop"]
GAME_ONLY = ["gamescope-session.desktop"]   # a dedicated Game Mode box


def setup(sessions, tools=True, outputs=True, session="desktop"):
    """Point the probe at fixtures. Returns the temp dir so it can be removed."""
    d = session_dir(sessions)
    cs._SESSION_DIRS = (d,)
    cs.shutil.which = (lambda t: "/usr/bin/" + t) if tools else (lambda t: None)
    cs._connected_outputs = lambda: (
        [{"name": "eDP-1", "internal": True}] if outputs else [])
    cs._couchmode_session = lambda: session
    return d


def main():
    real_dirs = cs._SESSION_DIRS
    real_which = cs.shutil.which
    real_outputs = cs._connected_outputs
    real_session = cs._couchmode_session
    dirs = []
    try:
        print("the box that reported the bug, and the fleet that already worked")
        for label, sessions in (("cachyos deckify", CACHYOS),
                                ("bazzite", BAZZITE),
                                ("steamos", STEAMOS)):
            dirs.append(setup(sessions))
            check("%-16s offers Couch Mode" % label,
                  cs.couchmode_available(), True)
            check("%-16s offers the desktop cluster (in the desktop)" % label,
                  cs.desktop_available(), True)

        print()
        print("...and it is the SESSIONS that decide, not the distro name")
        # The old gate read /etc/os-release. Nothing here does, so a box that
        # calls itself steamos but ships no session machinery is refused, and
        # the fixtures above pass with no os-release involvement at all. If the
        # distro string ever creeps back, one of these two fails.
        dirs.append(setup([], tools=False))
        check("no session tooling -> refused", cs.couchmode_available(), False)
        dirs.append(setup(["plasma.desktop"]))
        check("desktop session but NO gamescope-session -> refused",
              cs.couchmode_available(), False)
        dirs.append(setup(["gamescope-session.desktop"]))
        check("gamescope-session but NO desktop session -> refused",
              cs.couchmode_available(), False)
        dirs.append(setup(["kiosk.desktop", "sway.desktop"]))
        check("neither target installed -> refused",
              cs.couchmode_available(), False)

        print()
        print("the other two gates still hold (they were never the bug)")
        dirs.append(setup(CACHYOS, tools=False))
        check("tools missing -> refused", cs.couchmode_available(), False)
        dirs.append(setup(CACHYOS, outputs=False))
        check("headless (no connected output) -> refused",
              cs.couchmode_available(), False)
        dirs.append(setup(CACHYOS, session="gamescope"))
        check("desktop cluster hides once you are IN Game Mode",
              cs.desktop_available(), False)
        check("...while Couch Mode itself stays offered (Back to Desktop)",
              cs.couchmode_available(), True)

        print()
        print("the desktop cluster is DE-agnostic and has its OWN gate")
        # It rides a different predicate than Couch Mode on purpose. Sharing
        # couchmode's would have taken the trackpad toggle, the nav cluster and
        # the file-drop reveal away from Bazzite's GNOME images, which the OLD
        # distro-string gate happily allowed — a regression hidden inside a fix.
        dirs.append(setup(BAZZITE_GNOME))
        check("bazzite GNOME keeps the desktop cluster",
              cs.desktop_available(), True)
        check("...even though it has no Plasma session at all",
              any(n.startswith("plasma") for n in cs._installed_session_files()),
              False)
        check("...and Couch Mode is a separate question there",
              cs.couchmode_available(), False)
        dirs.append(setup(GAME_ONLY))
        check("a Game-Mode-only box has no desktop to drive",
              cs.desktop_available(), False)

        print()
        print("unreadable session dirs are UNKNOWN, not ABSENT")
        # _installed_session_files() returns an empty set both when a box has no
        # sessions and when the dirs cannot be read — the same ambiguity
        # _dm_write handles by only refusing on a POSITIVE miss. Refusing here
        # instead would hide a working handheld's Couch button over an
        # unreadable directory, and the tool requirement is the real gate.
        cs._SESSION_DIRS = ("/nonexistent-couchside-test",)
        cs.shutil.which = lambda t: "/usr/bin/" + t
        cs._connected_outputs = lambda: [{"name": "eDP-1", "internal": True}]
        check("cannot enumerate + tools present -> still offered",
              cs.couchmode_available(), True)
        cs.shutil.which = lambda t: None
        check("...but cannot enumerate + no tools -> refused (control)",
              cs.couchmode_available(), False)
        # The desktop cluster takes the OPPOSITE default, because it has no
        # second gate: no session dirs at all is a headless box (HTPC, Proxmox
        # guest, "any systemd machine"), where the whole cluster would be dead
        # controls. Both stub states are checked so this cannot pass by
        # accident of the tool lambda above.
        cs._couchmode_session = lambda: "desktop"
        check("headless (no session dirs) -> desktop cluster HIDDEN",
              cs.desktop_available(), False)
        cs.shutil.which = lambda t: "/usr/bin/" + t
        check("...still hidden with every tool present (no second gate here)",
              cs.desktop_available(), False)

        print()
        print("guide-hold rides the same gate")
        # It is the reason relaxing this matters twice: the hold-to-couch
        # trigger was invisible on CachyOS for the same reason the button was.
        dirs.append(setup(CACHYOS))
        real_access = cs.os.access
        try:
            cs.os.access = lambda *a, **k: True
            check("capable box -> guide hold offered",
                  cs.guide_hold_available(), True)
            dirs.append(setup(["plasma.desktop"]))
            check("box with no Game Mode target -> guide hold refused",
                  cs.guide_hold_available(), False)
        finally:
            cs.os.access = real_access
    finally:
        cs._SESSION_DIRS = real_dirs
        cs.shutil.which = real_which
        cs._connected_outputs = real_outputs
        cs._couchmode_session = real_session
        import shutil as _sh
        for d in dirs:
            _sh.rmtree(d, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all couch-mode gate tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
