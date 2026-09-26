#!/usr/bin/env python3
"""Windows agent: the anti-DNS-rebinding Host gate on the loopback-only /pair page.

Run: python3 tests/test_win_host_gate.py

WHY THIS EXISTS (KI-087). /pair embeds the bearer token, so it is gated on two
axes: the socket peer must be loopback AND the Host header must name loopback.
The Host half is what stops a page in the box's OWN browser from rebinding its
domain to 127.0.0.1 and reading the token. That half used to be
`host.startswith("127.")`, which also accepts a rebindable HOSTNAME such as
127.0.0.1.evil.com — so the gate could be walked around. The fix parses the host
as an address. This file pins both directions (§11.2): the spoof names must be
refused, and the real loopback names the box's own launcher uses must still pass —
a gate that rejects `localhost` would break pairing on every Windows box.

Control: before the fix, every name in SPOOF returned True (reproduced 2026-09-24).

Pure stdlib, cross-platform: the Windows agent module imports on macOS/Linux
(winreg and the PowerShell bridge are guarded), and the gate is a pure function of
the Host header, so it is exercised directly with a stand-in request object.
"""
import importlib.util
import os
import sys
from http.server import BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "win", "couchsided-win.py")
spec = importlib.util.spec_from_file_location("couchsided_win", AGENT)
win = importlib.util.module_from_spec(spec)
sys.modules["couchsided_win"] = win
spec.loader.exec_module(win)

# The request handler class, found by type rather than by name so a rename does
# not silently turn this into a test of nothing.
Handler = next(v for v in vars(win).values()
               if isinstance(v, type) and issubclass(v, BaseHTTPRequestHandler)
               and v is not BaseHTTPRequestHandler)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class _Req:
    """Just enough of a request for the gate: it only reads self.headers."""
    def __init__(self, host):
        self.headers = {"Host": host}


def gate(host):
    return Handler._host_header_is_local(_Req(host))


# Names an attacker can point at 127.0.0.1. All must be refused.
SPOOF = (
    "127.0.0.1.evil.com",
    "127.0.0.1.evil.com:8787",
    "127.example.com",
    "localhost.evil.com",
    "attacker.tld:8787",
    "127.0.0.1evil",
    "",
)

# What the box's own launcher / kiosk actually sends. All must still pass.
LEGIT = (
    "localhost",
    "localhost:8787",
    "127.0.0.1",
    "127.0.0.1:8787",
    "127.0.0.53",
    "::1",
    "[::1]",
    "[::1]:8787",
    "LOCALHOST:8787",   # header case is not significant
)


def test_spoof_names_refused():
    print("test_spoof_names_refused")
    for h in SPOOF:
        check("refuses Host %r" % h, gate(h), False)


def test_loopback_names_still_pass():
    print("test_loopback_names_still_pass")
    for h in LEGIT:
        check("accepts Host %r" % h, gate(h), True)


if __name__ == "__main__":
    test_spoof_names_refused()
    test_loopback_names_still_pass()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
