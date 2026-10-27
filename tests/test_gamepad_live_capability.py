"""Controller availability must recover without restarting the agent.
No uinput devices are opened or created by these tests.
"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import ExitStack

spec = importlib.util.spec_from_file_location('cs', Path(__file__).resolve().parents[1] / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

class LiveCapability(unittest.TestCase):
    def test_status_tracks_access_loss_and_recovery_without_mutating_boot_caps(self):
        defaults = {'read_os_release': {}, 'read_load': [0,0,0], 'read_cpu_temp_c': None,
            'read_mem': {}, 'read_box_battery': None, 'read_cpu_freq': None,
            'read_net_rate': (None,None), 'display_info': None, 'audio_info': None,
            '_record_history': None, 'read_uptime_s': 1, 'read_disks': [],
            'net_info_cached': {}, 'desktop_available': False, 'medialaunch_available': False,
            'live_screenstream_caps': {}, 'install_health': {}, '_history_snapshot': []}
        with ExitStack() as stack:
            for name, value in defaults.items():
                stack.enter_context(patch.object(cs,name,return_value=value))
            stack.enter_context(patch.object(cs,'CAPS',{'gamepad':False,'steam':True}))
            access=stack.enter_context(patch.object(cs.os,'access',side_effect=[False,True,False,True]))
            observed=[cs.real_status()['caps'] for _ in range(4)]
        self.assertEqual([c['gamepad'] for c in observed],[False,True,False,True])
        self.assertTrue(all(c['steam'] for c in observed))
        self.assertEqual(access.call_count,4)
        access.assert_called_with('/dev/uinput',cs.os.W_OK)

    def test_probe_failure_stays_unavailable(self):
        with patch.object(cs.os,'access',side_effect=OSError('device unavailable')):
            self.assertFalse(cs._uinput_writable())

if __name__ == '__main__': unittest.main()
