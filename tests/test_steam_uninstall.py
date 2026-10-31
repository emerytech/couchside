#!/usr/bin/env python3
"""Steam UI handoff only: synthetic manifests, stub execution, real auth/routes.
No game is removed. Native Steam confirmation behavior needs device acceptance.
"""
import http.client
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
AGENTS = []
for name, rel in [('uninstall_linux', 'agent/couchsided.py'), ('uninstall_win', 'agent/win/couchsided-win.py')]:
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    AGENTS.append(module)
GAME = {'id': 'steam:620', 'appid': 620, 'label': 'QA game', 'kind': 'steam'}

class UninstallTests(unittest.TestCase):
    def test_manifest_allowlist_and_idle_state(self):
        for agent in AGENTS:
            with self.subTest(agent=agent.__name__), tempfile.TemporaryDirectory() as root:
                path = Path(root) / 'appmanifest_620.acf'
                with patch.object(agent, '_steam_root', return_value=root), patch.object(agent, '_steam_libraries', return_value=[root]):
                    for flags, ready in [('4', True), ('1028', False), ('6', False), ('', False), ('junk', False)]:
                        path.write_text('"appid" "620"\n"name" "QA game"\n"StateFlags" "%s"\n' % flags)
                        self.assertEqual(agent._steam_uninstall_ready('620'), ready)
                    self.assertFalse(agent._steam_uninstall_ready('../620'))
                    self.assertFalse(agent._steam_uninstall_ready('６２０'))
                    self.assertFalse(agent._steam_uninstall_ready('0620'))
                    path.write_text('"appid" "570"\n"name" "QA game"\n"StateFlags" "4"\n')
                    self.assertFalse(agent._steam_uninstall_ready('620'))
                    path.unlink()
                    self.assertFalse(agent._steam_uninstall_ready('620'))

    def test_request_refuses_bad_ids_missing_confirmation_busy_and_disappeared_games(self):
        for agent in AGENTS:
            with self.subTest(agent=agent.__name__), patch.object(agent, 'discover_steam_games', return_value=[GAME]), patch.object(agent, '_steam_uninstall_ready', return_value=True) as ready, patch.object(agent, '_launcher_argv', return_value=['steam-executable', 'steam://rungameid/620']), patch.object(agent, 'real_launch', return_value={'ok': True}) as launch:
                for body in [None, {}, {'id': 'steam:620', 'confirm': 1}, {'id': 'custom:620', 'confirm': True}, {'id': 'steam:620;bad', 'confirm': True}]:
                    self.assertEqual(agent.steam_uninstall_request(body)[0], 400)
                self.assertEqual(agent.steam_uninstall_request({'id': 'steam:570', 'confirm': True})[0], 404)
                ready.return_value = False
                self.assertEqual(agent.steam_uninstall_request({'id': 'steam:620', 'confirm': True})[0], 409)
                launch.assert_not_called()
                ready.return_value = True
                status, result = agent.steam_uninstall_request({'id': 'steam:620', 'confirm': True})
                self.assertEqual((status, result['state']), (200, 'requested'))
                launch.assert_called_once_with(['steam-executable', 'steam://uninstall/620'])
                self.assertNotIn('removed', result)

    def test_offers_do_not_mutate_cached_records(self):
        for agent in AGENTS:
            with patch.object(agent, '_steam_uninstall_ready', return_value=False):
                offered = agent._with_uninstall_offers([GAME, {'id': 'custom:a', 'kind': 'custom'}])
                self.assertEqual(offered[0]['uninstall'], 'busy')
                self.assertNotIn('uninstall', GAME)
                self.assertNotIn('uninstall', offered[1])

    def test_authenticated_http_route(self):
        for agent in AGENTS:
            with self.subTest(agent=agent.__name__), patch.object(agent, 'discover_steam_games', return_value=[GAME]), patch.object(agent, '_steam_uninstall_ready', return_value=True), patch.object(agent, '_launcher_argv', return_value=['steam-executable', 'steam://rungameid/620']), patch.object(agent, 'real_launch', return_value={'ok': True}) as launch:
                agent.Handler.token = 'synthetic-qa-token'
                agent.Handler.token_file = None
                agent.Handler.mock = False
                agent.Handler.port = 0
                server = ThreadingHTTPServer(('127.0.0.1', 0), agent.Handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                try:
                    for token, appid, expected in [(None,'620',401), ('wrong','620',401), ('synthetic-qa-token','570',404), ('synthetic-qa-token','620',200)]:
                        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        headers = {'Content-Type': 'application/json'}
                        if token: headers['Authorization'] = 'Bearer ' + token
                        conn.request('POST','/api/steam/uninstall',json.dumps({'id':'steam:'+appid,'confirm':True}),headers)
                        response = conn.getresponse(); response.read(); conn.close()
                        self.assertEqual(response.status, expected)
                    launch.assert_called_once()
                finally:
                    server.shutdown(); server.server_close()

if __name__ == '__main__':
    unittest.main()
