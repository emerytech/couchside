#!/usr/bin/env python3
"""Phase 0 spike for the Couchside media player.

Answers, on a real box, the questions that decide whether the design is viable:

  Q1  Is Chrome's CDP endpoint reachable from the HOST when Chrome runs inside
      the flatpak sandbox? (flatpak Context has shared=network, so it should be
      -- but "should" is not a measurement.)
  Q2  Does the Widevine CDM load in that instance WITH CDP attached?
  Q3  Does encrypted content actually PLAY end to end, with CDP attached?
      Control: Shaka's public Angel One Widevine asset + the no_auth license
      proxy -- a known-good stream that needs no login, so a failure is ours.
  Q4  Does attaching CDP set automation tells a service could block on
      (navigator.webdriver, HeadlessChrome in the UA)?
  Q5  Do the real services render, or do they serve an unsupported-browser wall?

Pure stdlib. The WebSocket client here is deliberately the shape the shipped
player would use (the agent already hand-rolls one for the WebOS TV backend).

Run ON the box. Cleans up the Chrome it starts.
"""

import base64
import http.server
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

CDP_PORT = 9333
HTTP_PORT = 9334
FLATPAK_ID = os.environ.get("COUCHSIDE_PROBE_FLATPAK", "com.google.Chrome")
# Inside the flatpak sandbox only the app's own ~/.var/app/<id> tree is reliably
# writable, so the throwaway profile lives there rather than anywhere in $HOME.
PROFILE = os.path.expanduser(
    "~/.var/app/%s/config/couchside-probe" % FLATPAK_ID)

# Known-good public Widevine asset (Shaka demo assets) + the open license proxy.
# This is the CONTROL: if this does not play, the failure is our harness, not
# some service's anti-automation.
MPD = "https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd"
LICENSE = "https://cwip-shaka-proxy.appspot.com/no_auth"
SHAKA = "https://cdn.jsdelivr.net/npm/shaka-player@4/dist/shaka-player.compiled.js"

DRM_HTML = """<!doctype html><html><head><meta charset=utf-8>
<title>couchside drm probe</title>
<script src="%s"></script></head>
<body style="margin:0;background:#000">
<video id="v" autoplay muted style="width:100%%;height:100%%"></video>
<script>
window.__st = {stage:"init", err:null, t:0, dur:0};
function go() {
  try {
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      window.__st.stage = "unsupported"; return;
    }
    var v = document.getElementById('v');
    var p = new shaka.Player(v);
    p.configure({drm: {servers: {'com.widevine.alpha': %s}}});
    window.__st.stage = "loading";
    p.load(%s).then(function () {
      window.__st.stage = "loaded";
      return v.play();
    }).then(function () {
      window.__st.stage = "playing";
    }).catch(function (e) {
      window.__st.stage = "error";
      window.__st.err = (e && (e.code || e.message || String(e))) + "";
      window.__st.detail = JSON.stringify(e && e.data || null);
    });
    setInterval(function () {
      window.__st.t = v.currentTime; window.__st.dur = v.duration || 0;
    }, 250);
  } catch (e) {
    window.__st.stage = "throw"; window.__st.err = String(e);
  }
}
if (window.shaka) { go(); } else { window.addEventListener('load', go); }
</script></body></html>
""" % (SHAKA, json.dumps(LICENSE), json.dumps(MPD))


