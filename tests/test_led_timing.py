"""Monotonic sequence deadlines and real strobe, without hardware writes."""
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('cs', Path(__file__).parents[1] / 'agent/couchsided.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

class TimingTests(unittest.TestCase):
    def test_short_frame_boundaries(self):
        seq = {'effect': 'sequence', 'frames': [[None]] * 3, 'holds': [30, 80, 1000], 't0': 100, 'loop': True}
        self.assertAlmostEqual(cs._seq_next_delay(seq, 100.02), .01)
        self.assertAlmostEqual(cs._seq_next_delay(seq, 100.10), .01)
        self.assertAlmostEqual(cs._seq_next_delay(seq, 101.12), .02)
        self.assertLessEqual(cs._seq_next_delay(seq, 100.5), cs._SEQ_TICK)
    def test_once_does_not_wrap(self):
        seq = {'effect': 'sequence', 'frames': [[None]], 'holds': [30], 't0': 100, 'loop': False}
        self.assertEqual(cs._seq_next_delay(seq, 101), cs._SEQ_TICK)
    def test_strobe_is_on_off_not_breath(self):
        color = {'r': 30, 'g': 40, 'b': 50}
        seq = {'effect': 'strobe', 'members': ['a', 'b'], 'speed': 100, 'color': color, 't0': 100}
        self.assertEqual(cs._seq_compute_frame(seq, 100), [color, color])
        self.assertEqual(cs._seq_compute_frame(seq, 100.26), [None, None])
        self.assertEqual(cs._seq_compute_frame(seq, 100.51), [color, color])
    def test_paint_cost_is_deducted(self):
        seq = {'effect': 'sequence', 'frames': [[None]], 'holds': [30], 't0': 0}
        old = cs._SEQ_ACTIVE, cs._seq_render, cs._FX_STOP, cs.time.monotonic
        class Stop:
            done = False
            delay = None
            def is_set(self): return self.done
            def wait(self, value): self.delay = value; self.done = True
        stop = Stop()
        times = iter([0., 0., .012])
        try:
            cs._SEQ_ACTIVE = {'test': seq}
            cs._seq_render = lambda *_: None
            cs._FX_STOP = stop
            cs.time.monotonic = lambda: next(times)
            cs._seq_loop()
            self.assertAlmostEqual(stop.delay, .018)
        finally:
            cs._SEQ_ACTIVE, cs._seq_render, cs._FX_STOP, cs.time.monotonic = old

if __name__ == '__main__': unittest.main()
