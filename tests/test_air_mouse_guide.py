"""Exercise real dispatch methods in isolation on both single-file agents."""
import ast
import json
import re
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

class CursorLeaseTests(unittest.TestCase):
    def test_validation_and_stale_stop_cannot_retire_new_session(self):
        tree=ast.parse((ROOT/'agent/couchsided.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='air_cursor_lease')
        proc=Mock(); ns=dict(re=re,threading=threading,_AIR_CURSOR_LOCK=threading.Lock(),_AIR_CURSOR_PROCESS=proc,_AIR_CURSOR_OWNER='newlease123',subprocess=__import__('subprocess'))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'lease','exec'),ns)
        for enabled,lease in ((1,'newlease123'),(True,'bad\nname'),(True,'short')):
            with self.assertRaises(ValueError):ns['air_cursor_lease'](enabled,lease)

        for size in (0,999,'192',True):
            with self.assertRaises(ValueError):ns['air_cursor_lease'](True,'newlease123',size)
        self.assertTrue(ns['air_cursor_lease'](False,'oldlease123')['ok'])
        proc.stdin.close.assert_not_called()
        self.assertTrue(ns['air_cursor_lease'](False,'newlease123')['ok'])
        proc.stdin.close.assert_called_once();proc.wait.assert_called_once()

class WebosPointerTests(unittest.TestCase):
    def test_bounded_frames_stop_and_no_replay_after_uncertain_send(self):
        tree=ast.parse((ROOT/'agent/couchsided.py').read_text())
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('real_webos_pointer','_webos_result')]
        session=Mock();conn=Mock(return_value=session)
        ns=dict(time=time,WEBOS=session,WEBOS_LOCK=threading.Lock(),_WEBOS_MOCK=False,_webos_conn=conn)
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'webos','exec'),ns)
        send=ns['real_webos_pointer']
        for req in ({'op':'move','dx':True,'dy':0},{'op':'move','dx':121,'dy':0},{'op':'move','dx':float('nan'),'dy':0},{'op':'injected'}):
            with self.assertRaises(ValueError):send(req)
        conn.assert_not_called()
        self.assertTrue(send({'op':'move','dx':12,'dy':-8})['ok'])
        session.pointer_frame.assert_called_once_with('type:move\ndx:12\ndy:-8\ndown:0\n\n')
        send({'op':'click'});session.pointer_frame.assert_called_with('type:click\n\n')
        send({'op':'stop'});self.assertIsNone(session.pointer)
        session.pointer_frame.side_effect=OSError('uncertain send');conn.reset_mock()
        self.assertFalse(send({'op':'move','dx':1,'dy':1})['ok'])
        conn.assert_called_once();self.assertIsNone(ns['WEBOS'])

if __name__ == '__main__': unittest.main()
