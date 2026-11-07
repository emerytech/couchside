"""Leased WASD cannot leak across controller holders or survive a lost phone."""
import ast
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import Mock

class CameraLeaseTests(unittest.TestCase):
    def namespace(self, agent="couchsided.py"):
        tree=ast.parse((Path(__file__).parents[1]/"agent"/agent).read_text())
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('_camera_key','_camera_keys_release','_camera_keys_watch')]
        ns=dict(threading=threading,time=time,EV_KEY=1,CHAR_KEYMAP={k:(i,False) for i,k in enumerate('wasd')},_CAMERA_KEY_LOCK=threading.RLock(),_CAMERA_KEY_ENTRIES={},_CAMERA_KEY_WORKER=None)
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'camera','exec'),ns)
        return ns
    def test_failed_key_up_remains_owned_until_retry_succeeds(self):
        for agent in ('couchsided.py', 'win/couchsided-win.py'):
            with self.subTest(agent=agent):
                ns=self.namespace(agent);keyboard=Mock()
                keyboard.emit.side_effect=[OSError('temporarily blocked'), None]
                entry={'keyboard':keyboard,'camera_keys':{'w'}}
                ns['_CAMERA_KEY_ENTRIES'][id(entry)]=entry
                ns['_camera_keys_release'](entry)
                self.assertEqual(entry['camera_keys'],{'w'})
                self.assertIn(id(entry),ns['_CAMERA_KEY_ENTRIES'])
                ns['_camera_keys_release'](entry)
                self.assertFalse(entry['camera_keys'])
                self.assertFalse(ns['_CAMERA_KEY_ENTRIES'])
                self.assertEqual(keyboard.emit.call_count,2)

    def test_retry_does_not_release_a_new_holders_key(self):
        for agent in ('couchsided.py', 'win/couchsided-win.py'):
            with self.subTest(agent=agent):
                ns=self.namespace(agent);keyboard=Mock()
                keyboard.emit.side_effect=[OSError('temporarily blocked'), None]
                old={'keyboard':keyboard,'camera_keys':{'w'}}
                ns['_CAMERA_KEY_ENTRIES'][id(old)]=old
                ns['_camera_keys_release'](old)
                new={'keyboard':keyboard,'camera_keys':{'w'}}
                ns['_CAMERA_KEY_ENTRIES'][id(new)]=new
                ns['_camera_keys_release'](old)
                self.assertFalse(old['camera_keys'])
                self.assertEqual(new['camera_keys'],{'w'})
                self.assertEqual(keyboard.emit.call_count,1)
                ns['_camera_keys_release'](new)
                self.assertFalse(ns['_CAMERA_KEY_ENTRIES'])

    def test_lease_worker_retries_a_failed_release(self):
        for agent in ('couchsided.py', 'win/couchsided-win.py'):
            with self.subTest(agent=agent):
                ns=self.namespace(agent);keyboard=Mock();releases=[]
                def emit(events):
                    if events[0][-1] == 0:
                        releases.append(events)
                        if len(releases)==1:raise OSError('temporarily blocked')
                keyboard.emit.side_effect=emit;entry={'keyboard':keyboard}
                ns['_camera_key'](entry,{'key':'w','v':1})
                entry['camera_until']=0
                deadline=time.monotonic()+1
                while ns['_CAMERA_KEY_ENTRIES'] and time.monotonic()<deadline:time.sleep(.01)
                self.assertEqual(len(releases),2)
                self.assertFalse(ns['_CAMERA_KEY_ENTRIES'])
                self.assertFalse(entry['camera_keys'])

    def test_validation_refcounts_and_expiry(self):
        ns=self.namespace();keyboard=Mock();a={'keyboard':keyboard};b={'keyboard':keyboard};send=ns['_camera_key']
        for req in ({'key':'x','v':1},{'key':'w','v':True},{'key':{},'v':1}):
            with self.assertRaises(ValueError):send(a,req)
        send(a,{'key':'w','v':1});send(a,{'key':'w','v':1});send(b,{'key':'w','v':1})
        self.assertEqual(keyboard.emit.call_count,1)
        ns['_camera_keys_release'](a);self.assertEqual(keyboard.emit.call_count,1)
        b['camera_until']=0
        deadline=time.monotonic()+1
        while ns['_CAMERA_KEY_ENTRIES'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertFalse(ns['_CAMERA_KEY_ENTRIES']);self.assertEqual(keyboard.emit.call_count,2)
        self.assertEqual(keyboard.emit.call_args.args[0],[(1,0,0)])

class WindowsCameraTests(unittest.TestCase):
    def test_no_pad_and_privilege_guard(self):
        import importlib.util
        from unittest.mock import patch
        spec=importlib.util.spec_from_file_location('camera_win',Path(__file__).parents[1]/'agent/win/couchsided-win.py')
        cs=importlib.util.module_from_spec(spec);spec.loader.exec_module(cs)
        entry={'nopad':True,'name':'QA'}
        with patch.object(cs,'ViGEmGamepad') as gamepad, patch.object(cs,'WinMouse'), patch.object(cs,'WinKeyboard'), patch.object(cs,'_wsend_json'):
            self.assertTrue(cs._make_holder(entry,False));gamepad.assert_not_called();self.assertIsNone(entry['device'])
        handler=Mock();handler.mock=False;handler._CONTROL_TYPES=cs.Handler._CONTROL_TYPES;handler._MOUSE_TYPES=cs.Handler._MOUSE_TYPES;handler._KEYBOARD_TYPES=cs.Handler._KEYBOARD_TYPES
        import json
        with patch.object(cs,'_input_reachable',return_value=False),patch.object(cs,'_camera_key') as camera:
            self.assertTrue(cs.Handler._gamepad_message(handler,None,entry,json.dumps({'t':'kh','key':'w','v':1}).encode()))
            camera.assert_not_called();handler._note_input_error.assert_called_once()
        for v in (True,2,'1'):
            with self.assertRaises(ValueError):cs.keyboard_events({'t':'kh','key':'w','v':v})

if __name__=='__main__':unittest.main()
