import ast
import pathlib
import types
import unittest
from unittest.mock import patch, mock_open

source = pathlib.Path(__file__).resolve().parents[1].joinpath('agent/couchsided.py').read_text()
nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in ('_wake_iface', 'read_net')]
namespace = {'os': __import__('os')}
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'wake-network', 'exec'), namespace)

class WakeNetworkTests(unittest.TestCase):
    def choose(self, default, interfaces):
        namespace['_iface_wired'] = lambda n: interfaces[n]['wired']
        namespace['_iface_mac'] = lambda n: interfaces[n].get('mac', '02:00:00:00:00:01')
        namespace['_iface_wol_armed'] = lambda n: interfaces[n].get('armed')
        namespace['_default_iface'] = lambda: default
        def read(path):
            name = path.split('/')[-2]
            return mock_open(read_data=str(interfaces[name].get('carrier', 1)))()
        with patch('os.listdir', return_value=list(interfaces)), patch('os.path.exists', side_effect=lambda p: interfaces[p.split('/')[-2]].get('physical', True)), patch('builtins.open', side_effect=read):
            return namespace['read_net']()

    def test_wifi_route_uses_wired_wake(self):
        n = self.choose('wlan0', {'wlan0': {'wired':False}, 'eth0': {'wired':True}})
        self.assertEqual((n['iface'],n['route_iface'],n['wired']), ('eth0','wlan0',True))
    def test_virtual_and_disconnected_are_excluded(self):
        n = self.choose('wlan0', {'wlan0':{'wired':False},'br0':{'wired':True,'physical':False},'eth0':{'wired':True,'carrier':0}})
        self.assertEqual(n['iface'],'wlan0')
    def test_confirmed_wake_beats_default_unarmed(self):
        n = self.choose('eth0', {'eth0':{'wired':True,'armed':False},'eth1':{'wired':True,'armed':True}})
        self.assertEqual(n['iface'],'eth1')
        self.assertTrue(n['wol_armed'])
    def test_unknown_support_is_not_reported_enabled(self):
        n = self.choose('wlan0', {'wlan0':{'wired':False},'eth0':{'wired':True}})
        self.assertIsNone(n['wol_armed'])
    def test_no_interfaces(self):
        self.assertIsNone(self.choose(None,{})['mac'])

if __name__ == '__main__': unittest.main()
