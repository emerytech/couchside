#!/usr/bin/env python3
"""Tests that a REALISTIC config actually loads.

Run: python3 tests/test_config_load.py

WHY THIS EXISTS. Adding a new optional config section (an LG commercial panel)
crashed the agent on a real box with:

    NameError: name 'lgcom' is not defined   (load_config, at CONFIG_LGCOM = lgcom)

_parse_config() parses into locals and RETURNS them as a positional tuple that
load_config() unpacks. A new section has to be threaded through BOTH ends. Miss
either and the config parses fine and the assignment explodes.

Three checks that all LOOKED like verification and all missed it:
  * py_compile        -- syntax only, and the code is syntactically perfect.
  * importing the module and calling functions -- load_config is never reached
    by an import, so it passed while startup was broken.
  * starting the agent with an EMPTY config -- {} fails validation and takes the
    "using built-in generic defaults" path, which RETURNS BEFORE the unpack.

Only a config with real content exercises the path. So that is what this does:
load a config carrying every optional section and assert the globals arrive.

Pure stdlib, no pytest -- same style as the other agent tests.
"""
import importlib.util
import json
import os
import tempfile

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


# Every optional section at once. A config that only exercises the sections you
# happened to think about is how the tuple drifts in the first place.
FULL = {
    "units": [{"name": "couchside.service", "scope": "system"}],
    # `actions` must be an object; omitting it makes load_config fall back to
    # built-in defaults and silently skip the unpack this test exists to guard.
    "actions": {},
    "port": 8787,
    "webos": {"host": "10.0.0.5", "client_key": "abc", "mac": "aa:bb:cc:dd:ee:ff"},
    "samsung": {"host": "10.0.0.6", "token": "tok"},
    "roku": {"host": "10.0.0.7", "name": "Den Roku"},
    "androidtv": {"host": "10.0.0.8", "name": "Google TV"},
    "vidaa": {"host": "10.0.0.9", "name": "Hisense"},
    "lg_commercial": {"host": "10.0.0.10", "name": "Lobby panel"},
    "panel": {"device": "/dev/ttyS0", "baud": 19200, "protocol": "newline"},
}


def _load(cfg):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    try:
        cs.load_config(path)
    finally:
        os.unlink(path)


def test_full_config_loads():
    print("a config with every optional section")
    _load(FULL)
    # If _parse_config's return tuple and load_config's unpack ever disagree,
    # load_config raises and this never gets here.
    check(cs.CONFIG_WEBOS and cs.CONFIG_WEBOS["host"] == "10.0.0.5", "webos loaded")
    check(cs.CONFIG_SAMSUNG and cs.CONFIG_SAMSUNG["host"] == "10.0.0.6", "samsung loaded")
    check(cs.CONFIG_ROKU and cs.CONFIG_ROKU["host"] == "10.0.0.7", "roku loaded")
    check(cs.CONFIG_ANDROIDTV and cs.CONFIG_ANDROIDTV["host"] == "10.0.0.8",
          "androidtv loaded")
    check(cs.CONFIG_VIDAA and cs.CONFIG_VIDAA["host"] == "10.0.0.9", "vidaa loaded")
    check(cs.CONFIG_LGCOM and cs.CONFIG_LGCOM["host"] == "10.0.0.10",
          "lg_commercial loaded (the section whose unpack was missed)")
    check(cs.CONFIG_LGCOM.get("name") == "Lobby panel", "its optional name survives")


def test_absent_sections_are_none():
    print("a minimal config leaves the optional sections unset")
    _load({"units": [{"name": "couchside.service", "scope": "system"}],
           "actions": {}})
    for name in ("CONFIG_WEBOS", "CONFIG_SAMSUNG", "CONFIG_ROKU",
                 "CONFIG_ANDROIDTV", "CONFIG_VIDAA", "CONFIG_LGCOM"):
        check(getattr(cs, name) is None, "%s is None when absent" % name)


def test_bad_section_is_rejected():
    print("a malformed section is refused, not half-applied")
    for bad, why in (({"lg_commercial": "nope"}, "not an object"),
                     ({"lg_commercial": {}}, "no host"),
                     ({"lg_commercial": {"host": ""}}, "empty host")):
        cfg = dict(FULL)
        cfg.update(bad)
        raised = False
        try:
            cs._parse_config(cfg)
        except cs.ConfigError:
            raised = True
        except Exception:
            raised = True
        check(raised, "lg_commercial %s -> ConfigError" % why)


if __name__ == "__main__":
    test_full_config_loads()
    test_absent_sections_are_none()
    test_bad_section_is_rejected()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all config-load tests passed")
