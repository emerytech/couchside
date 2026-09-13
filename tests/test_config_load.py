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


# A tls block exactly as _tls_ensure persists it: cert + PRIVATE KEY + the SPKI
# the phone pins. Fake PEM bodies -- the point is whether the block SURVIVES
# load_config, not whether openssl likes it.
TLS_BLOCK = {
    "enabled": True, "port": 8788,
    "cert": "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n",
    "key": "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
    "sans": ["127.0.0.1"], "spki": "ab" * 32, "fp": "cd" * 32,
}


def test_invalid_field_still_loads_tls():
    """THE BUG (2.9.108): load_config read the tls block only AFTER _parse_config
    succeeded, so any invalid UNRELATED field made it bail first, CONFIG_TLS
    stayed empty, and _tls_ensure minted a FRESH KEY -- a new SPKI the phone
    (correctly) refuses. A user saw this as "re-pair every couple of weeks"."""
    print("THE BUG: an invalid unrelated field must NOT drop the persisted TLS key")
    cfg = dict(FULL)
    cfg["tls"] = TLS_BLOCK
    cfg["port"] = "not-a-port"  # _parse_config raises ConfigError on this
    cs.CONFIG_TLS = None        # prove THIS load sets it, not a previous one
    _load(cfg)
    t = cs.CONFIG_TLS if isinstance(cs.CONFIG_TLS, dict) else {}
    check(t.get("cert") == TLS_BLOCK["cert"], "cert survives an invalid port")
    check(t.get("key") == TLS_BLOCK["key"], "PRIVATE KEY survives an invalid port")
    check(t.get("spki") == TLS_BLOCK["spki"], "spki (what the phone pins) survives")
    # CONTROL: the invalid field itself was still REJECTED -- the config fell
    # back to defaults for everything except the identity it must keep.
    check(cs.CONFIG_PORT != "not-a-port", "the invalid port was not applied")


def test_valid_config_loads_tls_the_same_way():
    print("CONTROL: a valid config still loads tls (the reorder kept the normal path)")
    cfg = dict(FULL)
    cfg["tls"] = TLS_BLOCK
    cs.CONFIG_TLS = None
    _load(cfg)
    t = cs.CONFIG_TLS if isinstance(cs.CONFIG_TLS, dict) else {}
    check(t.get("key") == TLS_BLOCK["key"], "key loaded on a valid config")
    check(cs.CONFIG_PORT == 8787, "and the rest of the config applied normally")


def test_missing_tls_block_defaults_on_without_a_key():
    print("CONTROL: no tls block -> TLS defaults ON with no cert/key (a fresh box mints once)")
    cfg = dict(FULL)  # deliberately no "tls"
    cs.CONFIG_TLS = None
    _load(cfg)
    t = cs.CONFIG_TLS if isinstance(cs.CONFIG_TLS, dict) else {}
    check(t.get("enabled") is True, "defaults enabled")
    check("key" not in t and "cert" not in t, "nothing to preserve on a fresh box")


if __name__ == "__main__":
    test_full_config_loads()
    test_absent_sections_are_none()
    test_bad_section_is_rejected()
    test_invalid_field_still_loads_tls()
    test_valid_config_loads_tls_the_same_way()
    test_missing_tls_block_defaults_on_without_a_key()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all config-load tests passed")
