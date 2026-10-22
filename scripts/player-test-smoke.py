#!/usr/bin/env python3
"""Opt-in local acceptance test of a built isolated package and its web remote.

Usage: python3 scripts/player-test-smoke.py output/player-test-package/<folder>
Requires installed native Chrome/Chromium. Does not connect to any LAN machine.
"""
import importlib.util
import json
import re
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def until(fn, label, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = fn()
        if result:
            return result
        time.sleep(0.15)
    raise AssertionError('Timed out: ' + label)


def main():
    package = Path(sys.argv[1]).resolve()
    if package.parent != ROOT / 'output/player-test-package' or not package.is_dir():
        raise SystemExit('Choose a built package directory under this worktree output/player-test-package')
    output = ROOT / 'output/player-prototype'
    result_path = output / 'isolated-smoke-result.json'
    result_path.unlink(missing_ok=True)
    spec = importlib.util.spec_from_file_location('package_player', package / 'player_test.py')
    pt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pt)
    checks = []

    def check(condition, label):
        if not condition:
            raise AssertionError(label)
        checks.append(label)
        print('PASS: ' + label, flush=True)

    with tempfile.TemporaryDirectory(prefix='isolated-smoke-', dir=output) as temp:
        run = Path(temp)
        copied = run / 'package'
        shutil.copytree(package, copied, ignore=shutil.ignore_patterns('state', '__pycache__'))
        server = subprocess.Popen([sys.executable, str(copied / 'player_test.py'),
                                   '--headless', '--port', '0'],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ui = None
        try:
            check(bool(select.select([server.stdout], [], [], 10)[0]), 'isolated server startup')
            line = server.stdout.readline()
            match = re.search(r'listening on port (\d+)', line)
            check(match is not None, 'ephemeral local API port reported')
            port = int(match.group(1))
            token = (copied / 'state/test-token').read_text().strip()
            check(token not in line, 'startup message contains no token')
            ui_state = pt.private_state(run / 'remote-browser')
            ui = pt.Browser(ui_state, 'http://127.0.0.1:%d/' % port, headless=True)
            ui.start()
            agent = pt.load_agent()

            def evaluate(expression):
                cdp = agent._PlayerCDP(ui.port)
                try:
                    return cdp.evaluate(expression)
                finally:
                    cdp.close()

            def actual_playback(allow_error=False):
                import urllib.request
                request=urllib.request.Request('http://127.0.0.1:%d/api/player' % port,
                                              headers={'Authorization':'Bearer '+token})
                with urllib.request.urlopen(request, timeout=10) as response:
                    state=json.load(response).get('playback')
                if state and state.get('error') and not allow_error:
                    raise AssertionError('Decoder failed: '+state['error']['message'])
                return state

            def motion(label, seconds=3):
                start=actual_playback()
                if not start:
                    raise AssertionError('No video state for '+label)
                time.sleep(seconds)
                end=actual_playback()
                check(end is not None and end['position'] > start['position'] + seconds * 0.5
                      and end['decodedFrames'] > start['decodedFrames'], label)

            until(lambda: evaluate("!!document.getElementById('pair')"), 'phone web remote loaded')
            evaluate("document.getElementById('token').value=" + json.dumps(token)
                     + ";document.getElementById('pair').click();true")
            until(lambda: evaluate("document.getElementById('notice').textContent.includes('Connected')"),
                  'web remote connected with private test token')
            check(evaluate("document.getElementById('token').value === '' && localStorage.length === 0"),
                  'token input cleared and no browser localStorage credentials')
            evaluate("document.getElementById('open').click();true")
            until(lambda: evaluate("document.getElementById('status').textContent.startsWith('Playing')"),
                  'Play on TV started real trailer')
            check(True, 'Play on TV button launched real video')
            motion('initial playback clock and decoded frames advance')
            evaluate("document.getElementById('pause').click();true")
            until(lambda: evaluate("document.getElementById('status').textContent.startsWith('Paused')"),
                  'pause state')
            check(True, 'pause button changed actual playback state')
            evaluate("document.getElementById('back').click();true")
            until(lambda: evaluate("document.getElementById('progress').value < 0.5"), 'seek to start')
            until(lambda: evaluate("!document.getElementById('forward').disabled"), 'forward control enabled')
            evaluate("document.getElementById('forward').click();true")
            until(lambda: evaluate("document.getElementById('progress').value >= 9.5"), 'seek forward')
            check(True, 'back/forward buttons updated real video position')
            until(lambda: evaluate("!document.getElementById('pause').disabled"), 'post-seek resume enabled')
            evaluate("document.getElementById('pause').click();true")
            until(lambda: (actual_playback() or {}).get('playing'), 'post-seek playback resumed')
            motion('clock and decoded frames advance after seeking')
            evaluate("document.getElementById('pause').click();true")
            until(lambda: not (actual_playback() or {}).get('playing', True), 'pause before sizing')
            video_port = int(next((copied / 'state').glob('profile-*/DevToolsActivePort')).read_text().splitlines()[0])
            video = agent._PlayerCDP(video_port)
            sizes = []
            geometry_js = """(()=>{const v=document.getElementById('film');if(!v)return null;
              const r=v.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,
              viewportWidth:innerWidth,viewportHeight:innerHeight,fit:getComputedStyle(v).objectFit,
              videoWidth:v.videoWidth,videoHeight:v.videoHeight,ready:v.readyState,seeking:v.seeking};})()"""
            media_properties = {}
            original_frame = video._frame
            def media_frame():
                payload = original_frame()
                message = json.loads(payload)
                if message.get('method') == 'Media.playerPropertiesChanged':
                    for prop in message.get('params', {}).get('properties', []):
                        if prop.get('name') in ('kVideoDecoderName', 'kIsPlatformVideoDecoder'):
                            media_properties[prop['name']] = prop.get('value')
                return payload
            video._frame = media_frame
            try:
                until(lambda: video.evaluate("(()=>{let v=document.getElementById('film');return v&&v.readyState>=2&&!v.seeking})()"), 'decoded TV surface frame')
                video._call('Media.enable', {})
                video.evaluate('document.getElementById("film").readyState')
                (output / 'decoder-properties.json').write_text(json.dumps(media_properties, indent=2) + '\n')
                for width, height in [(1280,720), (1024,768), (2560,1080), (3840,2160)]:
                    video._call('Emulation.setDeviceMetricsOverride', {
                        'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False,
                    })
                    metrics = video.evaluate(geometry_js)
                    check(metrics is not None and metrics['videoWidth'] > 0 and metrics['videoHeight'] > 0
                          and abs(metrics['x']) < 1 and abs(metrics['y']) < 1
                          and abs(metrics['width']-width) < 1 and abs(metrics['height']-height) < 1
                          and metrics['fit'] == 'contain',
                          'TV video fills %dx%d viewport with aspect ratio preserved' % (width,height))
                    sizes.append(metrics)
                    if (width,height) in [(1280,720),(2560,1080)]:
                        import base64
                        shot = video._call('Page.captureScreenshot', {'format':'png'})
                        (output / ('tv-%dx%d.png' % (width,height))).write_bytes(base64.b64decode(shot['data']))
                video.evaluate('window.__sizingReloadMarker = true')
                video._call('Page.reload', {})
                until(lambda: video.evaluate("!window.__sizingReloadMarker && !!document.getElementById('film') && document.getElementById('film').readyState >= 2"), 'TV surface survived reload')
                metrics = video.evaluate(geometry_js)
                check(metrics['width'] == metrics['viewportWidth'] and metrics['height'] == metrics['viewportHeight'],
                      'TV sizing persists after page reload')
                # Deterministically replay the captured error state. This tests
                # reporting only; it does not claim to reproduce a GPU defect.
                video.evaluate("Object.defineProperty(document.getElementById('film'),'error',{configurable:true,get:()=>({code:3})});true")
                until(lambda: evaluate("document.getElementById('status').textContent.includes('Playback failed: video decode failed')"), 'remote shows decoder error')
                failed=actual_playback(allow_error=True)
                check(failed['playing'] is False and failed['error']['code']==3,
                      'decoder error cannot masquerade as playing')
                video.evaluate("delete document.getElementById('film').error;true")

            finally:
                video.close()
            (output / 'tv-sizing.json').write_text(json.dumps(sizes, indent=2) + '\n')
            until(lambda: evaluate("!document.getElementById('mute').disabled"), 'mute enabled')
            evaluate("document.getElementById('mute').click();true")
            until(lambda: evaluate("document.getElementById('mute').textContent === 'Unmute'"), 'mute state')
            check(True, 'mute button changed actual mute state')
            until(lambda: evaluate("!document.getElementById('stop').disabled"), 'stop enabled')
            evaluate("document.getElementById('stop').click();true")
            until(lambda: evaluate("document.getElementById('status').textContent === 'Video stopped'"), 'stop state')
            check(ui.running(), 'Stop ended test video and preserved unrelated remote browser')
            until(lambda: evaluate("!document.getElementById('open').disabled"), 'reopen enabled')
            evaluate("document.getElementById('open').click();true")
            until(lambda: evaluate("document.getElementById('status').textContent.startsWith('Playing')"), 'second launch')
            check(True, 'second launch works with a fresh profile')
            motion('reopened playback clock and decoded frames advance', seconds=5)
            duration=actual_playback()['duration']
            def completed():
                state=actual_playback()
                return state['position'] >= duration-0.15 and not state['playing']
            until(completed, 'reopened clip plays through to the end', timeout=45)
            check(not actual_playback()['playing'], 'completed clip reports stopped playback')

            cdp = agent._PlayerCDP(ui.port)
            try:
                shot = cdp._call('Page.captureScreenshot', {'format': 'png'})
                import base64
                (output / 'isolated-remote.png').write_bytes(base64.b64decode(shot['data']))
            finally:
                cdp.close()
            # Use the checked-in native app's real API method bodies over a
            # loopback transport, including the legacy Services tile path.
            subprocess.run(['node', str(ROOT / 'scripts/player-app-contract-smoke.mjs'),
                            'http://127.0.0.1:%d' % port,
                            str(copied / 'state/test-token')], check=True, timeout=100)
            debug_ports = [int(p.read_text().splitlines()[0])
                           for p in (copied / 'state').glob('profile-*/DevToolsActivePort')]
            server.terminate()
            server.wait(timeout=30)
            for debug_port in debug_ports:
                with socket.socket() as probe:
                    probe.settimeout(1)
                    check(probe.connect_ex(('127.0.0.1', debug_port)) != 0,
                          'server shutdown closed owned browser debug listener')
            check(ui.running(), 'server shutdown preserved unrelated remote browser')
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
            if ui is not None:
                ui.stop()
            server.stdout.close()
            server.stderr.close()
    result_path.write_text(json.dumps({'checks': checks, 'not_verified': [
        'Flatpak on Linux', 'Steam/gamescope focus', 'TV audio', 'physical phone', 'Themes coexistence',
    ]}, indent=2) + '\n')
    print('Isolated package acceptance passed locally; no deployment performed.')


if __name__ == '__main__':
    main()
