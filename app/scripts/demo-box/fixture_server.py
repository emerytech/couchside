#!/usr/bin/env python3
"""Couchside DEMO BOX: a fake agent on 127.0.0.1:8787 that serves a fully populated
Console (now playing, stream host, gaming, vitals, units) for design review.
Stdlib only. CORS-open so the Expo web build on localhost:8098 can call it."""
import json, math, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ART = open(os.path.join(HERE, "art.png"), "rb").read()
COVER = open(os.path.join(HERE, "cover.png"), "rb").read()
T0 = time.time()
STATE = {"playing": True, "pos0": 11000, "pos_t": T0}
LEN_MS = 214000

def elapsed(): return time.time() - T0

def history(n=36):
    now = int(time.time())
    return {
        "t": [now - (n - 1 - i) * 10 for i in range(n)],
        "temp": [round(48 + 4 * math.sin(i / 5) + (i % 3) * 0.4, 1) for i in range(n)],
        "load": [round(0.6 + 0.5 * max(0, math.sin(i / 6)) + (0.9 if i > n - 7 else 0), 2) for i in range(n)],
        "mem_pct": [round(15 + 1.2 * math.sin(i / 4) + (i % 2) * 0.3, 1) for i in range(n)],
    }

def status():
    return {
        "hostname": "couchside-box", "time": int(time.time()), "uptime_s": 94020 + int(elapsed()),
        "load": [1.98, 0.96, 0.58], "cpu_temp_c": 50.0,
        "mem": {"total_mb": 31948, "used_mb": 5222, "available_mb": 26726, "swap_total_mb": 8192, "swap_used_mb": 0},
        "disks": [
            {"mount": "/", "total_gb": 464.2, "used_gb": 203.9, "free_gb": 260.3, "pct": 44},
            {"mount": "/var/home", "total_gb": 931.5, "used_gb": 612.4, "free_gb": 319.1, "pct": 66},
        ],
        "net": {"iface": "enp5s0", "mac": "d8:bb:c1:12:34:56", "wired": True, "wol_armed": True},
        "ip": "10.7.0.64", "agent_version": "2.9.56",
        "os": {"name": "Bazzite", "version": "43", "kernel": "6.17.4-300.bazzite.fc43"},
        "caps": {"gamepad": True, "steam": True, "media": True, "tv": False, "screen": False, "power_schedule": True,
                 "gaming": True, "streamhost": True, "boxbattery": False, "file_upload": False,
                 "display_info": False, "audioswitch": False, "ledcontrol": False, "openrgb": False,
                 "screensaver": False, "couchmode": False, "desktop": False},
        "history": history(),
    }

def media():
    pos = STATE["pos0"] + (int((time.time() - STATE["pos_t"]) * 1000) if STATE["playing"] else 0)
    return {"available": True, "players": [{
        "id": "spotify", "identity": "Spotify", "status": "Playing" if STATE["playing"] else "Paused",
        "title": "Midnight City", "artist": "M83", "album": "Hurry Up, We're Dreaming",
        "position_ms": pos % LEN_MS, "length_ms": LEN_MS, "rate": 1.0,
        "can_seek": True, "can_go_next": True, "can_go_previous": True, "can_play": True, "can_pause": True,
        "art": True, "art_key": "midnight-city"}]}

def gaming():
    return {
        "gpu": {"name": "AMD Radeon RX 7800 XT", "card": "card1", "temp_c": 61.0,
                "vram_used_mb": 3277, "vram_total_mb": 8192, "busy_pct": 63},
        "game": {"appid": 1091500, "label": "Cyberpunk 2077", "running_s": 5520 + int(elapsed()), "pid": 4242},
        "output": {"name": "DP-1", "internal": False},
        "controllers": [{"uniq": "e4:17:d8:aa:bb:cc", "name": "Xbox Wireless Controller",
                         "battery_pct": 62, "battery_status": "Discharging"}],
        "session": "gamescope",
    }

ROUTES = {
    "/api/ping": lambda: {"ok": True, "app": "couchside-agent", "version": "2.9.56", "ip": "10.7.0.64", "host": "couchside-box"},
    "/api/status": status,
    "/api/units": lambda: {"units": [
        {"name": "couchside.service", "scope": "system", "active": "active", "sub": "running", "description": "Couchside agent"},
        {"name": "steam", "scope": "user", "active": "active", "sub": "running", "description": "Steam"},
        {"name": "sshd.service", "scope": "system", "active": "active", "sub": "running", "description": "OpenSSH"},
        {"name": "sunshine.service", "scope": "user", "active": "inactive", "sub": "dead", "description": "Sunshine"},
    ]},
    "/api/media": media,
    "/api/gaming": gaming,
    "/api/stream-host": lambda: {"available": True, "listening": True, "active": True, "client": "macOS", "since": int(T0) - 12 * 60},
}

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    def _send(self, code, body, ctype="application/json"):
        self.send_response(code); self._cors()
        self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)
    def _json(self, code, obj): self._send(code, json.dumps(obj).encode())
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.send_header("Content-Length", "0"); self.end_headers()
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ROUTES: return self._json(200, ROUTES[path]())
        if path == "/api/media/art": return self._send(200, ART, "image/png")
        if path.startswith("/api/steam/") and path.endswith("/cover"): return self._send(200, COVER, "image/png")
        self._json(404, {"error": "not found"})
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/media/spotify/"):
            op = path.rsplit("/", 1)[1]
            cur = media()["players"][0]["position_ms"]
            if op in ("play_pause", "play", "pause"):
                STATE["playing"] = (op == "play") if op != "play_pause" else not STATE["playing"]
                STATE["pos0"], STATE["pos_t"] = cur, time.time()
            elif op == "seek":
                n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
                STATE["pos0"], STATE["pos_t"] = int(body.get("position_ms", cur)), time.time()
            elif op in ("next", "previous"):
                STATE["pos0"], STATE["pos_t"] = 0, time.time()
            return self._json(200, {"ok": True, "exit_code": 0, "stdout": "", "stderr": ""})
        if path == "/api/game/stop": return self._json(200, {"stopped": True})
        self._json(404, {"error": "not found"})
    def log_message(self, fmt, *args):
        if "200" not in (args[1] if len(args) > 1 else ""): super().log_message(fmt, *args)

if __name__ == "__main__":
    print("demo box on http://127.0.0.1:8787  (Ctrl-C to stop)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8787), H).serve_forever()
