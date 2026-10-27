#!/usr/bin/env python3
"""Catalog HTTP boundary: authorized IDs only, no client URL or launch on refusal."""
import http.client
import importlib.util
import json
from pathlib import Path
import threading
import tempfile
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('cs', Path(__file__).resolve().parents[1] / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cs.set_player(True)
        cs.Handler.token = 'catalog-test'
        cs.Handler.mock = True
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), cs.Handler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def request(self, method, payload=None, token='catalog-test'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        conn.request(method, '/api/player', json.dumps(payload) if payload is not None else None, headers)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def setUp(self):
        cs._pl_last_open[0] = 0
        cs.PL_MOCK = True
        cs._PL_MOCK.clear()
        cs._PL_MOCK.update(running=False, service="", path="", query="")

    def test_catalog_and_exact_source(self):
        status, data = self.request('GET')
        self.assertEqual(status, 200)
        self.assertEqual(len(data['catalog']['metas']), 1)
        video_id = data['catalog']['metas'][0]['id']
        with patch.object(cs, 'player_open', return_value={'ok': True}) as launch:
            self.assertEqual(self.request('POST', {'op': 'catalog-open', 'video_id': video_id})[0], 200)
            launch.assert_called_once_with('', url='https://media.w3.org/2010/05/bunny/trailer.mp4')
        # Returned metadata cannot mutate the source allowlist.
        data['catalog']['metas'][0]['id'] = 'evil'
        self.assertEqual(cs.player_catalog()['metas'][0]['id'], video_id)

    def test_real_conf_and_launch_path(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(cs, 'PL_MOCK', False), patch.object(cs, 'PLAYER_CONF', str(Path(tmp) / 'player.conf')), patch.object(cs, 'player_available', return_value=True), patch.object(cs, '_pl_running', return_value=False), patch.object(cs, '_pl_appid', return_value=123), patch.object(cs, '_pl_relaunch') as launch:
            cs.player_catalog_open('couchside:bbb-trailer')
            launch.assert_called_once_with(123, False)
            conf = Path(cs.PLAYER_CONF).read_text()
            self.assertIn('url=https://media.w3.org/2010/05/bunny/trailer.mp4\n', conf)
            with patch.object(cs, '_pl_running', return_value=True):
                self.assertEqual(cs.player_catalog_current()['id'], 'couchside:bbb-trailer')
            self.assertIsNone(cs.player_catalog_current())

    def test_current_catalog_clears_on_stop_and_switch(self):
        cs.player_catalog_open('couchside:bbb-trailer')
        self.assertEqual(cs.player_catalog_current()['id'], 'couchside:bbb-trailer')
        cs.player_close()
        self.assertIsNone(cs.player_info()['catalog_video'])
        cs.player_catalog_open('couchside:bbb-trailer')
        cs.player_hub()
        self.assertIsNone(cs.player_info()['catalog_video'])
        cs.player_catalog_open('couchside:bbb-trailer')
        cs.player_open('youtube')
        self.assertIsNone(cs.player_info()['catalog_video'])
        self.assertEqual(cs._PL_MOCK.get('url'), '')

    def test_refusals_never_launch(self):
        for video_id in [None, '', [], {}, 1, True, 'https://evil.test/', '$(id)', '../../etc/passwd']:
            with self.subTest(video_id=video_id), patch.object(cs, 'player_open') as launch:
                self.assertEqual(self.request('POST', {'op': 'catalog-open', 'video_id': video_id})[0], 404)
                launch.assert_not_called()
        with patch.object(cs, 'player_open') as launch:
            payload = {'op': 'catalog-open', 'video_id': 'couchside:bbb-trailer'}
            for method in ['GET', 'POST']:
                for token in [None, 'wrong']:
                    self.assertEqual(self.request(method, payload if method == 'POST' else None, token)[0], 401)
            self.assertEqual(self.request('POST', dict(payload, url='https://evil.test/'))[0], 400)
            launch.assert_not_called()

    def test_rate_limit_and_unavailable(self):
        payload = {'op': 'catalog-open', 'video_id': 'couchside:bbb-trailer'}
        with patch.object(cs, 'player_open', return_value={'ok': True}) as launch:
            self.assertEqual(self.request('POST', payload)[0], 200)
            self.assertEqual(self.request('POST', payload)[0], 429)
            self.assertEqual(launch.call_count, 1)
        with patch.object(cs, 'player_available', return_value=False), patch.object(cs, 'player_open') as launch:
            self.assertEqual(self.request('POST', payload)[0], 404)
            launch.assert_not_called()

if __name__ == '__main__':
    unittest.main()
