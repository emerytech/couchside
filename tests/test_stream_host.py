#!/usr/bin/env python3
"""Tests for stream-host detection (GET /api/stream-host) — roadmap phase 4a.

Run: python3 tests/test_stream_host.py

Drives the REAL parsing/detection functions against /proc/net fixtures whose
lines were copied VERBATIM off the live box, so the traps they encode are the
real ones:
  * an ESTABLISHED TCP peer on 27036 is NOT a session — an idle box has one from
    the ROUTER (10.1.1.1). Detection must not treat it as active.
  * the clean idle baseline: the only connected UDP socket is DHCP (68<->67),
    and the streaming-port UDP socket has a zero remote.
  * a connected UDP peer on the transport range IS a live session, and names it.
Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os
import tempfile

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


TCP_HDR = ("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when "
           "retrnsmt   uid  timeout inode\n")
UDP_HDR = ("   sl  local_address rem_address   st tx_queue rx_queue tr tm->when "
           "retrnsmt   uid  timeout inode ref pointer drops\n")

# Verbatim off the live box while IDLE: 27036 (0x699C) listening, plus the
# router (10.1.1.1 = 0101010A) holding an ESTABLISHED (st 01) connection to it.
TCP_IDLE = TCP_HDR + (
    "   1: 00000000:699C 00000000:0000 0A 00000000:00000000 00:00000000 00000000"
    "  1000        0 449854 1 000000007c2d1673 100 0 0 10 0\n"
    "  45: 3C01010A:699C 0101010A:F762 01 00000000:00000000 02:0009BB24 00000000"
    "  1000        0 502670 2 000000006096426b 25 4 30 42 -1\n")
TCP_NO_STEAM = TCP_HDR + (
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000"
    "     0        0 12345 1 0000000000000000 100 0 0 10 0\n")
# Idle UDP: the streaming socket is unconnected (rem 0), and the only connected
# socket on the box is DHCP on 68<->67 — NOT a streaming port.
UDP_IDLE = UDP_HDR + (
    "  123: 00000000:699C 00000000:0000 07 00000000:00000000 00:00000000 00000000"
    "  1000        0 449855 2 0000000000000000 0\n"
    "  456: 3C01010A:0044 0101010A:0043 07 00000000:00000000 00:00000000 00000000"
    "     0        0 15000 2 0000000000000000 0\n")
# A live session: a connected UDP peer 10.1.1.42 (2A01010A) on 27033 (0x6999).
UDP_STREAMING = UDP_HDR + (
    "  123: 00000000:699C 00000000:0000 07 00000000:00000000 00:00000000 00000000"
    "  1000        0 449855 2 0000000000000000 0\n"
    "  789: 3C01010A:6999 2A01010A:C350 07 00000000:00000000 00:00000000 00000000"
    "  1000        0 449999 2 0000000000000000 0\n")
UDP_LOOPBACK = UDP_HDR + (
    "  790: 0100007F:6999 0100007F:C350 07 00000000:00000000 00:00000000 00000000"
    "  1000        0 449998 2 0000000000000000 0\n")


def _fixture(tcp, udp):
    d = tempfile.mkdtemp()
    t = os.path.join(d, "tcp")
    u = os.path.join(d, "udp")
    with open(t, "w") as f:
        f.write(tcp)
    with open(u, "w") as f:
        f.write(udp)
    cs._PROC_NET_TCP = (t,)
    cs._PROC_NET_UDP = (u,)


def test_hex_ip():
    print("hex address decode")
    check(cs._hex_ip("3C01010A") == "10.1.1.60", "little-endian hex -> dotted IPv4")
    check(cs._hex_ip("0101010A") == "10.1.1.1", "router address decodes")
    check(cs._hex_ip("0" * 32) is None, "IPv6 (32 chars) -> None (counted, not named)")
    check(cs._hex_ip("zzzz") is None, "garbage -> None")


def test_listening():
    print("host-listening probe")
    o_t, o_u = cs._PROC_NET_TCP, cs._PROC_NET_UDP
    try:
        _fixture(TCP_IDLE, UDP_IDLE)
        check(cs._stream_listening() is True, "27036 LISTEN detected (host is up)")
        _fixture(TCP_NO_STEAM, UDP_IDLE)
        check(cs._stream_listening() is False, "no 27036 LISTEN -> not hosting")
    finally:
        cs._PROC_NET_TCP, cs._PROC_NET_UDP = o_t, o_u


def test_peer_detection_and_router_trap():
    print("peer detection + the router false-positive trap")
    o_t, o_u = cs._PROC_NET_TCP, cs._PROC_NET_UDP
    try:
        # THE TRAP: idle box, but the router holds an ESTABLISHED TCP conn on
        # 27036. That must NOT read as a live session.
        _fixture(TCP_IDLE, UDP_IDLE)
        check(cs._stream_peer() is None,
              "idle: router's ESTABLISHED TCP on 27036 is NOT a session")
        check(cs.stream_host_info()["active"] is False, "idle -> active False")

        _fixture(TCP_IDLE, UDP_STREAMING)
        check(cs._stream_peer() == "10.1.1.42", "connected UDP peer names the client")
        info = cs.stream_host_info()
        check(info["active"] is True and info.get("peer") == "10.1.1.42",
              "active with peer")
        check(info["listening"] is True, "listening reported alongside")

        _fixture(TCP_IDLE, UDP_LOOPBACK)
        check(cs._stream_peer() is None, "loopback UDP peer ignored")
    finally:
        cs._PROC_NET_TCP, cs._PROC_NET_UDP = o_t, o_u


def test_since_edges():
    print("since timestamp edges")
    o_t, o_u = cs._PROC_NET_TCP, cs._PROC_NET_UDP
    try:
        cs._STREAM_STATE.update(active=False, since=0)
        _fixture(TCP_IDLE, UDP_STREAMING)
        first = cs.stream_host_info()
        check("since" in first and first["since"] > 0, "rising edge stamps `since`")
        again = cs.stream_host_info()
        check(again["since"] == first["since"], "`since` is stable while active")
        _fixture(TCP_IDLE, UDP_IDLE)
        idle = cs.stream_host_info()
        check(idle["active"] is False and "since" not in idle,
              "falling edge clears active + since")
    finally:
        cs._PROC_NET_TCP, cs._PROC_NET_UDP = o_t, o_u


def test_unreadable_proc():
    print("degrades safely")
    o_t, o_u = cs._PROC_NET_TCP, cs._PROC_NET_UDP
    try:
        cs._PROC_NET_TCP = ("/nonexistent/tcp",)
        cs._PROC_NET_UDP = ("/nonexistent/udp",)
        check(cs._stream_listening() is False, "missing /proc -> not listening (no raise)")
        check(cs._stream_peer() is None, "missing /proc -> no peer (no raise)")
    finally:
        cs._PROC_NET_TCP, cs._PROC_NET_UDP = o_t, o_u


if __name__ == "__main__":
    test_hex_ip()
    test_listening()
    test_peer_detection_and_router_trap()
    test_since_edges()
    test_unreadable_proc()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all stream-host tests passed")
