#!/usr/bin/env python3
"""Ports trust boundary, durable job recovery and worker lifecycle.

All executable fixtures are synthetic. No port/game installation or external
network is used. Run this script directly, as CI does.
"""
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('couchsided', ROOT / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(SPEC)
sys.modules['couchsided'] = cs
SPEC.loader.exec_module(cs)
BB = 'couchside-bbport'
TOKEN = 'synthetic-ports-token'


class Response(io.BytesIO):
    def geturl(self):
        return 'https://release-assets.githubusercontent.com/test/fixture'


class PortsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.log = self.root / 'ports.log'
        self.marker = self.root / 'allow-ports'
        self.marker.touch()
        self.patches = patch.multiple(cs, _PORTS_STATE_DIR=str(self.state),
                                     PORTS_INSTALL_LOG=str(self.log), _PORTS_MARKER=str(self.marker))
        self.patches.start()
        self.addCleanup(self.patches.stop)

    def job(self, **values):
        j = dict(id=BB, mode='install', job_id='a'*32, running=True,
                 started=int(time.time())-60, finished=None, exit_code=None,
                 ok=None, phase='starting', requires_user_files=True, user_files_prompt='fixture')
        j.update(values)
        cs._ports_write_job(j)
        return j

    def server(self):
        handler = type('TestHandler', (cs.Handler,), dict(token=TOKEN, token_file=None, mock=True, port=0))
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def request(self, port, method, path, body=None, token=TOKEN):
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer '+token
        c.request(method, path, json.dumps(body) if body is not None else None, headers)
        r = c.getresponse()
        data = json.loads(r.read())
        c.close()
        return r.status, data

    def test_http_auth_and_unknown_id_never_spawn(self):
        port = self.server()
        with patch.object(cs.subprocess, 'run', side_effect=AssertionError('spawned')):
            for method, path in [('GET','/api/ports'),('POST','/api/ports/install'),('POST','/api/ports/uninstall')]:
                self.assertEqual(self.request(port,method,path,{'id':BB},token=None)[0],401)
            self.assertEqual(self.request(port,'POST','/api/ports/install',{'id':'unknown'})[0],404)
            self.assertEqual(self.request(port,'POST','/api/ports/install',[])[0],400)
            self.assertEqual(self.request(port,'GET','/api/ports')[1]['ports'][0]['id'],BB)

    def test_mock_runs_nothing(self):
        port = self.server()
        with patch.object(cs.subprocess,'run',side_effect=AssertionError('spawned')):
            self.assertTrue(self.request(port,'POST','/api/ports/install',{'id':BB})[1]['started'])

    def test_optin_and_unknown_refuse_before_storage_or_process(self):
        self.marker.unlink()
        with patch.object(cs,'_ports_lock',side_effect=AssertionError('locked')), patch.object(cs.subprocess,'run',side_effect=AssertionError('spawned')):
            self.assertEqual(cs.ports_run('unknown','install')[1],404)
            self.assertEqual(cs.ports_run(BB,'bad')[1],400)
            self.assertEqual(cs.ports_run(BB,'install')[1],403)

    def test_launch_uses_fixed_user_unit_and_persists_before_spawn(self):
        def start(argv, **kwargs):
            j = cs._ports_read_job()
            self.assertTrue(j['running'])
            self.assertEqual(argv[:3],['systemd-run','--user','--quiet'])
            self.assertIn('--collect',argv)
            self.assertIn('--property=Type=exec',argv)
            self.assertEqual(argv[-2:],['--ports-worker',j['job_id']])
            self.assertNotIn('shell',kwargs)
            return subprocess.CompletedProcess(argv,0,'','')
        with patch.object(cs.subprocess,'run',side_effect=start):
            result, status = cs.ports_run(BB,'install')
        self.assertEqual(status,200)
        self.assertTrue(result['started'])
        self.assertEqual(cs._ports_read_job()['job_id'],result['job_id'])

    def test_active_job_survives_new_reader_and_refuses_competing_launch(self):
        j = self.job()
        with patch.object(cs,'_ports_unit_active',return_value=True), patch.object(cs.subprocess,'run',side_effect=AssertionError('spawned')):
            self.assertEqual(cs.ports_install_status()['job_id'],j['job_id'])
            self.assertEqual(cs.ports_run(BB,'uninstall')[1],409)

    def test_dead_worker_becomes_interrupted_not_success_and_can_retry(self):
        self.job()
        with patch.object(cs,'_ports_unit_active',return_value=False):
            result = cs.ports_install_status()
        self.assertFalse(result['running'])
        self.assertFalse(result['ok'])
        self.assertIsNone(result['exit_code'])
        self.assertEqual(result['phase'],'interrupted')
        with patch.object(cs.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
            self.assertEqual(cs.ports_run(BB,'install')[1],200)

    def test_unknown_bus_and_startup_window_hold_claim(self):
        self.job()
        with patch.object(cs,'_ports_unit_active',return_value=None):
            self.assertTrue(cs.ports_install_status()['recovery_pending'])
            self.assertEqual(cs.ports_run(BB,'install')[1],409)
        self.job(started=int(time.time()))
        with patch.object(cs,'_ports_unit_active',return_value=False):
            self.assertTrue(cs.ports_install_status()['running'])

    def test_corrupt_state_refuses_new_job(self):
        cs._ports_dir()
        (self.state/'job.json').write_text('{')
        self.assertTrue(cs.ports_install_status()['recovery_pending'])
        with patch.object(cs.subprocess,'run',side_effect=AssertionError('spawned')):
            self.assertEqual(cs.ports_run(BB,'install')[1],503)

    def test_terminal_status_survives_restart(self):
        self.job(running=False,ok=True,exit_code=0,finished=int(time.time()),phase='complete')
        with patch.object(cs,'_ports_unit_active',side_effect=AssertionError('should not probe')):
            self.assertTrue(cs.ports_install_status()['ok'])
        self.job(running=False,ok=False,exit_code=2,finished=int(time.time()),phase='failed')
        self.assertEqual(cs.ports_install_status()['exit_code'],2)

    def asset(self,data=b'fixture'):
        return dict(name='fixture.sh',url='https://github.com/emerytech/test/releases/download/v1/fixture.sh',
                    size=len(data),sha256=hashlib.sha256(data).hexdigest())

    def test_download_requires_exact_hash_size_and_cleans_failure(self):
        for body in (b'fixture',b'changed',b'fixture-long',b'short'):
            dest=self.root/'download'
            opener=type('Opener',(),{'open':lambda *a,**k:Response(body)})()
            with patch.object(cs.urllib.request,'build_opener',return_value=opener):
                if body==b'fixture':
                    cs._ports_download(self.asset(),str(dest)); self.assertEqual(dest.read_bytes(),body); dest.unlink()
                else:
                    with self.assertRaises(ValueError):cs._ports_download(self.asset(),str(dest))
                    self.assertFalse(dest.exists())

    def test_no_untrusted_redirect_or_missing_pin(self):
        captured=[]
        def opener(handler):
            captured.append(handler)
            return type('Opener',(),{'open':lambda *a,**k:Response(b'fixture')})()
        with patch.object(cs.urllib.request,'build_opener',side_effect=opener):
            cs._ports_download(self.asset(),str(self.root/'download'))
        h=captured[0]
        for url in ['http://github.com/file','https://evil.invalid/file','https://user@github.com/file','https://github.com:444/file']:
            with self.assertRaises(ValueError):h.redirect_request(None,None,302,'',{},url)
        a=self.asset();a['sha256']=''
        with self.assertRaises(ValueError):cs._ports_download(a,str(self.root/'bad'))

    def test_all_recipe_assets_verified_before_any_execution(self):
        port=dict(cs._PORTS_BY_ID[BB]);port['installed_check']=str(self.root/'app')
        for failed in ('setup.sh','steam_shortcut.py','uninstall.sh','Bloodborne-bbport-x86_64.AppImage'):
            def download(asset,dest):
                if asset['name']==failed:raise ValueError('changed bytes')
                Path(dest).write_bytes(b'fixture')
            stage=self.root/'stage';stage.mkdir(exist_ok=True)
            with patch.object(cs,'_ports_download',side_effect=download),patch.object(cs.subprocess,'run',side_effect=AssertionError('executed')):
                with self.assertRaises(ValueError):cs._ports_run_recipe(port,'install',str(stage),io.StringIO())
            self.assertFalse((self.root/'app').exists())
            for f in stage.iterdir():f.unlink()

    def test_bounded_log_tail(self):
        self.log.write_text('x'*200000+'\nlast\n')
        self.assertEqual(cs._ports_read_log(1),['last'])

    def test_worker_records_terminal_failure_and_cleans_stage(self):
        self.job()
        with patch.object(cs.os,'getuid',return_value=os.stat(self.root).st_uid or 501):
            # Tests run as a desktop user locally/CI. Root intentionally refuses.
            if os.getuid()==0:self.skipTest('worker refuses root')
            with patch.object(cs,'_ports_run_recipe',side_effect=ValueError('bad digest')):
                self.assertEqual(cs._ports_worker('a'*32),1)
        self.assertFalse(cs.ports_install_status()['ok'])
        self.assertEqual(list(self.state.glob('stage-*')),[])

    def test_real_worker_process_retains_lock_after_reader_restart(self):
        if os.getuid()==0:self.skipTest('worker refuses root')
        self.job()
        code='''import importlib.util,sys,time
s=importlib.util.spec_from_file_location('cs',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
c._PORTS_STATE_DIR=sys.argv[2];c.PORTS_INSTALL_LOG=sys.argv[3];c._PORTS_MARKER=sys.argv[4]
def recipe(*a):
 print('fixture-running',flush=True);time.sleep(1.5);return 0
c._ports_run_recipe=recipe
sys.exit(c._ports_worker('a'*32))
'''
        p=subprocess.Popen([sys.executable,'-c',code,str(ROOT/'agent/couchsided.py'),str(self.state),str(self.log),str(self.marker)],stdout=subprocess.PIPE,text=True)
        self.addCleanup(lambda:p.kill() if p.poll() is None else None)
        self.assertEqual(p.stdout.readline().strip(),'fixture-running')
        # A fresh reader has no Popen/PID registry. Kernel lock + disk still work.
        self.assertTrue(cs.ports_install_status()['running'])
        self.assertEqual(cs.ports_run(BB,'install')[1],409)
        self.assertEqual(p.wait(timeout=5),0)
        p.stdout.close()
        self.assertTrue(cs.ports_install_status()['ok'])
        self.assertEqual(list(self.state.glob('stage-*')),[])


    def test_verified_synthetic_script_executes_with_source_overrides_removed(self):
        script = b'#!/bin/bash\nprintf "fixture:%s:%s" "${BASH_ENV:-empty}" "$BBPORT_REPO"\n'
        asset=self.asset(script)
        port=dict(cs._PORTS_BY_ID[BB], installed_check=str(self.root/'app'))
        port['uninstall']=dict(bootstrap_url=asset['url'],sha256=asset['sha256'],size=asset['size'])
        stage=self.root/'stage';stage.mkdir()
        opener=type('Opener',(),{'open':lambda *a,**k:Response(script)})()
        env=dict(os.environ,BBPORT_REPO='evil',BASH_ENV='/must-not-run')
        with patch.object(cs.urllib.request,'build_opener',return_value=opener),patch.object(cs,'_user_env',return_value=env),self.log.open('w') as log:
            self.assertEqual(cs._ports_run_recipe(port,'uninstall',str(stage),log),0)
        self.assertEqual(self.log.read_text(),'fixture:empty:emerytech/Bloodborne-Android')

    def test_lock_held_with_unavailable_unit_does_not_clear_live_job(self):
        self.job()
        fd=cs._ports_lock()
        try:
            with patch.object(cs,'_ports_unit_active',side_effect=AssertionError('must use lock')):
                self.assertTrue(cs.ports_install_status()['running'])
                self.assertEqual(cs.ports_run(BB,'install')[1],409)
        finally:os.close(fd)

    def test_recovery_removes_only_dead_jobs_own_stage(self):
        self.job()
        own=self.state/('stage-'+'a'*32);own.mkdir();(own/'partial').write_bytes(b'partial')
        other=self.state/('stage-'+'b'*32);other.mkdir()
        with patch.object(cs,'_ports_unit_active',return_value=False):
            self.assertEqual(cs.ports_install_status()['phase'],'interrupted')
        self.assertFalse(own.exists());self.assertTrue(other.exists())

    def test_launch_timeout_retains_claim_until_reconciled(self):
        with patch.object(cs.subprocess,'run',side_effect=subprocess.TimeoutExpired('systemd-run',15)):
            self.assertEqual(cs.ports_run(BB,'install')[1],503)
        with patch.object(cs,'_ports_unit_active',return_value=True):
            self.assertTrue(cs.ports_install_status()['running'])
            self.assertEqual(cs.ports_run(BB,'install')[1],409)


if __name__=='__main__':unittest.main()
