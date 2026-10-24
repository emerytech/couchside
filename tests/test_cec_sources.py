#!/usr/bin/env python3
"""CEC inventory parsing, nonblocking cache and server-issued routing allowlist."""
import importlib.util
from pathlib import Path
import threading
import http.client
import http.server
import json
import time
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('cec_agent', Path(__file__).resolve().parents[1] / 'agent/couchsided.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
CEC = {'tool': 'cec-ctl', 'bin': '/usr/bin/cec-ctl', 'device': '/dev/cec0'}
DUMP = """Driver Info:
 Physical Address : 4.0.0.0
 OSD Name : 'Steam Machine'
 Primary Device Type : Playback
 System Information for device 0 (TV) from device 8 (Playback Device 2):
 Physical Address : 0.0.0.0
 Primary Device Type : TV
 OSD Name : 'Bedroom TV'
 System Information for device 4 (Playback Device 1) from device 8 (Playback Device 2):
 Physical Address : 2.0.0.0
 Primary Device Type : Playback
 OSD Name : 'Apple TV'
 System Information for device 5 (Audio System) from device 8:
 Physical Address : 3.0.0.0
 Primary Device Type : Audio System
 OSD Name : 'Soundbar'
 Topology:
     0.0.0.0: TV
"""

class Sources(unittest.TestCase):

    def setUp(self):
        with a._CEC_SOURCES_LOCK:
            a._CEC_SOURCES.update(key=None, t=-1000000000.0, loading=False, sources=[], error=None)

    def cache(self, **extra):
        with a._CEC_SOURCES_LOCK:
            a._CEC_SOURCES.update(key=a._cec_source_key(CEC), t=time.monotonic(), loading=False, sources=a._cec_parse_sources(DUMP), error=None, **extra)

    def test_inventory_not_fabricated(self):
        rows = a._cec_parse_sources(DUMP)
        self.assertEqual([r['id'] for r in rows], ['cec-4.0.0.0', 'cec-2.0.0.0'])
        self.assertEqual(rows[1]['label'], 'Apple TV · HDMI 2')
        self.assertTrue(rows[0]['is_box'])

    def test_malformed_or_injected_addresses(self):
        for v in ('0.0.0.0', 'f.f.f.f', '1.0.2.0', '--help', '2.0.0.0;reboot', '2.0.0.0\n', '2.0.0.00', '../../x', 'CEC-2.0.0.0'):
            self.assertFalse(a._cec_valid_address(v), v)
        self.assertTrue(a._cec_valid_address('1.2.a.0'))
        self.assertEqual(a._cec_parse_sources(DUMP.replace('2.0.0.0', '2.0.0.0;reboot'))[0]['id'], 'cec-4.0.0.0')
        self.assertEqual(len(a._cec_parse_sources(DUMP.replace('4.0.0.0', 'f.f.f.f'))), 1)

    def test_background_single_flight(self):
        started = threading.Event()
        finish = threading.Event()

        def scan(cec, key):
            started.set()
            finish.wait(2)
            with a._CEC_SOURCES_LOCK:
                a._CEC_SOURCES.update(loading=False, t=time.monotonic())
        with patch.object(a, 'panel_available', return_value=False), patch.object(a, 'cec_current', return_value=CEC), patch.object(a, '_cec_scan_sources', side_effect=scan) as worker:
            try:
                self.assertTrue(a.tv_sources()['loading'])
                self.assertTrue(started.wait(1))
                self.assertTrue(a.tv_sources()['loading'])
                self.assertEqual(worker.call_count, 1)
            finally:
                finish.set()
                for _ in range(100):
                    if not a._CEC_SOURCES['loading']:
                        break
                    time.sleep(0.005)

    def test_only_discovered_address_reaches_argv(self):
        self.cache()

        class Proc:
            returncode = 0
        with patch.object(a, 'cec_current', return_value=CEC), patch.object(a, '_cec_phys_addr', return_value='4.0.0.0'), patch.object(a.subprocess, 'run', return_value=Proc()) as run:
            self.assertFalse(a.real_cec_select_source('cec-1.0.0.0')['ok'])
            run.assert_not_called()
            self.assertFalse(a.real_cec_select_source('cec-2.0.0.0;reboot')['ok'])
            run.assert_not_called()
            result = a.real_cec_select_source('cec-2.0.0.0')
            self.assertTrue(result['ok'])
            self.assertFalse(result['confirmed'])
            self.assertEqual(run.call_args_list[0].args[0], [
                '/usr/bin/cec-ctl', '-d', '/dev/cec0', '--to', '4',
                '--user-control-pressed', 'ui-cmd=power-on-function',
                '--user-control-released'])
            self.assertEqual(run.call_args.args[0], ['/usr/bin/cec-ctl', '-d', '/dev/cec0', '--set-stream-path', 'phys-addr=2.0.0.0'])
            self.assertNotIn('shell', run.call_args.kwargs)

    def test_untrusted_logical_address_cannot_reach_command(self):
        self.cache()
        with patch.object(a, 'cec_current', return_value=CEC), \
                patch.object(a.subprocess, 'run') as run:
            for value in (None, '4', '--help', 0, 5, 15, True):
                a._CEC_SOURCES['sources'][1]['logical_address'] = value
                self.assertFalse(a.real_cec_select_source('cec-2.0.0.0')['ok'])
            run.assert_not_called()

    def test_unsupported_wake_key_still_requests_routing(self):
        self.cache()
        class Proc:
            returncode = 0
        with patch.object(a, 'cec_current', return_value=CEC), \
                patch.object(a, '_cec_phys_addr', return_value='4.0.0.0'), \
                patch.object(a.time, 'sleep'), \
                patch.object(a.subprocess, 'run', side_effect=[OSError(), Proc()]) as run:
            self.assertTrue(a.real_cec_select_source('cec-2.0.0.0')['ok'])
            self.assertIn('--set-stream-path', run.call_args.args[0])

    def test_stale_hotplug_busy_fail_closed(self):
        self.cache()
        with patch.object(a, 'cec_current', return_value=CEC), patch.object(a, '_cec_phys_addr', return_value='1.0.0.0'), patch.object(a.subprocess, 'run') as run:
            self.assertFalse(a.real_cec_select_source('cec-2.0.0.0')['ok'])
            run.assert_not_called()
            a._CEC_SOURCES['t'] = -1000000000.0
            self.assertFalse(a.real_cec_select_source('cec-2.0.0.0')['ok'])
            run.assert_not_called()
            a._CEC_SOURCES['t'] = time.monotonic()
            a._CEC_SWITCH_LOCK.acquire()
            try:
                self.assertFalse(a.real_cec_select_source('cec-2.0.0.0')['ok'])
            finally:
                a._CEC_SWITCH_LOCK.release()
            run.assert_not_called()

    def test_own_source_uses_existing_one_touch_play(self):
        self.cache()
        with patch.object(a, 'cec_current', return_value=CEC), patch.object(a, '_cec_phys_addr', return_value='4.0.0.0'), patch.object(a, 'real_cec_source_box', return_value={'ok': True}) as own:
            self.assertTrue(a.real_cec_select_source('cec-4.0.0.0')['ok'])
            own.assert_called_once_with(preserve_adapter=True)

    def test_picker_preserves_configured_cec_identity(self):
        class Proc:
            returncode = 0

        with patch.object(a, 'cec_current', return_value=CEC), \
                patch.object(a, '_cec_phys_addr', return_value='4.0.0.0'), \
                patch.object(a.time, 'sleep'), \
                patch.object(a.subprocess, 'run', return_value=Proc()) as run:
            self.assertTrue(a.real_cec_source_box(preserve_adapter=True)['ok'])
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands), 3)
            self.assertTrue(all('--playback' not in argv for argv in commands))
            self.assertEqual(commands[1][-2:], ['--active-source', 'phys-addr=4.0.0.0'])

    def test_panel_and_unsupported_unchanged(self):
        with patch.object(a, 'panel_available', return_value=True):
            state = a.tv_sources()
            self.assertEqual(state['backend'], 'panel')
            self.assertEqual(state['sources'][0]['id'], a.PANEL_SOURCES[0][0])
        with patch.object(a, 'panel_available', return_value=False), patch.object(a, 'cec_current', return_value={'tool': 'cec-client'}):
            self.assertFalse(a.tv_sources()['available'])

    def test_scan_failure_not_stuck_loading(self):
        a._CEC_SOURCES.update(key=a._cec_source_key(CEC), loading=True)
        with patch.object(a.subprocess, 'run', side_effect=TimeoutError()):
            a._cec_scan_sources(CEC, a._cec_source_key(CEC))
        self.assertFalse(a._CEC_SOURCES['loading'])
        self.assertTrue(a._CEC_SOURCES['error'])
        self.assertEqual(a._CEC_SOURCES['sources'], [])

    def test_refresh_is_throttled_and_thread_failure_recovers(self):
        self.cache()
        with patch.object(a, 'panel_available', return_value=False), \
                patch.object(a, 'cec_current', return_value=CEC), \
                patch.object(a.threading, 'Thread') as worker:
            self.assertFalse(a.tv_sources(force=True)['loading'])
            worker.assert_not_called()
            a._CEC_SOURCES['t'] = -1e9
            worker.return_value.start.side_effect = RuntimeError('no thread slots')
            state = a.tv_sources(force=True)
            self.assertFalse(state['loading'])
            self.assertIn('Retry', state['error'])

    def test_old_adapter_scan_does_not_replace_new_inventory(self):
        self.cache()
        a._CEC_SOURCES['key'] = ('/usr/bin/cec-ctl', '/dev/cec1')
        with patch.object(a.subprocess, 'run', side_effect=TimeoutError()):
            a._cec_scan_sources(CEC, a._cec_source_key(CEC))
        self.assertIsNone(a._CEC_SOURCES['error'])
        self.assertEqual(len(a._CEC_SOURCES['sources']), 2)

