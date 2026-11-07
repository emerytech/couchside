"""Exercise real dispatch methods in isolation on both single-file agents."""
import ast
import json
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]

class GuideTests(unittest.TestCase):
    def test_dispatch_and_no_credentials(self):
        pages = []
        for filename in ('agent/couchsided.py', 'agent/win/couchsided-win.py'):
            with self.subTest(agent=filename):
                tree = ast.parse((ROOT / filename).read_text())
                render = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'render_air_mouse_page')
                handler = next(n for n in tree.body if isinstance(n, ast.ClassDef) and any(isinstance(m, ast.FunctionDef) and m.name == 'do_GET' for m in n.body))
                methods = [m for m in handler.body if isinstance(m, ast.FunctionDef) and m.name in ('do_GET', 'do_POST')]
                ns = dict(time=time, urlparse=urlparse, parse_qs=parse_qs, json=json,
                          _BOX_POP_LOCK=threading.Lock(), _BOX_POP_AT=[0], _BOX_POP_COOLDOWN=10,
                          pair_show_on_box_url=Mock(), os=Mock())
                ns['ssl'] = type('TLS', (), {'SSLSocket': type('Socket', (), {})})
                exec(compile(ast.fix_missing_locations(ast.Module(body=[render]+methods, type_ignores=[])), filename, 'exec'), ns)
                page = ns['render_air_mouse_page'](); pages.append(page)
                self.assertNotIn('fetch(', page)
                self.assertNotIn('token', page)
                for local, host, expected in ((True, True, 200), (False, True, 403), (True, False, 403)):
                    peer = Mock(path='/air-mouse', _is_loopback=Mock(return_value=local), _host_header_is_local=Mock(return_value=host))
                    ns['do_GET'](peer)
                    sender = peer._send_html if expected == 200 else peer._send
                    self.assertEqual(sender.call_args.args[0], expected)
                for auth, expected in ((False, 401), (True, 200), (True, 429)):
                    peer = Mock(port=8787, path='/api/air-mouse/show', headers={}, _authorized=Mock(return_value=auth))
                    ns['do_POST'](peer)
                    self.assertEqual(peer._send.call_args.args[0], expected)
                launch = ns['os'].startfile if '/win/' in filename else ns['pair_show_on_box_url']
                self.assertEqual(launch.call_count, 1)
                self.assertIn('/air-mouse', launch.call_args.args[0])
        self.assertEqual(pages[0], pages[1])

if __name__ == '__main__': unittest.main()
