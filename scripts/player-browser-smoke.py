#!/usr/bin/env python3
"""Opt-in local Player acceptance check. No Steam, install, or LAN box access.

Runs the real /api/player handlers and CDP transport against a fresh headless
Chrome process. Only Steam registration/relaunch is replaced by a local browser
launch. Requires installed Chrome/Chromium and network access to the fixed sample.
Runtime files, a screenshot and the redacted result stay under this worktree.
"""
import base64
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://media.w3.org/2010/05/bunny/trailer.mp4'
VIDEO_ID = 'couchside:bbb-trailer'


def until(read, description, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = read()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError('Timed out: ' + description)


def main():
    browser = next((p for p in [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        shutil.which('google-chrome'), shutil.which('chromium'),
        shutil.which('chromium-browser'),
    ] if p and Path(p).is_file()), None)
    if browser is None:
        raise SystemExit('Chrome/Chromium is required; no browser was installed.')
    output = ROOT / 'output' / 'player-prototype'
    output.mkdir(parents=True, exist_ok=True)
    # A failed rerun must not leave an earlier success looking current.
    (output / 'browser-smoke-result.json').unlink(missing_ok=True)
    (output / 'browser-smoke.png').unlink(missing_ok=True)
    spec = importlib.util.spec_from_file_location('player_smoke_agent', ROOT / 'agent/couchsided.py')
    cs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cs)
    cs.PL_MOCK = False
    token = secrets.token_urlsafe(32)
    cs.Handler.token = token
    cs.Handler.mock = False
    proc = None
    server = None
    checks = []

    def check(ok, label):
        if not ok:
            raise AssertionError(label)
        checks.append(label)
        print('PASS: ' + label, flush=True)

    with tempfile.TemporaryDirectory(prefix='browser-smoke-', dir=output) as temp:
        run = Path(temp)
        profile = run / 'chrome'
        conf = run / 'player.conf'
        pidfile = run / 'player.pid'
        log = (run / 'chrome.log').open('wb')
        port = [None]

        def launch(_appid, _was_running):
            nonlocal proc
            check('url=' + SOURCE in conf.read_text(), 'catalog resolved the fixed source')
            # Fresh profile and ephemeral debug port: never attach to a user's
            # browser, cookies or existing tabs. These are test-owned argv.
            # Render the production launcher's fixed file:// surface and use
            # its sample-only flags, rather than Chrome's raw-MP4 viewer.
            launch_spec = subprocess.check_output([
                'bash', str(ROOT / 'agent/couchside-player.sh'),
                '--print-sample-launch', SOURCE], text=True,
                env={**os.environ, 'HOME': str(run / 'tile-home'),
                     'XDG_CACHE_HOME': str(run / 'tile-cache')}).splitlines()
            page, *sample_args = launch_spec
            check(page.startswith('file://') and page.endswith('/sample.html'),
                  'production tile selected its local sample surface')
            check('--disable-accelerated-video-decode' in sample_args,
                  'production sample selects software video decoding')
            proc = subprocess.Popen([
                browser, '--headless=new', '--no-first-run',
                '--no-default-browser-check', '--remote-debugging-port=0',
                '--remote-debugging-address=127.0.0.1',
                *sample_args, '--user-data-dir=' + str(profile), '--app=' + page,
            ], stdout=log, stderr=log)
            pidfile.write_text(str(proc.pid))
            active = profile / 'DevToolsActivePort'
            until(lambda: active.exists(), 'browser debugging port')
            port[0] = int(active.read_text().splitlines()[0])

        try:
            with patch.object(cs, 'PLAYER_CONF', str(conf)), \
                 patch.object(cs, 'PLAYER_PIDFILE', str(pidfile)), \
                 patch.object(cs, 'player_available', return_value=True), \
                 patch.object(cs, '_pl_appid', return_value=123), \
                 patch.object(cs, '_pl_relaunch', side_effect=launch), \
                 patch.object(cs, '_pl_cdp_port', side_effect=lambda: port[0]):
                server = ThreadingHTTPServer(('127.0.0.1', 0), cs.Handler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()

                def request(payload=None, authorized=True):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=60)
                    headers = {'Authorization': 'Bearer ' + token} if authorized else {}
                    connection.request('POST' if payload else 'GET', '/api/player',
                                       json.dumps(payload) if payload else None, headers)
                    response = connection.getresponse()
                    status, data = response.status, json.loads(response.read())
                    connection.close()
                    return status, data

                def command(op, **fields):
                    status, data = request(dict(op=op, **fields))
                    check(status == 200 and data.get('ok') is True, op + ' accepted')

                def playback():
                    status, data = request()
                    return data.get('playback') if status == 200 else None

                check(request(authorized=False)[0] == 401, 'unauthorized read refused')
                check(request({'op': 'catalog-open', 'video_id': VIDEO_ID}, False)[0] == 401,
                      'unauthorized launch refused')
                check(request({'op': 'catalog-open', 'video_id': 'unknown'})[0] == 404,
                      'unknown video refused')
                check(proc is None and not conf.exists(), 'refusals wrote nothing and launched nothing')
                status, data = request()
                check(status == 200 and data['catalog']['metas'][0]['id'] == VIDEO_ID,
                      'catalog discovered over HTTP')
                command('catalog-open', video_id=VIDEO_ID)
                until(lambda: (playback() or {}).get('duration', 0) > 0, 'video metadata')
                cdp = cs._PlayerCDP(port[0])
                try:
                    for width, height in ((1280, 720), (1024, 768), (2560, 1080), (3840, 2160)):
                        cdp._call('Emulation.setDeviceMetricsOverride', {
                            'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
                        geometry = cdp.evaluate("(()=>{let v=document.getElementById('film'),r=v.getBoundingClientRect();return [r.x,r.y,r.width,r.height,getComputedStyle(v).objectFit]})()")
                        check(geometry == [0, 0, width, height, 'contain'],
                              'production sample fills %dx%d with aspect ratio preserved' % (width, height))
                finally:
                    cdp.close()
                command('pause')
                check(playback()['playing'] is False, 'video paused')
                position = playback()['position']
                time.sleep(0.3)
                check(abs(playback()['position'] - position) < 0.1, 'paused position stayed still')
                command('play')
                until(lambda: (playback() or {}).get('position', 0) > position + 0.1,
                      'playback clock advancing')
                check(playback()['playing'] is True, 'resume advanced real video')
                initial_frames = playback()['decodedFrames']
                until(lambda: (playback() or {}).get('decodedFrames', 0) > initial_frames + 3,
                      'actual decoded frames advancing')
                check(True, 'production state reports decoded-frame progress')
                command('pause')
                command('seek', secs=-90)
                check(playback()['position'] < 0.5, 'backward seek clamped at start')
                command('seek', secs=10)
                check(abs(playback()['position'] - 10) < 0.5, 'forward seek reached 10 seconds')
                command('play')
                until(lambda: (playback() or {}).get('playing'), 'post-seek playing')
                after_seek = playback()
                time.sleep(3)
                progressed = playback()
                check(not progressed.get('error')
                      and progressed['position'] > after_seek['position'] + 1
                      and progressed['decodedFrames'] > after_seek['decodedFrames'] + 5,
                      'production surface sustains clock and decoded frames after seeking')
                command('pause')
                before = playback()['muted']
                command('mute')
                check(playback()['muted'] != before, 'mute changed real video')
                command('mute')
                check(playback()['muted'] == before, 'mute restored real video')
                cdp = cs._PlayerCDP(port[0])
                try:
                    shot = cdp._call('Page.captureScreenshot', {'format': 'png'})
                    (output / 'browser-smoke.png').write_bytes(base64.b64decode(shot['data']))
                    cdp.evaluate("Object.defineProperty(document.getElementById('film'),'error',{configurable:true,value:{code:3}}); true")
                    # Force paused=false to reproduce the decode failure that
                    # previously looked like playback solely from that flag.
                    cdp.evaluate("Object.defineProperty(document.getElementById('film'),'paused',{configurable:true,value:false}); true")
                    failed = playback()
                    check(failed['playing'] is False and failed['error']['code'] == 3
                          and failed['error']['message'] == 'video decode failed',
                          'production decode failure is explicit and never reports playing')
                finally:
                    cdp.close()
                command('close')
                proc.wait(timeout=15)
                status, data = request()
                check(status == 200 and data['running'] is False
                      and data['playback'] is None and data['catalog_video'] is None,
                      'Stop ended browser and cleared active playback/title')
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
            if server is not None:
                server.shutdown()
                server.server_close()
                worker.join(timeout=5)
            log.close()
    (output / 'browser-smoke-result.json').write_text(json.dumps({
        'checks': checks,
        'boundary': 'Real HTTP and CDP; local Chrome replaces Steam registration/relaunch.',
        'not_verified': ['Steam/gamescope', 'TV audio', 'physical phone', 'Themes integration'],
    }, indent=2) + '\n')
    print('Local acceptance check passed. No Steam machine was accessed.')


if __name__ == '__main__':
    main()
