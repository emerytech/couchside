#!/usr/bin/env python3
"""Holds all THREE protocol implementations against protocol/protocol.json.

Run: python3 tests/test_protocol_parity.py

Why this exists: the Linux agent, the Windows agent, and the app each carry
their own copy of the wire vocabulary, and "added to one end, not the other" is
this repo's most repeated defect. A config section reached _parse_config but not
load_config's unpack and crash-looped a live box with a NameError; the smart-TV
backends existed on Linux for weeks before Windows. Both were invisible to
py_compile, to a bare import, and to every existing test.

HOW IT CHECKS -- deliberately not by comparing symbol names. The agents' internal
tables legitimately differ: Linux drives uinput (BTN_CODES/DPAD_MAP), Windows
drives ViGEm (XUSB_BTN_BITS). Comparing table names would fail forever for no
reason. Instead it drives the REAL decode entry points -- gamepad_events() and
mouse_events(), which both agents expose with the same contract (raise
ValueError on anything unknown) -- and asserts behaviour.

The app has no test runner, so its side is read out of the literal string unions
in app/lib/gamepad.ts. They are plain `'a' | 'b' | ...` unions, so a lexical
read is exact.

BOTH DIRECTIONS, always. An implementation must accept everything the spec
declares AND nothing it doesn't. A one-directional check is precisely how the
drift got in.

Pure stdlib, no pytest. Both agents' platform-specific bits are lazy, so they
import and run on Linux CI.
"""
import importlib.util
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SPEC = json.load(open(os.path.join(ROOT, "protocol", "protocol.json")))
AGENTS = {
    "linux": _load("couchsided", "agent/couchsided.py"),
    "windows": _load("couchsided_win", "agent/win/couchsided-win.py"),
}


def group(name):
    g = SPEC[name]
    return g["keys"], g["platforms"]


# ---- the agents: drive the real decoders -----------------------------------

def _accepts(mod, fn_name, msg):
    """True when this agent's REAL decoder accepts the frame.

    Unknown keys raise ValueError by contract. Anything else propagates: a
    TypeError or AttributeError means the decoder is broken, not that the key is
    unsupported, and silently swallowing that would make this test lie."""
    fn = getattr(mod, fn_name, None)
    if fn is None:
        return False
    try:
        fn(msg)
        return True
    except ValueError:
        return False


FRAMES = {
    "buttons": ("gamepad_events", lambda k: {"t": "b", "k": k, "v": 1}),
    "triggers": ("gamepad_events", lambda k: {"t": "t", "k": k, "v": 10}),
    "sticks": ("gamepad_events", lambda k: {"t": "s", "k": k, "x": 0, "y": 0}),
    "mouseButtons": ("mouse_events", lambda k: {"t": "mb", "k": k, "v": 1}),
}


def test_agent_decoders():
    print("agents accept every key the spec declares for their platform")
    for gname, (fn_name, mk) in FRAMES.items():
        keys, platforms = group(gname)
        for plat, mod in AGENTS.items():
            if plat not in platforms:
                continue
            missing = [k for k in keys if not _accepts(mod, fn_name, mk(k))]
            check(not missing, "%s: %s accepts all %d (missing: %s)"
                  % (plat, gname, len(keys), missing or "none"))


def test_agents_reject_unknown():
    """CONTROL. Without this, a decoder that accepted EVERYTHING would pass
    every assertion above."""
    print("control: a bogus key is rejected, so 'accepts' means something")
    for gname, (fn_name, mk) in FRAMES.items():
        for plat, mod in AGENTS.items():
            if plat not in group(gname)[1]:
                continue
            check(not _accepts(mod, fn_name, mk("__nope__")),
                  "%s: %s rejects an unknown key" % (plat, gname))


