#!/usr/bin/env python3
"""Tests for the OpenRGB backend (GET /api/openrgb, POST /api/openrgb/set) and
the hand-rolled OpenRGB SDK client.

Run: python3 tests/test_openrgb.py

There is no OpenRGB hardware in CI, so the wire format is proven against an
IN-PROCESS mock OpenRGB TCP server that speaks the documented protocol
(SET_CLIENT_NAME / REQUEST_PROTOCOL_VERSION / REQUEST_CONTROLLER_COUNT /
REQUEST_CONTROLLER_DATA / UPDATE_LEDS). This proves the client's handshake,
controller-data parse (name + zones + summed LED count) and per-LED frame writes
round-trip -- but REAL hardware remains the final gate (see the PR / spec).

The property that matters for the allowlist: a client `device` is an int index
LOOKED UP in the live controller list -- an out-of-range index writes NOTHING and
404s; the client never names a socket/host/command. Effect ids are the frozen
_LED_EFFECTS set.

Pure stdlib, no pytest -- same style as the other agent tests. The client is
pointed at 127.0.0.1:<ephemeral> (the mock), never a real OpenRGB daemon, and the
persistence file is redirected to a temp path.
"""
import importlib.util
import os
import socket
import struct
import tempfile
import threading
import time

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


def wait_for(pred, timeout=2.0):
    """Poll pred() until true or timeout (the mock server processes writes on a
    per-connection thread, so a captured frame lands slightly after the call)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


# ---- a minimal mock OpenRGB server -----------------------------------------
SERVER_PROTO = 3
# device index -> (name, [(zone_name, led_count), ...])
DEVICES = [
    ("ASUS Aura Motherboard", [("Addressable 1", 8), ("Onboard", 4)]),   # 12 LEDs
    ("Corsair Vengeance RGB", [("DIMM 1", 10), ("DIMM 2", 10)]),         # 20 LEDs
]


def _bstr(s):
    b = s.encode("utf-8")
    return struct.pack("<H", len(b) + 1) + b + b"\x00"


def _build_controller(idx):
    """A proto-3 controller-data blob matching the agent's parser layout."""
    name, zones = DEVICES[idx]
    body = b""
    body += struct.pack("<i", 0)                      # device type
    body += _bstr(name)
    body += _bstr("desc")                             # description
    body += _bstr("1.0")                              # version
    body += _bstr("SERIAL")                           # serial
    body += _bstr("loc")                              # location
    body += struct.pack("<H", 1)                      # num_modes
    body += struct.pack("<i", 0)                      # active mode
    # one mode (proto-3 field layout, incl. brightness fields)
    body += _bstr("Direct")                           # mode name
    body += struct.pack("<i", 0)                      # value
    body += struct.pack("<I", 0)                      # flags
    body += struct.pack("<II", 0, 100)                # speed_min, speed_max
    body += struct.pack("<II", 0, 100)                # brightness_min, brightness_max (proto>=3)
    body += struct.pack("<II", 0, 0)                  # colors_min, colors_max
    body += struct.pack("<I", 50)                     # speed
    body += struct.pack("<I", 100)                    # brightness (proto>=3)
    body += struct.pack("<I", 0)                      # direction
    body += struct.pack("<I", 0)                      # color_mode
    body += struct.pack("<H", 0)                      # num mode colors
    body += struct.pack("<H", len(zones))             # num_zones
    total = 0
    for zname, zleds in zones:
        body += _bstr(zname)
        body += struct.pack("<i", 0)                  # zone type
        body += struct.pack("<I", 0)                  # leds_min
        body += struct.pack("<I", zleds)              # leds_max
        body += struct.pack("<I", zleds)              # leds_count
        body += struct.pack("<H", 0)                  # matrix_len (none)
        total += zleds
    # per-LED section (parser stops before this, but a real server sends it)
    body += struct.pack("<H", total)
    for i in range(total):
        body += _bstr("LED %d" % i) + struct.pack("<I", 0)
    body += struct.pack("<H", 0)                      # num device colors
    return struct.pack("<I", len(body) + 4) + body    # prefix data_size


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def _reply(conn, dev, pid, payload):
    conn.sendall(b"ORGB" + struct.pack("<III", dev, pid, len(payload)) + payload)


