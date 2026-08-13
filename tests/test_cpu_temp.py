#!/usr/bin/env python3
"""CPU temperature sensor selection (read_cpu_temp_c).

Run: python3 tests/test_cpu_temp.py

Regression for issue #449: on an AMD 7800X3D board (Gigabyte x870i Pro Ice) the
reported CPU temp was stuck at 16.8C and never moved. Root cause: the reader only
recognized Intel's `coretemp`, and on AMD (no coretemp) it fell through to "the
first hwmon with temp1_input" — which latched a static board/NVMe sensor. AMD Zen
exposes the real CPU temp via `k10temp` (Tctl at temp1_input), so a recognized CPU
driver must win over the generic fallback.

Fixtures build a faithful /sys/class/hwmon + /sys/class/thermal tree. The k10temp
layout (name=k10temp, temp1_input in millidegrees, temp1_label=Tctl) matches real
Zen hardware; the decoy value/name reproduces the #449 shape (a low, static board
sensor sorted BEFORE the CPU driver, so the fallback would latch it).

Every test carries a control — an input whose answer is known — and the #449 case
asserts BOTH that the CPU value is returned AND that the decoy 16.8 is not.

Pure stdlib, no pytest.
"""
import importlib.util
import os
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _mk(root, kind, index, files):
    """Create <root>/<kind><index>/ with the given {filename: contents}."""
    d = os.path.join(root, "%s%d" % (kind, index))
    os.makedirs(d, exist_ok=True)
    for fn, val in files.items():
        with open(os.path.join(d, fn), "w") as f:
            f.write(str(val))
    return d


def _hwmon(root, index, name, temp1_input=None, label=None):
    files = {"name": name}
    if temp1_input is not None:
        files["temp1_input"] = temp1_input
    if label is not None:
        files["temp1_label"] = label
    return _mk(root, "hwmon", index, files)


def _zone(root, index, ztype, temp):
    return _mk(root, "thermal_zone", index, {"type": ztype, "temp": temp})


def _roots():
    base = tempfile.mkdtemp(prefix="cputemp_")
    h = os.path.join(base, "hwmon")
    t = os.path.join(base, "thermal")
    os.makedirs(h)
    os.makedirs(t)
    return h, t


def test_amd_k10temp_wins_over_board_sensor():
    """THE #449 control: a decoy board sensor (hwmon0, static 16.8C) sorts before
    k10temp (hwmon3, 52.0C). The CPU driver must win by NAME, not by scan order."""
    h, t = _roots()
    _hwmon(h, 0, "nvme", temp1_input=16800)          # decoy, latches fallback first
    _hwmon(h, 1, "iwlwifi_1", temp1_input=44000)     # another non-CPU sensor
    _hwmon(h, 3, "k10temp", temp1_input=52000, label="Tctl")
    got = cs.read_cpu_temp_c(hwmon_root=h, thermal_root=t)
    check(got == 52.0, "AMD: k10temp (52.0) wins over first-hwmon decoy", got)
    check(got != 16.8, "AMD: the static 16.8 board sensor is NOT reported", got)


def test_zenpower_recognized():
    h, t = _roots()
    _hwmon(h, 0, "nct6798", temp1_input=16800)        # Super-I/O decoy
    _hwmon(h, 2, "zenpower", temp1_input=61500)
    got = cs.read_cpu_temp_c(hwmon_root=h, thermal_root=t)
    check(got == 61.5, "AMD: zenpower recognized as a CPU driver", got)


def test_intel_coretemp_still_works():
    h, t = _roots()
    _hwmon(h, 0, "acpitz", temp1_input=27000)         # decoy first
    _hwmon(h, 1, "coretemp", temp1_input=45000)
    got = cs.read_cpu_temp_c(hwmon_root=h, thermal_root=t)
    check(got == 45.0, "Intel: coretemp still selected (no regression)", got)


def test_cpu_thermal_zone_beats_random_hwmon():
    """No recognized CPU hwmon driver: a CPU-typed thermal zone must be preferred
    over a random board hwmon sensor."""
    h, t = _roots()
    _hwmon(h, 0, "nvme", temp1_input=39000)           # only a board sensor in hwmon
    _zone(t, 0, "acpitz", 30000)                      # non-CPU zone, ignored
    _zone(t, 1, "x86_pkg_temp", 58000)                # the CPU package zone
    got = cs.read_cpu_temp_c(hwmon_root=h, thermal_root=t)
    check(got == 58.0, "x86_pkg_temp zone beats a random hwmon sensor", got)


def test_fallback_to_board_sensor_when_nothing_better():
    """No CPU driver and no CPU zone: still return SOMETHING (degrade, not None) so
    a box we can't classify keeps a reading rather than a blank."""
    h, t = _roots()
    _hwmon(h, 0, "nvme", temp1_input=38000)
    _zone(t, 0, "acpitz", 31000)                      # not CPU-typed
    got = cs.read_cpu_temp_c(hwmon_root=h, thermal_root=t)
    check(got == 38.0, "fallback: last-resort hwmon temp1_input still reported", got)


def test_none_when_no_sensors():
    h, t = _roots()
    got = cs.read_cpu_temp_c(hwmon_root=h, thermal_root=t)
    check(got is None, "no sensors at all -> None (degrade closed)", got)


if __name__ == "__main__":
    test_amd_k10temp_wins_over_board_sensor()
    test_zenpower_recognized()
    test_intel_coretemp_still_works()
    test_cpu_thermal_zone_beats_random_hwmon()
    test_fallback_to_board_sensor_when_nothing_better()
    test_none_when_no_sensors()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all CPU-temp tests passed")
