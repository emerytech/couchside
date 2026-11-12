"""Experimental pause: policy, HTTP gates, PID identity and real Linux recovery.
No installed agents or user games are touched. Linux live test owns its processes.
"""
import importlib.util
import inspect
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pause_agent', ROOT / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cs)

class PausePolicy(unittest.TestCase):
    def test_no_client_targets_and_default_disabled(self):
        self.assertEqual(len(inspect.signature(cs.pause_running_game).parameters), 0)
        self.assertEqual(len(inspect.signature(cs.resume_running_game).parameters), 0)
        with mock.patch.object(cs, 'ALLOW_GAME_PAUSE', False), mock.patch.object(cs, '_game_pause_signal') as send:
            self.assertFalse(cs.pause_running_game()['ok'])
            send.assert_not_called()

    def test_refuse_identity_reuse_other_user_agent_and_protected_process(self):
        identity = {'pid': 99999, 'start': 10}
        safe = {'pid': 99999, 'start': 10, 'uid': cs.UID, 'name': 'fakegame', 'state': 'S', 'tracer': 0}
        for change in ({'start': 11}, {'uid': cs.UID + 1}, {'name': 'steam'}, {'tracer': 10}, {'state':'T'}, {'protected':True}):
            with self.subTest(change=change), mock.patch.object(os, 'pidfd_open', return_value=123, create=True), mock.patch.object(os, 'close'), mock.patch.object(signal, 'pidfd_send_signal', create=True) as send, mock.patch.object(cs, '_game_pause_proc', return_value={**safe, **change}), mock.patch.object(cs, '_game_pause_ancestors', return_value={1}):
                with self.assertRaises(ValueError): cs._game_pause_signal(identity, signal.SIGSTOP, {})
                send.assert_not_called()
        with mock.patch.object(os, 'pidfd_open', return_value=123, create=True), mock.patch.object(os, 'close'), mock.patch.object(signal, 'pidfd_send_signal', create=True) as send, mock.patch.object(cs, '_game_pause_proc', return_value=safe), mock.patch.object(cs, '_game_pause_ancestors', return_value={99999}):
            with self.assertRaises(ValueError): cs._game_pause_signal(identity, signal.SIGSTOP, {})
            send.assert_not_called()

    def test_journal_security_and_stale_boot_never_signals(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(cs, '_GAME_PAUSE_FILE', os.path.join(d, 'pause.json')):
            record = {'version': 1, 'boot': 'old-boot', 'game': {'appid': 42}, 'processes': [{'pid': 99999, 'start': 10}]}
            cs._game_pause_write(record)
            self.assertEqual(os.stat(cs._GAME_PAUSE_FILE).st_mode & 0o777, 0o600)
            self.assertEqual(cs._game_pause_read(), record)
            with mock.patch.object(cs, '_game_pause_boot', return_value='new-boot'), mock.patch.object(cs, '_game_pause_signal') as send:
                self.assertTrue(cs._game_pause_resume_locked()['ok']);send.assert_not_called()
            Path(cs._GAME_PAUSE_FILE).write_text('{}')
            os.chmod(cs._GAME_PAUSE_FILE, 0o644)
            with self.assertRaises(ValueError): cs._game_pause_read()
            os.unlink(cs._GAME_PAUSE_FILE);os.symlink('/dev/null', cs._GAME_PAUSE_FILE)
            with self.assertRaises(OSError): cs._game_pause_read()

    def test_resume_discards_reused_pid_without_signalling(self):
        record = {'boot': 'boot', 'game': {'appid': 42}, 'processes': [{'pid': 99999, 'start': 10}]}
        with mock.patch.object(cs, '_game_pause_read', return_value=record), mock.patch.object(cs, '_game_pause_boot', return_value='boot'), mock.patch.object(cs, '_game_pause_proc', return_value={'start': 11, 'state': 'S'}), mock.patch.object(cs, '_game_pause_signal') as send, mock.patch.object(os, 'unlink'):
            self.assertTrue(cs._game_pause_resume_locked()['ok']);send.assert_not_called()

    def test_local_recovery_cli_does_not_open_server_or_read_pairing(self):
        with mock.patch.object(sys, 'argv', ['couchsided.py', '--resume-game']), mock.patch.object(cs, 'resume_running_game', return_value={'ok':True,'paused':False}), mock.patch.object(cs, 'load_config') as config, mock.patch.object(cs, 'resolve_token') as token, mock.patch('builtins.print'):
            with self.assertRaises(SystemExit) as result: cs.main()
            self.assertEqual(result.exception.code,0);config.assert_not_called();token.assert_not_called()

    def test_interprocess_recovery_lock_is_nonblocking_and_does_not_run_action(self):
        if not cs.fcntl: self.skipTest('requires flock')
        with tempfile.TemporaryDirectory() as d, mock.patch.object(cs, '_GAME_PAUSE_FILE', os.path.join(d,'pause.json')):
            lock=os.open(cs._GAME_PAUSE_FILE+'.lock',os.O_CREAT|os.O_RDWR,0o600)
            try:
                cs.fcntl.flock(lock,cs.fcntl.LOCK_EX|cs.fcntl.LOCK_NB)
                action=mock.Mock(return_value={'ok':True})
                self.assertFalse(cs._game_pause_control(action)['ok']);action.assert_not_called()
            finally:os.close(lock)
            self.assertTrue(cs._game_pause_control(lambda:{'ok':True})['ok'])

    def test_unknown_game_id_cannot_signal_any_process(self):
        with mock.patch.object(cs, '_game_pause_supported', return_value=True), mock.patch.object(cs, '_game_pause_control', side_effect=lambda operation: operation()), mock.patch.object(cs, 'ALLOW_GAME_PAUSE', True), mock.patch.object(cs, 'UID', 1000), mock.patch.object(cs, 'GAME_PAUSE_APPIDS', {42}), mock.patch.object(cs, '_game_pause_read', return_value=None), mock.patch.object(cs, '_running_game', return_value={'appid':43,'pid':99999}), mock.patch.object(cs, '_game_pause_signal') as send:
            self.assertFalse(cs.pause_running_game()['ok']);send.assert_not_called()

    def test_close_game_cannot_queue_sigterm_against_a_pause_record(self):
        for value in ({'game':{'appid':42}}, ValueError('invalid journal')):
            patch=mock.patch.object(cs, '_game_pause_read', side_effect=value) if isinstance(value,Exception) else mock.patch.object(cs, '_game_pause_read', return_value=value)
            with patch, mock.patch.object(os, 'kill') as kill, mock.patch.object(os, 'killpg') as group:
                self.assertFalse(cs.stop_running_game()['stopped']);kill.assert_not_called();group.assert_not_called()

    def test_partial_pause_rolls_back_and_preserves_recovery_failure(self):
        game = {'appid': 42, 'pid': 99999}
        with mock.patch.object(cs, '_game_pause_supported', return_value=True), mock.patch.object(cs, '_game_pause_control', side_effect=lambda operation: operation()), mock.patch.object(cs, 'ALLOW_GAME_PAUSE', True), mock.patch.object(cs, 'UID', 1000), mock.patch.object(cs, 'GAME_PAUSE_APPIDS', {42}), mock.patch.object(cs, '_game_pause_read', return_value=None), mock.patch.object(cs, '_running_game', return_value=game), mock.patch.object(cs, '_game_pause_proc', return_value={'pid':99999,'uid':1000,'start':1}), mock.patch('builtins.open', mock.mock_open(read_data='reaper\0AppId=42\0/tmp/steamapps/fake')), mock.patch.object(cs, '_game_pause_boot', return_value='boot'), mock.patch.object(cs, '_game_pause_signal', side_effect=OSError('fake failure')), mock.patch.object(cs, '_game_pause_resume_locked', return_value={'ok':False}) as recover:
            result=cs.pause_running_game();self.assertFalse(result['ok']);self.assertTrue(result['paused']);recover.assert_called_once()

class PauseHTTP(unittest.TestCase):
    def test_auth_empty_body_only_and_mock_pause_resume(self):
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        with tempfile.TemporaryFile() as log:
            agent=subprocess.Popen([sys.executable,str(ROOT/'agent/couchsided.py'),'--mock','--host','127.0.0.1','--port',str(port),'--token','fake-pause-test'],stdout=log,stderr=log)
            base='http://127.0.0.1:'+str(port)
            def request(path,body=b'',token='fake-pause-test',method='POST'):
                req=urllib.request.Request(base+path,data=body if method=='POST' else None,method=method,headers={'Authorization':'Bearer '+token})
                try:
                    with urllib.request.urlopen(req,timeout=3) as r:return r.status,json.load(r)
                except urllib.error.HTTPError as r:
                    with r:return r.code,json.load(r)
            try:
                for n in range(100):
                    try:
                        if request('/api/ping',method='GET')[0]==200:break
                    except OSError:time.sleep(.05)
                for action in ('pause','resume'):
                    self.assertEqual(request('/api/game/'+action,token='wrong')[0],401)
                    for body in (b'{}',b'{"pid":1}',b'[]'):
                        self.assertEqual(request('/api/game/'+action,body)[0],400)
                    self.assertEqual(request('/api/game/'+action+'?pid=1')[0],400)
                self.assertFalse(request('/api/gaming',method='GET')[1]['game_pause']['has_record'])
                self.assertTrue(request('/api/game/pause')[1]['paused'])
                self.assertTrue(request('/api/gaming',method='GET')[1]['game_pause']['has_record'])
                self.assertFalse(request('/api/game/resume')[1]['paused'])
                self.assertFalse(request('/api/gaming',method='GET')[1]['game_pause']['has_record'])
            finally:agent.terminate();agent.wait(timeout=5)

@unittest.skipUnless(cs._game_pause_supported() and cs.UID != 0, 'requires non-root Linux with pidfds')
class PauseRealLinux(unittest.TestCase):
    def test_owned_tree_stops_and_resumes_after_module_reload(self):
        with tempfile.TemporaryDirectory() as d:
            child="import time,pathlib,sys; p=pathlib.Path(sys.argv[1]); n=0\nwhile True:\n n+=1; p.write_text(str(n)); time.sleep(.02)"
            rootcode="import subprocess,sys; code=sys.argv[1]; rootfile=sys.argv[2]; subprocess.Popen([sys.executable,'-c',code,sys.argv[3]]); sys.argv=[sys.argv[0],rootfile]; exec(code)"
            # Synthetic Steam-shaped argv belongs ONLY to this disposable test.
            proc=subprocess.Popen([sys.executable,'-c',rootcode,child,str(Path(d)/'root'),str(Path(d)/'child'),'reaper','AppId=424242','/tmp/steamapps/CouchsideFake'],start_new_session=True)
            original=cs._GAME_PAUSE_FILE
            try:
                for n in range(100):
                    if (Path(d)/'child').exists() and (Path(d)/'root').exists():break
                    time.sleep(.02)
                cs._GAME_PAUSE_FILE=str(Path(d)/'journal.json')
                with mock.patch.object(cs,'ALLOW_GAME_PAUSE',True),mock.patch.object(cs,'GAME_PAUSE_APPIDS',{424242}),mock.patch.object(cs,'_running_game',return_value={'appid':424242,'pid':proc.pid,'label':'Synthetic test'}):
                    self.assertTrue(cs.pause_running_game()['ok'])
                    before=(Path(d)/'child').read_text();time.sleep(.15);self.assertEqual((Path(d)/'child').read_text(),before)
                    spec=importlib.util.spec_from_file_location('pause_reloaded',ROOT/'agent/couchsided.py');fresh=importlib.util.module_from_spec(spec);spec.loader.exec_module(fresh);fresh._GAME_PAUSE_FILE=cs._GAME_PAUSE_FILE
                    self.assertTrue(fresh.resume_running_game()['ok'])
                    time.sleep(.15);self.assertNotEqual((Path(d)/'child').read_text(),before)
                    self.assertFalse(Path(cs._GAME_PAUSE_FILE).exists())
            finally:
                if Path(cs._GAME_PAUSE_FILE).exists():cs.resume_running_game()
                cs._GAME_PAUSE_FILE=original
                os.killpg(proc.pid,signal.SIGCONT);os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=5)

if __name__=='__main__':unittest.main()