# --------------------------------------------------------------------------
# Minimal RFC6455 client. Client frames MUST be masked; server frames are not.
# --------------------------------------------------------------------------
class WS:
    def __init__(self, url, timeout=20):
        if not url.startswith("ws://"):
            raise ValueError("expected ws:// url, got %r" % url)
        hostport, _, path = url[5:].partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        # No Origin header on purpose: Chrome rejects unknown Origins on the
        # DevTools socket unless --remote-allow-origins is passed, and omitting
        # it entirely is accepted.
        self.sock.sendall((
            "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
        ).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("socket closed during handshake")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0] + b" ":
            raise RuntimeError("handshake refused: %r" % head[:200])
        self.buf = rest
        self.next_id = 0

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self.buf += chunk

    def _frame(self):
        while True:
            self._need(2)
            opcode = self.buf[0] & 0x0F
            length = self.buf[1] & 0x7F
            offset = 2
            if length == 126:
                self._need(4)
                length = struct.unpack(">H", self.buf[2:4])[0]
                offset = 4
            elif length == 127:
                self._need(10)
                length = struct.unpack(">Q", self.buf[2:10])[0]
                offset = 10
            self._need(offset + length)
            payload = self.buf[offset:offset + length]
            self.buf = self.buf[offset + length:]
            if opcode == 0x1:
                return payload
            if opcode == 0x8:
                raise RuntimeError("peer closed the websocket")
            # 0x9 ping / 0xA pong / 0x0 continuation: not needed for CDP.

    def call(self, method, params=None, timeout=60):
        self.next_id += 1
        mid = self.next_id
        payload = json.dumps({"id": mid, "method": method,
                              "params": params or {}}).encode()
        mask = os.urandom(4)
        n = len(payload)
        header = bytes([0x81])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask
                          + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        self.sock.settimeout(timeout)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            msg = json.loads(self._frame())
            if msg.get("id") == mid:      # everything else is an event
                return msg
        raise RuntimeError("timed out waiting for %s" % method)


def evaluate(ws, expression, await_promise=False):
    res = ws.call("Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
        "awaitPromise": await_promise,
    }).get("result", {})
    if "exceptionDetails" in res:
        exc = res["exceptionDetails"].get("exception", {})
        return "EXCEPTION: %s" % (exc.get("description") or exc.get("value"))
    return res.get("result", {}).get("value")


def http_get(url, timeout=5):
    """Chrome's DevTools HTTP server keeps the connection open even when the
    request says `Connection: close`, so reading to EOF hangs until the socket
    timeout fires -- AFTER the whole body has already arrived. Read the headers,
    then exactly Content-Length bytes."""
    host, _, rest = url[len("http://"):].partition("/")
    h, _, p = host.partition(":")
    sock = socket.create_connection((h, int(p)), timeout)
    try:
        sock.settimeout(timeout)
        sock.sendall(("GET /%s HTTP/1.1\r\nHost: %s\r\n\r\n"
                      % (rest, host)).encode())
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError("closed before headers")
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n")[1:]:
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1])
        while len(body) < length:
            chunk = sock.recv(65536)
            if not chunk:
                break
            body += chunk
        return body
    finally:
        sock.close()


