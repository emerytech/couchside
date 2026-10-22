#!/usr/bin/env python3
"""Temporary, experimental Legion Go 2 LampArray preview helper.

Manually start as root on the test device; this is NOT an installed service.
Only the exact inspected 17ef:61eb descriptor is accepted. No device paths,
raw reports, mode changes, or persistent configuration are accepted from clients.
Cleanup can restore the original custom mode if takeover changed its readback.
The fixed Unix socket is usable only by deck. Each preview lasts ten seconds,
uses at most 20% RGB, and restores the native lighting snapshot before Stop
returns. The helper exits after thirty minutes. SIGKILL/power loss cannot run
cleanup; normal exit, disconnect errors, SIGINT and SIGTERM do run cleanup.

Report layouts: USB HUTRR84 Lighting and Illumination, sections 3.1–3.5:
https://www.usb.org/sites/default/files/hutrr84_-_lighting_and_illumination_page.pdf
No upstream implementation code is used here.
"""
import colorsys
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import select
import signal
import socket
import stat
import struct
import time

DESCRIPTOR_SHA256 = "54d3e06c94cb8f5872a7d9e4aae5c7149cd2977f63c7b37b12069bec61a9b7f3"
SOCKET_PATH = "/run/couchside-ring-preview.sock"
LOCK_PATH = "/run/couchside-ring-preview.lock"
LED_PATH = Path("/sys/class/leds/go:rgb:joystick_rings")
PREVIEW_SECONDS = 10
LIFETIME_SECONDS = 1800
MAX_MESSAGE = 1024


def validate_preview(p):
    keys = {"effect", "direction", "color", "colorShift", "trail", "period", "brightness"}
    if not isinstance(p, dict) or set(p) != keys:
        raise ValueError("invalid preview fields")
    if p["effect"] not in ("ball", "comet", "bounce"):
        raise ValueError("unknown effect")
    if p["direction"] not in ("clockwise", "counterclockwise"):
        raise ValueError("unknown direction")
    if type(p["colorShift"]) is not bool:
        raise ValueError("invalid color shift")
    color = p["color"]
    if not isinstance(color, dict) or set(color) != {"r", "g", "b"}:
        raise ValueError("invalid color")
    for value in color.values():
        if type(value) is not int or not 0 <= value <= 255:
            raise ValueError("invalid color channel")
    for key, lo, hi in (("trail", 0, 4), ("period", 2, 8), ("brightness", 1, 20)):
        if type(p[key]) is not int or not lo <= p[key] <= hi:
            raise ValueError("invalid " + key)
    return {**p, "color": dict(color)}


def frame(p, elapsed):
    """IDs ascend counterclockwise from the top on each observed nine-LED ring."""
    pixels = [(0, 0, 0)] * 18
    phase = max(0, elapsed) / p["period"]
    color = tuple(p["color"][k] / 255 for k in ("r", "g", "b"))
    if p["colorShift"]:
        hue, saturation, value = colorsys.rgb_to_hsv(*color)
        color = colorsys.hsv_to_rgb((hue + phase / 2) % 1, saturation, value)
    scale = 255 * p["brightness"] / 100
    direction = -1 if p["direction"] == "clockwise" else 1
    trail = 0 if p["effect"] == "ball" else p["trail"]
    if p["effect"] == "bounce":
        # Travel around one stick, across the other, then reverse back again.
        tick = int(phase * 34) % 34
        head = tick if tick <= 17 else 34 - tick
        travel = 1 if tick <= 17 else -1
        for tail in range(trail + 1):
            position = head - travel * tail
            if 0 <= position < 18:
                ring, index = divmod(position, 9)
                pixels[ring * 9 + (direction * index) % 9] = tuple(
                    round(c * scale * (1 - tail / (trail + 1))) for c in color)
    else:
        head = int(phase * 9)
        for ring in (0, 9):
            for tail in range(trail + 1):
                pixels[ring + (direction * (head - tail)) % 9] = tuple(
                    round(c * scale * (1 - tail / (trail + 1))) for c in color)
    return pixels


