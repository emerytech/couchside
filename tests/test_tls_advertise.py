#!/usr/bin/env python3
"""TLS availability advertisement on the pre-auth surfaces (TLS P2).

Run: python3 tests/test_tls_advertise.py

TLS is a TRANSPORT concern, not a capability (it can't be read over the transport
whose scheme it selects), so a future TLS-aware app must DISCOVER the HTTPS listener
on the surfaces it already reaches unauthenticated: GET /api/ping, the UDP discovery
reply, and the pairing QR (build_pair_url). This proves those three advertise the
listener additively.

The decisive control (CLAUDE.md §11 observe-both-states): when TLS is DARK the payload
is BYTE-FOR-BYTE what every shipped app already parses, and when TLS is ENABLED the new
tls_* fields are the ONLY difference — stripping them reproduces the dark bytes exactly.
That is what keeps an old app working against a TLS-advertising agent (CLAUDE.md §4:
never change existing response shapes; additive only).

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import threading
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
# A plausible advert: real fp/spki are 64-hex SHA-256 digests.
ADVERT = {"port": 8791, "fp": "ab" * 32, "spki": "cd" * 32}


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _strip_tls(d):
    return {k: v for k, v in d.items() if not str(k).startswith("tls_")}


# ---- /api/ping (pre-auth) --------------------------------------------------

class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import ssl
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, ssl.SSLError, OSError)):
            return
        super().handle_error(request, client_address)


def _plain_ping(port):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", "/api/ping", headers={"Connection": "close"})
    resp = conn.getresponse()
    body = json.loads(resp.read() or b"{}")
    st = resp.status
    conn.close()
    return st, body


def test_ping_advertises_additively():
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True
    saved = cs.Handler.tls_info
    srv = _QuietServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        # DARK: tls_info None -> no tls_* keys at all.
        cs.Handler.tls_info = None
        st, dark = _plain_ping(port)
        check(st == 200, "ping 200 (dark)", st)
        check(not any(str(k).startswith("tls_") for k in dark),
              "ping dark: no tls_* keys", list(dark))

        # ENABLED: tls_info set -> tls_port/fp/spki appended, nothing else changed.
        cs.Handler.tls_info = {"cert_pem": "x", "fp": ADVERT["fp"],
                               "spki": ADVERT["spki"], "port": ADVERT["port"]}
        st, on = _plain_ping(port)
        check(st == 200, "ping 200 (tls enabled)", st)
        check(on.get("tls_port") == ADVERT["port"] and
              on.get("tls_fp") == ADVERT["fp"] and
              on.get("tls_spki") == ADVERT["spki"],
              "ping enabled: tls_port/tls_fp/tls_spki present + correct",
              {k: on.get(k) for k in ("tls_port", "tls_fp", "tls_spki")})
        # THE CONTROL: the enabled payload minus the tls_* keys IS the dark payload.
        check(_strip_tls(on) == dark,
              "ping enabled minus tls_* == dark payload (additive only)",
              (dark, on))
    finally:
        cs.Handler.tls_info = saved
        srv.shutdown()


# ---- UDP discovery reply ----------------------------------------------------

def test_discovery_reply_additive():
    saved = cs.TLS_ADVERT
    try:
        cs.TLS_ADVERT = None
        dark = cs._discovery_reply(8787)
        dark_bytes = json.dumps(dark).encode()
        check(set(dark) == {"couchside", "name", "host", "port", "version"},
              "discovery dark: exactly the 5 legacy keys", list(dark))

        cs.TLS_ADVERT = dict(ADVERT)
        on = cs._discovery_reply(8787)
        check(on.get("tls_port") == ADVERT["port"] and
              on.get("tls_fp") == ADVERT["fp"] and
              on.get("tls_spki") == ADVERT["spki"],
              "discovery enabled: tls_port/tls_fp/tls_spki present",
              {k: on.get(k) for k in ("tls_port", "tls_fp", "tls_spki")})
        # CONTROL: strip tls_* -> byte-identical to the dark reply (order preserved).
        check(json.dumps(_strip_tls(on)).encode() == dark_bytes,
              "discovery enabled minus tls_* is byte-identical to dark",
              (dark_bytes, json.dumps(_strip_tls(on)).encode()))
    finally:
        cs.TLS_ADVERT = saved


def test_discovery_advert_absent_when_no_port():
    """Degrade-closed: a half-populated advert (no port) advertises nothing."""
    saved = cs.TLS_ADVERT
    try:
        cs.TLS_ADVERT = {"fp": ADVERT["fp"]}  # no port
        r = cs._discovery_reply(8787)
        check(not any(str(k).startswith("tls_") for k in r),
              "discovery: advert without a port -> no tls_* keys", list(r))
    finally:
        cs.TLS_ADVERT = saved


# ---- pairing QR (build_pair_url) -------------------------------------------

def test_pair_url_additive():
    saved = cs.TLS_ADVERT
    try:
        cs.TLS_ADVERT = None
        dark = cs.build_pair_url("tok", 8787)
        check(dark.startswith("https://couchside.tv/pair#host="),
              "pair url dark: shape unchanged", dark)
        check("tlsport=" not in dark and "&fp=" not in dark,
              "pair url dark: no tlsport / fp", dark)

        cs.TLS_ADVERT = dict(ADVERT)
        on = cs.build_pair_url("tok", 8787)
        # CONTROL: the dark URL is an exact prefix; TLS params are strictly appended.
        check(on.startswith(dark),
              "pair url enabled: dark url is an exact prefix (additive)", (dark, on))
        check(on == dark + "&tlsport=%d&fp=%s" % (ADVERT["port"], ADVERT["fp"]),
              "pair url enabled: appends &tlsport=&fp= only", on)
    finally:
        cs.TLS_ADVERT = saved


if __name__ == "__main__":
    test_ping_advertises_additively()
    test_discovery_reply_additive()
    test_discovery_advert_absent_when_no_port()
    test_pair_url_additive()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all TLS advertise tests passed")
