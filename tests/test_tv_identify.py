#!/usr/bin/env python3
"""Tests for identify_tv() — what KIND of device is at this address.

Run: python3 tests/test_tv_identify.py

WHY THIS EXISTS: the app used to ask the user to pick a brand, then fire that
brand's pairing at whatever IP was in the box. Aiming it at the wrong device
produced a raw socket error. Reported from the field, pairing an LG:

    Could not reach the box or TV. Check the IP and try again.
    — box says: HTTP 502: pairing failed: _ssl.c:1063:
      The handshake operation timed out

The address was an LG COMMERCIAL signage panel that the scan had offered and
the app had pre-filled. Nothing in that message says so.

THE TRAP, measured on real hardware (both devices on one network):

    10.7.0.178  LG signage    3001 OPEN (6ms), TLS NEVER COMPLETES, 9761 OPEN
    10.7.0.205  consumer 85"  3001 OPEN,       TLS completes TLSv1.3, 9761 REFUSED

So "port 3001 is open" does NOT mean "consumer webOS TV". The handshake has to
actually complete, and the commercial panel is positively identifiable by 9761.
Order matters: the commercial check MUST precede the consumer one, because both
open 3001.

Verified live against three real devices and one empty address; these tests
lock in that behaviour with the sockets stubbed.

Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os

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


def fake(open_ports, tls_ok=(), http=None):
    """Stub the three primitives identify_tv probes with."""
    o = (cs._port_open, cs._tls_completes, cs._discover_http)
    cs._port_open = lambda h, p, timeout=1.5: p in open_ports
    cs._tls_completes = lambda h, p, timeout=4.0: p in tls_ok
    cs._discover_http = lambda url, timeout=2.0: (http or "")
    return o


def restore(o):
    cs._port_open, cs._tls_completes, cs._discover_http = o


def test_commercial_vs_consumer_lg():
    print("the LG trap: signage panel vs consumer TV")
    # The panel: 3001 open but the handshake never completes, 9761 open.
    o = fake({3001, cs.LG_COMMERCIAL_PORT}, tls_ok=())
    try:
        r = cs.identify_tv("10.0.0.1")
        check(r["brand"] == "lg_commercial", "signage panel identified as commercial")
        check(r["supported"] is False, "and reported as NOT pairable")
        check("commercial" in r["reason"].lower() or "signage" in r["reason"].lower(),
              "reason names what it actually is")
        check("_ssl" not in r["reason"], "reason is a sentence, not a socket error")
    finally:
        restore(o)

    # The consumer TV: 3001 open AND the handshake completes; no 9761.
    o = fake({3001}, tls_ok={3001})
    try:
        r = cs.identify_tv("10.0.0.2")
        check(r["brand"] == "webos", "consumer webOS identified")
        check(r["supported"] is True, "and reported as pairable")
    finally:
        restore(o)


def test_open_3001_alone_is_not_webos():
    print("an open port is not an identification")
    # 3001 open, no 9761, handshake fails: something else entirely. Guessing
    # "webos" here is what produced the raw TLS error in the field.
    o = fake({3001}, tls_ok=())
    try:
        r = cs.identify_tv("10.0.0.3")
        check(r["brand"] is None, "not claimed as webOS on an open port alone")
        check(r["supported"] is False, "not offered as pairable")
        check("handshake" in r["reason"] or "not answering" in r["reason"],
              "reason explains the handshake, in words")
    finally:
        restore(o)


def test_commercial_wins_over_consumer_order():
    print("check order: 9761 decides even when 3001 would handshake")
    # A panel that BOTH opens 9761 and completes TLS on 3001 must still read as
    # commercial -- the consumer branch must not be reached first.
    o = fake({3001, cs.LG_COMMERCIAL_PORT}, tls_ok={3001})
    try:
        check(cs.identify_tv("10.0.0.4")["brand"] == "lg_commercial",
              "commercial check precedes the consumer check")
    finally:
        restore(o)


def test_other_brands():
    print("the remaining brands")
    o = fake({cs.ROKU_PORT}, http="<device-info><friendly-device-name>Den Roku"
                                  "</friendly-device-name></device-info>")
    try:
        r = cs.identify_tv("10.0.0.5")
        check(r["brand"] == "roku", "Roku identified from its ECP reply")
        check(r["label"] == "Den Roku", "and names itself")
    finally:
        restore(o)

    for ports, brand in ((({cs.SAMSUNG_PORT}), "samsung"),
                         (({cs.ANDROIDTV_REMOTE_PORT}), "androidtv"),
                         (({cs.VIDAA_PORT}), "vidaa")):
        o = fake(ports)
        try:
            check(cs.identify_tv("10.0.0.6")["brand"] == brand, "%s identified" % brand)
        finally:
            restore(o)


def test_nothing_there():
    print("an address with nothing on it")
    o = fake(set())
    try:
        r = cs.identify_tv("10.0.0.7")
        check(r["brand"] is None, "no brand claimed")
        # A TV in standby is the common case and the user can act on it.
        check("powered on" in r["reason"] or "standby" in r["reason"],
              "reason suggests the TV may be off, which is actionable")
    finally:
        restore(o)

    r = cs.identify_tv("")
    check(r["brand"] is None and not r["supported"], "empty address is handled")


if __name__ == "__main__":
    test_commercial_vs_consumer_lg()
    test_open_3001_alone_is_not_webos()
    test_commercial_wins_over_consumer_order()
    test_other_brands()
    test_nothing_there()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all tv-identify tests passed")
