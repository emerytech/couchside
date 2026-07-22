#!/usr/bin/env python3
"""DEV ONLY. Single-origin server for the app's web target.

Serves the exported web bundle AND proxies /api to a locally-running agent, so
the browser sees ONE origin.

WHY THIS EXISTS INSTEAD OF CORS HEADERS ON THE AGENT: the agent is a LAN-only,
token-authed service that deliberately sends no Access-Control-Allow-Origin.
Adding CORS to it so a dev browser can talk to it would widen the production
attack surface for a test convenience -- any page the user visits could then
script their box. Solving it in a dev-only proxy keeps that boundary intact.

NOT FOR DEPLOYMENT. Binds loopback only, no TLS, and forwards the Authorization
header verbatim. It exists so the app's UI can be driven against `--mock` data
on a laptop -- see scripts/web-dev.sh.

Not proxied: /ws/gamepad. WebSocket upgrade needs real tunnelling, and the Pad
surfaces are native-gesture territory that a desktop browser cannot exercise
faithfully anyway. Verify those on a device.

Usage: web-dev-proxy.py <dist_dir> <listen_port> <agent_host:agent_port> [token]
"""
import http.client
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if len(sys.argv) not in (4, 5):
    raise SystemExit(__doc__.strip().splitlines()[-1])

DIST, PORT, AGENT = sys.argv[1], int(sys.argv[2]), sys.argv[3]
# DEV-ONLY token used to backfill Authorization on requests that structurally
# cannot carry it. React Native's <Image> takes source.headers on NATIVE only;
# on web it becomes a plain <img>, which cannot send a bearer token. So every
# token-gated image -- Steam cover art, the screen preview -- 401'd in the
# harness and silently rendered its fallback. That made a whole class of UI
# unverifiable here while looking merely "empty".
#
# Backfill ONLY: a request that already carries Authorization is passed through
# untouched, so the auth-rejection path stays testable. Loopback-only, dev-only,
# and never shipped to a box.
DEV_TOKEN = sys.argv[4] if len(sys.argv) > 4 else ""
AGENT_HOST, AGENT_PORT = AGENT.rsplit(":", 1)[0], int(AGENT.rsplit(":", 1)[1])
PROXY_PREFIXES = ("/api", "/pair")

MIME = {".html": "text/html", ".js": "application/javascript",
        ".css": "text/css", ".json": "application/json", ".png": "image/png",
        ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
        ".map": "application/json"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass                                  # keep the console readable

    def _proxy(self, method):
        body = None
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            body = self.rfile.read(n)
        conn = http.client.HTTPConnection(AGENT_HOST, AGENT_PORT, timeout=20)
        # Drop hop-by-hop headers; keep Authorization so the token still works.
        hdrs = {k: v for k, v in self.headers.items()
                if k.lower() not in ("host", "connection", "accept-encoding")}
        if DEV_TOKEN and not any(k.lower() == "authorization" for k in hdrs):
            hdrs["Authorization"] = "Bearer " + DEV_TOKEN
        try:
            conn.request(method, self.path, body=body, headers=hdrs)
            r = conn.getresponse()
            data = r.read()
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
            print("proxy error %s %s: %s" % (method, self.path, e))
            return
        finally:
            conn.close()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() in ("transfer-encoding", "connection", "content-length"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self):
        rel = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        # Contain the path: a traversal must not escape the export directory.
        path = os.path.normpath(os.path.join(DIST, rel))
        if not path.startswith(os.path.abspath(DIST)):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.isfile(path):
            # expo-router emits <route>.html; fall back, then to the SPA shell.
            alt = path + ".html"
            path = alt if os.path.isfile(alt) else os.path.join(DIST, "index.html")
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type",
                         MIME.get(os.path.splitext(path)[1], "text/plain"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIXES):
            return self._proxy("GET")
        self._static()

    def do_POST(self):
        return self._proxy("POST")

    def do_OPTIONS(self):
        return self._proxy("OPTIONS")


if __name__ == "__main__":
    DIST = os.path.abspath(DIST)
    print("serving %s on http://127.0.0.1:%d  (/api -> %s)" % (DIST, PORT, AGENT))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
