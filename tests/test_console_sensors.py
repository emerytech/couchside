#!/usr/bin/env python3
"""Tests for the Console's CPU-frequency sensor (read_cpu_freq) and its additive
splice into GET /api/status.

Run: python3 tests/test_console_sensors.py

Drives the REAL agent function against a filesystem fixture — the per-CPU sysfs
root is a module constant (_CPUFREQ_DIR) the test repoints, so nothing is
reimplemented.

The cpufreq tree here is SYNTHETIC, not a verbatim hardware capture: the repo has
no dumped /sys/devices/system/cpu tree, and CI has no handheld to read one from.
The VALUES are anchored to a real Legion Go S measurement recorded in
docs/ROADMAP.md (governor "powersave", scaling_cur_freq ~2160 MHz) — an
amd-pstate-epp handheld reports governor "powersave" permanently while the EPP
carries the real intent, which is exactly why read_cpu_freq surfaces both. The
shape is faithful to that; the file paths are the documented cpufreq ABI. Read
the values off a box before shipping any UI copy that quotes them (CLAUDE.md
§11.1: test the thing).
"""
import importlib.util
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


class CpuTree:
    """A fake /sys/devices/system/cpu the REAL read_cpu_freq walks."""

    def __init__(self, cpus, decoys=()):
        # cpus: {"cpu0": {"scaling_governor": "powersave", ...}, ...}
        self.dir = tempfile.mkdtemp(prefix="cpufreq-")
        for name, files in cpus.items():
            for fname, val in files.items():
                _write(os.path.join(self.dir, name, "cpufreq", fname), val + "\n")
        # Real sysfs also holds non-cpuN entries (cpufreq/, cpuidle/, kernel_max);
        # re.fullmatch(cpu\d+) must skip them.
        for name in decoys:
            os.makedirs(os.path.join(self.dir, name), exist_ok=True)
        self._old = cs._CPUFREQ_DIR
        cs._CPUFREQ_DIR = self.dir

    def close(self):
        cs._CPUFREQ_DIR = self._old
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)


def test_full_handheld_reading():
    """governor from cpu0; cur_mhz is the PEAK across cores (cpu3 busier than
    cpu0); max + epp when present."""
    print("test_full_handheld_reading")
    t = CpuTree(
        {
            "cpu0": {"scaling_governor": "powersave",
                     "scaling_cur_freq": "2000000",
                     "scaling_max_freq": "4900000",
                     "energy_performance_preference": "balance_performance"},
            "cpu3": {"scaling_cur_freq": "2160000"},
        },
        decoys=("cpufreq", "cpuidle", "kernel_max"),
    )
    try:
        got = cs.read_cpu_freq()
        check("governor", got.get("governor"), "powersave")
        check("cur_mhz is the peak core (2160, not cpu0's 2000)", got.get("cur_mhz"), 2160)
        check("max_mhz", got.get("max_mhz"), 4900)
        check("epp verbatim", got.get("epp"), "balance_performance")
    finally:
        t.close()


def test_no_cpufreq_degrades_to_empty():
    """A box with no cpufreq (a VM) -> {} , never a fabricated governor."""
    print("test_no_cpufreq_degrades_to_empty")
    t = CpuTree({})  # cpu0/cpufreq/scaling_governor absent
    try:
        check("empty dict", cs.read_cpu_freq(), {})
    finally:
        t.close()


def test_optional_fields_omitted():
    """governor present but the rest missing/garbage -> only governor, and no
    cur_mhz for a non-positive reading (rejected, not reported as 0)."""
    print("test_optional_fields_omitted")
    t = CpuTree({"cpu0": {"scaling_governor": "schedutil",
                          "scaling_cur_freq": "0"}})
    try:
        got = cs.read_cpu_freq()
        check("governor kept", got.get("governor"), "schedutil")
        check("cur_mhz omitted for 0", "cur_mhz" in got, False)
        check("max_mhz omitted when absent", "max_mhz" in got, False)
        check("epp omitted when absent", "epp" in got, False)
    finally:
        t.close()


def test_garbage_cur_freq_omitted():
    """A non-integer scaling_cur_freq is dropped, not cleaned."""
    print("test_garbage_cur_freq_omitted")
    t = CpuTree({"cpu0": {"scaling_governor": "performance",
                          "scaling_cur_freq": "notanumber"}})
    try:
        got = cs.read_cpu_freq()
        check("governor still read", got.get("governor"), "performance")
        check("cur_mhz omitted for garbage", "cur_mhz" in got, False)
    finally:
        t.close()


def test_status_splices_cpu_when_present():
    """real_status() carries the `cpu` block when the box has cpufreq..."""
    print("test_status_splices_cpu_when_present")
    t = CpuTree({"cpu0": {"scaling_governor": "powersave",
                          "scaling_cur_freq": "2100000"}})
    try:
        st = cs.real_status()
        check("cpu key present", "cpu" in st, True)
        check("cpu.governor", st.get("cpu", {}).get("governor"), "powersave")
    finally:
        t.close()


def test_status_omits_cpu_when_absent():
    """...and OMITS it entirely on a box with no cpufreq (additive-and-omitted,
    like `battery` — never a null block)."""
    print("test_status_omits_cpu_when_absent")
    t = CpuTree({})
    try:
        check("cpu key omitted", "cpu" in cs.real_status(), False)
    finally:
        t.close()


if __name__ == "__main__":
    for fn in (test_full_handheld_reading,
               test_no_cpufreq_degrades_to_empty,
               test_optional_fields_omitted,
               test_garbage_cur_freq_omitted,
               test_status_splices_cpu_when_present,
               test_status_omits_cpu_when_absent):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
