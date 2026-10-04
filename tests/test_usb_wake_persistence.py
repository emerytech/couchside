"""USB wake rules: hardware scope, verification and failed-save rollback."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('helper', Path(__file__).resolve().parents[1] / 'agent/couchside-helper.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.base = self.root / 'usb/1-3'
        (self.base / 'power').mkdir(parents=True)
        for name, value in [('power/wakeup', 'enabled'), ('idVendor', '28de'), ('idProduct', '1305')]:
            (self.base / name).write_text(value)
        self.rules = self.root / 'rules'
        for name, value in [('_USB_WAKE_DIR', str(self.root/'usb')), ('_USB_WAKE_RULE_DIR', str(self.rules))]:
            p = patch.object(h, name, value); p.start(); self.addCleanup(p.stop)
        self.path = 'pci-0000:07:00.3-usb-0:3'
        self.fail_reload = False
        def run(cmd, **kwargs):
            if cmd[1] == 'info': return subprocess.CompletedProcess(cmd, 0, 'ID_PATH='+self.path+'\n')
            if self.fail_reload and kwargs.get('check'): raise subprocess.CalledProcessError(1, cmd)
            return subprocess.CompletedProcess(cmd, 0, '')
        p = patch.object(h.subprocess, 'run', side_effect=run); p.start(); self.addCleanup(p.stop)
    def save(self, on): return h.verb_usb_wake_save({'id':'1-3', 'on':on})[0]
    def test_installer_preserves_and_removes_saved_rules(self):
        installer = (Path(__file__).resolve().parents[1] / 'install.sh').read_text()
        pattern = '/etc/udev/rules.d/99-couchside-usb-wake-*.rules'
        self.assertIn(pattern, installer.split('# --uninstall', 1)[1].split('say "Couchside agent uninstalled."', 1)[0])
        self.assertIn(pattern, installer.split("<<'KEEPCONF'", 1)[1].split('KEEPCONF', 1)[0])

    def test_persists_and_updates_same_rule(self):
        self.assertTrue(self.save(False))
        rule, = self.rules.glob('*.rules')
        text = rule.read_text()
        for value in [self.path, '28de', '1305', '="disabled"']: self.assertIn(value, text)
        self.assertEqual((self.base/'power/wakeup').read_text(), 'disabled')
        self.assertTrue(self.save(True))
        self.assertEqual(len(list(self.rules.glob('*.rules'))), 1)
        self.assertIn('="enabled"', rule.read_text())
    def test_rejects_untrusted_identity(self):
        self.path = 'port", RUN+="bad'
        self.assertFalse(self.save(False))
        self.assertFalse(self.rules.exists())
        self.assertEqual((self.base/'power/wakeup').read_text(), 'enabled')
    def test_unknown_and_malformed_ids(self):
        for value in [None, {}, {'id':'../../etc', 'on':True}, {'id':'1-9','on':True}]:
            self.assertFalse(h.verb_usb_wake_save(value)[0])
    def test_reload_failure_restores_existing_rule(self):
        self.assertTrue(self.save(True))
        rule, = self.rules.glob('*.rules'); before = rule.read_text()
        self.fail_reload = True
        self.assertFalse(self.save(False))
        self.assertEqual(rule.read_text(), before)
        self.assertEqual((self.base/'power/wakeup').read_text(), 'enabled')
    def test_failed_verification_rolls_back(self):
        with patch.object(h, 'verb_usb_wake_arm', return_value=(True, 'ok')):
            self.assertFalse(self.save(False))
        self.assertEqual(list(self.rules.glob('*.rules')), [])
        self.assertEqual((self.base/'power/wakeup').read_text(), 'enabled')

if __name__ == '__main__': unittest.main()
