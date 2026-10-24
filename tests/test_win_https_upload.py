"""Real HTTP/TLS regression tests; all files are confined to a temp directory."""
import importlib.util, pathlib, tempfile, threading, ssl, json, http.client, socket, time, unittest, hashlib
spec=importlib.util.spec_from_file_location('win',pathlib.Path(__file__).resolve().parents[1]/'agent'/'win'/'couchsided-win.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class TransportTest(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory(); cls.root=pathlib.Path(cls.tmp.name);cls.drop=cls.root/'drop';cls.drop.mkdir()
  w._drop_dir=lambda:str(cls.drop);w._pair_lan_ip=lambda:'127.0.0.1'
  w.Handler.token='test-only-token';w.Handler.mock=True
  cls.http=w.QuietThreadingHTTPServer(('127.0.0.1',0),w.Handler);cls.http.daemon_threads=True
  threading.Thread(target=cls.http.serve_forever,daemon=True).start()
  cls.tls=w._start_https('127.0.0.1',0,str(cls.root/'tls'))
  cls.ctx=ssl.create_default_context(cadata=w.TLS_ADVERT['cert'])
 @classmethod
 def tearDownClass(cls):
  for s in [cls.http,cls.tls]:s.shutdown();s.server_close()
  cls.tmp.cleanup()
 def req(self,path,body=None,auth=True,tls=True,headers=None):
  c=http.client.HTTPSConnection('127.0.0.1',self.tls.server_port,context=self.ctx,timeout=4) if tls else http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=4)
  h={'Authorization':'Bearer '+w.Handler.token} if auth else {}
  h.update(headers or {})
  c.request('POST' if body is not None else 'GET',path,body=body,headers=h)
  r=c.getresponse();data=r.read();code=r.status;c.close();return code,json.loads(data)
 def test_legacy_and_pin(self):
  self.assertEqual(self.req('/api/status',tls=False)[0],200)
  self.assertEqual(self.req('/api/status',auth=False)[0],401)
  self.assertEqual(self.req('/api/upload?name=plain.txt',b'plain',tls=False)[0],426)
  _,info=self.req('/api/tls/cert',auth=False)
  self.assertEqual(info['fp'],hashlib.sha256(ssl.PEM_cert_to_DER_cert(info['cert'])).hexdigest())
  self.assertIn('tlsport=',w.build_pair_url('test-only-token',8787))
 def test_persisted_identity(self):
  _,_,again=w._tls_identity(str(self.root/'tls'));self.assertEqual(again['spki'],w.TLS_ADVERT['spki']);self.assertEqual(again['fp'],w.TLS_ADVERT['fp'])
 def test_stream_and_no_overwrite(self):
  body=b'test-data\x00'*150000
  code,d=self.req('/api/upload?name=roundtrip.bin',body)
  self.assertEqual(code,200);self.assertEqual(d['bytes'],len(body));self.assertEqual((self.drop/'roundtrip.bin').read_bytes(),body)
  self.assertEqual(self.req('/api/upload?name=roundtrip.bin',b'overwrite')[0],409)
  self.assertEqual((self.drop/'roundtrip.bin').read_bytes(),body)
 def test_rejected_uploads(self):
  self.assertEqual(self.req('/api/upload?name=unauth.bin',b'abc',auth=False)[0],401)
  self.assertEqual(self.req('/api/upload?name=empty.bin',b'')[0],411)
  self.assertEqual(self.req('/api/upload?name=oversize.bin',b'',headers={'Content-Length':str(w.Handler.MAX_UPLOAD_BYTES+1)})[0],413)
  self.assertEqual(self.req('/api/upload?name=chunked.bin',b'',headers={'Transfer-Encoding':'chunked'})[0],411)
  self.assertFalse((self.drop/'unauth.bin').exists())
 def test_bad_names(self):
  for name in ['../bad','CON','CON .txt','AUX.txt','x:y','test.','COM1.txt','COM¹.txt','x\\y','x/y','a\x00b']:
   with self.assertRaises(ValueError):w._upload_name(name)
 def test_ticket_replay_and_plaintext(self):
  code,d=self.req('/api/ticket?once=1',b'');self.assertEqual(code,200);t=d['ticket']
  self.assertEqual(self.req('/api/upload?name=ticket.txt&ticket='+t,b'one',auth=False)[0],200)
  self.assertEqual(self.req('/api/upload?name=replay.txt&ticket='+t,b'two',auth=False)[0],401)
  t=w._ticket_mint()
  self.assertEqual(self.req('/api/upload?name=plain-ticket.txt&ticket='+t,b'two',auth=False,tls=False)[0],401)
  self.assertTrue(w._ticket_consume(t))
 def test_idle_tls_does_not_block(self):
  idle=[socket.create_connection(('127.0.0.1',self.tls.server_port)) for _ in range(8)]
  try:
   before=time.monotonic();self.assertEqual(self.req('/api/status')[0],200);self.assertLess(time.monotonic()-before,2)
  finally:
   for s in idle:s.close()
 def test_incomplete_cleanup(self):
  c=self.ctx.wrap_socket(socket.create_connection(('127.0.0.1',self.tls.server_port)),server_hostname='127.0.0.1')
  c.sendall(b'POST /api/upload?name=incomplete.bin HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-only-token\r\nContent-Length: 10000\r\n\r\nshort');c.close()
  for _ in range(100):
   if not list(self.drop.glob('*.part')):time.sleep(.01)
   else:time.sleep(.01)
  self.assertFalse((self.drop/'incomplete.bin').exists());self.assertFalse(list(self.drop.glob('*.part')))
if __name__=='__main__':unittest.main()
