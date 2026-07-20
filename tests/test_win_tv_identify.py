#!/usr/bin/env python3
"""Tests for the WINDOWS agent's ported TV identify + SSDP discovery (Phase 1).

Run: python3 tests/test_win_tv_identify.py

The smart-TV backends were ported from the Linux agent into
agent/win/couchsided-win.py. They are pure-stdlib sockets/TLS, so they IMPORT
and run on any OS (couchsided-win.py's Win32 bits are lazy ctypes calls, not
module-level), which is exactly why these tests can run in CI on Linux.

Locks in the same trap the Linux identify test does: an open port is NOT an
identification (the LG commercial panel opens 3001 and never completes TLS), and
the commercial check must precede the consumer webOS check because both open
3001.

Pure stdlib, no pytest -- same style as the other agent tests.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "win", "couchsided-win.py")
spec = importlib.util.spec_from_file_location("couchsided_win", AGENT)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def fake(open_ports, tls=(), http=""):
    o = (cw._port_open, cw._tls_completes, cw._discover_http)
    cw._port_open = lambda h, p, timeout=1.5: p in open_ports
    cw._tls_completes = lambda h, p, timeout=4.0: p in tls
    cw._discover_http = lambda u, timeout=2.0: http
    return o


def restore(o):
    cw._port_open, cw._tls_completes, cw._discover_http = o


def test_identify_lg_trap():
    print("identify: LG commercial vs consumer (the ordering trap)")
    o = fake({3001, cw.LG_COMMERCIAL_PORT}, tls=())
    try:
        r = cw.identify_tv("10.0.0.1")
        check(r["brand"] == "lg_commercial", "signage panel -> commercial")
        check(r["supported"] is False, "and NOT pairable")
        check("_ssl" not in r["reason"], "reason is a sentence, not a socket error")
    finally:
        restore(o)

    o = fake({3001}, tls={3001})
    try:
        check(cw.identify_tv("10.0.0.2")["brand"] == "webos", "consumer webOS identified")
    finally:
        restore(o)


def test_open_3001_not_webos():
    print("identify: an open port alone is not an identification")
    o = fake({3001}, tls=())
    try:
        r = cw.identify_tv("10.0.0.3")
        check(r["brand"] is None, "open 3001 + failed TLS -> None, not webos")
        check(r["supported"] is False, "not offered as pairable")
    finally:
        restore(o)


def test_commercial_precedes_consumer():
    print("identify: 9761 decides even when 3001 would handshake")
    o = fake({3001, cw.LG_COMMERCIAL_PORT}, tls={3001})
    try:
        check(cw.identify_tv("10.0.0.4")["brand"] == "lg_commercial",
              "commercial check runs before the consumer check")
    finally:
        restore(o)


def test_other_brands_and_nothing():
    print("identify: other brands, and an empty address")
    o = fake({cw.SAMSUNG_PORT})
    try:
        check(cw.identify_tv("10.0.0.5")["brand"] == "samsung", "samsung by port")
    finally:
        restore(o)
    o = fake({cw.ANDROIDTV_REMOTE_PORT})
    try:
        check(cw.identify_tv("10.0.0.6")["brand"] == "androidtv", "google tv by port")
    finally:
        restore(o)
    o = fake({cw.VIDAA_PORT})
    try:
        check(cw.identify_tv("10.0.0.7")["brand"] == "vidaa", "hisense by port")
    finally:
        restore(o)
    o = fake(set())
    try:
        r = cw.identify_tv("10.0.0.8")
        check(r["brand"] is None, "nothing there -> None")
        check("powered on" in r["reason"], "reason suggests the TV may be off")
    finally:
        restore(o)
    check(cw.identify_tv("")["brand"] is None, "empty address handled")


def test_discover_mock():
    print("discovery: --mock yields a stable pair")
    tvs = cw.tv_discover(True)
    brands = sorted(t["brand"] for t in tvs)
    check(brands == ["roku", "webos"], "mock discover -> webos + roku")


if __name__ == "__main__":
    test_identify_lg_trap()
    test_open_3001_not_webos()
    test_commercial_precedes_consumer()
    test_other_brands_and_nothing()
    test_discover_mock()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all win-tv-identify tests passed")
