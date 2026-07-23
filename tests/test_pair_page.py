#!/usr/bin/env python3
"""Tests for the on-box pairing page — the idle tutorial, the PIN, the handoff,
the two gates, and the KI-019 box-pop throttle.

Run: python3 tests/test_pair_page.py

WHY THIS EXISTS. `/pair` renders the pairing TOKEN as a QR and the live PIN, so
it is gated to loopback on TWO axes (peer IP and Host header, anti-DNS-rebinding)
— get either wrong and a LAN peer reads a box's token off its own screen. The
gate tests below are the point of this file. It also covers what KI-020 flagged
as untested: the PIN start/check state machine (attempt cap, expiry, single-use).

The idle tutorial and its handoff-to-PIN are new (the pairing-tutorial feature).
The handoff — idle page reloads into the PIN the instant a session starts — is
the one bug the design can ship: a tutorial that never hands off. It was proven
end to end on a real box's CEF, but the page's structural half (it polls, and it
reloads on active===true) is asserted here so a refactor can't quietly break it.
"""
import importlib.util
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --- the two loopback gates ------------------------------------------------
# _is_loopback and _host_header_is_local are plain methods reading
# self.client_address / self.headers, so a tiny stand-in exercises them without
# a socket. Half the security model is here; the other half is that /pair only
# ever calls these, verified by reading the dispatch.

class FakeHeaders(dict):
    def get(self, k, default=None):
        return dict.get(self, k, default)


class FakePeer:
    def __init__(self, ip, host_header):
        self.client_address = (ip, 12345)
        self.headers = FakeHeaders({"Host": host_header} if host_header else {})


def test_loopback_gate():
    print("test_loopback_gate")
    il = cs.Handler._is_loopback
    check("127.0.0.1 is loopback", il(FakePeer("127.0.0.1", "")), True)
    check("::1 is loopback", il(FakePeer("::1", "")), True)
    check("v4-mapped ::ffff:127.0.0.1 is loopback",
          il(FakePeer("::ffff:127.0.0.1", "")), True)
    # THE refusal: a real LAN peer must NOT pass. This is the gate that keeps a
    # box's token off the LAN.
    check("10.x LAN peer is NOT loopback", il(FakePeer("10.1.1.50", "")), False)
    check("192.168 LAN peer is NOT loopback", il(FakePeer("192.168.1.9", "")), False)


def test_host_header_gate():
    print("test_host_header_gate")
    hl = cs.Handler._host_header_is_local
    check("Host localhost:8787 is local", hl(FakePeer("127.0.0.1", "localhost:8787")), True)
    check("Host 127.0.0.1 is local", hl(FakePeer("127.0.0.1", "127.0.0.1:8787")), True)
    check("Host [::1] is local", hl(FakePeer("127.0.0.1", "[::1]:8787")), True)
    # Anti-DNS-rebinding: a loopback PEER with an attacker Host must be refused.
    # This is exactly the case _is_loopback alone would wave through.
    check("Host attacker.tld is NOT local",
          hl(FakePeer("127.0.0.1", "attacker.tld:8787")), False)
    check("Host a public IP is NOT local",
          hl(FakePeer("127.0.0.1", "203.0.113.7:8787")), False)


# --- the idle tutorial page ------------------------------------------------

def test_idle_page_has_the_tutorial():
    print("test_idle_page_has_the_tutorial")
    html = cs.render_pair_page("a" * 64, 8787)
    check("step 1 present", "Open Couchside on your phone" in html, True)
    check("step 2 present", "Scan for boxes" in html, True)
    check("step 3 present", "6-digit PIN appears here" in html, True)
    # The QR must survive — the Steam tile's documented job is re-showing it.
    check("QR canvas kept", 'id="qr"' in html and "qrcode(0)" in html, True)
    # CSS animation, not JS — the phone mock cross-fades on @keyframes.
    check("keyframe animation present", "@keyframes cs" in html, True)
    check("inline svg present", "<svg" in html and "</svg>" in html, True)


def test_idle_page_hands_off():
    print("test_idle_page_hands_off")
    html = cs.render_pair_page("a" * 64, 8787)
    # THE HANDOFF, asserted structurally: it polls status and reloads when a
    # session goes active. Both halves must be present or the tutorial strands
    # the user on a page that never becomes the PIN.
    check("polls /api/pair/status", "/api/pair/status" in html, True)
    check("reloads on active", "location.reload()" in html, True)
    check("guards against active===false", "active===true" in html, True)


