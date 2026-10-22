"""Experimental preview: bounded packets, restoration, and scene ownership."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("ring_preview", ROOT / "agent/couchside-ring-preview.py")
cs = load("ring_agent", ROOT / "agent/couchsided.py")


def config(**changes):
    return {"effect": "comet", "direction": "clockwise", "color": {"r": 255, "g": 0, "b": 100},
            "colorShift": False, "trail": 2, "period": 4, "brightness": 20, **changes}


def status(active=False, error=None):
    return {"available": error is None, "active": active, "error": error, "remaining_ms": 5000 if active else 0}


class FakeHardware:
    interval = .05

    def __init__(self):
        self.events = []
        self.fail_restore = False

    def snapshot(self):
        self.events.append("snapshot")
        return {"original": True}

    def set_report(self, value):
        self.events.append(value)

    def restore(self, value):
        self.events.append(("restore", value))
        if self.fail_restore:
            raise OSError("unplugged")


class RingPreviewTests(unittest.TestCase):
    def test_validation_precedes_any_hardware_access(self):
        hardware = FakeHardware()
        preview = helper.Preview(hardware)
        for key, value in [("brightness", 21), ("brightness", True), ("period", 1),
                           ("trail", 5), ("effect", "firmware"), ("direction", "up"),
                           ("colorShift", 1), ("color", {"r": 0, "g": 0, "b": -1})]:
            with self.assertRaises(ValueError):
                preview.start(config(**{key: value}))
        bad = config(); bad["raw_report"] = [6, 0]
        with self.assertRaises(ValueError): preview.start(bad)
        with self.assertRaises(ValueError): preview.request({"stop": 1})
        with self.assertRaises(ValueError): preview.request({"status": 1})
        self.assertEqual(hardware.events, [])

    def test_dark_gaps_brightness_trail_and_direction(self):
        for effect in ("ball", "comet", "bounce"):
            for trail in range(5):
                for tick in range(80):
                    pixels = helper.frame(config(effect=effect, trail=trail, colorShift=True), tick * .1)
                    self.assertEqual(len(pixels), 18)
                    self.assertLessEqual(max(c for p in pixels for c in p), 51)
                    self.assertGreaterEqual(pixels.count((0, 0, 0)), 8)
        clockwise = helper.frame(config(effect="ball", period=2), 2/9 + .001)
        counter = helper.frame(config(effect="ball", period=2, direction="counterclockwise"), 2/9 + .001)
        self.assertTrue(any(clockwise[8])); self.assertTrue(any(counter[1]))
        self.assertFalse(any(clockwise[1])); self.assertFalse(any(counter[8]))

    def test_bounce_crosses_sticks_and_returns_in_requested_period(self):
        p = config(effect="bounce", trail=0)
        first = helper.frame(p, 0)
        halfway = helper.frame(p, p["period"] / 2)
        self.assertTrue(any(first[0])); self.assertTrue(all(not any(p) for p in first[9:]))
        self.assertTrue(all(not any(p) for p in halfway[:9]))
        self.assertEqual(first, helper.frame(p, p["period"]))

    def test_full_frame_batches_commit_once_and_use_boolean_intensity(self):
        pixels = helper.frame(config(), 0)
        reports = helper.frame_reports(pixels)
        self.assertEqual([len(r) for r in reports], [51] * 3)
        self.assertEqual([r[:3] for r in reports], [bytes((4, 8, 0)), bytes((4, 8, 0)), bytes((4, 2, 1))])
        seen = []
        for report in reports:
            for slot in range(report[1]):
                index = struct.unpack_from("<H", report, 3 + 2 * slot)[0]
                seen.append(index)
                self.assertEqual(tuple(report[19 + slot * 4:22 + slot * 4]), pixels[index])
                self.assertEqual(report[22 + slot * 4], int(any(pixels[index])))
        self.assertEqual(seen, list(range(18)))
        with self.assertRaises(ValueError): helper.frame_reports([(52, 0, 0)] * 18)

    def test_hardware_boundary_rejects_wrong_ids_brightness_and_padding(self):
        hardware = helper.Hardware.__new__(helper.Hardware)
        reports = helper.frame_reports(helper.frame(config(), 0))
        with patch.object(hardware, "ioctl") as ioctl:
            for report in reports: hardware.set_report(report)
            self.assertEqual(ioctl.call_count, 3)
            for offset, value in ((0, 5), (1, 7), (2, 1), (3, 17), (19, 52), (22, 2)):
                bad = bytearray(reports[0]); bad[offset] = value
                with self.assertRaises(ValueError): hardware.set_report(bad)
            bad = bytearray(reports[-1]); bad[27] = 1
            with self.assertRaises(ValueError): hardware.set_report(bad)
            self.assertEqual(ioctl.call_count, 3)

    def test_waits_for_takeover_then_restores_after_ten_seconds(self):
        now = [0]
        hardware = FakeHardware(); preview = helper.Preview(hardware, lambda: now[0])
        self.assertTrue(preview.start(config())["active"])
        self.assertEqual(hardware.events, ["snapshot", bytes((6, 0))])
        preview.tick()
        self.assertEqual(len(hardware.events), 2)
        now[0] = .05; preview.tick()
        self.assertEqual(len(hardware.events), 5)
        now[0] = 10; preview.tick()
        self.assertFalse(preview.status()["active"])
        self.assertEqual(hardware.events[-1], ("restore", {"original": True}))
        count = len(hardware.events); now[0] = 20; preview.tick()
        self.assertEqual(count, len(hardware.events))

    def test_stop_restores_before_ack_and_new_preview_snapshots_after_restore(self):
        hardware = FakeHardware(); preview = helper.Preview(hardware)
        preview.start(config()); preview.start(config(effect="ball"))
        self.assertEqual(hardware.events[2:4], [("restore", {"original": True}), "snapshot"])
        result = preview.request({"stop": True})
        self.assertFalse(result["active"])
        self.assertEqual(hardware.events[-1], ("restore", {"original": True}))

    def test_restore_failure_keeps_snapshot_for_explicit_retry(self):
        hardware = FakeHardware(); preview = helper.Preview(hardware)
        preview.start(config()); hardware.fail_restore = True
        with self.assertRaises(OSError): preview.stop()
        self.assertTrue(preview.status()["active"])
        self.assertFalse(preview.status()["available"])
        self.assertIsNotNone(preview.status()["error"])
        hardware.fail_restore = False
        self.assertFalse(preview.stop()["active"])

    def test_failed_takeover_restores_native_snapshot(self):
        hardware = FakeHardware(); preview = helper.Preview(hardware)
        with patch.object(hardware, "set_report", side_effect=OSError("write failed")):
            with self.assertRaises(OSError): preview.start(config())
        self.assertFalse(preview.status()["active"])
        self.assertEqual(hardware.events[-1], ("restore", {"original": True}))

    def test_native_restore_verifies_custom_mode_and_all_original_attributes(self):
        attrs = {"mode": "custom", "profile": "3", "effect": "breathe", "speed": "71",
                 "brightness": "90", "multi_intensity": "0 80 255", "enabled": "true"}
        hardware = helper.Hardware.__new__(helper.Hardware)
        with tempfile.TemporaryDirectory() as directory, patch.object(helper, "LED_PATH", Path(directory)), \
             patch.object(hardware, "set_report") as report:
            for key, value in attrs.items(): (Path(directory) / key).write_text(value)
            (Path(directory) / "mode").write_text("dynamic")
            (Path(directory) / "brightness").write_text("0")
            writes = []
            original_write = Path.write_text
            def record_write(path, value):
                writes.append(path.name)
                return original_write(path, value)
            with patch.object(Path, "write_text", record_write):
                hardware.restore(attrs)
            self.assertNotIn("speed", writes)
            self.assertEqual(writes[-1], "enabled")
            report.assert_called_once_with(bytes((6, 1)))
            self.assertEqual(hardware.snapshot(), attrs)

    def test_shutdown_exposes_inactive_status_but_rejects_new_preview(self):
        hardware = FakeHardware(); preview = helper.Preview(hardware)
        preview.start(config()); preview.accepting = False; preview.stop()
        self.assertEqual(preview.status(), {"available": False, "active": False, "error": None, "remaining_ms": 0})
        count = len(hardware.events)
        with self.assertRaises(ValueError): preview.start(config())
        self.assertEqual(count, len(hardware.events))

    def test_slow_client_cannot_extend_absolute_read_deadline(self):
        class Client:
            def settimeout(self, timeout): self.timeout = timeout
            def recv(self, count): return b"{"
        client = Client()
        with patch.object(helper.time, "monotonic", side_effect=[0, .1, .2, .3]):
            with self.assertRaises(TimeoutError): helper.read_request(client, .25)
        self.assertAlmostEqual(client.timeout, .05)


class AgentOwnershipTests(unittest.TestCase):
    def test_bad_request_never_contacts_helper(self):
        with patch.object(cs, "_ring_motion_rpc") as rpc:
            for request in ({"stop": 1}, {"preview": config(brightness=100)}, {"raw": [6, 0]}, []):
                with self.assertRaises(ValueError): cs._ring_motion_apply(request)
            rpc.assert_not_called()

    def test_manual_waits_for_restore_before_native_write(self):
        events = []
        @cs._ring_manual
        def manual(name): events.append("native")
        def rpc(request):
            events.append(request)
            return status()
        with patch.object(cs, "_RING_MOTION_PAUSED", True), patch.object(cs, "_RING_PROGRAM", None), \
             patch.object(cs, "_ring_motion_rpc", side_effect=rpc):
            manual(cs._GO2_NAME)
        self.assertEqual(events, [{"stop": True}, "native"])

    def test_unconfirmed_restoration_blocks_manual_write(self):
        @cs._ring_manual
        def manual(name): self.fail("native write after unconfirmed restore")
        with patch.object(cs, "_RING_MOTION_PAUSED", True), \
             patch.object(cs, "_ring_motion_rpc", return_value=status(True, "restore failed")):
            with self.assertRaises(OSError): manual(cs._GO2_NAME)
            self.assertTrue(cs._RING_MOTION_PAUSED)
            self.assertTrue(cs._ring_motion_available())

    def test_agent_restart_discovers_and_stops_active_helper(self):
        events = []
        @cs._ring_manual
        def manual(name): events.append("native")
        def rpc(request):
            events.append(request)
            return status(request == {"status": True})
        with patch.object(cs, "_RING_MOTION_PAUSED", False), patch.object(cs, "_RING_PROGRAM", None), \
             patch.object(cs, "_ring_motion_socket_ok", return_value=True), \
             patch.object(cs, "_ring_motion_rpc", side_effect=rpc):
            manual(cs._GO2_NAME)
        self.assertEqual(events, [{"status": True}, {"stop": True}, "native"])

    def test_status_synchronizes_active_helper_after_restart(self):
        with patch.object(cs, "_RING_MOTION_PAUSED", False), \
             patch.object(cs, "_ring_motion_rpc", return_value=status(True)):
            cs._ring_motion_status()
            self.assertTrue(cs._RING_MOTION_PAUSED)

    def test_normal_native_controls_do_not_probe_absent_helper(self):
        @cs._ring_manual
        def manual(name): return "native"
        with patch.object(cs, "_RING_MOTION_PAUSED", False), patch.object(cs, "_RING_PROGRAM", None), \
             patch.object(cs, "_ring_motion_socket_ok", return_value=False), patch.object(cs, "_ring_motion_rpc") as rpc:
            self.assertEqual(manual(cs._GO2_NAME), "native")
            rpc.assert_not_called()

    def test_scene_worker_pauses_without_clearing_saved_program(self):
        class Stop:
            calls = 0
            def wait(self, _):
                self.calls += 1
                return self.calls > 1
        program = {"scene": "aurora"}
        with patch.object(cs, "_RING_MOTION_PAUSED", True), patch.object(cs, "_RING_PROGRAM", program), \
             patch.object(cs, "_FX_STOP", Stop()), patch.object(cs, "_ring_save") as save, \
             patch.object(cs, "_read_led_raw") as read:
            cs._ring_loop()
            self.assertIs(cs._RING_PROGRAM, program)
            save.assert_not_called(); read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
