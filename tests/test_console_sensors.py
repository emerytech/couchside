#!/usr/bin/env python3
"""Tests for the Console's CPU-frequency sensor (read_cpu_freq), the network
throughput sensor (read_net_rate), and their additive splice into GET /api/status.

Run: python3 tests/test_console_sensors.py

Drives the REAL agent functions against filesystem fixtures — the per-CPU sysfs
root and /proc/net/dev path are module constants (_CPUFREQ_DIR, _PROC_NET_DEV)
the tests repoint, so nothing is reimplemented.

The cpufreq tree here is SYNTHETIC, not a verbatim hardware capture: the repo has
no dumped /sys/devices/system/cpu tree, and CI has no handheld to read one from.
The VALUES are anchored to a real Legion Go S measurement recorded in
docs/ROADMAP.md (governor "powersave", scaling_cur_freq ~2160 MHz) — an
amd-pstate-epp handheld reports governor "powersave" permanently while the EPP
carries the real intent, which is exactly why read_cpu_freq surfaces both. The
shape is faithful to that; the file paths are the documented cpufreq ABI. Read
the values off a box before shipping any UI copy that quotes them (CLAUDE.md
§11.1: test the thing).

The /proc/net/dev fixture is likewise SYNTHETIC (both home boxes were offline
when this shipped, and CI has no Linux box to capture one from). The format is
the documented, stable kernel ABI — two header lines, then `iface: rx_bytes
rx_packets ... tx_bytes ...` with rx at column 0 and tx at column 8. The delta
math (bytes/elapsed) is exercised with an explicit clock, so it needs no real
values; capture a real /proc/net/dev off a box before trusting any absolute rate
in the wild (KI-085).
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


# --- network throughput (read_net_rate) ------------------------------------

# SYNTHETIC /proc/net/dev (see module docstring). lo carries traffic the reader
# MUST exclude; eth0 is the real interface; wlan0 is idle. Column 0 after the
# `iface:` is rx_bytes, column 8 is tx_bytes.
_NETDEV_HEADER = (
    "Inter-|   Receive                                                |  Transmit\n"
    " face |bytes    packets errs drop fifo frame compressed multicast|"
    "bytes    packets errs drop fifo colls carrier compressed\n"
)


def _netdev(eth_rx, eth_tx, lo_rx=100000, lo_tx=100000):
    # A body with lo (must be skipped), eth0 (the real one), wlan0 (idle).
    return _NETDEV_HEADER + (
        "    lo: %8d     500    0    0    0     0          0         0 "
        "%8d     500    0    0    0     0       0          0\n"
        "  eth0: %8d    2000    0    0    0     0          0         0 "
        "%8d    1500    0    0    0     0       0          0\n"
        "  wlan0:       0       0    0    0    0     0          0         0 "
        "      0       0    0    0    0     0       0          0\n"
    ) % (lo_rx, lo_tx, eth_rx, eth_tx)


class NetDev:
    """A fake /proc/net/dev the REAL read_net_rate reads, with the module's
    last-sample state reset so each test starts from a clean first-call."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="netdev-")
        self.path = os.path.join(self.dir, "net_dev")
        self._old_path = cs._PROC_NET_DEV
        cs._PROC_NET_DEV = self.path
        self._old_state = dict(cs._NET_RATE)
        cs._NET_RATE.update({"at": None, "rx": None, "tx": None})

    def write(self, text):
        with open(self.path, "w") as f:
            f.write(text)

    def close(self):
        cs._PROC_NET_DEV = self._old_path
        cs._NET_RATE.update(self._old_state)
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)


def test_net_rate_first_call_is_none():
    """No prior sample to diff -> (None, None), the omit path (not a fake 0)."""
    print("test_net_rate_first_call_is_none")
    n = NetDev()
    try:
        n.write(_netdev(1_000_000, 500_000))
        check("first call omitted", cs.read_net_rate(now=10.0), (None, None))
    finally:
        n.close()


def test_net_rate_delta():
    """Second sample: summed rx/tx delta over a known interval. lo advances too
    but is EXCLUDED (the control — counting it would inflate rx)."""
    print("test_net_rate_delta")
    n = NetDev()
    try:
        n.write(_netdev(1_000_000, 500_000, lo_rx=100000, lo_tx=100000))
        cs.read_net_rate(now=10.0)  # seed
        # eth0 +2,000,000 rx / +1,000,000 tx over 2.0s; lo also +9,000,000 (must
        # NOT count) -> rx 1,000,000 B/s, tx 500,000 B/s.
        n.write(_netdev(3_000_000, 1_500_000, lo_rx=9_100_000, lo_tx=9_100_000))
        check("rx_bps excludes lo", cs.read_net_rate(now=12.0), (1_000_000, 500_000))
    finally:
        n.close()


