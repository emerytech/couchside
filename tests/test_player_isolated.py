#!/usr/bin/env python3
"""Isolated test package auth, route allowlist and browser ownership fixtures."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import time
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('isolated', ROOT / 'scripts/player-test/player_test.py')
pt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pt)


class FakeProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        self.returncode = 0
        return 0


class IsolatedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = pt.private_state(Path(self.tmp.name) / 'state')
        self.player = pt.Player(self.state)
        self.server = pt.Server(('127.0.0.1', 0), pt.Handler)
        self.server.player = self.player
        self.player.bind_surface(self.server.server_port)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=5)
        self.player.close()

    def request(self, method='GET', path='/api/player', body=None, token=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Authorization': 'Bearer ' + (self.player.token if token is True else token)} if token else {}
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = conn.getresponse()
        status, data = response.status, response.read()
        cors = response.getheader('Access-Control-Allow-Origin')
        conn.close()
        return status, data, cors

    def test_auth_and_route_boundary(self):
        with patch.object(self.player.browser, 'start') as start:
            for method in ('GET', 'POST'):
                self.assertEqual(self.request(method, body={'op': 'catalog-open', 'video_id': pt.VIDEO_ID}, token=False)[0], 401)
            for path in ('/pair', '/api/pair/start', '/api/pair/finish', '/api/power',
                         '/api/settings', '/api/update', '/api/decky', '/api/tv',
                         '/ws/gamepad', '/api/player?token=bad', '/../couchsided.py'):
                self.assertEqual(self.request(path=path)[0], 404)
                self.assertEqual(self.request('POST', path, {'op': 'close'})[0], 404)
            start.assert_not_called()
        status, page, cors = self.request(path='/')
        self.assertEqual(status, 200)
        self.assertNotIn(self.player.token.encode(), page)
        self.assertIsNone(cors)
        self.assertEqual((self.state / 'test-token').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_existing_phone_connection_contract(self):
        # Setup's manual Test connection: unauthenticated ping, then status
        # using ONLY this package's token. No production pairing is involved.
        status, data, cors = self.request(path='/api/ping', token=False)
        ping = json.loads(data)
        self.assertEqual(status, 200)
        self.assertEqual(ping['app'], 'couchside-agent')
        self.assertTrue(ping['ok'])
        self.assertNotIn(self.player.token.encode(), data)
        self.assertNotIn('tls_port', ping)
        self.assertIsNone(cors)
        for path in ('/api/status', '/api/launchers'):
            self.assertEqual(self.request(path=path, token=False)[0], 401)
            self.assertEqual(self.request(path=path, token='unrelated-production-token')[0], 401)
            self.assertEqual(self.request('POST', path, {})[0], 404)
        status, data, _ = self.request(path='/api/status')
        envelope = json.loads(data)
        self.assertEqual(status, 200)
        self.assertEqual(envelope['scope'], 'isolated-player-test')
        self.assertFalse(envelope['telemetry_available'])
        self.assertEqual({k for k, v in envelope['caps'].items() if v},
                         {'player', 'steam', 'launchers'})
        self.assertEqual(json.loads(self.request(path='/api/launchers')[1]),
                         {'launchers': [], 'create_enabled': False})
        info = json.loads(self.request()[1])
        self.assertTrue(info['available'])
        self.assertEqual(info['services'], ['sample'])
        self.assertEqual(info['seek_secs'], [-10, 10])
        self.assertFalse(info['open_url'])
        self.assertFalse(info['searchable'])

    def test_legacy_phone_sample_tile_and_transport(self):
        # Watch's existing Services tile POST shape. Both catalog and legacy
        # open use the same owned browser and share the launch rate limit.
        with patch.object(self.player.browser, 'start') as start:
            self.assertEqual(self.request('POST', body={'op': 'open', 'service': 'sample'})[0], 200)
            start.assert_called_once_with()
            self.assertEqual(self.request('POST', body={'op': 'catalog-open', 'video_id': pt.VIDEO_ID})[0], 429)
        with patch.object(self.player.browser, 'running', return_value=True), \
                patch.object(self.player.agent, 'player_playback', return_value={'playing': True}), \
                patch.object(self.player.agent, 'player_transport', return_value={'ok': True}) as transport:
            self.assertEqual(json.loads(self.request()[1])['service'], 'sample')
            for req in ({'op': 'playpause'}, {'op': 'seek', 'secs': -10},
                        {'op': 'seek', 'secs': 10}, {'op': 'mute'}):
                self.assertEqual(self.request('POST', body=req)[0], 200)
                transport.assert_called_with(req['op'], secs=req.get('secs'))
        with patch.object(self.player.browser, 'stop') as stop:
            self.assertEqual(self.request('POST', body={'op': 'close'})[0], 200)
            stop.assert_called_once_with()

    def test_tv_surface_is_fixed_and_loopback_only(self):
        status, page, _ = self.request(path='/tv', token=False)
        self.assertEqual(status, 200)
        self.assertIn(self.player.media_source.encode(), page)
        self.assertNotIn(self.player.token.encode(), page)
        self.assertEqual(self.player.browser.source, 'http://127.0.0.1:%d/tv' % self.server.server_port)
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        conn.request('GET', '/tv', headers={'Host': 'evil.test'})
        response = conn.getresponse()
        self.assertEqual(response.status, 404)
        response.read()
        conn.close()
        self.assertEqual(self.request(path='/tv?url=https://evil.test/')[0], 404)
        # Even with a valid Host, a LAN peer cannot retrieve the TV page.
        from types import SimpleNamespace
        handler = object.__new__(pt.Handler)
        handler.path = '/tv'
        handler.client_address = ('192.0.2.1', 10000)
        handler.server = SimpleNamespace(server_port=self.server.server_port)
        handler.headers = {'Host': '127.0.0.1:%d' % self.server.server_port}
        with patch.object(handler, 'reply') as reply:
            handler.do_GET()
            self.assertEqual(reply.call_args.args[0], 404)

    def test_rejections_launch_nothing(self):
        bad = [None, [], 'x', {'op': []}, {'op': 'power'}, {'op': 'open', 'url': 'https://evil.test'},
               {'op': 'catalog-open', 'video_id': []}, {'op': 'catalog-open', 'video_id': 'evil'},
               {'op': 'catalog-open', 'video_id': pt.VIDEO_ID, 'url': 'https://evil.test'},
               {'op': 'seek', 'secs': True}, {'op': 'seek', 'secs': 10.0}, {'op': 'seek', 'secs': 90},
               {'op': 'close', 'pid': 1}, {'op': 'open', 'service': 'youtube'},
               {'op': 'open', 'service': []}, {'op': 'open'},
               {'op': 'open', 'service': 'sample', 'path': '/'},
               {'op': 'open', 'service': 'sample', 'query': 'x'},
               {'op': 'open', 'service': 'sample', 'url': 'https://evil.test'}]
        with patch.object(self.player.browser, 'start') as start, patch.object(self.player.browser, 'stop') as stop:
            for body in bad:
                with self.subTest(body=body):
                    status, _, _ = self.request('POST', body=body)
                    self.assertIn(status, (400, 404))
            start.assert_not_called()
            stop.assert_not_called()
        self.assertEqual(self.request('POST', body={'op': 'play'})[0], 409)

    def test_allowed_launch_and_throttle(self):
        body = {'op': 'catalog-open', 'video_id': pt.VIDEO_ID}
        with patch.object(self.player.browser, 'start') as start:
            self.assertEqual(self.request('POST', body=body)[0], 200)
            self.assertEqual(self.request('POST', body=body)[0], 429)
            start.assert_called_once_with()
        self.assertEqual(self.request('POST', body={'op': 'close'})[0], 200)
        status, data, _ = self.request()
        self.assertEqual(status, 200)
        info = json.loads(data)
        self.assertFalse(info['running'])
        self.assertIsNone(info['catalog_video'])
        self.assertIsNone(info['playback'])
        self.assertEqual(self.player.agent.PLAYER_CONF, str(self.state / 'unused-player.conf'))

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux parent-death semantics')
    def test_linux_parent_death_signal_matches_lifecycle(self):
        children = []
        def spawn():
            # A real kernel parent-death signal, the mechanism behind
            # Flatpak/bubblewrap --die-with-parent, not a mock thread flag.
            code = "import ctypes,signal,time; assert ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)==0; print('ready',flush=True); time.sleep(60)"
            proc = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
            children.append(proc)
            self.assertEqual(proc.stdout.readline().strip(), 'ready')
        def cleanup():
            for proc in children:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=5)
                proc.stdout.close()
        self.addCleanup(cleanup)
        # Pre-fix control: the request-like thread exits while this process lives.
        short = threading.Thread(target=spawn)
        short.start()
        short.join(timeout=10)
        self.assertFalse(short.is_alive())
        self.assertEqual(children[0].wait(timeout=5), -signal.SIGTERM)
        def stop():
            children[-1].terminate()
            children[-1].wait(timeout=5)
        with patch.object(self.player.browser, 'start', side_effect=spawn), patch.object(self.player.browser, 'stop', side_effect=stop):
            self.assertEqual(self.request('POST', body={'op': 'catalog-open', 'video_id': pt.VIDEO_ID})[0], 200)
            time.sleep(0.2)  # allow the completed request thread to exit
            self.assertIsNone(children[-1].poll(), 'browser must survive HTTP worker exit')
            self.assertEqual(self.request('POST', body={'op': 'close'})[0], 200)
            self.assertIsNotNone(children[-1].poll(), 'explicit Stop must still end the child')

    def test_browser_owner_outlives_http_request(self):
        launched_by = []
        stopped_by = []
        def start():
            launched_by.append(threading.current_thread())
        def stop():
            stopped_by.append(threading.current_thread())
        with patch.object(self.player.browser, 'start', side_effect=start), patch.object(self.player.browser, 'stop', side_effect=stop):
            self.assertEqual(self.request('POST', body={'op': 'catalog-open', 'video_id': pt.VIDEO_ID})[0], 200)
            owner = launched_by[0]
            self.assertTrue(owner.name.startswith('player-browser-owner'))
            self.assertTrue(owner.is_alive(), 'request completion must not kill the browser owner')
            self.assertEqual(self.request('POST', body={'op': 'close'})[0], 200)
            self.assertIs(stopped_by[0], owner)
            self.assertTrue(owner.is_alive(), 'Stop must preserve the owner for reopening')

    def test_flatpak_ownership(self):
        browser = self.player.browser
        fake = FakeProcess()
        commands = []

        def spawn(argv, **kwargs):
            commands.append(argv)
            self.assertEqual(kwargs['pass_fds'], (int(next(a.split('=')[1] for a in argv if a.startswith('--instance-id-fd='))),))
            os.write(kwargs['pass_fds'][0], b'123456789\n')
            profile = Path(next(a.split('=', 1)[1] for a in argv if a.startswith('--user-data-dir=')))
            (profile / 'DevToolsActivePort').write_text('19234\n/devtools/browser/test\n')
            self.assertIn('--filesystem=' + str(profile), argv)
            self.assertNotIn('--filesystem=' + str(self.state), argv)
            self.assertIn('--die-with-parent', argv)
            self.assertIn('--disable-accelerated-video-decode', argv)
            self.assertNotIn('--disable-gpu', argv)
            return fake

        def run(argv, **kwargs):
            commands.append(argv)
            return subprocess.CompletedProcess(argv, 0)

        with patch.object(pt.shutil, 'which', side_effect=lambda name: '/usr/bin/flatpak' if name == 'flatpak' else None), patch.object(pt.subprocess, 'run', side_effect=run), patch.object(pt.subprocess, 'Popen', side_effect=spawn):
            browser.start()
            self.assertEqual(browser.port, 19234)
            browser.stop()
        self.assertIn(['/usr/bin/flatpak', 'kill', '123456789'], commands)
        self.assertNotIn(['/usr/bin/flatpak', 'kill', 'com.google.Chrome'], commands)
        self.assertTrue(fake.terminated)
        self.assertIsNone(browser.port)

    def test_malformed_flatpak_id_never_becomes_an_app_wide_kill(self):
        browser = self.player.browser
        fake = FakeProcess()
        commands = []

        def spawn(argv, **kwargs):
            os.write(kwargs['pass_fds'][0], b'com.google.Chrome\n')
            return fake

        def run(argv, **kwargs):
            commands.append(argv)
            return subprocess.CompletedProcess(argv, 0)

        with patch.object(pt.shutil, 'which', side_effect=lambda name: '/usr/bin/flatpak' if name == 'flatpak' else None), patch.object(pt.subprocess, 'run', side_effect=run), patch.object(pt.subprocess, 'Popen', side_effect=spawn):
            with self.assertRaises(RuntimeError):
                browser.start()
        self.assertTrue(fake.terminated)
        self.assertFalse(any('kill' in cmd for cmd in commands))

    def test_production_ports_refused_before_creating_state(self):
        result = subprocess.run([__import__('sys').executable, str(ROOT / 'scripts/player-test/player_test.py'), '--port', '8787'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('test port is 8791', result.stderr)

    def test_cleanup_when_flatpak_kill_fails(self):
        browser = self.player.browser
        fake = FakeProcess()
        browser.proc, browser.flatpak, browser.instance = fake, '/usr/bin/flatpak', '24680'
        with patch.object(pt.subprocess, 'run', side_effect=subprocess.TimeoutExpired('flatpak', 10)):
            browser.stop()
        self.assertTrue(fake.terminated)
        self.assertIsNone(browser.instance)

    def test_session_shutdown_releases_owner_and_refuses_relaunch(self):
        with patch.object(self.player.browser, 'start') as start:
            self.assertEqual(self.request('POST', body={'op': 'catalog-open', 'video_id': pt.VIDEO_ID})[0], 200)
            self.player.close()
            self.player.close()  # idempotent
            self.assertFalse(any(t.is_alive() for t in self.player.owner._threads))
            self.assertEqual(self.request('POST', body={'op': 'catalog-open', 'video_id': pt.VIDEO_ID})[0], 409)
            start.assert_called_once_with()

    def test_native_cleanup_signals_only_owned_child(self):
        fake = FakeProcess()
        self.player.browser.proc = fake
        with patch.object(pt.subprocess, 'run') as run, patch.object(pt.os, 'kill') as kill:
            self.player.browser.stop()
            run.assert_not_called()
            kill.assert_not_called()
        self.assertTrue(fake.terminated)

    def test_token_symlink_is_refused(self):
        target = self.state / 'unrelated'
        target.write_text('keep')
        (self.state / 'test-token').unlink()
        (self.state / 'test-token').symlink_to(target)
        with self.assertRaises(OSError):
            pt.Player(self.state)
        self.assertEqual(target.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
