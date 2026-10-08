import errno, importlib.util, pathlib, unittest, threading, http.client, json
from unittest.mock import patch, MagicMock
ROOT=pathlib.Path(__file__).resolve().parents[1]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
agent=load('agent',ROOT/'agent/couchsided.py')
class Health(unittest.TestCase):
 def setUp(self): agent._controller_creation_result()
 def test_distinct_device_errors(self):
  for code,state in ((errno.ENOENT,'device_missing'),(errno.ENODEV,'device_missing'),(errno.EACCES,'access_denied'),(errno.EPERM,'access_denied'),(errno.EIO,'unknown')):
   with patch.object(agent.os,'open',side_effect=OSError(code,'private detail')):
    self.assertEqual(agent.controller_health(),{'state':state})
 def test_creation_failure_and_successful_retry(self):
  with patch.object(agent.os,'open',return_value=7),patch.object(agent.os,'close') as close:
   self.assertEqual(agent.controller_health()['state'],'accessible')
   agent._controller_creation_result(RuntimeError('private detail'))
   self.assertEqual(agent.controller_health()['state'],'creation_failed')
   agent._controller_creation_result()
   self.assertEqual(agent.controller_health()['state'],'accessible')
   self.assertEqual(close.call_count,3)
 def test_health_endpoint_requires_auth(self):
  class Handler(agent.Handler):
   token='test-only';token_file=None;mock=True
  server=agent.BoundedThreadingHTTPServer(('127.0.0.1',0),Handler)
  server.daemon_threads=True
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   for authorized,expected in ((False,401),(True,200)):
    conn=http.client.HTTPConnection(*server.server_address,timeout=2)
    conn.request('GET','/api/controller-health',headers={'Authorization':'Bearer test-only'} if authorized else {})
    response=conn.getresponse();data=json.loads(response.read());conn.close()
    self.assertEqual(response.status,expected)
    if authorized:self.assertEqual(data,{'state':'accessible'})
  finally:server.shutdown();server.server_close();thread.join(2)
 def test_actual_creation_failure_records_diagnostic(self):
  entry={'nopad':False,'device':None}
  with patch.object(agent,'UInputGamepad',side_effect=RuntimeError('creation refused')),patch.object(agent,'_wsend_json'),patch.object(agent,'_wsend_op'):
   self.assertFalse(agent._make_holder(entry,False))
  with patch.object(agent.os,'open',return_value=7),patch.object(agent.os,'close'):
   self.assertEqual(agent.controller_health()['state'],'creation_failed')
if __name__=='__main__':unittest.main()
