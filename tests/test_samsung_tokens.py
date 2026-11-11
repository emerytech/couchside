#!/usr/bin/env python3
"""Samsung reconnect-token regression tests (no TV or network required).

Run: python3 tests/test_samsung_tokens.py
Use the real handshake, connection and atomic config writer with a fake wire.
These fixtures prove credential reuse; they do not prove a particular TV's
firmware/Access Notification behavior.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

spec = importlib.util.spec_from_file_location(
    "couchsided", Path(__file__).resolve().parents[1] / "agent/couchsided.py")
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


class SamsungTokenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "config.json"
        self.cfg = {"host": "tv.invalid", "token": "old-test-token",
                    "mac": "00:11:22:33:44:55"}
        self.raw = {"samsung": self.cfg.copy(), "tv_active": "webos",
                    "units": [], "unrelated": {"label": "Café 🎮"}}
        self.path.write_text(json.dumps(self.raw), encoding="utf-8")
        self.wires = []
        self.events = []
        self.on_connect = None
        owner = self

        class Wire:
            def __init__(self, url):
                self.url, self.closed, self.sent = url, False, []
                owner.wires.append(self)
                if owner.on_connect:
                    owner.on_connect()

            def recv_text(self):
                return json.dumps(owner.events.pop(0))

            def send_text(self, text):
                self.sent.append(json.loads(text))

            def close(self):
                self.closed = True

        for name, value in {"CONFIG_PATH": str(self.path),
                            "CONFIG_SAMSUNG": self.cfg, "SAMSUNG": None,
                            "CONFIG_TV_ACTIVE": "webos", "_SAMSUNG_MOCK": False,
                            "_WebOSWS": Wire}.items():
            p = patch.object(cs, name, value)
            p.start()
            self.addCleanup(p.stop)

    def authorize(self, token):
        self.events.append({"event": "ms.channel.connect",
                            "data": {} if token is None else {"token": token}})

    def connect(self):
        with cs.SAMSUNG_LOCK:
            return cs._samsung_conn()

    def test_rotated_token_survives_reconnect_and_agent_reload(self):
        self.authorize("new-test-token")
        first = self.connect()
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        expected = json.loads(json.dumps(self.raw))
        expected["samsung"]["token"] = "new-test-token"
        self.assertEqual(saved, expected)
        self.assertEqual(cs.CONFIG_SAMSUNG["token"], "new-test-token")
        self.assertIs(self.connect(), first)  # existing socket is reused
        self.assertEqual(len(self.wires), 1)

        # Model an agent restart: reload the saved credential from disk.
        cs.SAMSUNG = None
        cs.CONFIG_SAMSUNG = saved["samsung"]
        self.authorize("new-test-token")
        self.connect()
        query = parse_qs(urlparse(self.wires[-1].url).query)
        self.assertEqual(query["token"], ["new-test-token"])

    def test_unchanged_or_absent_token_does_not_rewrite_config(self):
        for token in ("old-test-token", None):
            with self.subTest(token=token):
                cs.SAMSUNG = None
                before = self.path.read_bytes()
                self.authorize(token)
                with patch.object(cs, "_config_set_field") as save:
                    self.connect()
                save.assert_not_called()
                self.assertEqual(self.path.read_bytes(), before)
                self.assertEqual(cs.CONFIG_SAMSUNG["token"], "old-test-token")

    def test_token_is_not_published_when_atomic_write_fails(self):
        self.authorize("new-test-token")
        before = self.path.read_bytes()
        with patch.object(cs, "_write_config_atomic", side_effect=OSError("read only")):
            with self.assertRaises(OSError):
                self.connect()
        self.assertIsNone(cs.SAMSUNG)
        self.assertEqual(cs.CONFIG_SAMSUNG, self.cfg)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(self.wires[0].closed)
        self.assertFalse(self.wires[0].sent)

    def test_new_pairing_is_not_overwritten_by_old_handshake(self):
        replacement = {"host": "other-tv.invalid", "token": "other-test-token"}
        def replace_pairing():
            with cs.CONFIG_LOCK:
                cs._config_set_field("samsung", replacement)
                cs.CONFIG_SAMSUNG = replacement
        self.on_connect = replace_pairing
        self.authorize("new-test-token")
        with self.assertRaisesRegex(OSError, "pairing changed"):
            self.connect()
        self.assertIs(cs.CONFIG_SAMSUNG, replacement)
        self.assertEqual(json.loads(self.path.read_text())["samsung"], replacement)
        self.assertIsNone(cs.SAMSUNG)
        self.assertTrue(self.wires[0].closed)
        self.assertFalse(self.wires[0].sent)

    def test_unreadable_config_is_not_replaced(self):
        self.path.write_text("{broken", encoding="utf-8")
        self.authorize("new-test-token")
        with self.assertRaises(cs.ConfigError):
            self.connect()
        self.assertEqual(self.path.read_text(), "{broken")
        self.assertIs(cs.CONFIG_SAMSUNG, self.cfg)
        self.assertIsNone(cs.SAMSUNG)
        self.assertTrue(self.wires[0].closed)

    def test_failed_persistence_sends_no_remote_key(self):
        self.authorize("new-test-token")
        self.authorize("new-test-token")  # existing action retry also fails
        with patch.object(cs, "_write_config_atomic", side_effect=OSError("read only")):
            result = cs.real_samsung("volume_up")
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.wires), 2)
        self.assertTrue(all(w.closed and not w.sent for w in self.wires))

    def test_pairing_waits_for_action_then_resets_old_session(self):
        attempted = threading.Event()
        finished = threading.Event()
        errors = []
        owner = threading.current_thread()

        class ObservedLock:
            def __init__(self):
                self.lock = threading.Lock()

            def __enter__(self):
                if threading.current_thread() is not owner:
                    attempted.set()
                self.lock.acquire()

            def __exit__(self, *args):
                self.lock.release()

        def pair():
            try:
                cs._samsung_save("other-tv.invalid", "other-test-token")
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()

        with patch.object(cs, "SAMSUNG_LOCK", ObservedLock()):
            with cs.SAMSUNG_LOCK:
                self.authorize("old-test-token")
                old = cs._samsung_conn()
                worker = threading.Thread(target=pair, daemon=True)
                worker.start()
                self.assertTrue(attempted.wait(2), "pairing takes the action lock")
                self.assertFalse(finished.is_set())
                self.assertIs(cs.CONFIG_SAMSUNG, self.cfg)
                self.assertIs(cs.SAMSUNG, old)
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertFalse(errors)
            self.assertTrue(old.ws.closed)
            self.assertIsNone(cs.SAMSUNG)
            self.assertEqual(cs.CONFIG_SAMSUNG["host"], "other-tv.invalid")
            self.authorize("other-test-token")
            new = self.connect()
            self.assertEqual(urlparse(new.ws.url).hostname, "other-tv.invalid")
            self.assertEqual(json.loads(self.path.read_text())["tv_active"], "samsung")

    def test_failed_pair_save_keeps_current_session_and_config(self):
        self.authorize("old-test-token")
        old = self.connect()
        before = self.path.read_bytes()
        with patch.object(cs, "_write_config_atomic", side_effect=OSError("read only")):
            with self.assertRaises(OSError):
                cs._samsung_save("other-tv.invalid", "other-test-token")
        self.assertIs(cs.SAMSUNG, old)
        self.assertFalse(old.ws.closed)
        self.assertIs(cs.CONFIG_SAMSUNG, self.cfg)
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
