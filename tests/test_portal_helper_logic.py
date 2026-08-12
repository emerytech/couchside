#!/usr/bin/env python3
"""Pure-logic tests for two fixes in the remote-desktop portal helper
(agent/couchside-portal.py), the concurrency-sensitive stream path.

Run: python3 tests/test_portal_helper_logic.py

The helper binds Gio at IMPORT (module-level `_con = Gio.bus_get_sync(...)`), so
it can't be imported in CI as-is. This shims a minimal fake `gi` so the module
loads, then tests the two fixes WITHOUT any real portal / gst / D-Bus:

  1. verb_status() is NON-BLOCKING. `_ensure_session` holds `_SLOCK` for its whole
     run — including the Start call that blocks on the user's consent (up to
     _CONSENT_TIMEOUT_S). The agent probes status on a ~2s budget to fill
     caps.screenstream[_h264]; the old `with _SLOCK: sess = _SESSION` made that
     probe DEADLOCK behind a pending consent, so caps read False and the app never
     offered the fluid tiers. status must return immediately even while _SLOCK is
     held elsewhere.

  2. stream() PREEMPTS on a codec switch instead of refusing. When the app moves
     MJPEG->H.264 (box just gained a VA encoder), a leftover MJPEG encoder used to
     make the helper REFUSE -> the /ws/h264 socket closed -> the app demoted back
     to MJPEG. Now it terminates + waits for the old encoder, then spawns the new
     one (last-opener wins across codecs).
"""
import os
import sys
import threading
import time
import types

# --- shim a minimal `gi` so couchside-portal.py imports without a real bus -----
_fake_gi = types.ModuleType("gi")
_fake_gi.require_version = lambda *a, **k: None


class _FakeConn:
    def get_unique_name(self):
        return ":1.999"

    def call_sync(self, *a, **k):
        return None


class _Gio:
    class BusType:
        SESSION = 0

    class DBusCallFlags:
        NONE = 0

    class DBusSignalFlags:
        NONE = 0

    class VariantType:
        @staticmethod
        def new(*a, **k):
            return None

    @staticmethod
    def bus_get_sync(*a, **k):
        return _FakeConn()


class _GLib:
    @staticmethod
    def Variant(*a, **k):
        return None

    class VariantType:
        @staticmethod
        def new(*a, **k):
            return None


_repo = types.ModuleType("gi.repository")
_repo.Gio = _Gio
_repo.GLib = _GLib
_fake_gi.repository = _repo
sys.modules["gi"] = _fake_gi
sys.modules["gi.repository"] = _repo

import importlib.util  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "cs_portal", os.path.join(ROOT, "agent", "couchside-portal.py"))
ph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ph)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --- 1. verb_status() is non-blocking while _SLOCK is held --------------------
print("1. verb_status() does not block on _SLOCK (the consent-deadlock fix)")
holding = threading.Event()
release = threading.Event()


def _hold_slock():
    with ph._SLOCK:            # mimic _ensure_session holding the lock over consent
        holding.set()
        release.wait(5)


t = threading.Thread(target=_hold_slock, daemon=True)
t.start()
holding.wait(2)                # ensure the lock is held before we probe
t0 = time.time()
res = ph.verb_status()
elapsed = time.time() - t0
release.set()
t.join(2)
check("status returned while _SLOCK held", isinstance(res, dict) and res.get("ok"), True)
check("status did NOT block (< 0.5s)", elapsed < 0.5, True)
check("status reports session False (none open)", res.get("session"), False)


# --- 2. stream() preempts a different-codec encoder ---------------------------
print()
print("2. stream() preempts on a codec switch (MJPEG encoder -> H.264 request)")


class _FakeProc:
    def __init__(self):
        self.terminated = False
        self.waited = False

    def poll(self):
        return None            # still running

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.waited = True
        return 0


class _FakeConnSock:
    def __init__(self):
        self.closed = False

    def settimeout(self, _t):
        pass

    def close(self):
        self.closed = True


old_proc = _FakeProc()
old_sub = _FakeConnSock()
old_done = threading.Event()
# A live MJPEG encoder is running for this session.
ph._STREAM.update(proc=old_proc, profile="720p20", codec="mjpeg",
                  sub=old_sub, done=old_done, idle_since=None)

spawned = {}
new_proc = _FakeProc()


def _fake_spawn(profile, codec):
    spawned["profile"] = profile
    spawned["codec"] = codec
    ph._STREAM.update(proc=new_proc, profile=profile, codec=codec)
    return new_proc


saved_ensure = ph._ensure_session
saved_spawn = ph._spawn_encoder
ph._ensure_session = lambda: {"node": 7, "w": 1280, "h": 720}
ph._spawn_encoder = _fake_spawn

new_conn = _FakeConnSock()


def _run_stream():
    ph.stream("720p60", new_conn, "h264")            # blocks on done.wait()


try:
    st = threading.Thread(target=_run_stream, daemon=True)
    st.start()
    # Wait until the H.264 subscriber is installed, then release the blocking wait.
    for _ in range(200):
        if ph._STREAM.get("sub") is new_conn:
            break
        time.sleep(0.01)
    done_evt = ph._STREAM.get("done")
    if isinstance(done_evt, threading.Event):
        done_evt.set()                               # unblock stream()'s done.wait()
    st.join(2)

    check("old MJPEG encoder was terminated", old_proc.terminated, True)
    check("old encoder was waited on (fully reaped)", old_proc.waited, True)
    check("old subscriber was kicked", old_sub.closed, True)
    check("a new encoder was spawned", spawned.get("codec"), "h264")
    check("new encoder used the requested profile", spawned.get("profile"), "720p60")
    check("new H.264 conn is the current subscriber", ph._STREAM.get("sub") is new_conn, True)
    check("codec is now h264", ph._STREAM.get("codec"), "h264")
finally:
    ph._ensure_session = saved_ensure
    ph._spawn_encoder = saved_spawn
    ph._STREAM.update(proc=None, profile=None, codec=None, sub=None, done=None,
                      idle_since=None)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all portal-helper-logic tests passed")
