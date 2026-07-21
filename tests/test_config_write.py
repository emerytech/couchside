#!/usr/bin/env python3
"""Tests that config saves land NEXT TO the config, not in the process CWD.

Run: python3 tests/test_config_write.py

Regression guard for the Steam Deck pairing bug. Pairing a Google TV on a Deck
returned:

    HTTP 500: could not persist config:
    [Errno 30] Read-only file system: '/.couchside-config-il0oed3c'

The atomic save built its temp file with

    directory = os.path.dirname(CONFIG_PATH) or "."

and tempfile.mkstemp returns an ABSOLUTE path, so `"."` resolved against the
process CWD -- which for a systemd service is "/". A CONFIG_PATH with no
directory part therefore wrote to the ROOT filesystem, which on SteamOS is
read-only. The errno named a temp file the user had never seen and gave them
nothing to act on.

Reproducing it does NOT need a read-only root: the defect is that the write
follows the CWD instead of the config. So the test chdir's somewhere else and
asserts nothing is created there. Pre-fix that directory receives the file;
post-fix it stays empty.

Pure stdlib, no pytest.
"""
import importlib.util
import json
import os
import shutil
import stat
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# BOTH agents, because both shipped the same defect. couchsided-win.py's Win32
# bits are lazy ctypes, so it imports and runs here on Linux CI.
AGENTS = [("linux", _load("couchsided", "agent/couchsided.py")),
          ("windows", _load("couchsided_win", "agent/win/couchsided-win.py"))]

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []
_agent = ""


def check(cond, label):
    label = "[%s] %s" % (_agent, label)
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


MINIMAL = {"units": [{"name": "couchside", "scope": "user"}], "actions": {}}


def _seed(directory, name="config.json"):
    path = os.path.join(directory, name)
    with open(path, "w") as f:
        json.dump(MINIMAL, f)
    return path


def _save(cm, field, value):
    with cm.CONFIG_LOCK:
        cm._config_set_field(field, value)


def test_relative_path_does_not_follow_cwd(cm):
    """The bug itself: a bare config name + a different CWD."""
    print("a relative --config writes beside the config, not into the CWD")
    home = tempfile.mkdtemp(prefix="cfg-home-")
    elsewhere = tempfile.mkdtemp(prefix="cfg-cwd-")  # stands in for "/"
    prev = os.getcwd()
    try:
        _seed(home)
        os.chdir(home)
        cm.load_config("config.json")  # bare name -- no directory part
        check(os.path.isabs(cm.CONFIG_PATH), "CONFIG_PATH resolved to absolute")
        check(os.path.dirname(cm.CONFIG_PATH) == os.path.realpath(home),
              "and points at the config's real directory")

        os.chdir(elsewhere)  # systemd would have us at "/"
        _save(cm, "tv_active", "webos")

        strays = os.listdir(elsewhere)
        check(strays == [], "nothing written into the CWD (was: %r)" % strays)
        with open(os.path.join(home, "config.json")) as f:
            check(json.load(f).get("tv_active") == "webos",
                  "the real config actually received the save")
    finally:
        os.chdir(prev)
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(elsewhere, ignore_errors=True)


def test_unwritable_dir_is_actionable(cm):
    """A read-only/foreign-owned config dir must explain itself."""
    print("an unwritable config dir raises something a user can act on")
    if os.getuid() == 0:
        print("  SKIP  running as root -- W_OK is not enforced")
        return
    directory = tempfile.mkdtemp(prefix="cfg-ro-")
    try:
        path = _seed(directory)
        cm.load_config(path)
        os.chmod(directory, stat.S_IRUSR | stat.S_IXUSR)  # r-x, no write
        raised = None
        try:
            _save(cm, "tv_active", "webos")
        except Exception as e:
            raised = e
        check(isinstance(raised, cm.ConfigError),
              "raises ConfigError (handled by both the pairing and launcher routes)")
        msg = str(raised or "")
        check(directory in msg, "message names the offending directory")
        check(path in msg, "message names the config it could not save")
        check("Errno" not in msg,
              "message is a sentence, not a bare errno on a temp file")
    finally:
        os.chmod(directory, stat.S_IRWXU)
        shutil.rmtree(directory, ignore_errors=True)


def test_writable_dir_still_saves(cm):
    """CONTROL. A plain writable config must round-trip.

    Without this, an implementation that raised unconditionally would pass every
    other test in this file."""
    print("control: a normal writable config saves and round-trips")
    directory = tempfile.mkdtemp(prefix="cfg-ok-")
    try:
        path = _seed(directory)
        cm.load_config(path)
        _save(cm, "tv_active", "samsung")
        with open(path) as f:
            saved = json.load(f)
        check(saved.get("tv_active") == "samsung", "field persisted")
        check(saved.get("units") == MINIMAL["units"],
              "and the rest of the config survived the rewrite")
        leftovers = [n for n in os.listdir(directory)
                     if n.startswith(".couchside-config-")]
        check(leftovers == [], "no temp file left behind (was: %r)" % leftovers)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    for _agent, _mod in AGENTS:
        print("=== %s agent ===" % _agent)
        test_relative_path_does_not_follow_cwd(_mod)
        test_unwritable_dir_is_actionable(_mod)
        test_writable_dir_still_saves(_mod)
        print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all config-write tests passed")