def test_live_pin_page_is_the_pin_not_the_tutorial():
    """When a session is live the route serves render_pin_page, NOT the tutorial.
    The two must not blur: the PIN page is a single huge number, nothing else."""
    print("test_live_pin_page_is_the_pin_not_the_tutorial")
    pin_html = cs.render_pin_page("123456")
    check("shows the PIN prompt", "ENTER THIS PIN IN THE APP" in pin_html, True)
    check("no tutorial steps on the PIN page",
          "Open Couchside on your phone" not in pin_html, True)
    check("no QR on the PIN page", "qrcode(0)" not in pin_html, True)


# --- the PIN state machine (KI-020) ----------------------------------------

def _reset_pin():
    with cs.PAIR_PIN_LOCK:
        cs.PAIR_PIN = None


def test_pin_start_is_debounced_and_marks_fresh():
    print("test_pin_start_is_debounced_and_marks_fresh")
    _reset_pin()
    pin1, ttl1, fresh1 = cs.pair_pin_start()
    check("first start is fresh", fresh1, True)
    check("ttl is the full window", ttl1, cs.PAIR_PIN_TTL)
    pin2, _ttl2, fresh2 = cs.pair_pin_start()
    # Within the debounce window: same PIN, NOT fresh. This is what gates the
    # box-screen pop (KI-019) — a double-tap must not re-throw the page onto the
    # TV.
    check("second start within debounce is NOT fresh", fresh2, False)
    check("second start returns the SAME pin", pin2, pin1)


def test_pin_check_counts_attempts_and_caps():
    print("test_pin_check_counts_attempts_and_caps")
    _reset_pin()
    pin, _ttl, _fresh = cs.pair_pin_start()
    wrong = "000000" if pin != "000000" else "111111"
    for i in range(cs.PAIR_PIN_MAX_ATTEMPTS):
        try:
            cs.pair_pin_check(wrong)
            check("wrong pin should raise (attempt %d)" % i, True, False)
        except ValueError as e:
            check("attempt %d rejected" % i, "wrong PIN" in str(e), True)
    # Cap reached: the session is burned, even a CORRECT pin now fails.
    try:
        cs.pair_pin_check(pin)
        check("correct pin after cap should raise", True, False)
    except ValueError as e:
        check("cap burns the session", "too many" in str(e), True)


def test_pin_check_is_single_use():
    print("test_pin_check_is_single_use")
    _reset_pin()
    pin, _ttl, _fresh = cs.pair_pin_start()
    check("correct pin accepted once", cs.pair_pin_check(pin), True)
    # Consumed on success — a replay must not pair again.
    try:
        cs.pair_pin_check(pin)
        check("replay should raise", True, False)
    except ValueError as e:
        check("session consumed on success", "no active pairing" in str(e), True)


def test_pin_expiry_clears_the_session():
    print("test_pin_expiry_clears_the_session")
    _reset_pin()
    pin, _ttl, _fresh = cs.pair_pin_start()
    # Force expiry without sleeping 120s.
    with cs.PAIR_PIN_LOCK:
        cs.PAIR_PIN["expires"] = time.monotonic() - 1
    check("expired session reports inactive", cs.pair_pin_active(), None)
    try:
        cs.pair_pin_check(pin)
        check("check on expired should raise", True, False)
    except ValueError as e:
        check("expiry clears the session", "no active pairing" in str(e), True)


# --- KI-019: the box-screen pop is throttled -------------------------------

def test_box_pop_is_rate_limited():
    """KI-019: any LAN peer could pop the page full-screen repeatedly. The pop
    is now gated on a fresh mint AND throttled. Here we prove the throttle: back
    -to-back pops fire ONCE."""
    print("test_box_pop_is_rate_limited")
    fired = []
    real = cs.pair_show_on_box_url
    cs.pair_show_on_box_url = lambda url: fired.append(url)
    # reset the cooldown clock so this test is order-independent
    with cs._BOX_POP_LOCK:
        cs._BOX_POP_AT[0] = 0.0
    try:
        cs.pair_show_on_box(8787)
        cs.pair_show_on_box(8787)
        cs.pair_show_on_box(8787)
        check("three rapid pops fire exactly once", len(fired), 1)
    finally:
        cs.pair_show_on_box_url = real


if __name__ == "__main__":
    for fn in (test_loopback_gate,
               test_host_header_gate,
               test_idle_page_has_the_tutorial,
               test_idle_page_hands_off,
               test_live_pin_page_is_the_pin_not_the_tutorial,
               test_pin_start_is_debounced_and_marks_fresh,
               test_pin_check_counts_attempts_and_caps,
               test_pin_check_is_single_use,
               test_pin_expiry_clears_the_session,
               test_box_pop_is_rate_limited):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
