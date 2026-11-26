#!/usr/bin/env python3
"""Local PIN consent, remote privacy barrier, bounded recovery. No real grants."""
import importlib.util
import http.client
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('addon_agent', Path(__file__).resolve().parents[1]/'agent/couchsided.py')
cs = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cs
SPEC.loader.exec_module(cs)

class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = patch.multiple(cs, _ADDON_CHOICE=self.tmp.name+'/ports.json',
                                _PORTS_MARKER=self.tmp.name+'/legacy', _ADDON_REQUEST=None,
                                _ADDON_MOCK_ENABLED=False, _ADDON_COOLDOWN=0,
                                _ADDON_ACTIVE=set())
        self.p.start(); self.addCleanup(self.p.stop)
        self.pop = patch.object(cs, 'pair_show_on_box_url')
        self.pop.start(); self.addCleanup(self.pop.stop)
    def start(self, enabled=True):
        data, code = cs.addon_request('ports', enabled, 8787)
        self.assertEqual(code, 202)
        self.assertNotIn('pin', data)
        self.assertNotIn('nonce', data)
        return cs._ADDON_REQUEST['pin']
    def test_approve_persists_once_and_disable_preserves_files(self):
        pin = self.start()
        self.assertTrue(cs.addon_paused())
        self.assertFalse(cs._ports_allowed())
        self.assertEqual(cs.addon_verify(pin)[1], 200)
        self.assertTrue(cs._ports_allowed())
        self.assertFalse(cs.addon_paused())
        self.assertEqual(cs.addon_verify(pin)[1], 409)
        pin = self.start(False)
        self.assertEqual(cs.addon_verify(pin)[1], 200)
        self.assertFalse(cs._ports_allowed())
    def test_decline_and_no_local_approve(self):
        self.start()
        nonce = cs._ADDON_REQUEST['nonce']
        self.assertEqual(cs.addon_decide(nonce, True)[1],403)
        self.assertTrue(cs.addon_paused())
        self.assertEqual(cs.addon_decide(nonce,False)[1],200)
        self.assertFalse(cs.addon_paused())
        self.assertFalse(cs._ports_allowed())
    def test_attempt_limit_and_replay(self):
        pin = self.start()
        wrong = '111111' if pin != '111111' else '222222'
        for i in range(5):
            self.assertEqual(cs.addon_verify(wrong)[1],403)
        self.assertFalse(cs.addon_paused())
        self.assertEqual(cs.addon_verify(pin)[1],409)
        self.assertFalse(cs._ports_allowed())
    def test_expiry_without_browser_or_phone_polling(self):
        with patch.object(cs,'_ADDON_TTL',0.08):
            pin = self.start()
            time.sleep(0.15)
            self.assertEqual(cs._ADDON_REQUEST['state'],'expired')
            self.assertIsNone(cs._ADDON_REQUEST['pin'])
            self.assertFalse(cs.addon_paused())
            self.assertEqual(cs.addon_verify(pin)[1],409)
    def test_validation_and_duplicate(self):
        for addon, enabled, code in [('arbitrary',True,404),('ports','yes',400),([],True,404)]:
            self.assertEqual(cs.addon_request(addon,enabled,8787)[1],code)
        self.start()
        self.assertEqual(cs.addon_request('ports',True,8787)[1],409)
    def test_failed_write_resumes(self):
        pin=self.start()
        with patch.object(cs.os,'replace',side_effect=OSError('fixture')):
            self.assertEqual(cs.addon_verify(pin)[1],500)
        self.assertFalse(cs.addon_paused())
        self.assertFalse(cs._ports_allowed())
    def test_remote_handler_drained_before_pin(self):
        entered=threading.Event(); cleaned=threading.Event()
        left,right=socket.socketpair()
        self.addCleanup(left.close); self.addCleanup(right.close)
        class Fake:
            command='GET'; path='/ws/screen'; connection=left
            @cs.addon_remote_guard
            def run(self):
                entered.set()
                left.recv(1)
                self.cleanup_state=cs._ADDON_REQUEST['state']
                self.cleanup_pin=cs._ADDON_REQUEST['pin']
                cleaned.set()
        h=Fake(); thread=threading.Thread(target=h.run);thread.start()
        self.assertTrue(entered.wait(1)); self.start();thread.join(1)
        self.assertTrue(cleaned.is_set())
        self.assertEqual(h.cleanup_state,'preparing');self.assertIsNone(h.cleanup_pin)
        self.assertEqual(len(cs._ADDON_ACTIVE),0)
    def test_gamepad_messages_refused_without_emit(self):
        self.start()
        h=object.__new__(cs.Handler)
        self.assertFalse(h._gamepad_message(None,{},b'{"t":"kt","text":"secret"}'))
    def test_active_gamepad_reaped_then_reconnect_after_expiry(self):
        port=self.server()
        def connect():
            c=socket.create_connection(('127.0.0.1',port),timeout=2)
            c.sendall(("GET /ws/gamepad?token=test-token&name=fixture HTTP/1.1\r\n"
                       "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            data=c.recv(4096)
            self.assertIn(b'101 Switching Protocols',data)
            deadline=time.monotonic()+2
            while not cs.GAMEPAD_SESSIONS and time.monotonic()<deadline:time.sleep(.005)
            self.assertTrue(cs.GAMEPAD_SESSIONS)
            return c
        c=connect();self.addCleanup(c.close)
        first=cs.GAMEPAD_SESSIONS[0]
        with patch.object(cs,'_ADDON_TTL',0.15):
            self.assertEqual(self.request(port,'POST','/api/addons/request',{'id':'ports','enabled':True})[0],202)
            self.assertFalse(cs.GAMEPAD_SESSIONS)
            self.assertIsNone(cs.GAMEPAD_HOLDER)
            self.assertEqual(self.request(port,'GET','/api/screen/frame')[0],423)
            time.sleep(.2)
            # This gate evaluates expiry even with no browser alive.
            self.assertEqual(self.request(port,'GET','/api/screen/frame')[0],200)
        c2=connect();c2.close()
        deadline=time.monotonic()+2
        while cs.GAMEPAD_SESSIONS and time.monotonic()<deadline:time.sleep(.005)
        self.assertFalse(cs.GAMEPAD_SESSIONS)

    def server(self):
        h=type('TestHandler',(cs.Handler,),dict(token='test-token',token_file=None,mock=True,port=8787))
        server=ThreadingHTTPServer(('127.0.0.1',0),h)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return server.server_address[1]
    def request(self,port,method,path,body=None,token=True,host=None):
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer test-token'
        if host:headers['Host']=host
        c.request(method,path,json.dumps(body) if body is not None else None,headers)
        r=c.getresponse();data=r.read();c.close();return r.status,data
    def test_http_auth_privacy_pause_restore_and_local_host(self):
        port=self.server()
        self.assertEqual(self.request(port,'POST','/api/addons/request',{'id':'ports','enabled':True},False)[0],401)
        self.assertEqual(self.request(port,'POST','/api/addons/verify',{'pin':'123456'},False)[0],401)
        self.assertEqual(self.request(port,'POST','/api/addons/request',{'id':'ports','enabled':True})[0],202)
        pin=cs._ADDON_REQUEST['pin']
        for path in ['/api/screen/frame','/ws/gamepad','/ws/screen','/ws/h264','/ws/webrtc']:
            self.assertEqual(self.request(port,'GET',path)[0],423,path)
        self.assertEqual(self.request(port,'POST','/api/action',{})[0],423)
        self.assertEqual(self.request(port,'GET','/api/ports')[0],200)
        status,data=self.request(port,'GET','/addons/confirm',host='remote.example')
        self.assertEqual(status,403);self.assertNotIn(pin.encode(),data)
        status,data=self.request(port,'GET','/addons/confirm')
        self.assertEqual(status,200);self.assertIn(pin.encode(),data)
        self.assertEqual(self.request(port,'POST','/api/addons/confirm',{'nonce':cs._ADDON_REQUEST['nonce'],'approve':False},host='remote.example')[0],403)
        self.assertEqual(self.request(port,'POST','/api/addons/verify',{'pin':pin})[0],200)
        self.assertEqual(self.request(port,'GET','/api/screen/frame')[0],200)
        self.assertFalse(cs.addon_paused())

if __name__=='__main__':unittest.main()
