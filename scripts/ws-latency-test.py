#!/usr/bin/env python3
"""Tokened WS latency test against a Couchside agent's /ws/gamepad endpoint.

Measures, from this machine, using a raw RFC6455 stdlib client (no deps):
  1. TCP connect + WS upgrade + hello latency (xN cold connects)
  2. Idle ping->pong RTT distribution (xN)
  3. FIRST mouse-move penalty: move + ping, time to pong
     (expected to expose the in-loop UI_DEV_CREATE + _UINPUT_SETTLE_S=0.5 stall)
  4. Sustained 90 Hz mouse moves with interleaved pings: RTT under load
  5. Burst: 300 back-to-back moves then ping: queue-drain time
  6. First keyboard-frame penalty (second lazy device create)

Usage: ws_latency_test.py <host> <port> <token>
"""
import base64
import json
import os
import socket
import struct
import sys
import time


def ws_connect(host: str, port: int, token: str, timeout: float = 8.0):
    """Open TCP + upgrade. Returns (sock, t_tcp_ms, t_upgrade_ms, t_hello_ms, hello)."""
    t0 = time.perf_counter()
    s = socket.create_connection((host, port), timeout=timeout)
    t_tcp = time.perf_counter()
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    key = base64.b64encode(os.urandom(16)).decode()
    path = ("/ws/gamepad?token=%s&handoff=takeover&name=latency-test" % token)
    req = (
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
    )
    s.sendall(req.encode())
    # Read HTTP response headers.
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("closed during upgrade: %r" % buf[:200])
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b" 101 " not in head.split(b"\r\n", 1)[0]:
        raise RuntimeError("upgrade refused: %r" % head.split(b"\r\n", 1)[0])
    t_up = time.perf_counter()
    # Wait for the hello frame.
    frame, rest = read_frame(s, rest)
    t_hello = time.perf_counter()
    hello = json.loads(frame)
    return (
        s,
        rest,
        (t_tcp - t0) * 1000,
        (t_up - t0) * 1000,
        (t_hello - t0) * 1000,
        hello,
    )


def send_text(s: socket.socket, obj: dict) -> None:
    payload = json.dumps(obj, separators=(",", ":")).encode()
    mask = os.urandom(4)
    n = len(payload)
    if n < 126:
        header = struct.pack("!BB", 0x81, 0x80 | n)
    elif n < 65536:
        header = struct.pack("!BBH", 0x81, 0x80 | 126, n)
    else:
        header = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(header + mask + masked)


def read_frame(s: socket.socket, buf: b"") -> tuple:
    """Read one complete server frame (unmasked text). Returns (payload, leftover)."""
    buf = bytes(buf)
    while True:
        # Parse what we have.
        if len(buf) >= 2:
            b1, b2 = buf[0], buf[1]
            opcode = b1 & 0x0F
            ln = b2 & 0x7F
            off = 2
            if ln == 126:
                if len(buf) >= 4:
                    ln = struct.unpack("!H", buf[2:4])[0]
                    off = 4
                else:
                    ln = None
            elif ln == 127:
                if len(buf) >= 10:
                    ln = struct.unpack("!Q", buf[2:10])[0]
                    off = 10
                else:
                    ln = None
            if ln is not None and len(buf) >= off + ln:
                payload = buf[off : off + ln]
                leftover = buf[off + ln :]
                if opcode == 0x8:
                    raise RuntimeError("server close: %r" % payload[:120])
                if opcode in (0x1, 0x2):
                    return payload, leftover
                # ping/pong/continuation: skip
                buf = leftover
                continue
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("connection closed")
        buf += chunk


def wait_pong(s, buf) -> tuple:
    """Read frames until {"t":"pong"}; returns (ms_from_call, leftover)."""
    t0 = time.perf_counter()
    while True:
        payload, buf = read_frame(s, buf)
        try:
            msg = json.loads(payload)
        except ValueError:
            continue
        if msg.get("t") == "pong":
            return (time.perf_counter() - t0) * 1000, buf
        # ignore hello/waiting/etc


