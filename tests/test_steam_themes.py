#!/usr/bin/env python3
"""Exercise the real authenticated routes, persistence and companion fallback."""
import asyncio
import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
cs = load('theme_agent', ROOT / 'agent/couchsided.py')

class Themes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        cs._STEAM_THEME_FILE = str(Path(self.tmp.name) / 'steam-themes.json')
        self.original_probe = cs._decky_read_json_capped
        cs._decky_read_json_capped = lambda path: ({'api': 1}, None)
        cs.Handler.token = 'test-themes-local'
        cs.Handler.token_file = None
        cs.Handler.mock = False
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), cs.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        cs._decky_read_json_capped = self.original_probe
        self.tmp.cleanup()
    def req(self, method, data=None, token=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = {'Authorization': 'Bearer test-themes-local'} if token else {}
        body = json.dumps(data) if data is not None else None
        conn.request(method, '/api/steam/themes', body, headers)
        r = conn.getresponse(); result = (r.status, json.loads(r.read())); conn.close()
        return result
    def test_other_renderer_blocks_enable_but_not_restore(self):
        with patch.object(cs, '_steam_theme_conflict', return_value='Turn off ThemeHub first'):
            self.assertEqual(self.req('POST', {'installed': True, 'enabled': True})[0], 400)
            self.assertFalse(Path(cs._STEAM_THEME_FILE).exists())
            self.assertEqual(self.req('POST', {'enabled': False})[0], 200)

    def test_conflict_reader_and_malformed_settings(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); (root/'plugin.json').write_text('{}')
            original = cs.os.path.expanduser
            def home(path):
                if path.endswith('/ThemeHub/plugin.json'): return str(root/'plugin.json')
                if path.endswith('/ThemeHub/settings.json'): return str(root/'settings.json')
                return original(path)
            with patch.object(cs.os.path, 'expanduser', side_effect=home):
                for value in ['{', '[]', '{}', '{"enabled":true}', 'x'*65537]:
                    (root/'settings.json').write_text(value)
                    self.assertTrue(cs._steam_theme_conflict())
                (root/'settings.json').write_text('{"enabled":false}')
                self.assertIsNone(cs._steam_theme_conflict())

    def test_console_layouts_require_capability(self):
        state = self.req('GET')[1]
        self.assertNotIn('wave', [t['id'] for t in state['themes']])
        self.assertEqual(self.req('POST', {'installed': True, 'enabled': True, 'theme': 'wave'})[0], 400)
        cs._decky_read_json_capped = lambda path: ({'api': 1, 'themes': ['couchside', 'orbit', 'shelf', 'wave', 'channels']}, None)
        for theme in ['wave', 'channels']:
            code, body = self.req('POST', {'installed': True, 'enabled': True, 'theme': theme})
            self.assertEqual(code, 200)
            self.assertEqual(body['settings']['theme'], theme)
            self.assertIn(theme, [item['id'] for item in body['themes']])

    def test_auth_and_persistence(self):
        self.assertEqual(self.req('GET', token=False)[0], 401)
        self.assertEqual(self.req('POST', {'installed': True}, token=False)[0], 401)
        self.assertFalse(Path(cs._STEAM_THEME_FILE).exists())
        self.assertFalse(self.req('GET')[1]['settings']['enabled'])
        code, body = self.req('POST', {'installed': True, 'enabled': True, 'theme': 'orbit', 'accent': 'violet', 'motion': False})
        self.assertEqual(code, 200)
        self.assertEqual(body['settings'], cs._steam_theme_read())
        self.assertEqual(os.stat(cs._STEAM_THEME_FILE).st_mode & 0o777, 0o600)
        self.assertEqual(self.req('GET')[1]['settings']['theme'], 'orbit')
        self.assertEqual(self.req('POST', {'enabled': False})[0], 200)
        self.assertFalse(self.req('GET')[1]['settings']['enabled'])
    def test_rejected_data_never_changes_settings(self):
        for bad in [[], 'code', {'theme': '../../etc'}, {'theme': []}, {'accent': '#fff'}, {'enabled': 1}, {'motion': 'false'}, {'version': True}, {'script': 'run'}, {'enabled': True}]:
            with self.subTest(bad=bad):
                self.assertEqual(self.req('POST', bad)[0], 400)
                self.assertFalse(Path(cs._STEAM_THEME_FILE).exists())
    def test_oversized_body_refused_before_read(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        conn.putrequest('POST', '/api/steam/themes')
        conn.putheader('Authorization', 'Bearer test-themes-local')
        conn.putheader('Content-Length', '4097')
        conn.endheaders()
        response = conn.getresponse()
        self.assertEqual(response.status, 413)
        response.read(); conn.close()
        self.assertFalse(Path(cs._STEAM_THEME_FILE).exists())

    def test_missing_companion_and_corrupt_state(self):
        cs._decky_read_json_capped = lambda path: (None, None)
        self.assertEqual(self.req('POST', {'installed': True, 'enabled': True})[0], 400)
        self.assertEqual(self.req('POST', {'enabled': False})[0], 200)
        for content in ['{', 'x'*4097, '{"enabled":true,"theme":"evil"}']:
            Path(cs._STEAM_THEME_FILE).write_text(content)
            self.assertFalse(self.req('GET')[1]['settings']['enabled'])
        Path(cs._STEAM_THEME_FILE).unlink()
        target = Path(self.tmp.name) / 'other'; target.write_text('keep')
        Path(cs._STEAM_THEME_FILE).symlink_to(target)
        self.assertFalse(self.req('GET')[1]['settings']['enabled'])
        self.assertEqual(self.req('POST', {'enabled': False})[0], 200)
        self.assertEqual(target.read_text(), 'keep')

if __name__ == '__main__': unittest.main()
