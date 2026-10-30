"""Updater trust-boundary tests. Network/signing/processes are mocked, never installed."""
import copy
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / 'couchsided-win.py'
if not AGENT.exists():
    AGENT = ROOT / 'agent/win/couchsided-win.py'
spec = importlib.util.spec_from_file_location('win_update', AGENT)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

PAYLOAD = b'not-an-executable-test-fixture'
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
META = {'tag_name': 'v0.4.16-win', 'draft': False, 'prerelease': False, 'assets': [
    {'name': name, 'browser_download_url': w._UPDATE_ASSET_PREFIX + 'v0.4.16-win/' + name}
    for name in (w._UPDATE_SETUP_ASSET, w._UPDATE_SUM_ASSET)]}
SIGNATURE = dict(status='Valid', subject='CN=SignPath Foundation, O=SignPath Foundation',
                 timestamped=True, product='Couchside', version='0.4.16.0')

class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in [('VERSION', '0.4.15-win'), ('ALLOW_APP_UPDATE', True),
                            ('ALLOW_UPDATE_CHECK', True), ('_apply_state', {'state':'idle'}),
                            ('_self_sig_cache', {}), ('_update_cache', {'at':0,'data':None}),
                            ('_UPDATE_LOG', str(Path(self.tmp.name)/'update.log'))]:
            p = patch.object(w, name, value); p.start(); self.addCleanup(p.stop)

    def worker(self, meta=None, signature=None, digest=DIGEST, checksum=None, exit_code=0):
        stage = Path(self.tmp.name)/'download'; stage.mkdir()
        def fetch(url, dest=None, limit=None):
            if dest:
                Path(dest).write_bytes(PAYLOAD); return digest
            return checksum if checksum is not None else (DIGEST+'  CouchsideSetup.exe\n').encode()
        with patch.object(w, '_http_text', return_value=json.dumps(meta if meta is not None else META)), \
             patch.object(w, '_fetch_asset', side_effect=fetch), \
             patch.object(w, '_authenticode_info', return_value=signature if signature is not None else SIGNATURE), \
             patch.object(w.tempfile, 'mkdtemp', return_value=str(stage)), \
             patch.object(w.subprocess, 'Popen') as launch:
            launch.return_value.wait.return_value = exit_code
            w._update_apply_worker()
            return copy.deepcopy(w._apply_state), launch.call_count, stage.exists()

    def test_verified_mock_runs_only_expected_command_and_cleans_up(self):
        state, count, exists = self.worker()
        self.assertEqual(state['state'], 'completed'); self.assertEqual(count, 1); self.assertFalse(exists)

    def test_hash_failure_never_executes_and_removes_download(self):
        state, count, exists = self.worker(digest='0'*64)
        self.assertEqual(state['state'], 'failed'); self.assertEqual(count, 0); self.assertFalse(exists)

    def test_bad_signatures_never_execute(self):
        for changed in [dict(status='NotSigned'), dict(status='HashMismatch'),
                        dict(subject='CN=Another Signer'), dict(timestamped=False),
                        dict(product='Another App'), dict(version='0.4.15.0'), dict(version='0.4.16.9'),
                        dict(version='0.4.16-rc1')]:
            with self.subTest(changed=changed):
                state, count, exists = self.worker(signature=dict(SIGNATURE, **changed))
                self.assertEqual(state['state'], 'failed'); self.assertEqual(count,0); self.assertFalse(exists)

    def test_bad_release_never_executes(self):
        for changed in [dict(draft=True),dict(prerelease=True),dict(tag_name='v0.4.16-rc1-win'),
                        dict(tag_name='v0.4.15-win'),dict(tag_name='v0.4.14-win'),dict(tag_name='vgarbage'),
                        dict(assets=[]),dict(assets=META['assets']*2)]:
            with self.subTest(changed=changed):
                # Early rejection happens before staging is allocated.
                state, count, _ = self.worker(meta=dict(META, **changed))
                self.assertEqual(state['state'],'failed');self.assertEqual(count,0)
                stage=Path(self.tmp.name)/'download'
                if stage.exists(): stage.rmdir()

    def test_cross_tag_or_repository_asset_rejected(self):
        for url in [w._UPDATE_ASSET_PREFIX+'v0.4.17-win/CouchsideSetup.exe',
                    'https://github.com/other/repo/releases/download/v0.4.16-win/CouchsideSetup.exe']:
            meta=copy.deepcopy(META);meta['assets'][0]['browser_download_url']=url
            with self.assertRaises(ValueError):w._release_candidate(meta)

    def test_checksum_requires_one_named_entry(self):
        for checksum in [DIGEST.encode(), b'junk', (DIGEST+'  Other.exe').encode(),
                         ((DIGEST+'  CouchsideSetup.exe\n')*2).encode()]:
            state,count,_=self.worker(checksum=checksum)
            self.assertEqual(state['state'],'failed');self.assertEqual(count,0)
            (Path(self.tmp.name)/'download').rmdir()

    def test_installer_failure_reported(self):
        state,count,exists=self.worker(exit_code=7)
        self.assertEqual(state['state'],'failed');self.assertEqual(count,1);self.assertFalse(exists)

    def test_disabled_checks_do_not_contact_network_even_forced(self):
        with patch.object(w,'ALLOW_UPDATE_CHECK',False),patch.object(w,'_http_text') as net:
            self.assertTrue(w.update_check(force=True)['disabled']);net.assert_not_called()

    def test_check_and_apply_use_same_repository(self):
        with patch.object(w,'_http_text',return_value=json.dumps(META)) as net:
            self.assertEqual(w.update_check(True)['latest'],'0.4.16-win')
            net.assert_called_once_with(w._UPDATE_WIN_RELEASE_API)

    def test_version_check_works_for_older_release_asset_contract(self):
        meta=dict(META,assets=[])
        with patch.object(w,'_http_text',return_value=json.dumps(meta)):
            self.assertEqual(w.update_check(True)['latest'],'0.4.16-win')
        with self.assertRaises(ValueError):w._release_candidate(meta)

    def test_strict_versions(self):
        for version in ['0.4.15-rc1-win','0.4.15-win-rc','0.4.15','04.1.0-win','0.4.15-win\n']:
            self.assertIsNone(w._release_version(version))
        self.assertEqual(w._release_version('0.4.15-win'),(0,4,15))

    def test_disabled_apply_is_defense_in_depth(self):
        with patch.object(w,'ALLOW_APP_UPDATE',False),patch.object(w,'_self_update_blocker') as check:
            self.assertEqual(w.update_apply()[0],403);check.assert_not_called()

    def test_unsigned_source_and_preview_never_start_worker(self):
        with patch.object(w,'IS_WINDOWS',True), patch.object(w.sys,'frozen',True,create=True), \
             patch.object(w,'_authenticode_info',return_value=dict(SIGNATURE,status='NotSigned')), \
             patch.object(w.threading,'Thread') as thread:
            self.assertEqual(w.update_apply()[0],409);thread.assert_not_called()
        with patch.object(w,'IS_WINDOWS',True),patch.object(w.sys,'frozen',False,create=True):
            self.assertIn('Python source',w._self_update_blocker())
        with patch.object(w,'IS_WINDOWS',True),patch.object(w,'VERSION','0.4.15-rc1-win'), \
             patch.object(w,'_authenticode_info') as signature:
            self.assertIn('Preview',w._self_update_blocker());signature.assert_not_called()

    def test_self_identity_requires_matching_product_and_version(self):
        with patch.object(w,'IS_WINDOWS',True),patch.object(w.sys,'frozen',True,create=True), \
             patch.object(w,'_authenticode_info',return_value=SIGNATURE):
            self.assertIsNotNone(w._self_update_blocker()) # 0.4.16 != running 0.4.15

    def test_running_or_launched_update_cannot_launch_twice(self):
        with patch.object(w,'_self_update_blocker',return_value=None),patch.object(w.threading,'Thread') as thread:
            for state in ['running','launched','completed']:
                w._apply_state['state']=state
                self.assertEqual(w.update_apply()[0],409)
            thread.assert_not_called()

    def test_redirects_rejected_before_request(self):
        handler=w._UpdateRedirectHandler(w._UPDATE_DL_HOSTS)
        req=urllib.request.Request(META['assets'][0]['browser_download_url'])
        for url in ['http://github.com/file','https://evil.example/file','https://github.com@evil.example/x',
                    'https://user@github.com/x','https://github.com:444/x','https://127.0.0.1/x']:
            with self.subTest(url=url),self.assertRaises(ValueError):
                handler.redirect_request(req,None,302,'Found',{},url)
        allowed='https://release-assets.githubusercontent.com/x?signature=test'
        self.assertEqual(handler.redirect_request(req,None,302,'Found',{},allowed).full_url,allowed)

    def test_oversize_body_rejected(self):
        reply=Mock();reply.__enter__=Mock(return_value=reply);reply.__exit__=Mock(return_value=False)
        reply.geturl.return_value=META['assets'][0]['browser_download_url'];reply.read.return_value=b'x'*5
        opener=Mock();opener.open.return_value=reply
        with patch.object(w.urllib.request,'build_opener',return_value=opener):
            with self.assertRaises(ValueError):w._fetch_asset(reply.geturl(),limit=4)
            dest=Path(self.tmp.name)/'oversize.exe'
            with self.assertRaises(ValueError):w._fetch_asset(reply.geturl(),dest=str(dest),limit=4)
            self.assertFalse(dest.exists())

    def test_download_never_overwrites_or_deletes_existing_file(self):
        reply=Mock();reply.__enter__=Mock(return_value=reply);reply.__exit__=Mock(return_value=False)
        reply.geturl.return_value=META['assets'][0]['browser_download_url']
        opener=Mock();opener.open.return_value=reply
        dest=Path(self.tmp.name)/'existing.exe';dest.write_bytes(b'keep')
        with patch.object(w.urllib.request,'build_opener',return_value=opener):
            with self.assertRaises(FileExistsError):w._fetch_asset(reply.geturl(),dest=str(dest))
        self.assertEqual(dest.read_bytes(),b'keep')

    def test_http_auth_default_off_and_unsigned_refusal(self):
        w.Handler.mock=False;w.Handler.token='synthetic-updater-test'
        server=w.QuietThreadingHTTPServer(('127.0.0.1',0),w.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            def request(method,path,auth=True):
                c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                c.request(method,path,headers={'Authorization':'Bearer synthetic-updater-test'} if auth else {})
                r=c.getresponse();body=json.loads(r.read());code=r.status;c.close();return code,body
            self.assertEqual(request('POST','/api/update/apply',False)[0],401)
            with patch.object(w,'ALLOW_APP_UPDATE',False),patch.object(w,'ALLOW_UPDATE_CHECK',False),patch.object(w,'_http_text') as net:
                self.assertEqual(request('POST','/api/update/apply')[0],403)
                self.assertTrue(request('GET','/api/update/check?force=1')[1]['disabled']);net.assert_not_called()
            with patch.object(w,'IS_WINDOWS',True),patch.object(w,'VERSION','0.4.15-rc1-win'),patch.object(w,'_http_text') as net:
                self.assertEqual(request('POST','/api/update/apply')[0],409);net.assert_not_called()
        finally:server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
