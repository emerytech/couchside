#!/usr/bin/env python3
"""OpenPuck device safety, protocol, auth and platform parity; synthetic USB fixtures.
Native USB IO still needs the physical Linux/Windows acceptance run.
"""
import ast
import http.client
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT/path)
    mod = importlib.util.module_from_spec(spec); sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

linux = load('op_linux', 'agent/couchsided.py')
windows = load('op_windows', 'agent/win/couchsided-win.py')


def test_shared_implementation():
    """Single-file deployment requires copies; guard against two implementations drifting."""
    def nodes(path):
        tree = ast.parse((ROOT/path).read_text())
        return {n.name: ast.dump(n, include_attributes=False) for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    a, b = nodes('agent/couchsided.py'), nodes('agent/win/couchsided-win.py')
    names = [n for n in a if n.startswith('_op_') or n in ('_OpUSB', '_OpHID', 'real_openpuck_flash') or n.startswith('_openpuck_') and n not in ('_openpuck_bootloader_mount', '_openpuck_state') or n in ('openpuck_latest', 'mock_openpuck_latest')]
    for n in names:
        assert a[n] == b[n], n


def test_status_and_pairing():
    for m in (linux, windows):
        p = bytearray(73); p[0] = 19; p[11] = 1; p[15:17] = (250).to_bytes(2, 'little')
        p[39:45] = b'0.9.40'; p[61:64] = bytes([1, 95, 47])
        info = m._op_status(p)
        assert info['build'] == '0.9.40' and info['new_reports'] == 250
        assert info['slots'][0] == {'slot': 1, 'connected': True, 'battery': 95, 'rssi': -47}
        try: m._op_status(b'bad')
        except ValueError: pass
        else: raise AssertionError('truncated status accepted')
        empty = lambda n: [{'slot': i, 'used': False, 'record': bytes(24)} for i in range(n)]
        pb, cb = empty(4), empty(2)
        plan = m._op_pair_plan('PUCK', 'CONTROLLER', pb, cb)
        assert plan['puck_record'][8:] == b'CONTROLLER'.ljust(16, b'\0')
        assert plan['puck_record'][:8] == plan['controller_record'][:8]
        # Existing unrelated pairing survives; use an empty second slot.
        cb[0] = {'slot': 0, 'used': True, 'record': b'12345678OTHER'.ljust(24, b'\0')}
        assert m._op_pair_plan('PUCK', 'CONTROLLER', pb, cb)['controller_slot'] == 1
        cb[1] = dict(cb[0], slot=1)
        try: m._op_pair_plan('PUCK', 'CONTROLLER', pb, cb)
        except ValueError: pass
        else: raise AssertionError('full controller pairing table accepted')
        cb[1] = {'slot': 1, 'used': True, 'record': b'ABCDEFGHPUCK'.ljust(24, b'\0')}
        assert m._op_pair_plan('PUCK', 'CONTROLLER', pb, cb)['controller_record'][:8] == b'ABCDEFGH'


def test_all_blocks_verified():
    m = linux
    n = 736
    data = b''.join(struct.pack('<8I', 0x0a324655, 0x9e5d5157, 0x2000, 0x26000+i*256,
                                 256, i, n, 0xada52840)+bytes(476)+struct.pack('<I', 0x0ab16f30) for i in range(n))
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder)/'firmware.uf2'; path.write_bytes(data)
        assert m._op_validate_firmware(str(path))
        for offset, value in ((512+28, 0), (512+12, 0), (512+20, 0), (512+24, n-1), (512+8, 0x2001), (512+508, 0)):
            broken = bytearray(data); struct.pack_into('<I', broken, offset, value); path.write_bytes(broken)
            assert not m._op_validate_firmware(str(path)), offset


def test_rejections_and_locks():
    for m in (linux, windows):
        with patch.object(m, '_op_usb_inventory', side_effect=AssertionError('USB touched for rejected request')):
            for op, body in [('wipe', {}), ('inspect', {'path': '/dev/usb'}), ('test', {'serial': '../bad'}), ('pair', {'confirmation': []})]:
                assert m._op_action(op, body)[0] == 400
            m._OP_LOCK.acquire()
            try:
                assert m._op_action('inspect', {})[0] == 409
                assert not m.real_openpuck_flash()['ok']
            finally: m._OP_LOCK.release()
        assert m._op_action('pair', {'confirmation': 'X'*32})[1]['ok'] is False
        m._OP_PAIR_PLANS['E'*32] = {'expires': -1}
        with patch.object(m, '_op_usb_inventory', side_effect=AssertionError('expired plan touched USB')):
            assert not m._op_action('pair', {'confirmation': 'E'*32})[1]['ok']


def test_diagnostics_no_false_pass():
    m = linux
    p = bytearray(73); p[0] = 19
    class USB:
        def __init__(self, item): pass
        def request(self, command): return bytes(p)
        def close(self): pass
    with patch.object(m, '_op_one_puck', return_value={}), patch.object(m, '_OpUSB', USB), patch.object(m.time, 'sleep'):
        r = m._op_check('PUCK')
        assert r['usb_ok'] and not r['wireless_ok'] and r['active_samples'] == 0
        p[61] = 1; p[15] = 250
        assert m._op_check('PUCK')['wireless_ok']
        with patch.object(USB, 'request', side_effect=OSError('unplugged')):
            code, r = m._op_action('test', {'serial': 'PUCK'})
            assert code == 200 and not r['ok'] and 'usb_ok' not in r


