#!/usr/bin/env python3
"""Tests for stream-host liveness (the `online` field on GET /api/steamlink).

Run: python3 tests/test_stream_online.py

WHY THIS EXISTS: remoteclients.vdf lists every host this box has EVER streamed
from and says nothing about which are on now. Picking a game from a host that is
off makes Steam fall back to "play locally" and offer a multi-GB INSTALL
(observed: 6 GB, from an asleep Steam Deck), which reads as a Couchside bug when
it is really "that PC is off".

WHAT WAS MEASURED before choosing the rule (two live boxes, 2026-07-20):
  * The join key is the 64-bit Steam CLIENT ID, not the hostname. It is the map
    key in remoteclients.vdf and the id Steam writes in remote_connections.txt.
    A box keeps its id across a rename -- one box in the sample appears as both
    "bazzite" and "lenovodesktop" in the same log.
  * Beacon recency ALONE is unusable: beacons are bursty, median gap 9s but p99
    2725s, and 5.4% of gaps inside an active stretch exceed 15 minutes. Any
    tight freshness window flickers a present host to "offline".
  * The lifecycle lines are a STATE and matched every independently-known truth:
    two live boxes read `connected`, the asleep Deck from the bug report read
    `disconnected` 12h, a machine gone a month read `disconnected` 28d.
  * A host that loses power abruptly may never log `disconnected` -- the same
    missing-stop-marker shape as streaming_log.txt -- so `connected` is paired
    with a staleness cap.

FIXTURE TIMESTAMPS ARE RELATIVE TO NOW, NEVER LITERAL DATES. A dated fixture
plus an age cap is a time bomb: it passes until wall-clock drifts past the
threshold, then fails on every branch with no code change. That already cost a
day's debugging on this repo (see tests/test_stream_host.py).

Pure stdlib, no pytest -- same style as the other agent tests.
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


NOW = int(time.time())


def stamp(ago):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(NOW - ago))


# Line shapes copied verbatim from a live box's remote_connections.txt.
def beacon(ago, cid, host, addr=None):
    return ("[%s] Received broadcast message from client %s (%s): %s:27036\n"
            % (stamp(ago), cid, host, addr or ("10.0.0.5")))


def life(ago, cid, host, what, extra=""):
    if what == "connected":
        return ("[%s] Client %s (%s) connected via direct connection\n"
                % (stamp(ago), cid, host))
    return ("[%s] Client %s (%s) disconnected: %s\n"
            % (stamp(ago), cid, host, extra or "disconnect callback: I/O Operation Failed"))


def with_log(text):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "remote_connections.txt")
    with open(p, "w") as f:
        f.write(text)
    cs._remote_log_path = lambda: p
    return p


def test_lifecycle_state():
    print("lifecycle state decides online")
    o = cs._remote_log_path
    try:
        with_log(
            beacon(400, "111", "live-box")
            + life(300, "111", "live-box", "connected")
            + life(3600, "222", "dead-box", "disconnected")
            + beacon(3700, "222", "dead-box"))
        live = cs.remote_client_liveness()
        check(set(live) == {"111", "222"}, "both client ids parsed")

        on, why = cs.stream_host_online(live["111"], NOW)
        check(on is True, "a connected host reads online")
        check(why == "connected", "reason names the state")

        on, why = cs.stream_host_online(live["222"], NOW)
        check(on is False, "a disconnected host reads offline")
        check("last seen" in why, "reason carries a last-seen age")
    finally:
        cs._remote_log_path = o


def test_beacon_recency_does_not_override():
    print("a fresh beacon does NOT resurrect a disconnected host")
    o = cs._remote_log_path
    try:
        # Disconnected 10 minutes ago, but still beaconing seconds ago. Steam
        # keeps announcing itself; that is presence on the wire, not a usable
        # host, and the whole point is to not promise a stream we cannot give.
        with_log(life(600, "333", "flapper", "disconnected")
                 + beacon(5, "333", "flapper"))
        live = cs.remote_client_liveness()
        on, _ = cs.stream_host_online(live["333"], NOW)
        check(on is False, "beacon after a disconnect stays offline")
        check(live["333"]["last_seen"] >= NOW - 10, "but last_seen tracks the beacon")
    finally:
        cs._remote_log_path = o


def test_stale_connected_is_not_trusted():
    print("a host that died without logging a disconnect")
    o = cs._remote_log_path
    try:
        # Yanked power: the last thing ever written is `connected`. Without a
        # staleness cap this host stays "online" forever and Steam offers the
        # multi-GB install.
        with_log(life(cs.STREAM_HOST_STALE_S + 600, "444", "yanked", "connected"))
        live = cs.remote_client_liveness()
        on, why = cs.stream_host_online(live["444"], NOW)
        check(on is False, "stale `connected` is not trusted past the cap")
        check("no response" in why, "reason says it stopped responding")

        # Just inside the cap it is still trusted.
        with_log(life(cs.STREAM_HOST_STALE_S - 600, "444", "yanked", "connected"))
        live = cs.remote_client_liveness()
        on, _ = cs.stream_host_online(live["444"], NOW)
        check(on is True, "inside the cap it still counts as online")
    finally:
        cs._remote_log_path = o


def test_rename_keeps_identity():
    print("a renamed box keeps its client id")
    o = cs._remote_log_path
    try:
        with_log(life(9000, "555", "old-name", "connected")
                 + life(120, "555", "new-name", "connected"))
        live = cs.remote_client_liveness()
        check(list(live) == ["555"], "one identity, not two")
        check(live["555"]["host"] == "new-name", "newest hostname wins")
    finally:
        cs._remote_log_path = o


def test_unknown_and_missing():
    print("hosts with no history, and no log at all")
    o = cs._remote_log_path
    try:
        on, why = cs.stream_host_online(None, NOW)
        check(on is False, "a host absent from the log is not called online")
        check("never" in why, "reason says it was never seen")

        cs._remote_log_path = lambda: None
        check(cs.remote_client_liveness() == {}, "no log -> {}, no raise")
    finally:
        cs._remote_log_path = o


def test_vdf_client_id_is_captured():
    print("the vdf join key")
    text = '''"RemoteClientCache"
{
\t"13928384185804371762"
\t{
\t\t"hostname"\t\t"MacBook-Pro-M2-4"
\t\t"lastupdated"\t\t"1784558649"
\t\t"apps"
\t\t{
\t\t\t"0"\t\t"220"
\t\t}
\t}
}
'''
    hosts = cs._parse_remoteclients(text)
    check(len(hosts) == 1, "one host parsed")
    check(hosts[0]["cid"] == "13928384185804371762",
          "client id captured from the block key (was previously discarded)")
    check(hosts[0]["host"] == "MacBook-Pro-M2-4", "hostname still parsed")
    check(hosts[0]["apps"] == ["220"], "apps still parsed")
    # An appid inside "apps" is also a bare quoted number: it must not be
    # mistaken for the next block's client id.
    check(all(h["cid"] != "220" for h in hosts), "an appid is never read as a client id")


def test_log_tail_only():
    print("a multi-megabyte log is not read whole")
    o = cs._remote_log_path
    try:
        filler = ("[%s] Received broadcast message from client 999 (noise): "
                  "10.0.0.9:27036\n" % stamp(90000)) * 40000
        with_log(filler + life(60, "777", "recent", "connected"))
        live = cs.remote_client_liveness()
        check("777" in live, "the newest events are still seen past the tail cap")
        on, _ = cs.stream_host_online(live["777"], NOW)
        check(on is True, "and still resolve correctly")
    finally:
        cs._remote_log_path = o


if __name__ == "__main__":
    test_lifecycle_state()
    test_beacon_recency_does_not_override()
    test_stale_connected_is_not_trusted()
    test_rename_keeps_identity()
    test_unknown_and_missing()
    test_vdf_client_id_is_captured()
    test_log_tail_only()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all stream-online tests passed")
