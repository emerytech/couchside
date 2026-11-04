#!/usr/bin/env python3
"""Exercise the shipped installer offer with isolated files and no privilege changes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'install.sh').read_text()
OFFER = SOURCE.split('offer_ports_optin() {', 1)[1].split('\n}\noffer_ports_optin', 1)[0]
OFFER = 'offer_ports_optin() {' + OFFER + '\n}\n'

class PortsOptin(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        cli = self.root / 'cli'
        cli.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$QA_ROOT/calls"\nexit "${QA_CLI_RC:-0}"\n')
        cli.chmod(0o755)

    def run_offer(self, **values):
        env = dict(os.environ, QA_ROOT=str(self.root), QA_TTY='1', QA_STEAM='1', QA_YES='0')
        env.update(values)
        script = '''
set -e
CLI="$QA_ROOT/cli"
PORTS_MARKER="$QA_ROOT/enabled"
PORTS_DECLINED="$QA_ROOT/declined"
say() { :; }; note() { :; }
decky_steam_root_present() { [ "$QA_STEAM" = 1 ]; }
decky_have_tty() { [ "$QA_TTY" = 1 ]; }
ask_yn() { echo asked >> "$QA_ROOT/asked"; [ "$QA_YES" = 1 ]; }
sudo() {
 if [ "$1" = install ]; then
  shift; while [ "$#" -gt 2 ]; do shift; done
  cp "$1" "$2"
 else "$@"; fi
}
''' + OFFER + '\noffer_ports_optin\n'
        result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unattended_does_not_grant_or_record_decline(self):
        self.run_offer(QA_TTY='0', QA_YES='1')
        for name in ['asked', 'calls', 'declined', 'enabled']:
            self.assertFalse((self.root / name).exists(), name)

    def test_no_steam_no_offer(self):
        self.run_offer(QA_STEAM='0')
        self.assertFalse((self.root / 'asked').exists())

    def test_existing_choices_are_preserved(self):
        for name in ['enabled', 'declined']:
            marker = self.root / name; marker.touch()
            self.run_offer(QA_YES='1')
            self.assertFalse((self.root / 'asked').exists())
            self.assertTrue(marker.exists()); marker.unlink()

    def test_decline_is_remembered(self):
        self.run_offer()
        self.assertTrue((self.root / 'declined').exists())
        self.run_offer(QA_YES='1')
        self.assertEqual((self.root / 'asked').read_text().splitlines(), ['asked'])
        self.assertFalse((self.root / 'calls').exists())

    def test_yes_delegates_to_existing_confirmed_cli(self):
        self.run_offer(QA_YES='1')
        self.assertEqual((self.root / 'calls').read_text(), 'allow-ports on\n')
        self.assertFalse((self.root / 'enabled').exists())
        self.assertFalse((self.root / 'declined').exists())

    def test_cli_failure_does_not_abort_base_install_or_stamp_choice(self):
        self.run_offer(QA_YES='1', QA_CLI_RC='1')
        self.assertFalse((self.root / 'declined').exists())
        self.assertFalse((self.root / 'enabled').exists())

if __name__ == '__main__': unittest.main()
