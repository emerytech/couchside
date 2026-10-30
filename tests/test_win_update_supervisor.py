"""Windows process-lifecycle tests, with a local unsigned dummy installer.

These exercise ONLY supervision/cleanup, never the signed-update trust gate.
No network, driver, installer, or real agent is run.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / 'couchsided-win.py'
if not AGENT.exists():
    AGENT = ROOT / 'agent/win/couchsided-win.py'


@unittest.skipUnless(sys.platform == 'win32', 'requires real Windows process behavior')
class SupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='couchside-supervisor-test-')
        cls.root = Path(cls.tmp.name)
        cls.ps = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        source = '''using System; using System.IO; using System.Threading; using System.Diagnostics;
public class FakeSetup { public static int Main(string[] args) {
  string root = Environment.GetEnvironmentVariable("COUCHSIDE_TEST_ROOT");
  if(Environment.GetEnvironmentVariable("COUCHSIDE_TEST_DESCENDANT")=="1") {
    var start=new ProcessStartInfo("cmd.exe", "/c ping -n 30 127.0.0.1 >nul");
    start.UseShellExecute=false; start.CreateNoWindow=true;
    var child=Process.Start(start);
    File.WriteAllText(Path.Combine(root,"descendant.pid"), child.Id.ToString());
  }
  File.WriteAllText(Path.Combine(root,"started"), String.Join("\\n",args));
  for(int i=0;i<300;i++) { if(File.Exists(Path.Combine(root,"finish")))
    return Int32.Parse(File.ReadAllText(Path.Combine(root,"finish")));
    Thread.Sleep(100); }
  return 99;
} }'''
        env = dict(os.environ, COUCHSIDE_TEST_SOURCE=source,
                   COUCHSIDE_TEST_BINARY=str(cls.root / 'fixture.exe'))
        subprocess.run([cls.ps, '-NoProfile', '-NonInteractive', '-Command',
                        'Add-Type -TypeDefinition $env:COUCHSIDE_TEST_SOURCE '
                        '-OutputAssembly $env:COUCHSIDE_TEST_BINARY -OutputType ConsoleApplication'],
                       env=env, check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def wait_for(self, predicate):
        end = time.monotonic() + 20
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.1)
        self.fail('Timed out waiting for Windows process state')

    def exercise(self, code=0, kill_parent=False, corrupt=False, descendant=False):
        case = Path(tempfile.mkdtemp(dir=self.root))
        stage = case / 'download'; stage.mkdir()
        setup = stage / 'CouchsideSetup.exe'
        setup.write_bytes((self.root / 'fixture.exe').read_bytes())
        digest = hashlib.sha256(setup.read_bytes()).hexdigest()
        if corrupt:
            digest = '0' * 64
        # Call the production launcher directly; signing gates remain untouched.
        env = dict(os.environ, COUCHSIDE_UPDATE_STAGE=str(stage),
                   COUCHSIDE_UPDATE_SHA256=digest, COUCHSIDE_TEST_ROOT=str(case),
                   QA_AGENT=str(AGENT), COUCHSIDE_TEST_DESCENDANT="1" if descendant else "0")
        parent_code = """import importlib.util,os
spec=importlib.util.spec_from_file_location('qa_agent',os.environ['QA_AGENT'])
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
w._UPDATE_LOG=os.path.join(os.environ['COUCHSIDE_TEST_ROOT'],'log with spaces.txt')
p=w._launch_update_supervisor(os.environ['COUCHSIDE_UPDATE_STAGE'],os.environ['COUCHSIDE_UPDATE_SHA256'])
open(os.path.join(os.environ['COUCHSIDE_TEST_ROOT'],'supervisor.pid'),'w').write(str(p.pid))
rc=p.wait()
open(os.path.join(os.environ['COUCHSIDE_TEST_ROOT'],'exit'),'w').write(str(rc))
"""
        parent = subprocess.Popen([sys.executable, '-c', parent_code], env=env)
        try:
            if not corrupt:
                self.wait_for(lambda: (case / 'started').exists() or (case / 'exit').exists())
                self.assertTrue((case / 'started').exists(),
                                'Supervisor exited before starting fixture')
                arguments = (case / 'started').read_text()
                self.assertIn('/VERYSILENT', arguments)
                self.assertIn('/LOG=' + str(case / 'log with spaces.txt') + '.setup.txt', arguments)
                if kill_parent:
                    parent.kill(); parent.wait(timeout=10)
                (case / 'finish').write_text(str(code))
            self.wait_for(lambda: not stage.exists())
            if not kill_parent:
                parent.wait(timeout=15)
                self.assertEqual(int((case / 'exit').read_text()), 1 if corrupt else code)
            if descendant:
                check = subprocess.run(['tasklist', '/FI', 'PID eq ' + (case / 'descendant.pid').read_text()], capture_output=True, text=True)
                self.assertIn('cmd.exe', check.stdout)
            if corrupt:
                self.assertFalse((case / 'started').exists())
        finally:
            (case / 'finish').write_text('0')
            if (case / 'descendant.pid').exists():
                subprocess.run(['taskkill', '/PID', (case / 'descendant.pid').read_text(), '/T', '/F'], capture_output=True)
            if parent.poll() is None:
                parent.wait(timeout=40)

    def test_success_cleanup(self):
        self.exercise()

    def test_nonzero_exit_cleanup(self):
        self.exercise(code=7)

    def test_cleanup_survives_initiator_termination(self):
        self.exercise(kill_parent=True)

    def test_browser_descendant_does_not_delay_cleanup(self):
        self.exercise(descendant=True)

    def test_changed_download_never_executes(self):
        self.exercise(corrupt=True)


if __name__ == '__main__':
    unittest.main()