def frame_reports(pixels):
    if len(pixels) != 18 or any(len(p) != 3 or any(type(c) is not int or not 0 <= c <= 51
                                                for c in p) for p in pixels):
        raise ValueError("invalid or over-bright frame")
    reports = []
    for start in (0, 8, 16):
        count = min(8, 18 - start)
        # All 18 pixels must be staged, including black gaps; commit only the
        # final report, so an old bright pixel cannot survive behind the comet.
        report = bytearray(51)
        report[:3] = bytes((4, count, 1 if start == 16 else 0))
        for slot in range(count):
            index = start + slot
            struct.pack_into("<H", report, 3 + 2 * slot, index)
            rgb = pixels[index]
            # This firmware advertises intensity 0..1. Brightness is RGB-scaled.
            report[19 + 4 * slot:23 + 4 * slot] = bytes((*rgb, int(any(rgb))))
        reports.append(bytes(report))
    return reports


def timed_out(_signum, _frame):
    raise TimeoutError("lighting device timed out")


class Hardware:
    def __init__(self):
        devices = []
        for device in Path("/sys/bus/hid/devices").glob("*:17EF:61EB.*"):
            descriptor = device / "report_descriptor"
            if descriptor.is_file() and hashlib.sha256(descriptor.read_bytes()).hexdigest() == DESCRIPTOR_SHA256:
                devices.extend((device / "hidraw").glob("hidraw*"))
        if len(devices) != 1:
            raise OSError("verified Legion Go 2 LampArray not found")
        self.fd = os.open("/dev/" + devices[0].name, os.O_RDWR | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            report = self.get_array()
            _, count, width, height, depth, kind, interval_us = struct.unpack("<BHIIIII", report)
            if (count, width, height, depth, kind) != (18, 100000, 78000, 1000, 3):
                raise ValueError("unexpected lighting capabilities")
            if not 1 <= interval_us <= 1000000:
                raise ValueError("unexpected lighting timing")
            self.interval = max(0.05, interval_us / 1000000)
            self.min_interval = interval_us / 1000000
            self.last_set = 0
            self.snapshot()  # Fail closed before any control report is sent.
        except BaseException:
            os.close(self.fd)
            raise

    def ioctl(self, request, data):
        signal.setitimer(signal.ITIMER_REAL, 2)
        try:
            length = fcntl.ioctl(self.fd, request, data, True)
            if length != len(data):
                raise OSError("incomplete lighting report")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)

    def get_array(self):
        report = bytearray(23); report[0] = 1
        self.ioctl((3 << 30) | (23 << 16) | (ord("H") << 8) | 7, report)
        if report[0] != 1:
            raise ValueError("unexpected array report")
        return report

    def set_report(self, report):
        # A second allowlist at the actual hardware boundary. No arbitrary
        # vendor reports, range updates, input events, or controller commands.
        if not ((len(report) == 2 and report[0] == 6 and report[1] in (0, 1))
                or (len(report) == 51 and report[0] == 4 and report[1] in (2, 8)
                    and report[2] in (0, 1))):
            raise ValueError("report not allowed")
        if report[0] == 4:
            first = struct.unpack_from("<H", report, 3)[0]
            count = report[1]
            if first not in (0, 8, 16) or count != min(8, 18 - first) or report[2] != int(first == 16):
                raise ValueError("invalid lamp batch")
            for slot in range(8):
                index = struct.unpack_from("<H", report, 3 + slot * 2)[0]
                r, g, b, intensity = report[19 + slot * 4:23 + slot * 4]
                if slot >= count:
                    if index or r or g or b or intensity:
                        raise ValueError("nonzero lamp padding")
                elif (index != first + slot or max(r, g, b) > 51
                      or intensity != int(bool(r or g or b))):
                    raise ValueError("invalid lamp values")
        wait = getattr(self, "last_set", 0) + getattr(self, "min_interval", 0) - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            self.ioctl((3 << 30) | (len(report) << 16) | (ord("H") << 8) | 6, bytearray(report))
        finally:
            self.last_set = time.monotonic()

    def snapshot(self):
        attrs = {name: (LED_PATH / name).read_text().strip() for name in
                 ("mode", "profile", "effect", "speed", "brightness", "multi_intensity", "enabled")}
        # Do not switch dynamic/OS modes to gain control. Custom mode is the
        # currently verified restorable native configuration only.
        if (attrs["mode"] != "custom" or attrs["profile"] not in ("1", "2", "3")
                or attrs["effect"] not in ("monocolor", "breathe", "chroma", "rainbow")
                or attrs["enabled"] not in ("true", "false")):
            raise ValueError("native lighting configuration cannot be safely restored")
        for name in ("speed", "brightness"):
            if not attrs[name].isdigit() or not 0 <= int(attrs[name]) <= 100:
                raise ValueError("invalid native " + name)
        channels = attrs["multi_intensity"].split()
        if len(channels) != 3 or any(not c.isdigit() or not 0 <= int(c) <= 255 for c in channels):
            raise ValueError("invalid native color")
        return attrs

    def restore(self, attrs):
        failure = None
        try:
            self.set_report(bytes((6, 1)))
        except (OSError, ValueError) as exc:
            failure = exc
        try:
            signal.setitimer(signal.ITIMER_REAL, 2)
            if (LED_PATH / "mode").read_text().strip() != attrs["mode"]:
                # Some firmware may change its reported mode on takeover.
                # Restore ONLY original custom mode, never dynamic or OS mode;
                # never use a mode switch to obtain preview control.
                (LED_PATH / "mode").write_text("custom")
        except (OSError, ValueError) as exc:
            failure = failure or exc
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        # Restore only attributes inspected above, in driver-safe order.
        # Enable last avoids an intermediate
        # flash at an old brightness/color. Attempt every attribute on error.
        # The preview never changes native speed. Do not write a speed readback:
        # some hid-lenovo-go versions invert writes but expose raw read values,
        # so writing back the same number can change the user's effect speed.
        # The complete snapshot comparison below still detects any speed drift.
        for name in ("profile", "effect", "multi_intensity", "brightness", "enabled"):
            try:
                signal.setitimer(signal.ITIMER_REAL, 2)
                (LED_PATH / name).write_text(attrs[name])
            except (OSError, ValueError) as exc:
                failure = failure or exc
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
        if failure:
            raise OSError("native lighting restoration failed") from failure
        if self.snapshot() != attrs:
            raise OSError("native lighting restoration readback mismatch")

    def close(self):
        os.close(self.fd)


