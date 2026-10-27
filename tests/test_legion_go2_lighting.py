"""Legion Go 2 kernel ABI fixtures; not a claim of physical-device validation."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('couchsided', Path(__file__).parents[1] / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


class LegionGo2Tests(unittest.TestCase):
    def setUp(self):
        self.attrs = {'brightness': '50', 'max_brightness': '100',
                      'multi_index': 'blue red green', 'multi_intensity': '0 100 0',
                      'multi_max_intensity': '100 100 100', 'profile': '1',
                      'mode': 'custom', 'mode_index': 'custom', 'enabled': 'true',
                      'enabled_index': 'false true', 'effect': 'monocolor',
                      'effect_index': 'monocolor chroma rainbow', 'speed': '66'}
        self.writes = []
        def write(name, attr, value):
            self.writes.append((attr, value))
            self.attrs[attr] = value
        for name, replacement in [('_led_read_attr', lambda name, attr: self.attrs.get(attr)),
                                  ('_led_access_w', lambda name, attr: attr in self.attrs),
                                  ('_led_write', write), ('_list_led_names', lambda: [cs._GO2_NAME]),
                                  ('_led_realpath_ok', lambda name: True),
                                  ('_led_clear_trigger', lambda name: None),
                                  ('_led_state_save', lambda: None)]:
            mock = patch.object(cs, name, replacement); mock.start(); self.addCleanup(mock.stop)

    def test_probe_is_read_only_and_filters_effects(self):
        raw = cs._read_led_raw(cs._GO2_NAME)
        self.assertTrue(raw['writable'])
        public = cs._led_public(raw)
        self.assertEqual(public['effects'], ['solid', 'off', 'rainbow', 'circle'])
        self.assertEqual(public['ring_control'], 'linked')
        self.assertFalse(public['shape'])
        self.assertEqual(self.writes, [])

    def test_spin_uses_native_rainbow_and_speed(self):
        raw = cs._read_led_raw(cs._GO2_NAME)
        result = cs._apply_gated_effect(cs._GO2_NAME, raw, 'circle',
            {'brightness': 30, 'speed': 42, 'color': None})
        self.assertTrue(result['ok'])
        self.assertIn(('effect', 'rainbow'), self.writes)
        self.assertIn(('speed', '42'), self.writes)
        self.assertEqual(self.writes[0], ('profile', '3'))
        self.assertEqual(self.writes[-1], ('enabled', 'true'))

    def test_spin_hidden_if_firmware_does_not_support_it(self):
        self.attrs['effect_index'] = 'monocolor breathe chroma'
        raw = cs._read_led_raw(cs._GO2_NAME)
        self.assertNotIn('circle', cs._go2_effects(raw))
        result = cs._apply_gated_effect(cs._GO2_NAME, raw, 'circle',
            {'brightness': 30, 'speed': 42, 'color': None})
        self.assertFalse(result['ok'])
        self.assertEqual(self.writes, [])

    def test_profile_first_enable_last_and_channel_scaling(self):
        result = cs.set_led(cs._GO2_NAME, 25, {'r': 255, 'g': 0, 'b': 128})
        self.assertTrue(result['ok'])
        self.assertEqual(self.writes[0], ('profile', '3'))
        self.assertEqual(self.writes[-1], ('enabled', 'true'))
        self.assertIn(('multi_intensity', '50 100 0'), self.writes)
        self.assertIn(('brightness', '25'), self.writes)

    def test_go2_byte_channels_are_independent_of_percent_brightness(self):
        del self.attrs['multi_max_intensity']
        self.attrs['multi_index'] = 'red green blue'
        self.attrs['multi_intensity'] = '1 90 255'
        raw = cs._read_led_raw(cs._GO2_NAME)
        self.assertEqual(raw['color'], {'r': 1, 'g': 90, 'b': 255})
        cs.set_led(cs._GO2_NAME, 30, {'r': 0, 'g': 255, 'b': 128})
        self.assertIn(('multi_intensity', '0 255 128'), self.writes)
        self.assertIn(('brightness', '30'), self.writes)

    def test_incomplete_driver_does_not_write(self):
        del self.attrs['profile']
        self.assertIsNone(cs.set_led(cs._GO2_NAME, 50, None))
        self.assertEqual(self.writes, [])

    def test_unknown_mode_does_not_write(self):
        self.attrs['mode_index'] = 'dynamic'
        self.assertIsNone(cs.set_led(cs._GO2_NAME, 50, None))
        self.assertEqual(self.writes, [])

    def test_enable_failure_is_not_reported_as_success(self):
        with patch.object(cs, '_led_write', side_effect=PermissionError('denied')):
            self.assertFalse(cs.set_led(cs._GO2_NAME, 50, None)['ok'])

    def test_no_fake_strobe_fallback(self):
        raw = cs._read_led_raw(cs._GO2_NAME)
        result = cs._apply_gated_effect(cs._GO2_NAME, raw, 'strobe',
                                      {'brightness': 50, 'speed': 50, 'color': None})
        self.assertEqual(result['status'], 400)
        self.assertEqual(self.writes, [])

    def test_native_rainbow_uses_chroma_and_speed(self):
        raw = cs._read_led_raw(cs._GO2_NAME)
        result = cs._apply_gated_effect(cs._GO2_NAME, raw, 'rainbow',
                                      {'brightness': 50, 'speed': 33, 'color': None})
        self.assertTrue(result['ok'])
        self.assertEqual(self.writes[0], ('profile', '3'))
        self.assertIn(('effect', 'chroma'), self.writes)
        self.assertIn(('speed', '33'), self.writes)
        self.assertEqual(self.writes[-1], ('enabled', 'true'))

    def test_steam_machine_has_no_go2_restrictions(self):
        raw = cs._read_led_raw('valve-leds[0]')
        self.assertNotIn('effects', cs._led_public(raw))
        self.assertFalse(cs._go2_ready('valve-leds[0]'))


if __name__ == '__main__':
    unittest.main()