class MockOpenRGB:
    def __init__(self):
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.frames = []          # (dev_idx, [(r,g,b), ...]) captured from UPDATE_LEDS
        self.custom_mode = []     # dev indices that got SET_CUSTOM_MODE
        self._stop = False
        self.t = threading.Thread(target=self._serve, daemon=True)
        self.t.start()

    def _serve(self):
        self.srv.settimeout(0.5)
        while not self._stop:
            try:
                conn, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        conn.settimeout(2.0)
        while not self._stop:
            try:
                hdr = _recv_exact(conn, 16)
            except OSError:
                return
            if not hdr or hdr[:4] != b"ORGB":
                return
            dev, pid, size = struct.unpack("<III", hdr[4:16])
            body = _recv_exact(conn, size) if size else b""
            if body is None and size:
                return
            if pid == 50:                              # SET_CLIENT_NAME
                pass
            elif pid == 40:                            # REQUEST_PROTOCOL_VERSION
                _reply(conn, 0, 40, struct.pack("<I", SERVER_PROTO))
            elif pid == 0:                             # REQUEST_CONTROLLER_COUNT
                _reply(conn, 0, 0, struct.pack("<I", len(DEVICES)))
            elif pid == 1:                             # REQUEST_CONTROLLER_DATA
                _reply(conn, dev, 1, _build_controller(dev))
            elif pid == 1100:                          # SET_CUSTOM_MODE
                self.custom_mode.append(dev)
            elif pid == 1050:                          # UPDATE_LEDS
                self.frames.append((dev, self._parse_leds(body)))

    @staticmethod
    def _parse_leds(body):
        n = struct.unpack_from("<H", body, 4)[0]       # skip u32 data_size
        out = []
        off = 6
        for _ in range(n):
            r, g, b = body[off], body[off + 1], body[off + 2]
            out.append((r, g, b))
            off += 4
        return out

    def stop(self):
        self._stop = True
        try:
            self.srv.close()
        except OSError:
            pass


def _point_client_at(server):
    """Redirect the agent's OpenRGB client + persistence at the mock server and a
    temp file. Returns a restore fn."""
    saved = {k: getattr(cs, k) for k in ("_ORGB_HOST", "_ORGB_PORT", "_ORGB",
                                         "_ORGB_STATE_CONF")}
    cs._ORGB_HOST = "127.0.0.1"
    cs._ORGB_PORT = server.port
    cs._ORGB = cs._OpenRGBClient()
    cs._ORGB_CACHE["ctrls"] = []
    cs._ORGB_CACHE["at"] = 0.0
    fd, tmp = tempfile.mkstemp(prefix="test-orgb-", suffix=".json")
    os.close(fd)
    os.unlink(tmp)
    cs._ORGB_STATE_CONF = tmp

    def restore():
        cs._ORGB_FX_STOP.set()
        th = cs._ORGB_FX_THREAD[0]
        if th is not None:
            th.join(timeout=1.0)
        with cs._ORGB_FX_LOCK:
            cs._ORGB_FX_ACTIVE.clear()
            cs._ORGB_PERSIST.clear()
            cs._ORGB_FX_THREAD[0] = None
        cs._ORGB_FX_STOP.clear()
        try:
            cs._ORGB._drop()
        except Exception:
            pass
        for k, v in saved.items():
            setattr(cs, k, v)
        try:
            os.unlink(tmp)
        except OSError:
            pass


    return restore


def test_enumerate_wire():
    print("client enumerates controllers over the wire (name + zones + LED count)")
    srv = MockOpenRGB()
    restore = _point_client_at(srv)
    try:
        ctrls = cs._ORGB.controllers()
        check(len(ctrls) == 2, "two controllers enumerated")
        check(ctrls[0]["name"] == "ASUS Aura Motherboard", "controller 0 name parsed")
        check(ctrls[0]["led_count"] == 12, "controller 0 LED count = sum of zones (8+4)")
        check([z["name"] for z in ctrls[0]["zones"]] == ["Addressable 1", "Onboard"],
              "controller 0 zone names parsed")
        check(ctrls[1]["led_count"] == 20, "controller 1 LED count = 10+10")
        check(cs.openrgb_available() is True, "openrgb_available() true when server answers")
    finally:
        restore()
        srv.stop()


def test_frame_write_wire():
    print("set_frame writes a per-LED UPDATE_LEDS frame that round-trips")
    srv = MockOpenRGB()
    restore = _point_client_at(srv)
    try:
        colors = [{"r": 10, "g": 20, "b": 30}, {"r": 255, "g": 0, "b": 128}]
        ok = cs._ORGB.set_frame(0, colors)
        check(ok is True, "set_frame returned ok")
        wait_for(lambda: bool(srv.frames))
        check(srv.custom_mode and srv.custom_mode[-1] == 0,
              "device put into custom/direct mode first")
        check(srv.frames and srv.frames[-1][0] == 0, "frame addressed to device 0")
        got = srv.frames[-1][1] if srv.frames else None
        check(got == [(10, 20, 30), (255, 0, 128)],
              "colours round-trip R,G,B in order (got %s)" % got)
    finally:
        restore()
        srv.stop()


