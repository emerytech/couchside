#!/usr/bin/env python3
"""Tests for stream-host detection (GET /api/stream-host) — roadmap phase 4a.

Run: python3 tests/test_stream_host.py

Drives the REAL detection functions against fixtures whose lines are copied
VERBATIM from a live box, including a genuine macOS Remote Play session it
served. The traps encoded here are all real and all cost something once:
  * BOTH session edges exist in streaming_log.txt (">>> Starting/Stopped desktop
    stream"). An earlier draft keyed on a connected UDP peer in 27031-27036
    instead — that signal did NOT fire during the real session and silently
    missed it, which is why detection is log-driven now.
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
NOISE = (
    "[2026-07-19 17:49:00][60.100000] Adding process 68515 for gameID 1868140\n"
    "[2026-07-19 17:49:01][61.100000] Removing process 68515 for gameID 1868140\n"
    "[2026-07-19 17:49:02][62.100000] Game Recording - game stopped [gameid=1868140]\n"
)
START = "[2026-07-19 17:50:17][75.044840] >>> Starting desktop stream\n"
CLIENT = ("[2026-07-19 17:50:18][75.533834] >>> Client video decoder set to "
          "macOS Metal hardware decoding\n")
MIDDLE = ("[2026-07-19 17:50:18][75.506495] >>> Capture resolution set to 1920x1080\n"
          "[2026-07-19 17:51:04][122.042206] Encoding complete\n")
STOP = "[2026-07-19 17:51:04][122.094521] >>> Stopped desktop stream\n"

TCP_LISTENING = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
    # 27036 = 0x699C listening, plus the router holding an ESTABLISHED conn to it
    "   1: 00000000:699C 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n"
    "  45: 3C01010A:699C 0101010A:F762 01 00000000:00000000 02:0009BB24 00000000\n")
TCP_NO_STEAM = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt\n"
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n")


def _setup(log_text, tcp_text=TCP_LISTENING):
    """Point the agent at a fixture log + /proc/net/tcp, with fresh state."""
    d = tempfile.mkdtemp()
    log = os.path.join(d, "streaming_log.txt")
    with open(log, "w") as f:
        f.write(log_text)
    tcp = os.path.join(d, "tcp")
    with open(tcp, "w") as f:
        f.write(tcp_text)
    cs._stream_log_path = lambda: log
    cs._PROC_NET_TCP = (tcp,)
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
    o_path, o_tcp = cs._stream_log_path, cs._PROC_NET_TCP
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


def test_noise_never_activates():
    print("the 9,915-line noise trap")
    o_path, o_tcp = cs._stream_log_path, cs._PROC_NET_TCP
    try:
        log = _setup(START + STOP)          # settled: a finished session
        cs.stream_host_info()
        _append(log, NOISE * 20)            # lots of gameID churn, no stream
        check(cs.stream_host_info()["active"] is False,
              "Adding/Removing/Game Recording never re-activates a session")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp


def test_rotation():
    print("log rotation")
    o_path, o_tcp = cs._stream_log_path, cs._PROC_NET_TCP
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


def test_listening_crosscheck():
    print("listening cross-check + router trap")
    o_path, o_tcp = cs._stream_log_path, cs._PROC_NET_TCP
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


def test_missing_log():
    print("degrades safely")
    o_path, o_tcp = cs._stream_log_path, cs._PROC_NET_TCP
    try:
        cs._stream_log_path = lambda: None
        cs._PROC_NET_TCP = ("/nonexistent/tcp",)
        cs._STREAM_STATE.update(active=False, since=0, client=None, pos=0)
        info = cs.stream_host_info()
        check(info["active"] is False and info["listening"] is False,
              "no log + no /proc -> inactive, no raise")
    finally:
        cs._stream_log_path, cs._PROC_NET_TCP = o_path, o_tcp


if __name__ == "__main__":
    test_timestamp_parse()
    test_session_edges()
    test_noise_never_activates()
    test_rotation()
    test_listening_crosscheck()
    test_missing_log()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all stream-host tests passed")
