#!/usr/bin/env python3
"""couchside-cec-bridge.py: HDMI-CEC bridge for Couchside.

A tiny pure-stdlib python3 daemon for a Raspberry Pi (or any Linux box) that is
plugged into the TV's HDMI and can therefore drive it over HDMI-CEC — power and
volume — on behalf of a Couchside agent that can't reach the TV itself. The
canonical case: a Windows HTPC (which has no CEC) forwards TV power/volume here,
and this bridge, on a Pi wired to the TV's HDMI, sends the CEC commands.

The Couchside agent's `cec_bridge` TV backend forwards each TV op to this
daemon over the LAN; the daemon runs the matching CEC command (cec-client /
cec-ctl) to the TV and returns the same ActionResult shape the agent uses.

No pip dependencies. Runs on Raspberry Pi OS with nothing but the preinstalled
python3 plus `cec-utils` (cec-client) — the installer adds that.

Security: a bearer token (same model as the Couchside agent), LAN-only, plain
HTTP. Keep it on your local network; do NOT port-forward it.
"""

import argparse
import hmac
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

APP_NAME = "couchside-cec-bridge"
VERSION = "0.1.0"

DEFAULT_PORT = 8799
DEFAULT_TOKEN_PATH = "/etc/couchside-cec/token"

# The op set the Couchside agent forwards (same names as the agent's TV strip).
CEC_OPS = ("power_on", "power_off", "volume_up", "volume_down", "mute")

# power_off maps to CEC standby (CEC has no discrete power-off; standby IS off).
_TO_CEC = {"power_on": "power_on", "power_off": "standby",
           "volume_up": "volume_up", "volume_down": "volume_down",
           "mute": "mute"}

# Resolved once at startup by detect_tool(): {"tool","bin","device","adapter"}.
CEC = None


# ---------------------------------------------------------------------------
# CEC tool detection + command construction (mirrors the Couchside agent's cec
# backend so behaviour is identical on both sides of the bridge).
# ---------------------------------------------------------------------------

def detect_tool(prefer, device):
    """Pick the CEC tool. On a Raspberry Pi cec-client (libcec) is the reliable
    path and is preferred; cec-ctl (v4l-utils / kernel framework) is used if it
    is the only one present or explicitly requested. Returns a descriptor dict
    or None when no CEC tool is installed."""
    have_client = shutil.which("cec-client")
    have_ctl = shutil.which("cec-ctl")

    def client_desc():
        return {"tool": "cec-client", "bin": have_client,
                "device": None, "adapter": "libcec (cec-client)"}

    def ctl_desc():
        dev = device or "/dev/cec0"
        return {"tool": "cec-ctl", "bin": have_ctl, "device": dev,
                "adapter": "kernel CEC (cec-ctl %s)" % dev}

    if prefer == "cec-client" and have_client:
        return client_desc()
    if prefer == "cec-ctl" and have_ctl:
        return ctl_desc()
    if have_client:
        return client_desc()
    if have_ctl:
        return ctl_desc()
    return None


def _cec_argv(cec, cec_op):
    """(argv, stdin_bytes|None) for a CEC-internal op (power_on/standby/
    volume_*/mute) against descriptor <cec>. Targets the TV (logical address 0);
    volume/mute use CEC User Control (UI) commands, which a TV forwards to an
    ARC audio system when system-audio control is on."""
    if cec["tool"] == "cec-ctl":
        # --playback each time claims a logical address (Playback Device) before
        # sending, so a command works even right after boot without a separate
        # "configure the adapter" step. Idempotent; the TV answers on LA 0.
        base = [cec["bin"], "-d", cec["device"], "--playback", "--to", "0"]
        if cec_op == "power_on":
            return base + ["--image-view-on"], None
        if cec_op == "standby":
            return base + ["--standby"], None
        ui = {"volume_up": "volume-up", "volume_down": "volume-down",
              "mute": "mute"}[cec_op]
        return base + ["--user-control-pressed", "ui-cmd=" + ui,
                       "--user-control-released"], None
    # cec-client (libcec): single-command mode (-s), command on stdin.
    cmd = {"power_on": "on 0", "standby": "standby 0", "volume_up": "volup",
           "volume_down": "voldown", "mute": "mute"}[cec_op]
    return [cec["bin"], "-s", "-d", "1"], (cmd + "\n").encode("ascii")