class Preview:
    def __init__(self, hardware, clock=time.monotonic):
        self.hardware, self.clock = hardware, clock
        self.program = self.saved = None
        self.started = self.next_frame = 0
        self.error = None
        self.accepting = True

    def status(self):
        return {"available": self.accepting and self.error is None, "active": self.saved is not None,
                "error": self.error, "remaining_ms": max(0, round((self.started + PREVIEW_SECONDS - self.clock()) * 1000))
                if self.program is not None else 0}

    def start(self, program):
        clean = validate_preview(program)  # Validate before any read or write.
        if not self.accepting:
            raise ValueError("preview session is ending")
        self.stop()
        self.saved = self.hardware.snapshot()
        self.started = self.clock()
        self.next_frame = self.started
        self.program = clean
        try:
            self.hardware.set_report(bytes((6, 0)))
            # Do not race the first LampArray update with control takeover.
            self.next_frame = self.clock() + self.hardware.interval
        except (OSError, ValueError):
            self.stop()
            raise
        return self.status()

    def stop(self):
        self.program = None
        if self.saved is not None:
            try:
                self.hardware.restore(self.saved)
            except (OSError, ValueError):
                self.error = "Restoration failed; stop and inspect lighting before continuing."
                raise
            # Keep snapshot and active state on failure so a later stop retries.
            self.saved = None
        self.error = None
        return self.status()

    def tick(self):
        if self.program is None:
            return
        now = self.clock()
        if now - self.started >= PREVIEW_SECONDS:
            self.stop()
        elif now >= self.next_frame:
            for report in frame_reports(frame(self.program, now - self.started)):
                self.hardware.set_report(report)
            # No catch-up bursts when a call stalls.
            self.next_frame = self.clock() + self.hardware.interval

    def request(self, data):
        if data == {"status": True} and type(data["status"]) is bool:
            return self.status()
        if data == {"stop": True} and type(data["stop"]) is bool:
            return self.stop()
        if isinstance(data, dict) and set(data) == {"preview"}:
            return self.start(data["preview"])
        raise ValueError("unknown request")


