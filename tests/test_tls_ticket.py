#!/usr/bin/env python3
"""Short-lived TLS tickets (P5) — POST /api/ticket + ?ticket= on un-pinnable loads.

Run: python3 tests/test_tls_ticket.py

The app pins its own TLS socket for the API/WS, but the native <Image> loader and
the streamed uploader cannot pin a self-signed cert. Rather than put the bearer
token on those cleartext requests, the app mints a SHORT-LIVED ticket over the
pinned channel and passes ?ticket=. This proves the ticket is a strictly weaker
credential than the token:

  * mint is BEARER-GATED (401 without the token) — a ticket can't bootstrap a ticket.
  * a valid ticket authorizes an IMAGE GET (?ticket=) but NOT a control route.
  * image tickets cannot upload; upload tickets cannot read images.
  * a single-use ('once') ticket is BURNED on first use — a sniffed upload URL
    cannot be replayed.
  * expired / unknown / empty tickets are refused (degrade closed).

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import threading
import time
import tempfile
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path

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
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


# ---- ticket lifecycle (pure) -----------------------------------------------

def test_ticket_lifecycle():
    t = cs._mint_ticket(once=False)
    check(cs._ticket_ok(t, "image") and cs._ticket_ok(t, "image"),
          "multi-use image ticket validates repeatedly")
    check(not cs._ticket_ok(t, "upload"), "image ticket cannot authorize upload scope")
    check(not cs._ticket_ok(t, "unknown"), "unknown scope refused")

    o = cs._mint_ticket(once=True)
    check(not cs._ticket_ok(o, "image"), "upload ticket cannot authorize image scope")
    first = cs._ticket_ok(o, "upload")
    second = cs._ticket_ok(o, "upload")
    check(first and not second, "single-use ticket is CONSUMED after one use", (first, second))

    check(not cs._ticket_ok("", "image"), "empty ticket refused")
    check(not cs._ticket_ok("deadbeef" * 4, "image"), "unknown ticket refused")

    # Expired: mint then force its expiry into the past.
    e = cs._mint_ticket()
    with cs._TICKETS_LOCK:
        cs._TICKETS[e]["exp"] = time.time() - 1
    check(not cs._ticket_ok(e, "image"), "expired ticket refused")
    with cs._TICKETS_LOCK:
        check(e not in cs._TICKETS, "expired ticket is pruned on access")


# ---- live endpoint + image-route acceptance --------------------------------

class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import ssl
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, ssl.SSLError, OSError)):
            return
        super().handle_error(request, client_address)


class _ImageFixtureHandler(cs.Handler):
    # Only replace image retrieval: the real routes and authorization gates run.
    # No external cover/store fetch is needed to prove the permission boundary.
    def _handle_steam_cover(self, appid, started):
        self._send(200, {"fixture": "cover"}, started)

    def _handle_decky_icon(self, seg, started):
        self._send(200, {"fixture": "icon"}, started)


def _serve():
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True
    cs.Handler.tls_info = None
    srv = _QuietServer(("127.0.0.1", 0), _ImageFixtureHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Connection": "close"}
    if token:
        headers["Authorization"] = "Bearer " + token
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(body or b"{}")
    except ValueError:
        return resp.status, {}


def test_endpoint_and_image_auth():
    srv, port = _serve()
    try:
        # mint is bearer-gated
        st, _ = _req(port, "POST", "/api/ticket", token=None)
        check(st == 401, "POST /api/ticket without token -> 401", st)
        st, body = _req(port, "POST", "/api/ticket", token=TOKEN)
        ticket = body.get("ticket", "")
        check(st == 200 and len(ticket) == 32, "POST /api/ticket with token -> 200 + ticket", (st, body))

        # a valid ticket authorizes an IMAGE GET (?ticket=): _authorized_image
        # passes, so we DON'T get a 401 (404/200 depending on cover presence).
        st, _ = _req(port, "GET", "/api/steam/123/cover?ticket=" + ticket)
        check(st != 401, "valid ticket authorizes /api/steam/<id>/cover (not 401)", st)
        # a garbage ticket does NOT authorize the image
        st, _ = _req(port, "GET", "/api/steam/123/cover?ticket=" + ("00" * 16))
        check(st == 401, "garbage ticket on cover -> 401", st)

        # a ticket must NOT satisfy a control route (state-changing): the query
        # form is scoped to image GETs only.
        st, _ = _req(port, "GET", "/api/status?ticket=" + ticket)
        check(st == 401, "ticket does NOT authorize /api/status (control) -> 401", st)

        # single-use upload ticket: valid once (upload handler runs), then burned.
        st, b = _req(port, "POST", "/api/ticket?once=1", token=TOKEN)
        up = b.get("ticket", "")
        st1, _ = _req(port, "POST", "/api/upload?name=x.bin&ticket=" + up)
        st2, _ = _req(port, "POST", "/api/upload?name=x.bin&ticket=" + up)
        # first use is NOT a 401 (handler reached); the second, burned, IS a 401.
        check(st1 != 401 and st2 == 401,
              "single-use upload ticket accepted once then refused (no replay)", (st1, st2))
    finally:
        srv.shutdown()
        srv.server_close()


def test_scoped_ticket_compatibility():
    """Exercise the shipped app's unchanged URLs with real temporary uploads."""
    previous_drop = os.environ.get("COUCHSIDE_DROP_DIR")
    with tempfile.TemporaryDirectory(prefix="couchside-ticket-") as tmp:
        drop = Path(tmp) / "drop"
        os.environ["COUCHSIDE_DROP_DIR"] = str(drop)
        srv, port = _serve()
        try:
            st, body = _req(port, "POST", "/api/ticket", token=TOKEN)
            image = body.get("ticket", "")
            check(st == 200 and set(body) == {"ticket", "ttl"} and body["ttl"] == 300,
                  "existing mint response stays ticket + 300-second ttl", body)

            # A read-only image credential must never become a write credential.
            for n in range(2):
                st, _ = _req(port, "POST", "/api/upload?name=denied.bin&ticket=" + image,
                             body=b"must not be written")
                check(st == 401, "image ticket upload attempt %d -> 401" % (n + 1), st)
            check(not drop.exists() or not any(drop.iterdir()),
                  "rejected image-ticket uploads leave no file or partial file")

            for path in ("/api/steam/123/cover", "/api/decky/store/icon/123"):
                statuses = [_req(port, "GET", path + "?ticket=" + image)[0] for _ in range(2)]
                check(statuses == [200, 200], "image ticket remains reusable on " + path, statuses)
                check(_req(port, "GET", path, token=TOKEN)[0] == 200,
                      "legacy bearer image access still works on " + path)
                check(_req(port, "GET", path + "?token=" + TOKEN)[0] == 200,
                      "legacy query-token image access still works on " + path)

            st, _ = _req(port, "POST", "/api/ticket?ticket=" + image)
            check(st == 401, "image ticket cannot mint another ticket", st)
            st, _ = _req(port, "POST", "/api/actions/not-an-action?ticket=" + image)
            check(st == 401, "image ticket cannot authorize a control POST", st)

            # All already-supported once spellings retain single-use uploads.
            payload = b"ticket-scoped upload fixture\x00\xff"
            for flag in ("1", "true", "yes"):
                st, body = _req(port, "POST", "/api/ticket?once=" + flag, token=TOKEN)
                upload = body.get("ticket", "")
                check(st == 200 and len(upload) == 32, "once=" + flag + " still mints a ticket", st)
                for path in ("/api/steam/123/cover", "/api/decky/store/icon/123"):
                    st, _ = _req(port, "GET", path + "?ticket=" + upload)
                    check(st == 401, "upload ticket cannot read " + path, st)
                st, _ = _req(port, "GET", "/api/status?ticket=" + upload)
                check(st == 401, "upload ticket cannot read protected status", st)
                st, _ = _req(port, "POST", "/api/ticket?ticket=" + upload)
                check(st == 401, "upload ticket cannot mint another ticket", st)
                name = "upload-" + flag + ".bin"
                path = "/api/upload?name=" + name + "&ticket=" + upload
                st, _ = _req(port, "POST", path, body=payload)
                check(st == 200 and (drop / name).read_bytes() == payload,
                      "wrong-scope attempts do not consume valid upload (once=" + flag + ")", st)
                st, _ = _req(port, "POST", path, body=b"replay")
                check(st == 401 and (drop / name).exists() and (drop / name).read_bytes() == payload,
                      "upload replay cannot overwrite saved bytes (once=" + flag + ")", st)

            # Full bearer auth still authorizes uploads, even if the URL carries
            # an image ticket (the ticket must not veto a valid stronger credential).
            st, _ = _req(port, "POST", "/api/upload?name=bearer.bin&ticket=" + image,
                         token=TOKEN, body=payload)
            check(st == 200 and (drop / "bearer.bin").read_bytes() == payload,
                  "existing bearer upload works with a wrong-scope ticket present", st)

            _, body = _req(port, "POST", "/api/ticket?once=1", token=TOKEN)
            expired = body["ticket"]
            with cs._TICKETS_LOCK:
                cs._TICKETS[expired]["exp"] = time.time() - 1
            st, _ = _req(port, "POST", "/api/upload?name=expired.bin&ticket=" + expired,
                         body=payload)
            check(st == 401 and not (drop / "expired.bin").exists(),
                  "expired upload ticket cannot write a file", st)

            # Requests start together with different names, so no file race can
            # hide multiple authorizations. Exactly one request may write.
            _, body = _req(port, "POST", "/api/ticket?once=1", token=TOKEN)
            upload = body["ticket"]
            barrier = threading.Barrier(6)

            def race(n):
                barrier.wait(timeout=10)
                return _req(port, "POST", "/api/upload?name=race-%d.bin&ticket=" % n + upload,
                            body=payload)[0]

            with ThreadPoolExecutor(max_workers=6) as pool:
                statuses = list(pool.map(race, range(6)))
            files = list(drop.glob("race-*.bin"))
            check(sorted(statuses) == [200, 401, 401, 401, 401, 401],
                  "six concurrent reuses authorize exactly one upload", statuses)
            check(len(files) == 1 and files[0].read_bytes() == payload,
                  "concurrent ticket reuse writes exactly one complete file")
        finally:
            srv.shutdown()
            srv.server_close()
            if previous_drop is None:
                os.environ.pop("COUCHSIDE_DROP_DIR", None)
            else:
                os.environ["COUCHSIDE_DROP_DIR"] = previous_drop


if __name__ == "__main__":
    test_ticket_lifecycle()
    test_endpoint_and_image_auth()
    test_scoped_ticket_compatibility()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all TLS ticket tests passed")