class Routes(unittest.TestCase):

    @classmethod
    def setUpClass(cls):

        class Handler(a.Handler):
            token = 'cec-route-test-only'
            mock = False
        cls.http = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def request(self, method, path, auth, body=None):
        c = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=3)
        headers = {'Authorization': 'Bearer cec-route-test-only'} if auth else {}
        c.request(method, path, body=(json.dumps(body).encode() if body is not None
                  else b'' if method == 'POST' else None), headers=headers)
        r = c.getresponse()
        status = r.status
        data = json.loads(r.read())
        c.close()
        return (status, data)

    def test_get_and_post_auth_gate(self):
        with patch.object(a, 'tv_sources') as scan, patch.object(a, 'real_cec_select_source') as switch:
            self.assertEqual(self.request('GET', '/api/tv/sources?refresh=1', False)[0], 401)
            self.assertEqual(self.request('POST', '/api/tv/source/cec-2.0.0.0', False)[0], 401)
            scan.assert_not_called()
            switch.assert_not_called()

    def test_authed_refresh(self):
        with patch.object(a, 'tv_sources', return_value={'sources': [], 'loading': True}) as scan:
            status, data = self.request('GET', '/api/tv/sources?refresh=1', True)
            self.assertEqual(status, 200)
            self.assertTrue(data['loading'])
            scan.assert_called_once_with(False, force=True)

    def test_mock_never_accesses_cec_hardware(self):
        self.http.RequestHandlerClass.mock = True
        try:
            with patch.object(a, 'panel_available', return_value=False), \
                    patch.object(a, 'cec_current') as cec, \
                    patch.object(a, 'real_cec_select_source') as switch:
                status, data = self.request('GET', '/api/tv/sources?refresh=1', True)
                self.assertEqual(status, 200)
                self.assertEqual(data['backend'], 'panel')
                self.assertEqual(self.request('POST', '/api/tv/source/cec-2.0.0.0', True)[0], 404)
                cec.assert_not_called()
                switch.assert_not_called()
        finally:
            self.http.RequestHandlerClass.mock = False

    def test_unknown_source_refused_over_http(self):
        a._CEC_SOURCES.update(key=a._cec_source_key(CEC), t=time.monotonic(), loading=False, sources=a._cec_parse_sources(DUMP), error=None)
        with patch.object(a, 'panel_available', return_value=False), patch.object(a, 'cec_current', return_value=CEC), patch.object(a.subprocess, 'run') as run:
            status, _ = self.request('POST', '/api/tv/source/cec-2.0.0.0%3Breboot', True)
            self.assertEqual(status, 409)
            run.assert_not_called()

    def test_explicit_paired_remote_preserves_cec_power_choice(self):
        with patch.object(a, '_tv_hw_backend', return_value='cec'), \
                patch.object(a, 'tv_key_backends_available', return_value=['androidtv']), \
                patch.object(a, 'real_androidtv_key', return_value={'ok': True}) as send:
            status, data = self.request('POST', '/api/tv/key/source', True,
                                        {'backend': 'androidtv'})
            self.assertEqual(status, 200)
            self.assertTrue(data['ok'])
            send.assert_called_once_with('source')
            # Body-less legacy requests still use the active hardware backend.
            self.assertEqual(self.request('POST', '/api/tv/key/source', True)[0], 404)
            self.assertEqual(self.request('POST', '/api/tv/key/source', True, {})[0], 404)
            self.assertEqual(send.call_count, 1)

    def test_explicit_remote_auth_validation_and_removed_pairing(self):
        with patch.object(a, '_tv_hw_backend', return_value='cec'), \
                patch.object(a, 'tv_key_backends_available', return_value=['androidtv']), \
                patch.object(a, 'real_androidtv_key') as send:
            self.assertEqual(self.request('POST', '/api/tv/key/source', False,
                                        {'backend': 'androidtv'})[0], 401)
            for body in ([], 'androidtv', {'host': '10.0.0.1'},
                         {'backend': 243}, {'backend': 'androidtv', 'code': 243}):
                self.assertEqual(self.request('POST', '/api/tv/key/source', True, body)[0], 400)
            for backend in ('cec', 'samsung', '10.0.0.1', '--help'):
                self.assertEqual(self.request('POST', '/api/tv/key/source', True,
                                            {'backend': backend})[0], 409)
            self.assertEqual(self.request('POST', '/api/tv/key/245', True,
                                        {'backend': 'androidtv'})[0], 404)
            send.assert_not_called()
        with patch.object(a, 'tv_key_backends_available', return_value=[]), \
                patch.object(a, 'real_androidtv_key') as send:
            self.assertEqual(self.request('POST', '/api/tv/key/source', True,
                                        {'backend': 'androidtv'})[0], 409)
            send.assert_not_called()

    def test_explicit_remote_mock_never_sends_to_tv(self):
        self.http.RequestHandlerClass.mock = True
        try:
            with patch.object(a, 'tv_key_backends_available', return_value=['androidtv']), \
                    patch.object(a, 'real_androidtv_key') as real:
                status, data = self.request('POST', '/api/tv/key/source', True,
                                            {'backend': 'androidtv'})
                self.assertEqual(status, 200)
                self.assertTrue(data['ok'])
                real.assert_not_called()
        finally:
            self.http.RequestHandlerClass.mock = False
if __name__ == '__main__':
    unittest.main()
