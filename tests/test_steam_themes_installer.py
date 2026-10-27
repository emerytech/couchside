#!/usr/bin/env python3
"""Run the shipped opt-in function against temporary desktop-user state."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[1]
script = (ROOT / 'install.sh').read_text()
function = script.split('offer_steam_themes() {', 1)[1].split('\n}\noffer_steam_themes', 1)[0]
function = 'offer_steam_themes() {' + function + '\n}'

class InstallerChoice(unittest.TestCase):
    def test_optin_and_upgrade(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'steam-themes.json'
            def run(choice='', tty=False, yes=False):
                env = dict(os.environ, STATE_DIR=temp, COUCHSIDE_THEMES=choice)
                stubs = 'note(){ :; }; say(){ :; }; decky_steam_root_present(){ return 0; }; decky_installed(){ return 0; };'
                stubs += 'decky_have_tty(){ return %d; }; ask_yn(){ return %d; };' % (0 if tty else 1, 0 if yes else 1)
                subprocess.run(['bash', '-c', stubs+function+'\noffer_steam_themes'], env=env, check=True)
            run(); self.assertFalse(path.exists())
            run(tty=True, yes=False); self.assertFalse(json.loads(path.read_text())['installed'])
            run(tty=True, yes=True); self.assertFalse(json.loads(path.read_text())['installed'])
            run('1'); value = json.loads(path.read_text()); self.assertTrue(value['installed']); self.assertFalse(value['enabled'])
            value.update(enabled=True, theme='crossbar', motion=False, studio={'format':'couchside-theme','version':1,'name':'My theme'}); path.write_text(json.dumps(value))
            run(); self.assertEqual(json.loads(path.read_text()), value)
            run('1'); self.assertEqual(json.loads(path.read_text()), value)
            run('0'); after=json.loads(path.read_text()); self.assertFalse(after['installed']); self.assertFalse(after['enabled']); self.assertEqual(after['theme'], 'crossbar')
            before=path.read_text(); run('invalid'); self.assertEqual(path.read_text(), before)

if __name__ == '__main__': unittest.main()
