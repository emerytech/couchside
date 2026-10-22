"""Ring scene timing, persistence and ownership regression checks."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('cs', Path(__file__).parents[1] / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)

class RingProgramTests(unittest.TestCase):
    def program(self):
        return {'scene': 'aurora', 'period': 20, 'brightness': 50,
                'night': {'enabled': True, 'start': 1320, 'end': 420, 'brightness': 10}}

    def test_night_crosses_midnight_and_restores_at_end(self):
        p = self.program()
        for minute in [1320, 1439, 0, 419]:
            self.assertEqual(cs._ring_frame(p, 0, minute)[1], 10)
        for minute in [420, 1000, 1319]:
            self.assertEqual(cs._ring_frame(p, 0, minute)[1], 50)

    def test_daytime_window_and_never_brightens(self):
        p = self.program(); p['night'].update(start=600, end=900, brightness=90)
        self.assertEqual(cs._ring_frame(p, 0, 700)[1], 50)
        p['night']['brightness'] = 0
        self.assertEqual(cs._ring_frame(p, 0, 700)[1], 0)
        self.assertEqual(cs._ring_frame(p, 0, 900)[1], 50)

    def test_palette_loops_smoothly_and_stays_in_bounds(self):
        for scene in cs._RING_SCENES:
            p = self.program(); p['scene'] = scene
            self.assertEqual(cs._ring_frame(p, 0, 800), cs._ring_frame(p, 20, 800))
            for tick in range(100):
                color, _ = cs._ring_frame(p, tick * .2, 800)
                self.assertTrue(all(0 <= v <= 255 for v in color.values()))

    def test_rejects_bad_persisted_or_network_values(self):
        for key, value in [('period', True), ('period', 0), ('brightness', 101), ('scene', '../bad')]:
            p = self.program(); p[key] = value
            with self.assertRaises(ValueError): cs._ring_validate(p)
        p = self.program(); p['night']['end'] = p['night']['start']
        with self.assertRaises(ValueError): cs._ring_validate(p)

    def test_save_is_readable_and_cancel_persists(self):
        with tempfile.TemporaryDirectory() as d, patch.object(cs, '_RING_FILE', d + '/program.json'):
            cs._ring_save(self.program())
            import json
            self.assertEqual(json.loads(Path(d + '/program.json').read_text()), self.program())
            cs._ring_save(None)
            self.assertIsNone(json.loads(Path(d + '/program.json').read_text()))

    def test_manual_takes_ownership_before_write(self):
        events=[]
        @cs._ring_manual
        def manual(name): events.append(('write', cs._RING_PROGRAM))
        with patch.object(cs, '_RING_PROGRAM', self.program()), patch.object(cs, '_ring_save', side_effect=lambda p: events.append(('save', p))):
            manual(cs._GO2_NAME)
        self.assertEqual(events, [('save', None), ('write', None)])

    def test_other_hardware_does_not_cancel_ring_scene(self):
        @cs._ring_manual
        def manual(name): return True
        with patch.object(cs, '_RING_PROGRAM', self.program()), patch.object(cs, '_ring_save') as save:
            manual('valve-leds:0'); save.assert_not_called()
            self.assertIsNotNone(cs._RING_PROGRAM)

    def test_worker_restores_brightness_after_driver_reset(self):
        p = self.program(); p['night']['enabled'] = False
        attrs = {'profile': '3', 'mode': 'custom', 'effect': 'monocolor',
                 'enabled': 'true', 'brightness': '50'}
        writes = []
        ticks = [0]
        def wait(_):
            ticks[0] += 1
            if ticks[0] == 2: attrs['brightness'] = '0'
            return ticks[0] > 3
        def write(name, attr, value):
            writes.append((attr, value)); attrs[attr] = value
        class Event:
            pass
        event = Event(); event.wait = wait
        raw = {'writable': True, 'max_brightness': 100, 'enable_on': 'true'}
        with patch.object(cs, '_RING_PROGRAM', p), patch.object(cs, '_FX_STOP', event), \
             patch.object(cs.time, 'monotonic', side_effect=[0, 6, 6, 12, 12, 18, 18]), \
             patch.object(cs, '_read_led_raw', return_value=raw), \
             patch.object(cs, '_led_read_attr', side_effect=lambda n, a: attrs.get(a)), \
             patch.object(cs, '_led_write', side_effect=write), \
             patch.object(cs, '_led_write_color', side_effect=lambda *args: writes.append(('color', 'frame'))), patch.object(cs, '_go2_prepare'):
            cs._ring_loop()
        self.assertEqual(writes.count(('brightness', '50')), 2)
        self.assertEqual(attrs['brightness'], '50')
        self.assertLess(writes.index(('brightness', '50')), writes.index(('enabled', 'true')))
        self.assertLess(writes.index(('color', 'frame')), writes.index(('enabled', 'true')))

    def test_failed_worker_cannot_erase_retry_worker(self):
        original, replacement = object(), object()
        class Lock:
            exits = 0
            def __enter__(self): return self
            def __exit__(self, *_):
                self.exits += 1
                if self.exits == 1:
                    # Simulate Apply acquiring the released lock before cleanup.
                    assert cs._RING_THREAD is None
                    cs._RING_THREAD = replacement
        class Event:
            def wait(self, _): return False
        with patch.object(cs, '_RING_PROGRAM', self.program()), \
             patch.object(cs, '_RING_THREAD', original), \
             patch.object(cs, '_RING_LOCK', Lock()), patch.object(cs, '_FX_STOP', Event()), \
             patch.object(cs.threading, 'current_thread', return_value=original), \
             patch.object(cs, '_read_led_raw', side_effect=OSError('unplugged')):
            cs._ring_loop()
            self.assertIs(cs._RING_THREAD, replacement)

    def test_restore_revalidates_saved_config(self):
        with tempfile.TemporaryDirectory() as d, patch.object(cs, '_RING_FILE', d + '/program.json'):
            cs._ring_save(self.program())
            with patch.object(cs, '_ring_apply') as apply:
                cs._ring_restore(); apply.assert_called_once_with(self.program())

if __name__ == '__main__': unittest.main()