def run_cec(op, mock):
    """Run one TV op via a one-shot arg-list subprocess. ActionResult-shaped
    (matches the Couchside agent so the app sees a uniform result)."""
    start = time.monotonic()
    if mock:
        time.sleep(0.1)
        print("[cec] %s" % op, flush=True)
        return {"ok": True, "exit_code": 0,
                "stdout": "[mock cec] %s\n" % op, "stderr": "",
                "duration_ms": 100}
    if CEC is None:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "no CEC tool available (install cec-utils)",
                "duration_ms": 0}
    argv, stdin = _cec_argv(CEC, _TO_CEC[op])
    try:
        r = subprocess.run(argv, input=stdin, capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "cec command timed out",
                "duration_ms": int((time.monotonic() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "",
                "stderr": "%s: %s" % (e.__class__.__name__, e),
                "duration_ms": int((time.monotonic() - start) * 1000)}
    return {"ok": r.returncode == 0, "exit_code": r.returncode,
            "stdout": (r.stdout or b"").decode("utf-8", "replace"),
            "stderr": (r.stderr or b"").decode("utf-8", "replace"),
            "duration_ms": int((time.monotonic() - start) * 1000)}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = APP_NAME + "/" + VERSION
    protocol_version = "HTTP/1.1"

    token = ""
    mock = False

    def log_message(self, fmt, *args):
        pass

    def _log(self, code, started):
        dur_ms = int((time.monotonic() - started) * 1000)
        path = self.path.split("?", 1)[0]
        print("%s %s %s %d %dms" % (
            self.client_address[0], self.command, path, code, dur_ms),
            flush=True)

    def _send(self, code, payload, started):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
        self._log(code, started)

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        return hmac.compare_digest(auth[len("Bearer "):].strip(), self.token)

    def _drain(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > 0:
            self.rfile.read(n)

    def do_OPTIONS(self):
        self._send(204, None, time.monotonic())

    def do_GET(self):
        started = time.monotonic()
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/api/ping":
                self._send(200, {"ok": True, "app": APP_NAME,
                                 "version": VERSION,
                                 "tool": CEC["tool"] if CEC else None,
                                 "host": socket.gethostname().split(".")[0]},
                           started)
                return
            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return
            if path == "/api/cec":
                self._send(200, {
                    "available": CEC is not None,
                    "tool": CEC["tool"] if CEC else None,
                    "adapter": CEC["adapter"] if CEC else None,
                    "ops": list(CEC_OPS),
                }, started)
                return
            self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass

    def do_POST(self):
        started = time.monotonic()
        self._drain()
        try:
            path = urlparse(self.path).path.rstrip("/")
            if not self._authorized():
                self._send(401, {"error": "unauthorized"}, started)
                return
            prefix = "/cec/"
            if path.startswith(prefix):
                op = path[len(prefix):]
                if op not in CEC_OPS:
                    self._send(404, {"error": "unknown cec op"}, started)
                    return
                self._send(200, run_cec(op, self.mock), started)
                return
            self._send(404, {"error": "not found"}, started)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send(500, {"error": e.__class__.__name__}, started)
            except Exception:
                pass


def load_token(args):
    if args.token:
        return args.token
    try:
        with open(args.token_file, encoding="utf-8-sig") as f:
            tok = f.read().strip()
        if not tok:
            print("error: token file %s is empty" % args.token_file,
                  file=sys.stderr)
            sys.exit(1)
        return tok
    except OSError as e:
        print("error: cannot read token file %s: %s" % (args.token_file, e),
              file=sys.stderr)
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(description="Couchside HDMI-CEC bridge")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--token-file", default=DEFAULT_TOKEN_PATH)
    p.add_argument("--token", default=None,
                   help="literal token (overrides --token-file; dev only)")
    p.add_argument("--tool", choices=["auto", "cec-client", "cec-ctl"],
                   default="auto", help="CEC tool to use (default auto)")
    p.add_argument("--device", default=None,
                   help="/dev/cecN for cec-ctl (default /dev/cec0)")
    p.add_argument("--mock", action="store_true",
                   help="log CEC ops, never run them (for development)")
    args = p.parse_args()

    global CEC
    if not args.mock:
        CEC = detect_tool(args.tool, args.device)
        if CEC is None:
            print("warning: no CEC tool found (install cec-utils for "
                  "cec-client). Ops will fail until one is present.",
                  file=sys.stderr, flush=True)

    Handler.token = load_token(args)
    Handler.mock = args.mock

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    mode = "mock" if args.mock else "real"
    print("%s %s listening on %s:%d (%s mode)" % (
        APP_NAME, VERSION, args.host, args.port, mode), flush=True)
    print("cec: %s" % (CEC["adapter"] if CEC else "unavailable"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
