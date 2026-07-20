#!/usr/bin/env python3
"""Tests for the injected Actions (Bluetooth pairing, Restart Decky).

Run: python3 tests/test_actions_inject.py

Injected actions are the ones that do NOT come from config: the agent decides at
boot whether the box can actually perform them, and only then offers the button.
The rule they all follow is "a dead button costs more trust than a missing one",
so each gate is asserted in BOTH directions here — present when the box can do
it, absent when it cannot.

The Bluetooth action exists because pairing a controller is the one job you
cannot do with a controller. It deep-links to steam://open/settings/bluetooth,
which was VERIFIED on hardware by screen-capturing the box: the URL lands
directly on the Bluetooth panel with the scan running. Note the trap recorded
in the agent source — that URL is not a string literal in Steam's JS bundle
(the handler builds the route from the panel name), so grepping the bundle for
it finds nothing and proves nothing. An earlier pass grepped and wrongly
concluded no such deep link existed.

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


def _reset():
    """Fresh action tables, as at boot before any injection."""
    cs.ACTIONS = dict(cs.DEFAULT_ACTIONS)
    cs.ACTION_ORDER = list(cs.DEFAULT_ACTION_ORDER)


def test_bluetooth_gated_on_steam():
    print("bluetooth action: gated on Steam being installed")
    o_root, o_actions, o_order = cs._steam_root, cs.ACTIONS, cs.ACTION_ORDER
    try:
        # No Steam -> no button, rather than one that silently does nothing.
        _reset()
        cs._steam_root = lambda: None
        cs._inject_bluetooth_action(False)
        check("pair-controller" not in cs.ACTIONS,
              "no Steam -> action absent (no dead button)")
        check("pair-controller" not in cs.ACTION_ORDER,
              "absent from the order too")

        # Steam present -> offered.
        _reset()
        cs._steam_root = lambda: "/home/u/.local/share/Steam"
        cs._inject_bluetooth_action(False)
        check("pair-controller" in cs.ACTIONS, "Steam present -> action injected")
        check("pair-controller" in cs.ACTION_ORDER, "appended to the order")

        # --mock always offers it so the Actions tab is developable off-box.
        _reset()
        cs._steam_root = lambda: None
        cs._inject_bluetooth_action(True)
        check("pair-controller" in cs.ACTIONS, "--mock injects regardless of Steam")
    finally:
        cs._steam_root, cs.ACTIONS, cs.ACTION_ORDER = o_root, o_actions, o_order


def test_bluetooth_action_shape():
    print("bluetooth action: contract")
    o_root, o_actions, o_order = cs._steam_root, cs.ACTIONS, cs.ACTION_ORDER
    try:
        _reset()
        cs._steam_root = lambda: "/home/u/.local/share/Steam"
        cs._inject_bluetooth_action(False)
        a = cs.ACTIONS.get("pair-controller", {})
        check(a.get("cmd") == ["steam", "steam://open/settings/bluetooth"],
              "deep-links to the Bluetooth panel, not the Settings root")
        # medium renders as "CHANGES WHAT'S ON SCREEN" in the app, which is
        # honest: it navigates the TV away from whatever is showing.
        check(a.get("danger") == "medium", "danger=medium (interrupts the screen)")
        check(a.get("user_env") is True, "user_env -> gets DISPLAY/XDG_RUNTIME_DIR")
        check(a.get("detached") is True, "detached -> url handler hands off")
        check(a.get("label") and a.get("description"),
              "carries a label and description")
    finally:
        cs._steam_root, cs.ACTIONS, cs.ACTION_ORDER = o_root, o_actions, o_order


def test_injection_is_idempotent():
    print("injection is idempotent + config wins")
    o_root, o_actions, o_order = cs._steam_root, cs.ACTIONS, cs.ACTION_ORDER
    try:
        _reset()
        cs._steam_root = lambda: "/home/u/.local/share/Steam"
        cs._inject_bluetooth_action(False)
        cs._inject_bluetooth_action(False)
        cs._inject_bluetooth_action(False)
        check(cs.ACTION_ORDER.count("pair-controller") == 1,
              "repeated injection does not duplicate the order entry")

        # A config-defined action of the same id must not be clobbered.
        _reset()
        cs.ACTIONS["pair-controller"] = {"label": "mine", "cmd": ["true"],
                                         "danger": "low"}
        cs._inject_bluetooth_action(False)
        check(cs.ACTIONS["pair-controller"]["label"] == "mine",
              "a config-defined action of the same id wins")
    finally:
        cs._steam_root, cs.ACTIONS, cs.ACTION_ORDER = o_root, o_actions, o_order


def test_bluetooth_action_is_not_privileged():
    print("bluetooth action needs no sudo")
    check("sudo" not in cs.BLUETOOTH_PAIRING_ACTION["cmd"],
          "runs as the desktop user, no sudoers grant required")


if __name__ == "__main__":
    test_bluetooth_gated_on_steam()
    test_bluetooth_action_shape()
    test_injection_is_idempotent()
    test_bluetooth_action_is_not_privileged()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all action-injection tests passed")