def test_platform_scoped_keys():
    """Platform-scoped vocabulary must be present where declared and ABSENT
    elsewhere. Asserting the absence is the point: it stops a half-finished port
    from looking complete, and records that the gap is a decision."""
    print("platform-scoped keys exist only where they are declared")
    for gname in ("desktopKeys", "chords"):
        keys, platforms = group(gname)
        for plat, mod in AGENTS.items():
            table = _key_vocabulary(mod, gname)
            if plat in platforms:
                missing = [k for k in keys if k not in table]
                check(not missing, "%s: %s present (missing: %s)"
                      % (plat, gname, missing or "none"))
            else:
                leaked = [k for k in keys if k in table]
                check(not leaked, "%s: %s correctly absent (leaked: %s)"
                      % (plat, gname, leaked or "none"))


def _key_vocabulary(mod, gname):
    """The named-key vocabulary an agent actually implements.

    desktopKeys span TWO tables on Linux and that is correct, not sloppy: 'meta'
    is a single keypress (SPECIAL_KEYS) while 'overview' is a CHORD -- Meta+W
    for the KWin overview effect -- so it lives in DESKTOP_CHORDS. The first
    version of this probe only read SPECIAL_KEYS and reported 'overview' as
    missing. The probe was wrong, not the agent. Union both."""
    if gname == "chords":
        return set(getattr(mod, "KEY_CHORDS", {}) or {})
    return (set(getattr(mod, "SPECIAL_KEYS", {}) or {})
            | set(getattr(mod, "DESKTOP_CHORDS", {}) or {}))


def test_special_keys_both_agents():
    print("named keys on the {t:'k'} channel agree across both agents")
    keys, _ = group("specialKeys")
    for plat, mod in AGENTS.items():
        have = set(getattr(mod, "SPECIAL_KEYS", {}) or {})
        missing = [k for k in keys if k not in have]
        check(not missing, "%s: all %d special keys (missing: %s)"
              % (plat, len(keys), missing or "none"))
        # Reverse direction: an agent must not accept vocabulary the spec has
        # never heard of -- that is an undocumented wire feature.
        allowed = set(keys) | set(group("desktopKeys")[0])
        extra = sorted(have - allowed)
        check(not extra, "%s: no undeclared special keys (extra: %s)"
              % (plat, extra or "none"))


# ---- the app: read the literal unions out of TypeScript ---------------------

APP_SRC = open(os.path.join(ROOT, "app", "lib", "gamepad.ts")).read()


def _ts_union(name):
    """Members of `export type <name> = 'a' | 'b' | ...;`. Exact for literal
    unions, which is all of these are."""
    m = re.search(r"export type %s\s*=\s*(.*?);" % re.escape(name), APP_SRC, re.S)
    if not m:
        return None
    return set(re.findall(r"'([^']+)'", m.group(1)))


APP_UNIONS = {
    "buttons": "ButtonKey",
    "triggers": "TriggerKey",
    "sticks": "StickKey",
    "chords": "SystemChord",
    "desktopKeys": "DesktopKey",
}


def test_app_matches_spec():
    print("the app's TypeScript unions match the spec exactly")
    for gname, ts in APP_UNIONS.items():
        want = set(group(gname)[0])
        got = _ts_union(ts)
        if got is None:
            check(False, "app: type %s not found in gamepad.ts" % ts)
            continue
        check(got == want, "app: %s == spec.%s (missing %s, extra %s)"
              % (ts, gname, sorted(want - got) or "none", sorted(got - want) or "none"))


def test_spec_is_well_formed():
    """CONTROL. A spec with an empty group would make the checks above vacuous."""
    print("control: the spec itself is non-empty and platform-tagged")
    for gname, g in SPEC.items():
        if gname.startswith("_"):
            continue
        check(bool(g.get("keys")), "spec.%s has keys" % gname)
        check(bool(g.get("platforms")), "spec.%s declares platforms" % gname)


if __name__ == "__main__":
    test_spec_is_well_formed()
    test_agent_decoders()
    test_agents_reject_unknown()
    test_special_keys_both_agents()
    test_platform_scoped_keys()
    test_app_matches_spec()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all protocol-parity tests passed")
