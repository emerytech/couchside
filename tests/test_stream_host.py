#!/usr/bin/env python3
"""Tests for stream-host detection (GET /api/stream-host) — roadmap phase 4a.

Run: python3 tests/test_stream_host.py

Drives the REAL detection functions against fixtures whose lines are copied
VERBATIM from a live box, including a genuine macOS Remote Play session it
served. The traps encoded here are all real and all cost something once:
  * Both session edges exist in streaming_log.txt (">>> Starting/Stopped desktop
    stream") — but ONLY on a graceful stop. An earlier draft keyed on a
    connected UDP peer in 27031-27036 instead; that signal did NOT fire during
    the real session and silently missed it, which is why detection is
    log-driven. A later revision then claimed both edges ALWAYS exist, which is
    false: a stream host that crashes or is replaced never writes its stop line,
    and the card advertised a dead macOS session for 27 minutes. Hence the
    data-port cross-check (udp/27031), measured in BOTH states this time.
  * Log mtime staleness is NOT a liveness signal: measured 41 seconds of silence
    during a healthy stream, so any useful threshold would hide live sessions.
  * "Adding/Removing process for gameID" dominates the log (9,915 lines on the
    live box) and fires with NO stream running — it must never read as activity.
  * An ESTABLISHED TCP peer on 27036 is NOT a session: an idle box has one from
    the router, plus one per Steam client on the LAN.
  * Rotation: the file shrinking must reset the cursor, not wedge it.
Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os
import tempfile
import time

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


# Verbatim off the live box: the noise that dominates the log, then a real
# session's start / client / stop lines.
#
# THE TIMESTAMPS ARE ANCHORED TO NOW, NOT HARDCODED, AND MUST STAY THAT WAY.
# stream_host_info() drops a session once it is older than _STREAM_MAX_S (12h),
# so a fixture dated with a literal wall-clock date is a TIME BOMB: it passes
# until real time drifts 12h past that date, then every "-> active" assertion
# in this file fails at once, on every branch, with no code change. That is
# exactly what happened -- fixtures dated 2026-07-19 17:50:17 turned CI red at
# 2026-07-20 05:50 UTC and cost a debugging session on an unrelated PR.
# `_stream_line_epoch` parses with time.mktime(), i.e. LOCAL time, so these are
# built with time.localtime() to match.
#
# Offsets preserve the spacing of the real captured log: noise runs ~77s before
# the session, the client line lands 1s after the start, the stop 47s after it.
_BASE = int(time.time()) - 60           # session started a minute ago


def _stamp(offset, uptime):
    """A '[YYYY-MM-DD HH:MM:SS][uptime]' log prefix `offset` seconds off _BASE."""
    when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(_BASE + offset))
    return "[%s][%s]" % (when, uptime)


NOISE = (
    _stamp(-77, "60.100000") + " Adding process 68515 for gameID 1868140\n"
    + _stamp(-76, "61.100000") + " Removing process 68515 for gameID 1868140\n"
    + _stamp(-75, "62.100000") + " Game Recording - game stopped [gameid=1868140]\n"
)
START = _stamp(0, "75.044840") + " >>> Starting desktop stream\n"
CLIENT = (_stamp(1, "75.533834") + " >>> Client video decoder set to "
          "macOS Metal hardware decoding\n")
MIDDLE = (_stamp(1, "75.506495") + " >>> Capture resolution set to 1920x1080\n"
          + _stamp(47, "122.042206") + " Encoding complete\n")
STOP = _stamp(47, "122.094521") + " >>> Stopped desktop stream\n"

TCP_LISTENING = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
    # 27036 = 0x699C listening, plus the router holding an ESTABLISHED conn to it
    "   1: 00000000:699C 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n"
    "  45: 3C01010A:699C 0101010A:F762 01 00000000:00000000 02:0009BB24 00000000\n")
TCP_NO_STEAM = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n")

# The Remote Play DATA socket, 27031 = 0x6997. Bound for the life of a session
# and released when it ends — cleanly or not — which is the only signal that
# recovers from a stream host that died without writing its stop marker. It
# binds on udp6 in practice, so the fixture uses a v6 local address.
UDP_STREAMING = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
    " 512: 00000000000000000000000000000000:6997"
    " 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000\n")
# What a box with Steam running but NO live session shows: the 27036 discovery
# socket only. Measured on hardware — 27031 was absent entirely.
UDP_IDLE = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
    " 511: 00000000:699C 00000000:0000 07 00000000:00000000 00:00000000\n")


def _setup(log_text, tcp_text=TCP_LISTENING, udp_text=UDP_STREAMING):
    """Point the agent at a fixture log + /proc/net/{tcp,udp}, with fresh state.

    udp defaults to the data port BOUND — "a session really is running" — so the
    marker tests below exercise the markers rather than tripping the cross-check.
    """
    d = tempfile.mkdtemp()
    log = os.path.join(d, "streaming_log.txt")
    with open(log, "w") as f:
        f.write(log_text)
    tcp = os.path.join(d, "tcp")
    with open(tcp, "w") as f:
        f.write(tcp_text)
    udp = os.path.join(d, "udp")
    with open(udp, "w") as f:
        f.write(udp_text)
    cs._stream_log_path = lambda: log
    cs._PROC_NET_TCP = (tcp,)
    cs._PROC_NET_UDP = (udp,)
    cs._STREAM_STATE.update(active=False, since=0, client=None, pos=0)
    return log


def _append(path, text):
    with open(path, "a") as f:
        f.write(text)


def test_timestamp_parse():
    print("log timestamp parse")
    e = cs._stream_line_epoch(START)
    check(isinstance(e, int) and e > 0, "parses the [YYYY-MM-DD HH:MM:SS] prefix")
    check(cs._stream_line_epoch("no timestamp here") is None, "unprefixed -> None")
    check(cs._stream_line_epoch("[garbage] x") is None, "garbage -> None")


def test_session_edges():
    print("session start/stop edges")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        log = _setup(NOISE)
        info = cs.stream_host_info()
        check(info["active"] is False, "noise only (Adding/Removing) -> NOT active")
        check(info["listening"] is True, "listening reported from 27036 LISTEN")

        _append(log, START + CLIENT + MIDDLE)
        info = cs.stream_host_info()
        check(info["active"] is True, "start marker -> active")
        check(info.get("client") == "macOS", "client platform captured from the log")
        check(info.get("since", 0) > 0, "since stamped from the log timestamp")

        _append(log, STOP)
        info = cs.stream_host_info()
        check(info["active"] is False, "stop marker -> inactive")
        check("client" not in info and "since" not in info, "session fields cleared")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


def test_noise_never_activates():
    print("the 9,915-line noise trap")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        log = _setup(START + STOP)          # settled: a finished session
        cs.stream_host_info()
        _append(log, NOISE * 20)            # lots of gameID churn, no stream
        check(cs.stream_host_info()["active"] is False,
              "Adding/Removing/Game Recording never re-activates a session")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


def test_rotation():
    print("log rotation")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        log = _setup(NOISE * 30 + START + CLIENT)
        check(cs.stream_host_info()["active"] is True, "active before rotation")
        cursor = cs._STREAM_STATE["pos"]
        check(cursor > 0, "cursor advanced")
        # Rotate: the file is replaced by a much shorter one that ends the session.
        with open(log, "w") as f:
            f.write(START + STOP)
        info = cs.stream_host_info()
        check(cs._STREAM_STATE["pos"] <= os.path.getsize(log),
              "cursor reset to fit the shrunken file (no wedge)")
        check(info["active"] is False, "post-rotation content re-read correctly")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


def test_listening_crosscheck():
    print("listening cross-check + router trap")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        # Steam drops its 27036 listener AROUND a session (verified live: present
        # before the stream, gone after) — so a live session must still read as
        # active with listening False. Gating on it would hide a real stream.
        _setup(START + CLIENT, tcp_text=TCP_NO_STEAM)
        info = cs.stream_host_info()
        check(info["listening"] is False, "no 27036 LISTEN -> listening False")
        check(info["active"] is True,
              "live session still ACTIVE while 27036 is not listening")
        # A stale "started" with no stop line is cleared by the age cap instead.
        cs._STREAM_STATE["since"] = 1  # epoch 1 = ancient
        check(cs.stream_host_info()["active"] is False,
              "stale started-with-no-stop cleared by the age cap")

        # And the router's ESTABLISHED conn on 27036 never implies a session.
        _setup(NOISE)
        check(cs.stream_host_info()["active"] is False,
              "router's ESTABLISHED 27036 conn is not a session")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


def test_dirty_end_recovery():
    print("dirty end (host died, no stop marker)")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        # A session that started and is genuinely live: markers say go, data
        # port bound. This is the state that must NOT regress.
        log = _setup(START + CLIENT)
        info = cs.stream_host_info()
        check(info["active"] is True, "live session stays active while 27031 is bound")
        check(info.get("client") == "macOS", "client still reported")

        # THE BUG: the host dies. No stop line is ever written — the log simply
        # stops growing — but the data port is released.
        with open(os.path.join(os.path.dirname(log), "udp"), "w") as f:
            f.write(UDP_IDLE)
        info = cs.stream_host_info()
        check(info["active"] is False,
              "data port released -> session cleared with NO stop marker")
        check("client" not in info and "since" not in info,
              "stale client/since not reported after a dirty end")
        check(cs._STREAM_STATE["active"] is False,
              "shared state cleared, not just the returned flag")
        check(cs._STREAM_STATE["pos"] > 0,
              "byte cursor preserved (no full re-read of the log next poll)")

        # And it stays cleared across polls rather than flapping.
        check(cs.stream_host_info()["active"] is False, "still inactive next poll")

        # A brand-new session after the dirty end is detected normally.
        with open(os.path.join(os.path.dirname(log), "udp"), "w") as f:
            f.write(UDP_STREAMING)
        _append(log, START + CLIENT)
        check(cs.stream_host_info()["active"] is True,
              "a fresh session after a dirty end still activates")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


def test_data_port_does_not_suppress_start():
    print("data port never suppresses a real session")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        # Steam binds 27031 ~4s BEFORE writing ">>> Starting desktop stream"
        # ("Streaming initialized and listening on port 27031" precedes it), so
        # the cross-check can never race a session that is merely starting.
        _setup(START + CLIENT, udp_text=UDP_STREAMING)
        check(cs.stream_host_info()["active"] is True,
              "port bound + start marker -> active")

        # Unreadable /proc must not silently kill a live session... it does clear
        # it, which is the SAFE direction (a hidden card, not a lying one).
        _setup(START + CLIENT)
        cs._PROC_NET_UDP = ("/nonexistent/udp",)
        check(cs.stream_host_info()["active"] is False,
              "unreadable /proc/net/udp fails closed, not open")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


def test_missing_log():
    print("degrades safely")
    o_path, o_tcp, o_udp = (cs._stream_log_path, cs._PROC_NET_TCP,
                            cs._PROC_NET_UDP)
    try:
        cs._stream_log_path = lambda: None
        cs._PROC_NET_TCP = ("/nonexistent/tcp",)
        cs._PROC_NET_UDP = ("/nonexistent/udp",)
        cs._STREAM_STATE.update(active=False, since=0, client=None, pos=0)
        info = cs.stream_host_info()
        check(info["active"] is False and info["listening"] is False,
              "no log + no /proc -> inactive, no raise")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp
        cs._PROC_NET_UDP = o_udp


if __name__ == "__main__":
    test_timestamp_parse()
    test_session_edges()
    test_noise_never_activates()
    test_rotation()
    test_listening_crosscheck()
    test_dirty_end_recovery()
    test_data_port_does_not_suppress_start()
    test_missing_log()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all stream-host tests passed")