def read_request(conn, deadline):
    data = bytearray()
    while b"\n" not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request deadline exceeded")
        conn.settimeout(remaining)
        part = conn.recv(MAX_MESSAGE + 1 - len(data))
        if not part:
            raise ValueError("incomplete request")
        data.extend(part)
        if len(data) > MAX_MESSAGE:
            raise ValueError("request too large")
    return json.loads(data.decode("utf-8"))


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run this temporary test helper with sudo.")
    user = pwd.getpwnam("deck")
    signal.signal(signal.SIGALRM, timed_out)
    lock_fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    info = os.fstat(lock_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(lock_fd)
        raise SystemExit("Unexpected preview lock owner or permissions.")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        hardware = Hardware()
    except BaseException:
        os.close(lock_fd)
        raise
    preview = Preview(hardware)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    running = [True]
    signal.signal(signal.SIGTERM, lambda *_: running.__setitem__(0, False))
    signal.signal(signal.SIGINT, lambda *_: running.__setitem__(0, False))
    signal.signal(signal.SIGHUP, lambda *_: running.__setitem__(0, False))
    bound = False
    expires = time.monotonic() + LIFETIME_SECONDS
    shutdown_deadline = None
    try:
        # Never unlink an existing socket: another helper may own an active
        # snapshot. /run is root-owned, preventing a deck-owned path swap.
        old_umask = os.umask(0o177)
        try:
            server.bind(SOCKET_PATH)
            bound = True
        finally:
            os.umask(old_umask)
        os.chown(SOCKET_PATH, user.pw_uid, user.pw_gid)
        server.listen(2)
        print("Temporary ring preview ready (10-second previews; exits in 30 minutes).", flush=True)
        while True:
            if not running[0] or time.monotonic() >= expires:
                if shutdown_deadline is None:
                    preview.accepting = False
                    try:
                        preview.stop()
                    except (OSError, ValueError):
                        pass
                    # Give the agent's 250ms monitor a chance to observe the
                    # completed restore before removing the socket. No new
                    # preview is accepted during this shutdown grace period.
                    shutdown_deadline = time.monotonic() + 2
                if time.monotonic() >= shutdown_deadline:
                    break
            try:
                preview.tick()
            except (OSError, ValueError):
                try:
                    preview.stop()
                    preview.error = "Preview stopped after a device error."
                except (OSError, ValueError):
                    pass
            readable, _, _ = select.select([server], [], [], 0.025)
            if not readable:
                continue
            conn, _ = server.accept()
            with conn:
                conn.settimeout(0.25)
                _, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != user.pw_uid:
                    continue
                try:
                    read_until = time.monotonic() + 0.25
                    if preview.program is not None:
                        read_until = min(read_until, preview.started + PREVIEW_SECONDS)
                    result = preview.request(read_request(conn, read_until))
                except (ValueError, UnicodeError, OSError):
                    result = preview.status()
                    result = {**result, "error": result["error"] or "Preview request failed."}
                try:
                    conn.sendall(json.dumps(result).encode("utf-8") + b"\n")
                except OSError:
                    pass  # The deadline still restores a disconnected preview.
    finally:
        try:
            preview.stop()
        finally:
            server.close()
            hardware.close()
            os.close(lock_fd)
            if bound:
                os.unlink(SOCKET_PATH)


if __name__ == "__main__":
    main()