def test_net_rate_idle_reports_zero():
    """A genuinely idle link reports 0 (gated on is-not-None, not truthiness) —
    the CONTROL proving 0 is a real reading, not the unavailable sentinel."""
    print("test_net_rate_idle_reports_zero")
    n = NetDev()
    try:
        n.write(_netdev(1_000_000, 500_000))
        cs.read_net_rate(now=10.0)
        n.write(_netdev(1_000_000, 500_000))  # no change
        check("idle -> (0, 0), not (None, None)", cs.read_net_rate(now=12.0), (0, 0))
    finally:
        n.close()


def test_net_rate_counter_reset_omitted():
    """A counter that ran backwards (iface reset / wrap) -> (None, None), and the
    baseline is re-seeded rather than reported as a garbage negative spike."""
    print("test_net_rate_counter_reset_omitted")
    n = NetDev()
    try:
        n.write(_netdev(5_000_000, 5_000_000))
        cs.read_net_rate(now=10.0)
        n.write(_netdev(1_000, 1_000))  # reset
        check("reset omitted", cs.read_net_rate(now=12.0), (None, None))
        # baseline re-seeded to the reset values -> the NEXT interval computes fine.
        n.write(_netdev(1_000 + 400_000, 1_000 + 200_000))
        check("recovers after reset", cs.read_net_rate(now=14.0), (200_000, 100_000))
    finally:
        n.close()


def test_net_rate_unreadable_degrades_closed():
    """An unreadable /proc/net/dev -> (None, None), never raises."""
    print("test_net_rate_unreadable_degrades_closed")
    n = NetDev()
    try:
        cs._PROC_NET_DEV = os.path.join(n.dir, "does-not-exist")
        check("missing file omitted", cs.read_net_rate(now=10.0), (None, None))
    finally:
        n.close()


def test_net_rate_garbage_line_skipped():
    """A malformed data line is skipped, not parsed — eth0 still summed."""
    print("test_net_rate_garbage_line_skipped")
    n = NetDev()
    try:
        body = _NETDEV_HEADER + (
            "  eth0: 1000000    2000    0    0    0     0          0         0 "
            "500000    1500    0    0    0     0       0          0\n"
            "  junk-no-colon-or-columns\n"
        )
        n.write(body)
        cs.read_net_rate(now=10.0)
        body2 = _NETDEV_HEADER + (
            "  eth0: 1200000    2200    0    0    0     0          0         0 "
            "600000    1600    0    0    0     0       0          0\n"
            "  junk-no-colon-or-columns\n"
        )
        n.write(body2)
        check("garbage skipped, eth0 summed", cs.read_net_rate(now=12.0), (100_000, 50_000))
    finally:
        n.close()


def test_status_splices_net_rate_when_present(monkey=None):
    """real_status() carries net_rx_bps/net_tx_bps when the reader yields a rate,
    and OMITS them (like `cpu`) when it yields (None, None). Two-state check —
    the reader is stubbed so this doesn't depend on interval timing."""
    print("test_status_splices_net_rate")
    orig = cs.read_net_rate
    try:
        cs.read_net_rate = lambda now=None: (2_000_000, 400_000)
        st = cs.real_status()
        check("net_rx_bps present", st.get("net_rx_bps"), 2_000_000)
        check("net_tx_bps present", st.get("net_tx_bps"), 400_000)
        check("net (WoL block) untouched", "net" in st, True)
        cs.read_net_rate = lambda now=None: (None, None)
        st2 = cs.real_status()
        check("net_rx_bps omitted when unavailable", "net_rx_bps" in st2, False)
        check("net_tx_bps omitted when unavailable", "net_tx_bps" in st2, False)
    finally:
        cs.read_net_rate = orig


def test_mock_status_carries_net_rate():
    """--mock reports both fields so the harness can exercise the VITALS line."""
    print("test_mock_status_carries_net_rate")
    st = cs.mock_status()
    check("mock net_rx_bps present", isinstance(st.get("net_rx_bps"), int), True)
    check("mock net_tx_bps present", isinstance(st.get("net_tx_bps"), int), True)


if __name__ == "__main__":
    for fn in (test_full_handheld_reading,
               test_no_cpufreq_degrades_to_empty,
               test_optional_fields_omitted,
               test_garbage_cur_freq_omitted,
               test_status_splices_cpu_when_present,
               test_status_omits_cpu_when_absent,
               test_net_rate_first_call_is_none,
               test_net_rate_delta,
               test_net_rate_idle_reports_zero,
               test_net_rate_counter_reset_omitted,
               test_net_rate_unreadable_degrades_closed,
               test_net_rate_garbage_line_skipped,
               test_status_splices_net_rate_when_present,
               test_mock_status_carries_net_rate):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
