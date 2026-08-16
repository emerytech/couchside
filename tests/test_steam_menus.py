#!/usr/bin/env python3
"""Tests for the Steam settings deep links (GET/POST /api/steam/menus).

Run: python3 tests/test_steam_menus.py

The important property here is not "does the code run" — it is that the slug
list stays HONEST. Every entry was confirmed on hardware by firing the URL at a
real box and screen-capturing where it landed, because the list cannot be
derived any other way: Steam builds the settings route from the panel name, so
the slugs are not string literals in its JS bundle. Grepping finds none of them,
including "bluetooth", which is proven to work.

The failure mode this guards is quiet: an unknown slug is NOT an error. Steam
opens Settings on its DEFAULT page instead. So a wrong entry ships as a button
that works and goes to the wrong place, which is worse than a missing one — the
regression test below therefore asserts that slugs MEASURED ABSENT stay absent.

Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


# Fired at a real box and screen-captured: Steam fell back to its DEFAULT
# settings page for every one of these, i.e. they are NOT real panels. Some of
# the PANELS do exist in Steam's sidebar (Notifications, In Game, Remote Play) —
# these particular SLUGS just are not how you reach them.
MEASURED_ABSENT = frozenset({
    "internet", "ingame", "notifications", "notification", "alerts", "in-game",
    "overlay", "gameoverlay", "ingameoverlay", "interface", "broadcast",
    "remoteplay", "remote-play", "remoteplaysettings", "account", "voice",
    "music", "compatibility", "developer", "wifi", "connectivity",
    "steamnetwork", "general", "steamcloud", "streaming", "recording",
})


def test_payload_shape():
    print("menu payload")
    p = cs.steam_menus_payload()
    menus = p.get("menus")
    check(isinstance(menus, list) and menus, "returns a non-empty menus list")
    check(all(set(m) == {"id", "label"} for m in menus),
          "every entry is exactly {id,label}")
    check(all(m["id"] and m["label"] for m in menus),
          "no blank ids or labels (a blank label renders as a mystery button)")
    ids = [m["id"] for m in menus]
    check(len(ids) == len(set(ids)), "ids are unique")
    check(p == cs.steam_menus_payload(), "stable across calls")


def test_no_unverified_slugs():
    print("slug honesty (the regression that matters)")
    ids = {m["id"] for m in cs.steam_menus_payload()["menus"]}
    leaked = ids & MEASURED_ABSENT
    check(not leaked,
          "no slug that was MEASURED ABSENT has been re-added%s"
          % ("" if not leaked else " -- found %s" % sorted(leaked)))
    # "system" is real but indistinguishable from an invalid slug by screen
    # capture (it IS the default page), so it is deliberately not shipped.
    check("system" not in ids,
          "'system' stays out: unverifiable by the method used, not measured")


def test_allowlist_is_enforced():
    print("allowlist")
    calls = []
    orig = cs.subprocess.Popen
    cs.subprocess.Popen = lambda *a, **k: calls.append((a, k)) or _FakeProc()
    try:
        check(cs.open_steam_menu("nope-not-a-panel") is False,
              "unknown id refused")
        check(cs.open_steam_menu("") is False, "empty id refused")
        check(cs.open_steam_menu("../../etc/passwd") is False,
              "path-ish id refused")
        check(cs.open_steam_menu("bluetooth; rm -rf /") is False,
              "injection-shaped id refused")
        check(not calls, "nothing was launched for any refused id")

        check(cs.open_steam_menu("bluetooth") is True, "known id accepted")
        check(len(calls) == 1, "exactly one launch")
        argv = calls[0][0][0]
        check(argv == ["steam", "steam://open/settings/bluetooth"],
              "argv is a LIST (no shell), url built from the allowlisted id")
        check(calls[0][1].get("shell") in (None, False),
              "never shell=True")
    finally:
        cs.subprocess.Popen = orig


class _FakeProc:
    pid = 1234


def test_available_gate():
    print("caps gate")
    orig = cs._steam_root
    try:
        cs._steam_root = lambda: None
        check(cs.steammenus_available() is False, "no Steam -> unavailable")
        cs._steam_root = lambda: "/home/u/.local/share/Steam"
        check(cs.steammenus_available() is True, "Steam present -> available")
        cs._steam_root = lambda: (_ for _ in ()).throw(OSError("boom"))
        check(cs.steammenus_available() is False, "raising probe -> False, no raise")
    finally:
        cs._steam_root = orig


def test_caps_key_registered():
    """The caps key, asserted against the RUNTIME dict rather than the source.

    This test used to open with

        check("steammenus" in cs.CAPS or True, "caps dict is built at boot")

    `X or True` is unconditionally true, so it asserted nothing: it stayed green
    with CAPS empty, with set_caps() never called, and with the key deleted
    outright. The cause is visible one line up — CAPS is `{}` until set_caps()
    runs (agent/couchsided.py: CAPS is initialised empty and populated there),
    so the honest assertion failed and was neutered instead of fixed.

    The other two checks grepped AGENT's source text for the literal wiring,
    which §11.1 rules out ("test the thing; don't grep for it") — a rename of
    `safe` or a reflow of that dict would fail them while the behaviour was
    perfect, and, worse, they pass whenever the string exists even if the key
    never reaches CAPS. All three are now runtime assertions on both branches.
    """
    print("caps key")
    orig_caps = dict(cs.CAPS)
    orig_root = cs._steam_root
    try:
        # The mock tuple is the off-box contract the app develops against.
        cs.set_caps(mock=True)
        check(cs.CAPS.get("steammenus") is True,
              "mock caps advertise steammenus")
        # The real dict must COMPUTE the key from the probe, not hardcode it —
        # so assert both directions. A key wired to a constant passes the first
        # of these and fails the second.
        cs._steam_root = lambda: None
        cs.set_caps(mock=False)
        check(cs.CAPS.get("steammenus") is False,
              "real caps: no Steam -> steammenus False")
        cs._steam_root = lambda: "/home/u/.local/share/Steam"
        cs.set_caps(mock=False)
        check(cs.CAPS.get("steammenus") is True,
              "real caps: Steam present -> steammenus True")
    finally:
        cs._steam_root = orig_root
        cs.CAPS = orig_caps


if __name__ == "__main__":
    test_payload_shape()
    test_no_unverified_slugs()
    test_allowlist_is_enforced()
    test_available_gate()
    test_caps_key_registered()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all steam-menu tests passed")
