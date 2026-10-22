#!/usr/bin/env python3
"""Fixture-only receiver discovery and authenticated Steam pairing handoff."""
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('receiver_agent', ROOT / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.usb = self.root / 'usb'; self.usb.mkdir()
        self.media = self.root / 'media'; self.media.mkdir()
        for name, value in (('_USB_DEVICES_DIR', str(self.usb)),
                            ('_MEDIA_ROOTS', (str(self.media),)), ('_receiver_pair_last', None)):
            p = patch.object(cs, name, value); p.start(); self.addCleanup(p.stop)
        self.steam = patch.object(cs, 'steammenus_available', return_value=True)
        self.steam.start(); self.addCleanup(self.steam.stop)
        p = patch.object(cs.shutil, 'which', return_value='/usr/bin/steam')
        p.start(); self.addCleanup(p.stop)
        self.open = patch.object(cs, 'open_steam_menu', return_value=True)
        self.open_menu = self.open.start(); self.addCleanup(self.open.stop)

    def device(self, name='1-3', vid='28de', pid='1305'):
        p = self.usb / name; p.mkdir()
        (p / 'idVendor').write_text(vid)
        (p / 'idProduct').write_text(pid)
        (p / 'serial').write_text('MUST-NOT-BE-READ')
        return p

    def test_internal_and_external_are_distinct_and_never_flashable(self):
        self.device(); self.device('1-4', pid='1304')
        self.device('1-3:1.0'); self.device('usb1')
        self.device('1-5', vid='1234'); self.device('1-6', pid='1205')
        state = cs.controller_receivers_state()
        self.assertEqual(state['scan_status'], 'ok')
        self.assertTrue(state['pairing_available'])
        self.assertEqual([r['kind'] for r in state['receivers']], ['steam_machine', 'external_puck'])
        self.assertTrue(all(r['flashable'] is False and r['status'] == 'detected' for r in state['receivers']))
        self.assertNotIn('MUST-NOT-BE-READ', json.dumps(state))
        self.open_menu.assert_not_called()

    def test_internal_receiver_does_not_become_flash_target(self):
        self.device()
        self.assertIsNone(cs._openpuck_bootloader_mount())
        self.assertEqual(cs._openpuck_state(), 'no_board')
        # A separate, verified DFU volume may still be flashed; presence of an
        # internal receiver neither supplies nor conceals that distinct target.
        volume = self.media / 'deck' / 'NICENANO'; volume.mkdir(parents=True)
        (volume / 'INFO_UF2.TXT').write_text('UF2 Bootloader')
        self.assertEqual(cs._openpuck_state(), 'board_ready')
        self.assertEqual(len(cs.controller_receivers_state()['receivers']), 1)

    def test_discovery_reads_only_public_usb_ids(self):
        self.device()
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(cs, '_usb_read', wraps=cs._usb_read) as read:
            cs.controller_receivers_state()
        self.assertTrue(all(Path(c.args[0]).name in ('idVendor', 'idProduct') for c in read.call_args_list))
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_missing_unreadable_and_vanished_devices_degrade_closed(self):
        with patch.object(cs, '_USB_DEVICES_DIR', str(self.root / 'missing')):
            state = cs.controller_receivers_state()
            self.assertFalse(state['supported']); self.assertEqual(state['scan_status'], 'unavailable')
        with patch.object(cs.os, 'listdir', side_effect=PermissionError):
            self.assertEqual(cs.controller_receivers_state()['scan_status'], 'unavailable')
        self.device()
        with patch.object(cs, '_usb_read', return_value=None):
            self.assertEqual(cs.controller_receivers_state()['receivers'], [])

    def test_no_steam_or_no_receiver_refuses_pairing(self):
        self.assertEqual(cs.controller_receivers_pair()[0], 409)
        self.device()
        with patch.object(cs, 'steammenus_available', return_value=False):
            self.assertEqual(cs.controller_receivers_pair()[0], 409)
        with patch.object(cs.shutil, 'which', return_value=None):
            self.assertEqual(cs.controller_receivers_pair()[0], 409)
        self.open_menu.assert_not_called()

    def test_pairing_is_fixed_steam_handoff_not_successful_bond(self):
        self.device()
        status, result = cs.controller_receivers_pair()
        self.assertEqual(status, 200); self.assertTrue(result['dispatched'])
        self.assertIsNone(result['paired'])
        self.open_menu.assert_called_once_with('controller')
        self.assertEqual(cs.controller_receivers_pair()[0], 429)
        self.open_menu.assert_called_once()

    def test_failed_dispatch_is_not_success(self):
        self.device()
        self.open_menu.side_effect = OSError('fixture failure')
        self.assertEqual(cs.controller_receivers_pair()[0], 409)

    def test_unplug_after_status_read_prevents_pairing_dispatch(self):
        device = self.device()
        self.assertTrue(cs.controller_receivers_state()['pairing_available'])
        for file in device.iterdir():
            file.unlink()
        device.rmdir()
        self.assertEqual(cs.controller_receivers_pair()[0], 409)
        self.open_menu.assert_not_called()

    def test_mock_never_opens_steam(self):
        self.assertEqual(cs.controller_receivers_pair(mock=True)[0], 200)
        self.open_menu.assert_not_called()

    def start_http(self):
        cs.Handler.token = 'receiver-test-only'
        cs.Handler.token_file = None
        cs.Handler.mock = False
        server = ThreadingHTTPServer(('127.0.0.1', 0), cs.Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        def close():
            server.shutdown(); server.server_close(); worker.join(timeout=5)
        self.addCleanup(close)
        return server.server_port

    def request(self, port, method, path, body=None, token='receiver-test-only'):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse(); data = json.loads(response.read()); status = response.status
        conn.close(); return status, data

    def test_http_auth_schema_and_fixed_dispatch(self):
        self.device(); port = self.start_http()
        for token in (None, 'wrong'):
            self.assertEqual(self.request(port, 'GET', '/api/controller-receivers', token=token)[0], 401)
            self.assertEqual(self.request(port, 'POST', '/api/controller-receivers/pair', '{}', token)[0], 401)
        for body in ('', '{', 'null', '[]', 'true', '"pair"', '{"device":"/dev/hidraw0"}',
                     '{"url":"steam://install/1"}', '{"key":"secret"}', '{"op":"flash"}'):
            self.assertEqual(self.request(port, 'POST', '/api/controller-receivers/pair', body)[0], 400)
        self.open_menu.assert_not_called()
        status, state = self.request(port, 'GET', '/api/controller-receivers')
        self.assertEqual(status, 200); self.assertEqual(state['receivers'][0]['usb_id'], '28de:1305')
        status, result = self.request(port, 'POST', '/api/controller-receivers/pair', '{}')
        self.assertEqual(status, 200); self.assertIsNone(result['paired'])
        self.open_menu.assert_called_once_with('controller')


if __name__ == '__main__':
    unittest.main()