def test_apply_allowlist():
    print("apply_openrgb allowlist: unknown device/effect writes NOTHING")
    srv = MockOpenRGB()
    restore = _point_client_at(srv)
    try:
        # unknown effect -> 400, no frame
        srv.frames.clear()
        res = cs.apply_openrgb(0, "kitt", None, 50, 100)
        check(isinstance(res, dict) and res.get("status") == 400, "unknown effect -> 400")
        check(not srv.frames, "unknown effect wrote no frame")
        # out-of-range device -> None, no frame
        for bad in (99, -1, "0", None, True):
            srv.frames.clear()
            res = cs.apply_openrgb(bad, "solid", {"r": 1, "g": 2, "b": 3}, 50, 100)
            check(res is None, "device %r refused" % (bad,))
            check(not srv.frames, "device %r wrote no frame" % (bad,))
        # valid solid -> a full-device frame of that colour
        srv.frames.clear()
        res = cs.apply_openrgb(0, "solid", {"r": 0, "g": 200, "b": 0}, 50, 100)
        check(res and res.get("ok") and res["active"] is None, "solid accepted")
        wait_for(lambda: bool(srv.frames))
        frame = srv.frames[-1][1] if srv.frames else []
        check(len(frame) == 12 and all(px == (0, 200, 0) for px in frame),
              "solid wrote 12 LEDs all green")
    finally:
        restore()
        srv.stop()


def test_scanner_effect_moves():
    print("scanner effect renders a moving lit dot (a real KITT sweep)")
    n = 12
    color = {"r": 255, "g": 0, "b": 0}
    # brightest LED index over time should move, not stay put
    peaks = []
    for k in range(6):
        frame = cs._orgb_frame("scanner", n, color, k * 0.3, 60)
        peak = max(range(n), key=lambda i: frame[i]["r"])
        peaks.append(peak)
    check(len(set(peaks)) > 1, "the lit position moves across frames (peaks=%s)" % peaks)
    # rainbow frames are all valid colours
    rb = cs._orgb_frame("rainbow", n, color, 0.7, 50)
    check(len(rb) == n and all(cs._is_rgb_triple(c) for c in rb),
          "rainbow frame is n valid colours")


def test_persistence_roundtrip():
    print("apply persists + restore re-applies (revalidated)")
    srv = MockOpenRGB()
    restore = _point_client_at(srv)
    try:
        cs.apply_openrgb(1, "scanner", {"r": 0, "g": 0, "b": 255}, 70, 90)
        saved = cs._orgb_state_load()
        check(saved.get("1", {}).get("effect") == "scanner", "scanner persisted for device 1")
        # wipe in-memory, restore from disk
        cs._ORGB_FX_STOP.set()
        th = cs._ORGB_FX_THREAD[0]
        if th:
            th.join(timeout=1.0)
        with cs._ORGB_FX_LOCK:
            cs._ORGB_FX_ACTIVE.clear()
            cs._ORGB_FX_THREAD[0] = None
        cs._ORGB_FX_STOP.clear()
        cs._orgb_restore()
        check(1 in cs._ORGB_FX_ACTIVE and cs._ORGB_FX_ACTIVE[1]["effect"] == "scanner",
              "restore re-applied the scanner effect")
    finally:
        restore()
        srv.stop()


def test_mock_state_observable():
    print("--mock: GET /api/openrgb reflects a selected effect (observe both)")
    saved = dict(cs._MOCK_ORGB_FX)
    try:
        cs._MOCK_ORGB_FX.clear()
        st = cs.openrgb_state(True)
        check(st["available"] is True and len(st["controllers"]) == 2,
              "mock advertises two controllers")
        check(st["active"] == {}, "no effect active initially")
        cs._MOCK_ORGB_FX[0] = {"effect": "scanner", "color": {"r": 255, "g": 0, "b": 0},
                               "speed": 80, "brightness": 100}
        st = cs.openrgb_state(True)
        check(st["active"].get("0", {}).get("effect") == "scanner",
              "GET reflects the switched-on scanner")
    finally:
        cs._MOCK_ORGB_FX.clear()
        cs._MOCK_ORGB_FX.update(saved)


if __name__ == "__main__":
    test_enumerate_wire()
    test_frame_write_wire()
    test_apply_allowlist()
    test_scanner_effect_moves()
    test_persistence_roundtrip()
    test_mock_state_observable()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all openrgb tests passed")
