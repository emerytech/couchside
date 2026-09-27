#!/usr/bin/env python3
"""Tests for GAME AURA — POST /api/leds/aura (agent, cap `ledcontrol`).

Run: python3 tests/test_led_aura.py

Game Aura paints a STATIC per-LED palette across an addressable strip: the app
samples a game's cover into ONE colour per LED and posts the frame
{ strip: <prefix>, colors: [{r,g,b}, ...] }. It is a general N-colour frame (a
Phase-2 per-game aura library reuses the same route), so the test proves the two
properties that matter:

  ALLOWLIST (CLAUDE.md §3) — the strip PREFIX is LOOKED UP in the live strip set
  and 404s if unknown (never interpolated); `colors` is DATA that is REJECTED
  (never sanitised) unless it is a list of EXACTLY the strip's member count, each
  an {r,g,b} of ints 0-255. A wrong length / out-of-range channel / non-list /
  unknown strip paints NOTHING. The validated ints only ever reach the strip's own
  members through the fixed-literal multi_intensity/brightness writers.

  §6 for a new authed endpoint — happy path (200, observable in the mock `active`),
  auth failure (401), and unknown/oversized/out-of-range rejection (400/404).

Both the render path and the reject paths are observed (§11.2): a valid frame is
seen to reach the fixed-literal writers via _seq_render, AND a rejected one writes
nothing. Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import threading
import time
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []
TOKEN = "test-secret-token"


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


# ---- Fake /sys/class/leds: a 5-node valve-leds strip (RGB) + a mono status LED,
#      exactly like tests/test_led_strip.py, so apply_strip_aura's writes can be
#      captured and asserted against the fixed-literal-attr allowlist. -----------
_N = 5
_EFFECT_INDEX = "patrol breath factory normal off rainbow demo manual"


def _member(name):
    return {"name": name, "desc": name, "rgb": True, "notable": True,
            "writable": True, "max_brightness": 255,
            "index": ["red", "green", "blue"], "maxint": [255, 255, 255],
            "brightness": 0, "color": {"r": 0, "g": 0, "b": 0}}


_FAKE = {("valve-leds[%d]" % i): _member("valve-leds[%d]" % i) for i in range(_N)}
_FAKE["status:white"] = {"name": "status:white", "desc": "status:white",
    "rgb": False, "notable": True, "writable": True, "max_brightness": 100,
    "index": [], "maxint": [], "brightness": 0, "color": None}


def _install(writes):
    """Point the agent's LED I/O at the fake strip; capture every write. Also stubs
    the render thread + the persist file so a unit test neither spawns a daemon nor
    touches disk (same discipline as test_led_strip's circle test)."""
    saved = {k: getattr(cs, k) for k in
             ("_list_led_names", "_read_led_raw", "_led_realpath_ok",
              "_led_read_attr", "_led_write", "_seq_ensure_thread",
              "_led_state_save")}
    cs._list_led_names = lambda: list(_FAKE)
    cs._read_led_raw = lambda n: dict(_FAKE[n]) if n in _FAKE else None
    cs._led_realpath_ok = lambda n: True

    def _read_attr(name, attr):
        if attr == "effect_index":
            return _EFFECT_INDEX
        if attr == "trigger":
            return "[none]"
        return None
    cs._led_read_attr = _read_attr
    cs._led_write = lambda name, attr, value: writes.append((name, attr, value))
    cs._seq_ensure_thread = lambda: None          # don't spawn the render thread
    cs._led_state_save = lambda: None             # don't touch ~/.config
    with cs._SEQ_LOCK:
        cs._SEQ_ACTIVE.clear()
    with cs._FX_LOCK:
        cs._LED_PERSIST.clear()

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        with cs._FX_LOCK:
            cs._LED_PERSIST.clear()
    return restore


_STRIP_ATTRS = {"effect", "enabled", "delay", "brightness", "multi_intensity", "trigger"}
_MEMBERS = {"valve-leds[%d]" % i for i in range(_N)}


# ---------------------------------------------------------------------------
print("\n_validate_aura_colors — rejects, never sanitises")
# ---------------------------------------------------------------------------
f, e = cs._validate_aura_colors([{"r": 1, "g": 2, "b": 3}] * 3, 3)
check(e is None and f == [{"r": 1, "g": 2, "b": 3}] * 3, "3 valid triples for a 3-LED strip", (f, e))
f, e = cs._validate_aura_colors("nope", 3)
check(f is None and e == "colors must be a list", "a non-list is rejected", (f, e))
f, e = cs._validate_aura_colors([{"r": 1, "g": 2, "b": 3}], 3)
check(f is None and "exactly 3" in (e or ""), "wrong length is rejected", (f, e))
f, e = cs._validate_aura_colors([{"r": 1, "g": 2, "b": 3}] * 4, 3)
check(f is None and "exactly 3" in (e or ""), "too-long (oversized) is rejected", (f, e))
for bad in ({"r": 1, "g": 2, "b": 256}, {"r": -1, "g": 0, "b": 0},
            {"r": 1, "g": 2}, {"r": 1, "g": 2, "b": 3, "a": 4},
            {"r": 1, "g": 2, "b": True}, [1, 2, 3], 7):
    f, e = cs._validate_aura_colors([{"r": 0, "g": 0, "b": 0}, bad, {"r": 0, "g": 0, "b": 0}], 3)
    check(f is None and e == "each color must be {r,g,b} ints 0-255",
          "out-of-range / malformed element rejected: %r" % (bad,), (f, e))
# The returned frame is a COPY: mutating the caller's dicts can't reach the strip.
src = [{"r": 10, "g": 20, "b": 30}]
f, e = cs._validate_aura_colors(src, 1)
src[0]["r"] = 99
check(f[0]["r"] == 10, "validated frame is copied, not aliased to the request")


# ---------------------------------------------------------------------------
print("\napply_strip_aura — allowlist: unknown / bad prefix paints NOTHING")
# ---------------------------------------------------------------------------
writes = []
restore = _install(writes)
try:
    palette = [{"r": i * 40, "g": 0, "b": 255 - i * 40} for i in range(_N)]
    for bad in ("nope", "valve-leds[", "../x", "", None, 123, "status"):
        writes.clear()
        res = cs.apply_strip_aura(bad, palette)
        check(res is None, "refused prefix %r -> None (404)" % (bad,), res)
        check(not writes, "nothing written for prefix %r" % (bad,), writes)
        check(bad not in cs._SEQ_ACTIVE, "no seq spec registered for %r" % (bad,))
finally:
    restore()


# ---------------------------------------------------------------------------
print("\napply_strip_aura — a valid palette registers an `aura` strip effect")
# ---------------------------------------------------------------------------
writes = []
restore = _install(writes)
try:
    palette = [{"r": i * 40, "g": 10, "b": 255 - i * 40} for i in range(_N)]
    res = cs.apply_strip_aura("valve-leds", palette)
    check(res and res.get("ok") and res["active"]["effect"] == "aura",
          "valid palette accepted, active reports effect=aura", res)
    check(res["active"]["colors"] == palette, "active echoes the N colours", res)
    check("valve-leds" in cs._SEQ_ACTIVE, "a seq spec is registered for the strip")
    spec_ = cs._SEQ_ACTIVE.get("valve-leds", {})
    check(spec_.get("effect") == "aura" and spec_.get("frame") == palette,
          "spec carries effect=aura + the static frame", spec_)
    check(all((("valve-leds[%d]" % i), "effect", "manual") in writes for i in range(_N)),
          "every member flipped to manual so the paint sticks")
    check(cs._LED_PERSIST.get("strip:valve-leds", {}).get("effect") == "aura",
          "aura persisted so a reboot re-arms it")
    check(cs._LED_PERSIST.get("strip:valve-leds", {}).get("colors") == palette,
          "persist keeps the colours (for restore)")
    # It is a strip effect, so GET /api/leds `active` reflects it (not filtered as static).
    check("strip:valve-leds" in cs._led_active_map(), "aura shows up in the active map")
    # _seq_compute_frame is time-independent for aura: same frame at any t.
    fr0 = cs._seq_compute_frame(spec_, spec_["t0"])
    fr1 = cs._seq_compute_frame(spec_, spec_["t0"] + 12.5)
    check(fr0 == palette and fr1 == palette, "compute_frame returns the static frame at any time")
finally:
    restore()


# ---------------------------------------------------------------------------
print("\n_seq_render — the aura frame reaches the FIXED-literal writers only")
# ---------------------------------------------------------------------------
writes = []
restore = _install(writes)
try:
    palette = [{"r": 200, "g": 0, "b": 0}, {"r": 0, "g": 0, "b": 0},
               {"r": 0, "g": 150, "b": 0}, {"r": 0, "g": 0, "b": 180},
               {"r": 0, "g": 0, "b": 0}]
    cs.apply_strip_aura("valve-leds", palette)
    writes.clear()
    cs._seq_render(cs._SEQ_ACTIVE["valve-leds"], time.monotonic())
    check(writes, "the render thread paints the aura frame")
    check(all(w[0] in _MEMBERS for w in writes), "only strip members are written", writes)
    check(all(w[1] in _STRIP_ATTRS for w in writes), "only fixed-literal attrs are written", writes)
    # Lit cells get a colour; a black cell is written brightness 0 (dark), not skipped
    # into an arbitrary attr.
    painted = {w[0] for w in writes if w[1] == "multi_intensity"}
    check(painted == _MEMBERS, "every member gets a multi_intensity write (whole frame)", painted)
    # A {0,0,0} cell is a valid RGB triple, so it is painted multi_intensity "0 0 0"
    # (dark) via the same fixed-literal writer -- not skipped, not routed anywhere else.
    black = [w for w in writes if w[0] == "valve-leds[1]" and w[1] == "multi_intensity"]
    check(black and black[0][2].split() == ["0", "0", "0"],
          "a black cell is painted multi_intensity 0 0 0 (dark), via the fixed writer", black)
finally:
    restore()


# ===========================================================================
# HTTP endpoint — auth + shape + reject, on the MOCK server (observable active)
# ===========================================================================
def _server(mock):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _post(port, path, obj, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    conn.request("POST", path, body=json.dumps(obj), headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


def _get(port, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request("GET", path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


print("\nPOST /api/leds/aura — auth gate (mock server)")
cs._MOCK_FX.clear()
srv, port = _server(mock=True)
try:
    # The mock strip is valve-leds with 8 members.
    good8 = [{"r": i * 20, "g": 0, "b": 255 - i * 20} for i in range(8)]
    st, _ = _post(port, "/api/leds/aura", {"strip": "valve-leds", "colors": good8}, token=None)
    check(st == 401, "no bearer -> 401", st)
    st, _ = _post(port, "/api/leds/aura", {"strip": "valve-leds", "colors": good8}, token="wrong")
    check(st == 401, "wrong bearer -> 401", st)
    check("strip:valve-leds" not in cs._MOCK_FX, "an unauthorised POST painted nothing")

    print("\nPOST /api/leds/aura — happy path, observable in GET /api/leds `active`")
    st, body = _post(port, "/api/leds/aura", {"strip": "valve-leds", "colors": good8})
    check(st == 200 and body.get("ok") is True, "valid 8-colour frame -> 200 ok", (st, body))
    check(body.get("active", {}).get("effect") == "aura", "reply active.effect == aura", body)
    check(body.get("active", {}).get("colors") == good8, "reply echoes the palette", body)
    st, leds = _get(port, "/api/leds")
    check(leds.get("aura") is True, "GET /api/leds advertises the aura capability", leds.get("aura"))
    active = leds.get("active", {}).get("strip:valve-leds", {})
    check(active.get("effect") == "aura", "GET active reflects the running aura", active)
    check(active.get("colors") == good8, "GET active carries the painted palette", active)

    print("\nPOST /api/leds/aura — rejects paint NOTHING (mock)")
    cs._MOCK_FX.clear()
    cases = [
        ("wrong length (too few)", {"strip": "valve-leds", "colors": good8[:3]}, 400),
        ("wrong length (oversized)", {"strip": "valve-leds", "colors": good8 + good8}, 400),
        ("out-of-range channel", {"strip": "valve-leds",
            "colors": [{"r": 0, "g": 0, "b": 0}] * 7 + [{"r": 0, "g": 0, "b": 999}]}, 400),
        ("a non-list colors", {"strip": "valve-leds", "colors": "red"}, 400),
        ("a boolean channel", {"strip": "valve-leds",
            "colors": [{"r": 0, "g": 0, "b": 0}] * 7 + [{"r": True, "g": 0, "b": 0}]}, 400),
        ("unknown strip", {"strip": "nope", "colors": good8}, 404),
        ("traversal-shaped strip", {"strip": "../etc", "colors": good8}, 404),
        ("strip is not a string", {"strip": 123, "colors": good8}, 404),
        ("missing strip", {"colors": good8}, 404),
    ]
    for label, payload, want in cases:
        st, _ = _post(port, "/api/leds/aura", payload)
        check(st == want, "%s -> %d" % (label, want), st)
    check("strip:valve-leds" not in cs._MOCK_FX,
          "after every reject the strip is still unpainted (nothing stored)", cs._MOCK_FX)

    # A well-formed but non-object body is a 400, not a 500.
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", "/api/leds/aura", body="[]",
                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    r = conn.getresponse(); r.read(); conn.close()
    check(r.status == 400, "a non-object JSON body -> 400", r.status)
finally:
    srv.shutdown()
    cs._MOCK_FX.clear()


# ===========================================================================
# HTTP endpoint on the REAL (non-mock) server, backed by the fake strip: proves
# the route drives apply_strip_aura (not just the mock store) and 404s an unknown
# strip without painting.
# ===========================================================================
print("\nPOST /api/leds/aura — real route drives the strip painter (fake sysfs)")
writes = []
restore = _install(writes)          # also stubs the render thread + persist file
try:
    srv, port = _server(mock=False)
    try:
        pal5 = [{"r": i * 40, "g": 5, "b": 255 - i * 40} for i in range(_N)]
        writes.clear()
        st, body = _post(port, "/api/leds/aura", {"strip": "valve-leds", "colors": pal5})
        check(st == 200 and body.get("ok") is True, "real server: valid 5-colour frame -> 200", (st, body))
        check(cs._SEQ_ACTIVE.get("valve-leds", {}).get("effect") == "aura",
              "real server registered the aura seq effect")
        check(cs._SEQ_ACTIVE.get("valve-leds", {}).get("frame") == pal5,
              "the posted frame reached the seq spec")
        check(all(w[0] in _MEMBERS for w in writes) and all(w[1] in _STRIP_ATTRS for w in writes),
              "real server wrote only fixed-literal attrs on strip members", writes)

        # Unknown strip on the real path: 404, and no new seq effect / no writes.
        with cs._SEQ_LOCK:
            cs._SEQ_ACTIVE.clear()
        writes.clear()
        st, _ = _post(port, "/api/leds/aura", {"strip": "ghost", "colors": pal5})
        check(st == 404, "real server: unknown strip -> 404", st)
        check(not cs._SEQ_ACTIVE and not writes,
              "real server: an unknown strip painted nothing", (dict(cs._SEQ_ACTIVE), writes))

        # Wrong length on the real path: 400, nothing painted.
        writes.clear()
        st, _ = _post(port, "/api/leds/aura", {"strip": "valve-leds", "colors": pal5[:2]})
        check(st == 400, "real server: wrong length -> 400", st)
        check(not writes, "real server: a rejected frame painted nothing", writes)
    finally:
        srv.shutdown()
finally:
    restore()


if __name__ == "__main__":
    if _fail:
        print("\n%d FAILED: %s" % (len(_fail), ", ".join(_fail)))
        raise SystemExit(1)
    print("\nall good")
