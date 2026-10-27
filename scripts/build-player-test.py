#!/usr/bin/env python3
"""Build a local reviewable tarball; never connect, install, or publish."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output/player-test-package'
FILES = {
    'player_test.py': 'scripts/player-test/player_test.py',
    'remote.html': 'scripts/player-test/remote.html',
    'tv.html': 'scripts/player-test/tv.html',
    'README.md': 'scripts/player-test/README.md',
    'couchsided.py': 'agent/couchsided.py',
}


def main():
    revision = subprocess.check_output(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=ROOT, text=True).strip()
    content_id = hashlib.sha256(b''.join(
        (ROOT / source).read_bytes() for _, source in sorted(FILES.items())
    )).hexdigest()[:12]
    name = 'couchside-player-test-' + revision + '-' + content_id
    OUTPUT.mkdir(parents=True, exist_ok=True)
    folder = OUTPUT / name
    # Refuse replacing any package that could have an active session or secrets.
    folder.mkdir(mode=0o700)
    for target, source in FILES.items():
        shutil.copyfile(ROOT / source, folder / target)
        (folder / target).chmod(0o600)
    launcher = folder / 'Couchside Player Test'
    launcher.write_text('''#!/usr/bin/env bash
set -euo pipefail
unset LD_LIBRARY_PATH LD_PRELOAD
cd -- "$(dirname -- "$0")"
exec /usr/bin/python3 ./player_test.py --host 0.0.0.0 --port 8791
''')
    launcher.chmod(0o700)
    entries = sorted(p for p in folder.iterdir() if p.is_file())
    manifest = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in entries)
    (folder / 'SHA256SUMS').write_text(manifest)
    (folder / 'SHA256SUMS').chmod(0o600)
    archive = OUTPUT / (name + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(folder, arcname=name)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (OUTPUT / (archive.name + '.sha256')).write_text(digest + '  ' + archive.name + '\n')
    print(archive)
    print('SHA256 ' + digest)
    print('Package built locally. No connection, installation or publication performed.')


if __name__ == '__main__':
    main()
