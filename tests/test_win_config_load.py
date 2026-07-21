#!/usr/bin/env python3
"""Tests that a REALISTIC config actually loads on the WINDOWS agent.

Run: python3 tests/test_win_config_load.py

Same guard as tests/test_config_load.py, for agent/win/couchsided-win.py:
_parse_config() returns a POSITIONAL tuple that load_config() unpacks, so a new
optional section (webos/samsung/vidaa/lg_commercial/tv_active) must be threaded
through BOTH ends. Miss either and the config parses fine and the assignment
explodes with NameError -- which crash-loops the agent on startup and is invisible
to py_compile, to a bare import (load_config is never reached), and to an EMPTY
config (invalid input takes the defaults path and returns before the unpack).

Only a config with real content exercises it. couchsided-win.py's Win32 bits are
lazy ctypes, so it imports and this runs on Linux CI.

Pure stdlib, no pytest.
"""
import importlib.util
import json
import os
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "win", "couchsided-win.py")
spec = importlib.util.spec_from_file_location("couchsided_win", AGENT)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


FULL = {
    "units": [{"name": "couchside", "scope": "user"}],
    "actions": {},
    "webos": {"host": "10.0.0.5", "client_key": "abc", "mac": "aa:bb:cc:dd:ee:ff"},
    "samsung": {"host": "10.0.0.6", "token": "tok"},
    "vidaa": {"host": "10.0.0.9", "name": "Hisense"},
    "roku": {"host": "10.0.0.7", "name": "Den Roku"},
    "lg_commercial": {"host": "10.0.0.10", "name": "Lobby panel"},
    "tv_active": "webos",
}


def _load(cfg):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    try:
        cw.load_config(path)
    finally:
        os.unlink(path)


def test_full_loads():
    print("a config with every new TV section")
    _load(FULL)  # raises here if the tuple / unpack disagree
    check(cw.CONFIG_WEBOS and cw.CONFIG_WEBOS["host"] == "10.0.0.5", "webos loaded")
    check(cw.CONFIG_SAMSUNG and cw.CONFIG_SAMSUNG["host"] == "10.0.0.6", "samsung loaded")
    check(cw.CONFIG_VIDAA and cw.CONFIG_VIDAA["host"] == "10.0.0.9", "vidaa loaded")
    check(cw.CONFIG_ROKU and cw.CONFIG_ROKU["host"] == "10.0.0.7", "roku loaded")
    check(cw.CONFIG_LGCOM and cw.CONFIG_LGCOM["host"] == "10.0.0.10",
          "lg_commercial loaded (the section whose unpack is easiest to miss)")
    check(cw.CONFIG_TV_ACTIVE == "webos", "tv_active loaded")


def test_absent_are_none():
    print("a minimal config leaves the new sections unset")
    _load({"units": [{"name": "couchside", "scope": "user"}], "actions": {}})
    for name in ("CONFIG_WEBOS", "CONFIG_SAMSUNG", "CONFIG_VIDAA", "CONFIG_LGCOM"):
        check(getattr(cw, name) is None, "%s is None when absent" % name)
    check(cw.CONFIG_TV_ACTIVE is None, "tv_active None when absent")


def test_malformed_rejected():
    print("a malformed section is refused, not half-applied")
    for bad, why in (({"webos": "nope"}, "webos not an object"),
                     ({"lg_commercial": {}}, "lg_commercial no host"),
                     ({"samsung": {"host": ""}}, "samsung empty host"),
                     ({"vidaa": {"host": "x", "name": 5}}, "vidaa.name not a string")):
        cfg = dict(FULL)
        cfg.update(bad)
        raised = False
        try:
            cw._parse_config(cfg)
        except Exception:
            raised = True
        check(raised, "%s -> ConfigError" % why)


if __name__ == "__main__":
    test_full_loads()
    test_absent_are_none()
    test_malformed_rejected()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all win-config-load tests passed")