def test_http_auth():
    for m in (linux, windows):
        class Handler(m.Handler):
            token = 'test-openpuck-token'
            mock = True
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def req(op, body, token=None):
                c = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                headers = {'Content-Type': 'application/json'}
                if token: headers['Authorization'] = 'Bearer '+token
                c.request('POST', '/api/utilities/openpuck/device/'+op, json.dumps(body), headers)
                r = c.getresponse(); status = r.status; data = json.loads(r.read()); c.close()
                return status, data
            with patch.object(m, '_op_usb_inventory', side_effect=AssertionError('mock touched USB')):
                for token in (None, 'wrong'):
                    assert req('inspect', {}, token)[0] == 401
                assert req('inspect', {}, Handler.token)[1]['serial'] == 'TESTPUCK'
                assert req('inspect', {'path': 'bad'}, Handler.token)[0] == 400
                assert req('wipe', {}, Handler.token)[0] == 400
                assert req('prepare_pair', {'serial': 'TESTPUCK'}, Handler.token)[1]['confirmation']
        finally:
            server.shutdown(); server.server_close()


def test_pair_commit_and_partial_failure():
    for m in (linux, windows):
        with tempfile.TemporaryDirectory() as folder:
            state = {'puck': bytes([1, 0])+bytes(96), 'controller': [bytes(24), bytes(24)],
                     'wireless': b'\x00', 'writes': [], 'fail': False}
            class USB:
                def __init__(self, item): pass
                def request(self, command, marker=0xa5): return state['puck']
                def transfer(self, raw):
                    state['writes'].append(bytes(raw))
                    if raw[0] == 0x0d:
                        p = bytearray(state['puck']); slot = raw[1]; p[1] |= 1 << slot
                        p[2+24*slot:26+24*slot] = raw[3:]; state['puck'] = bytes(p)
                def close(self): pass
            class HID:
                def __init__(self, item): pass
                def command(self, op, data=b'', read=False):
                    if op == 0xae: return b'\x01CONTROLLER\0'
                    key = data.split(b'\0', 1)[0]
                    if op == 0xed:
                        if key == b'user/wireless_transport': return state['wireless']
                        return state['controller'][1 if key == b'esb/bond_2' else 0]
                    if op == 0xee:
                        if state['fail']: raise OSError('controller unplugged during write')
                        value = data[len(key)+1:]
                        if key == b'user/wireless_transport': state['wireless'] = value
                        else: state['controller'][1 if key == b'esb/bond_2' else 0] = value
                    return b''
                def close(self): pass
            with patch.object(m, '_OpUSB', USB), patch.object(m, '_OpHID', HID), \
                    patch.object(m, '_op_usb_inventory', return_value=[{'pid': 0x1304, 'serial': 'PUCK'}, {'pid': 0x1301, 'serial': 'CONTROLLER'}]), \
                    patch.object(m, '_openpuck_cache_path', return_value=str(Path(folder)/'firmware.uf2')):
                _, prepared = m._op_action('prepare_pair', {'serial': 'PUCK'})
                assert prepared['ok'] and state['writes'] == []
                token = prepared['confirmation']
                _, result = m._op_action('pair', {'confirmation': token})
                assert result['ok'], result
                assert state['writes'][-1] == bytes([0x0e, 0xff])
                assert state['controller'][0][8:] == b'PUCK'.ljust(16, b'\0')
                assert not any(state['controller'][1])
                assert m._op_action('pair', {'confirmation': token})[1]['ok'] is False
                backups = list((Path(folder)/'pairing-backups').glob('*.json'))
                assert len(backups) == 1
                assert backups[0].stat().st_mode & 0o777 == 0o600
                assert not {'puck_record', 'controller_record', 'before_puck', 'before_controller'} & (set(result) | set(prepared))
                # A change after preview is refused before any mutation.
                _, prepared = m._op_action('prepare_pair', {'serial': 'PUCK'})
                state['controller'][1] = b'12345678OTHER'.ljust(24, b'\0')
                writes = len(state['writes'])
                assert not m._op_action('pair', {'confirmation': prepared['confirmation']})[1]['ok']
                assert len(state['writes']) == writes
                # Mid-pair loss leaves an explicit incomplete result and a backup.
                _, prepared = m._op_action('prepare_pair', {'serial': 'PUCK'})
                state['fail'] = True
                _, result = m._op_action('pair', {'confirmation': prepared['confirmation']})
                assert not result['ok'] and 'incomplete' in result['error']
                assert len(list((Path(folder)/'pairing-backups').glob('*.json'))) == 2
                assert state['writes'][-1][0] == 0x0d  # no commit after failed controller write


if __name__ == '__main__':
    for fn in (test_shared_implementation, test_status_and_pairing, test_all_blocks_verified,
               test_rejections_and_locks, test_diagnostics_no_false_pass, test_pair_commit_and_partial_failure, test_http_auth):
        fn(); print('PASS', fn.__name__)