class Quiet(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = DRM_HTML.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def main():
    results = []

    def record(label, value):
        results.append((label, value))
        print("  %-34s %s" % (label, value), flush=True)

    srv = http.server.HTTPServer(("127.0.0.1", HTTP_PORT), Quiet)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env.update({
        "XDG_RUNTIME_DIR": "/run/user/1000",
        "WAYLAND_DISPLAY": "wayland-0",
        "DISPLAY": ":0",
    })

    argv = [
        "flatpak", "run", FLATPAK_ID,
        # MEASURED 2026-07-27: without this Chrome picks the X11 ozone backend,
        # and from a non-graphical parent (ssh, or a systemd user service --
        # i.e. exactly how the agent would spawn it) there is no xauth cookie:
        #   "Authorization required, but no authorization protocol specified"
        #   "Missing X server or $DISPLAY ... The platform failed to initialize"
        # and Chrome exits before it ever binds the debugging port.
        "--ozone-platform=wayland",
        "--user-data-dir=" + PROFILE,
        "--no-first-run", "--no-default-browser-check",
        "--remote-debugging-port=%d" % CDP_PORT,
        "--window-size=1280,720",
        "--app=about:blank",
    ]
    print("launching: %s\n" % " ".join(argv), flush=True)
    errlog = open("/tmp/spike-chrome.err", "wb")
    proc = subprocess.Popen(argv, env=env, stdout=errlog,
                            stderr=errlog, start_new_session=True)

    try:
        print("Q1  CDP reachable from host loopback (flatpak shared=network)")
        version = None
        last_err = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                version = json.loads(http_get(
                    "http://127.0.0.1:%d/json/version" % CDP_PORT))
                break
            except Exception as exc:
                last_err = "%s: %s" % (type(exc).__name__, exc)
                time.sleep(1)
        if not version:
            record("cdp endpoint", "UNREACHABLE after 60s -> %s" % last_err)
            record("chrome alive", proc.poll() is None)
            try:
                with open("/tmp/spike-chrome.err", "rb") as fh:
                    record("chrome stderr tail", fh.read()[-600:])
            except Exception:
                pass
            return 1
        record("cdp endpoint", "reachable")
        record("browser", version.get("Browser"))
        record("user agent", version.get("User-Agent"))

        targets = json.loads(http_get("http://127.0.0.1:%d/json/list" % CDP_PORT))
        pages = [t for t in targets if t.get("type") == "page"]
        if not pages:
            record("page target", "NONE FOUND -> DESIGN BLOCKED")
            return 1
        ws = WS(pages[0]["webSocketDebuggerUrl"])
        ws.call("Runtime.enable")
        ws.call("Page.enable")
        record("page target", "attached (%s)" % pages[0].get("url"))

        print("\nQ4  automation tells a service could block on")
        record("navigator.webdriver", evaluate(ws, "String(navigator.webdriver)"))
        ua = evaluate(ws, "navigator.userAgent")
        record("ua contains HeadlessChrome",
               "YES" if "Headless" in str(ua) else "no")
        record("navigator.plugins.length",
               evaluate(ws, "navigator.plugins.length"))

        print("\nQ2  Widevine CDM loads with CDP attached")
        record("widevine key system", evaluate(ws, """
            navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
              initDataTypes: ['cenc'],
              videoCapabilities: [{
                contentType: 'video/mp4;codecs="avc1.42E01E"',
                robustness: 'SW_SECURE_DECODE'}]}])
              .then(a => 'GRANTED ' + a.keySystem)
              .catch(e => 'DENIED ' + e.name + ': ' + e.message)
        """, await_promise=True))
        record("hw-secure (L1) probe", evaluate(ws, """
            navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
              initDataTypes: ['cenc'],
              videoCapabilities: [{
                contentType: 'video/mp4;codecs="avc1.42E01E"',
                robustness: 'HW_SECURE_ALL'}]}])
              .then(a => 'GRANTED (L1)')
              .catch(e => 'DENIED (expected on L3): ' + e.name)
        """, await_promise=True))

        print("\nQ3  encrypted content actually plays, CDP attached  [CONTROL]")
        ws.call("Page.navigate",
                {"url": "http://127.0.0.1:%d/drm.html" % HTTP_PORT})
        state = {}
        for _ in range(40):
            time.sleep(1)
            state = evaluate(ws, "JSON.stringify(window.__st || {})")
            try:
                state = json.loads(state) if isinstance(state, str) else {}
            except Exception:
                state = {}
            if state.get("stage") in ("playing", "error", "throw", "unsupported"):
                if state.get("stage") != "playing" or (state.get("t") or 0) > 1.0:
                    break
        record("shaka stage", state.get("stage"))
        record("video currentTime", state.get("t"))
        record("video duration", state.get("dur"))
        if state.get("err"):
            record("shaka error", "%s %s" % (state.get("err"),
                                             state.get("detail")))
        record("VERDICT drm playback",
               "WORKS" if (state.get("t") or 0) > 0.5 else "FAILED")

        print("\nQ5  real services render (logged OUT, fresh profile)")
        for name, url in (("max", "https://play.max.com/"),
                          ("netflix", "https://www.netflix.com/"),
                          ("hulu", "https://www.hulu.com/")):
            ws.call("Page.navigate", {"url": url})
            time.sleep(9)
            title = evaluate(ws, "document.title")
            body = evaluate(ws, "(document.body ? document.body.innerText : '')"
                                ".slice(0, 400).replace(/\\s+/g, ' ')")
            blocked = any(s in str(body).lower() for s in (
                "unsupported browser", "not supported", "update your browser",
                "browser isn't supported", "browser is not supported"))
            record("%s title" % name, title)
            record("%s browser-wall" % name, "BLOCKED" if blocked else "no")
            record("%s body[:160]" % name, str(body)[:160])

    finally:
        print("\ncleanup", flush=True)
        try:
            subprocess.run(["flatpak", "kill", FLATPAK_ID], env=env, timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        try:
            os.killpg(os.getpgid(proc.pid), 15)
        except Exception:
            pass
        srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