def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    idx = min(len(sorted_vals) - 1, int(round(p / 100 * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


def dist(name, vals):
    v = sorted(vals)
    print(
        "%-34s n=%-4d min=%6.1f p50=%6.1f p90=%6.1f p99=%6.1f max=%7.1f (ms)"
        % (name, len(v), v[0], pct(v, 50), pct(v, 90), pct(v, 99), v[-1])
    )


def main():
    host, port, token = sys.argv[1], int(sys.argv[2]), sys.argv[3]

    # ---- 1. cold connect x8 ----
    tcp_ms, up_ms, hello_ms = [], [], []
    for i in range(8):
        s, buf, t_tcp, t_up, t_hello, hello = ws_connect(host, port, token)
        tcp_ms.append(t_tcp)
        up_ms.append(t_up)
        hello_ms.append(t_hello)
        if i == 0:
            print("hello frame: %s" % hello)
        s.close()
        time.sleep(0.15)
    dist("1. TCP connect", tcp_ms)
    dist("1. WS upgrade (from t0)", up_ms)
    dist("1. hello received (from t0)", hello_ms)

    # ---- fresh session for the rest ----
    s, buf, _, _, _, _ = ws_connect(host, port, token)

    # ---- 2. idle ping RTT x200 ----
    rtts = []
    for _ in range(200):
        send_text(s, {"t": "ping"})
        ms, buf = wait_pong(s, buf)
        rtts.append(ms)
        time.sleep(0.01)
    dist("2. idle ping->pong RTT", rtts)

    # ---- 3. FIRST mouse move penalty (lazy device create in recv loop) ----
    t0 = time.perf_counter()
    send_text(s, {"t": "m", "dx": 1, "dy": 0})
    send_text(s, {"t": "ping"})
    first_move_ms, buf = wait_pong(s, buf)
    print("3. FIRST mouse frame -> pong flush: %.1f ms   <-- lazy create + settle" % first_move_ms)

    # second move for contrast
    send_text(s, {"t": "m", "dx": -1, "dy": 0})
    send_text(s, {"t": "ping"})
    warm_move_ms, buf = wait_pong(s, buf)
    print("3. warm mouse frame -> pong flush: %.1f ms" % warm_move_ms)

    # ---- 4. sustained 90 Hz moves for 5 s, ping every 100 ms ----
    load_rtts = []
    t_end = time.perf_counter() + 5.0
    next_ping = time.perf_counter()
    moves = 0
    while time.perf_counter() < t_end:
        send_text(s, {"t": "m", "dx": 1 if moves % 2 else -1, "dy": 0})
        moves += 1
        now = time.perf_counter()
        if now >= next_ping:
            send_text(s, {"t": "ping"})
            ms, buf = wait_pong(s, buf)
            load_rtts.append(ms)
            next_ping = now + 0.1
        time.sleep(0.011)
    dist("4. RTT under 90Hz move load", load_rtts)
    print("   (moves sent: %d over 5s = %.0f Hz)" % (moves, moves / 5.0))

    # ---- 5. burst drain: 300 back-to-back moves then ping ----
    t0 = time.perf_counter()
    for i in range(300):
        send_text(s, {"t": "m", "dx": 1 if i % 2 else -1, "dy": 0})
    send_text(s, {"t": "ping"})
    drain_ms, buf = wait_pong(s, buf)
    print("5. 300-move burst -> drained in: %.1f ms (%.2f ms/frame)" % (drain_ms, drain_ms / 300))

    # ---- 6. first keyboard frame penalty ----
    send_text(s, {"t": "k", "key": "end"})
    send_text(s, {"t": "ping"})
    first_key_ms, buf = wait_pong(s, buf)
    print("6. FIRST key frame -> pong flush: %.1f ms   <-- second lazy create" % first_key_ms)

    send_text(s, {"t": "k", "key": "end"})
    send_text(s, {"t": "ping"})
    warm_key_ms, buf = wait_pong(s, buf)
    print("6. warm key frame -> pong flush: %.1f ms" % warm_key_ms)

    s.close()
    print("DONE")


if __name__ == "__main__":
    main()
