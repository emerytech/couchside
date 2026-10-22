#!/usr/bin/env python3
"""Temporary, opt-in Player-only server. Never invokes the Couchside main()."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hmac
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import signal
import socket
import subprocess
import threading
import time

HERE = Path(__file__).resolve().parent
VIDEO_ID = 'couchside:bbb-trailer'
SEEK = (-10, 10)
SAMPLE_SERVICE = 'sample'
TEST_VERSION = '2.9.77-player-test'
# Steam exists on the target; its cap keeps Launch/Watch reachable on older
# phones. No Steam commands are exposed. All other machine features are off.
TEST_CAPS = dict.fromkeys(('gamepad', 'steam', 'media', 'tv', 'screen',
    'power_schedule', 'screensaver', 'couchmode', 'bigpicture', 'desktop',
    'steamlink', 'steammenus', 'boxbattery', 'gaming', 'streamhost', 'launchers',
    'file_upload', 'session_default', 'display_info', 'player', 'steaminstall',
    'utilities', 'screenstream', 'audioswitch', 'ledcontrol', 'openrgb',
    'wlclipboard', 'medialaunch', 'usbwake'), False)
TEST_CAPS.update(steam=True, launchers=True, player=True)
OPS = frozenset(('play', 'pause', 'playpause', 'mute', 'seek', 'close', 'catalog-open', 'open'))


def load_agent():
    packaged = HERE / 'couchsided.py'
    source = packaged if packaged.is_file() else HERE.parents[1] / 'agent/couchsided.py'
    spec = importlib.util.spec_from_file_location('isolated_player_agent', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_state(path):
    if path.is_symlink():
        raise RuntimeError('test state must not be a symlink')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid():
        raise RuntimeError('test state is not owned by this user')
    path.chmod(0o700)
    return path.resolve()


class Browser:
    """Own one fresh browser launch; never stop a process discovered by name."""
    def __init__(self, state, source, headless=False):
        self.state, self.source, self.headless = state, source, headless
        self.proc = None
        self.instance = None
        self.port = None
        self.log = None
        self.flatpak = None
        self.exit_logged = False

    def event(self, event, **fields):
        # Fixed diagnostic fields only: never tokens, request data or URLs.
        if self.log is not None:
            self.log.write((json.dumps({'event': event, **fields}) + '\n').encode())
            self.log.flush()

    def running(self):
        if self.proc is None:
            return False
        code = self.proc.poll()
        if code is not None and not self.exit_logged:
            self.event('browser_exit', returncode=code)
            self.exit_logged = True
        return code is None

    def start(self):
        if self.running():
            return
        self.stop()
        # Fresh per-launch profile prevents cookie reuse and stale debug ports.
        profile = self.state / ('profile-' + secrets.token_hex(8))
        profile.mkdir(mode=0o700)
        args = ['--user-data-dir=' + str(profile), '--no-first-run',
                '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
                '--remote-debugging-port=0', '--autoplay-policy=no-user-gesture-required',
                '--disable-accelerated-video-decode',
                '--start-fullscreen', '--app=' + self.source]
        if self.headless:
            args.append('--headless=new')
        self.flatpak = shutil.which('flatpak')
        use_flatpak = False
        if self.flatpak and not self.headless:
            use_flatpak = subprocess.run([self.flatpak, 'info', 'com.google.Chrome'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        timeout=10).returncode == 0
        native = next((p for p in (
            shutil.which('google-chrome-stable'), shutil.which('google-chrome'),
            shutil.which('chromium'), shutil.which('chromium-browser'),
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ) if p and Path(p).is_file()), None)
        self.log = (self.state / 'browser.log').open('ab')
        self.exit_logged = False
        self.event('launch', backend='flatpak' if use_flatpak else 'native',
                   owner_thread=threading.current_thread().name, video_decode='software')
        env = dict(os.environ)
        env.pop('LD_LIBRARY_PATH', None)
        env.pop('LD_PRELOAD', None)
        try:
            if use_flatpak:
                read_fd, write_fd = os.pipe()
                try:
                    # The grant lasts for this launch and exposes only its own
                    # profile, never the token or the rest of the test folder.
                    self.proc = subprocess.Popen([
                        self.flatpak, 'run', '--die-with-parent',
                        '--instance-id-fd=' + str(write_fd),
                        '--filesystem=' + str(profile), 'com.google.Chrome', *args,
                    ], pass_fds=(write_fd,), env=env, stdout=self.log, stderr=self.log)
                    os.close(write_fd)
                    write_fd = None
                    chunks = b''
                    deadline = time.monotonic() + 10
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not select.select([read_fd], [], [], remaining)[0]:
                            raise RuntimeError('Flatpak did not provide an instance ID')
                        part = os.read(read_fd, 128)
                        chunks += part
                        if len(chunks) > 34:
                            raise RuntimeError('Flatpak instance ID too long')
                        if not part or chunks.endswith(b'\n'):
                            break
                    value = chunks.strip().decode('ascii')
                    if not value or len(value) > 32 or any(c not in '0123456789' for c in value):
                        raise RuntimeError('Flatpak instance ID refused')
                    self.instance = value
                finally:
                    os.close(read_fd)
                    if write_fd is not None:
                        os.close(write_fd)
            elif native:
                self.proc = subprocess.Popen([native, *args], env=env,
                                             stdout=self.log, stderr=self.log)
            else:
                raise RuntimeError('Installed Chrome/Chromium is required; nothing was installed')
            active = profile / 'DevToolsActivePort'
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if not self.running():
                    raise RuntimeError('Test browser exited before becoming ready')
                if active.is_file():
                    port = int(active.read_text().splitlines()[0])
                    if 0 < port < 65536:
                        self.port = port
                        self.event('debug_port_ready', port=port)
                        return
                time.sleep(0.1)
            raise RuntimeError('Test browser debugging port did not become ready')
        except Exception:
            self.stop()
            raise

    def stop(self):
        if self.running():
            self.event('stop_requested', instance=self.instance)
            if self.instance is not None:
                # ID comes exclusively from this Popen's inherited pipe.
                try:
                    subprocess.run([self.flatpak, 'kill', self.instance], timeout=10,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except (OSError, subprocess.SubprocessError):
                    pass  # --die-with-parent still confines termination to this launch.
            if self.running():
                self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self.port = None
        self.instance = None
        if self.log is not None:
            self.log.close()
            self.log = None


class Player:
    def __init__(self, state, headless=False):
        self.agent = load_agent()
        self.agent.PL_MOCK = False
        self.media_source = self.agent._PLAYER_CATALOG_STREAMS[VIDEO_ID]['url']
        self.browser = Browser(state, '', headless)
        # Only these runtime references are redirected. No full agent startup,
        # config/token loading, pairing, discovery, uinput, LEDs or TLS workers.
        self.agent.PLAYER_CONF = str(state / 'unused-player.conf')
        self.agent._pl_cdp_port = lambda: self.browser.port
        self.agent._pl_running = self.browser.running
        self.lock = threading.Lock()
        # Linux parent-death signals follow the creating THREAD, not merely
        # the containing process. A request thread exits after its response.
        # Own all browser launches/stops on one worker that outlives requests.
        self.owner = ThreadPoolExecutor(max_workers=1, thread_name_prefix='player-browser-owner')
        self.closed = False
        self.last_open = 0.0
        self.started = time.monotonic()
        self.token = secrets.token_urlsafe(32)
        token_path = state / 'test-token'
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(self.token + '\n')

    def bind_surface(self, port):
        # Always loopback and server-chosen. The remote cannot choose a URL.
        self.browser.source = 'http://127.0.0.1:%d/tv' % port

    def info(self):
        with self.lock:
            running = self.browser.running()
            return {'available': True, 'service': SAMPLE_SERVICE if running else '',
                    'path': '', 'services': [SAMPLE_SERVICE], 'service_urls': {},
                    'seek_secs': list(SEEK), 'searchable': [], 'open_url': False,
                    'nav_ops': [], 'key_ops': [],
                    'catalog': self.agent.player_catalog(), 'running': running,
                    'playback': self.agent.player_playback() if running else None,
                    'catalog_video': self.agent.player_catalog()['metas'][0] if running else None}

    def status(self):
        # Compatibility envelope, deliberately NOT machine monitoring. No
        # production config, token, service, network or Themes settings are read.
        return {'hostname': 'Couchside Player Test', 'time': time.time(),
                'uptime_s': time.monotonic() - self.started,
                'agent_version': TEST_VERSION, 'caps': TEST_CAPS.copy(),
                'scope': 'isolated-player-test', 'telemetry_available': False,
                'load': [0, 0, 0], 'cpu_temp_c': None,
                'mem': {'total_mb': 0, 'used_mb': 0, 'available_mb': 0},
                'disks': []}

    def command(self, req):
        if not isinstance(req, dict) or not isinstance(req.get('op'), str):
            return 400, {'error': 'JSON operation required'}
        op = req['op']
        if op not in OPS:
            return 404, {'error': 'operation not allowed'}
        expected = ({'op', 'video_id'} if op == 'catalog-open' else
                    {'op', 'service'} if op == 'open' else
                    {'op', 'secs'} if op == 'seek' else {'op'})
        if set(req) != expected:
            return 400, {'error': 'unexpected or missing fields'}
        if op == 'catalog-open' and req['video_id'] != VIDEO_ID:
            return 404, {'error': 'video not allowed'}
        if op == 'open' and req['service'] != SAMPLE_SERVICE:
            return 404, {'error': 'service not allowed'}
        if op == 'seek' and (type(req['secs']) is not int or req['secs'] not in SEEK):
            return 404, {'error': 'seek not allowed'}
        with self.lock:
            if self.closed:
                return 409, {'error': 'test session is closing'}
            try:
                if op in ('catalog-open', 'open'):
                    now = time.monotonic()
                    if now - self.last_open < 2:
                        return 429, {'error': 'wait before reopening'}
                    self.last_open = now
                    self.owner.submit(self.browser.start).result()
                    return 200, {'ok': True}
                if op == 'close':
                    self.owner.submit(self.browser.stop).result()
                    return 200, {'ok': True}
                if not self.browser.running():
                    return 409, {'error': 'test browser is not running'}
                return 200, self.agent.player_transport(op, secs=req.get('secs'))
            except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
                return 409, {'error': 'test browser unavailable; inspect private browser.log'}


    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                self.owner.submit(self.browser.stop).result()
            finally:
                # Stop the sandbox before releasing its parent thread.
                self.owner.shutdown(wait=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def get_request(self):
        conn, addr = super().get_request()
        conn.settimeout(10)
        return conn, addr


class Handler(BaseHTTPRequestHandler):
    server_version = 'CouchsidePlayerTest'

    def log_message(self, *_args):
        pass  # No request URLs, headers or credentials in logs.

    def reply(self, status, data, content_type='application/json'):
        body = json.dumps(data).encode() if content_type == 'application/json' else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src https://media.w3.org; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def authorize(self):
        supplied = self.headers.get('Authorization', '')
        if not hmac.compare_digest(supplied.encode(), ('Bearer ' + self.server.player.token).encode()):
            self.reply(401, {'error': 'test token required'})
            return False
        return True

    def do_GET(self):
        if self.path == '/api/ping':
            # Existing phones recognize the agent family; no credential, LAN
            # address, production hostname or TLS identity is disclosed here.
            self.reply(200, {'ok': True, 'app': 'couchside-agent',
                             'version': TEST_VERSION, 'scope': 'isolated-player-test'})
        elif self.path == '/api/status':
            if self.authorize():
                self.reply(200, self.server.player.status())
        elif self.path == '/api/launchers':
            if self.authorize():
                self.reply(200, {'launchers': [], 'create_enabled': False})
        elif self.path == '/':
            self.reply(200, (HERE / 'remote.html').read_bytes(), 'text/html; charset=utf-8')
        elif self.path == '/tv':
            # This page contains only the fixed sample, never the test token.
            # Restrict it to the local browser and refuse DNS-rebound hosts.
            allowed_hosts = {'127.0.0.1:%d' % self.server.server_port,
                             'localhost:%d' % self.server.server_port}
            if self.client_address[0] not in ('127.0.0.1', '::1') or self.headers.get('Host') not in allowed_hosts:
                self.reply(404, {'error': 'not found'})
                return
            page = (HERE / 'tv.html').read_text().replace(
                '__SAMPLE_URL__', html.escape(self.server.player.media_source, quote=True))
            self.reply(200, page.encode(), 'text/html; charset=utf-8')
        elif self.path == '/api/player':
            if self.authorize():
                self.reply(200, self.server.player.info())
        else:
            self.reply(404, {'error': 'not found'})

    def do_POST(self):
        self.close_connection = True
        if self.path != '/api/player':
            self.reply(404, {'error': 'not found'})
            return
        if not self.authorize():
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024 or self.headers.get('Transfer-Encoding'):
                raise ValueError
            req = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError, socket.timeout):
            self.reply(400, {'error': 'small JSON body required'})
            return
        status, data = self.server.player.command(req)
        self.reply(status, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1', choices=('127.0.0.1', '0.0.0.0'))
    parser.add_argument('--port', type=int, default=8791)
    parser.add_argument('--headless', action='store_true', help='local browser checks only')
    args = parser.parse_args()
    if args.port != 8791 and not (args.headless and args.port == 0):
        parser.error('test port is 8791; headless local checks may use port 0')
    os.umask(0o077)
    state = private_state(HERE / 'state')
    # Lock is local to this package; never inspect or signal an existing PID.
    import fcntl
    with (state / 'run.lock').open('a') as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('This test package is already running')
        player = Player(state, args.headless)
        server = Server((args.host, args.port), Handler)
        server.player = player
        player.bind_surface(server.server_port)
        stopping = threading.Event()

        def stop(_signum, _frame):
            if not stopping.is_set():
                stopping.set()
                threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print('Player test listening on port %d. Private token: state/test-token' % server.server_port, flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
            player.close()


if __name__ == '__main__':
    main()
