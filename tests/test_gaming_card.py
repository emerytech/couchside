#!/usr/bin/env python3
"""Tests for the gaming card (GET /api/gaming) building blocks.

Run: python3 tests/test_gaming_card.py

Drives the REAL agent functions against filesystem/string fixtures — the sysfs
roots are module constants (_DRM_DIR, _POWER_SUPPLY_DIR) and the pad list reads
_PROC_INPUT_DEVICES, all of which the tests repoint, so nothing is
reimplemented. Covers the traps the plan flagged as live:
  * the card* glob (a connector dir cardN-DP-1 must NOT be read as a GPU),
  * the reaper AppId matcher incl. the [oom_reaper]/no-steamapps rejects,
  * the empty-power_supply desktop case + the uniq (never phys) battery join,
  * per-field probe-and-appear (Intel i915 -> no gpu block, card still renders).
Pure stdlib, no pytest — same style as the other agent tests.
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


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


# --- reaper AppId matcher (pure) ---------------------------------------------

def test_appid_from_cmdline():
    print("reaper AppId matcher")
    real = "\x00".join([
        "/home/deck/.steam/steam/ubuntu12_32/reaper", "SteamLaunch",
        "AppId=1091500", "--",
        "/home/deck/.steam/steam/steamapps/common/Cyberpunk 2077/bin/x64/game.exe",
    ])
    check(cs._appid_from_cmdline(real) == "1091500", "real reaper form -> appid")
    # kernel thread the ps-based scan false-positives on; cmdline is bracketed.
    check(cs._appid_from_cmdline("[oom_reaper]") is None, "[oom_reaper] rejected")
    check(cs._appid_from_cmdline("") is None, "empty cmdline -> None")
    # AppId present but no reaper wrapper / no steamapps path -> not a launch.
    check(cs._appid_from_cmdline("steam\x00-applaunch\x00AppId=440") is None,
          "AppId without the reaper wrapper -> None")
    no_steamapps = "\x00".join(["/usr/bin/reaper", "AppId=440", "--", "/usr/bin/thing"])
    check(cs._appid_from_cmdline(no_steamapps) is None,
          "reaper without a steamapps path -> None")


# --- GPU sensors (the card* glob trap) ---------------------------------------

def test_gpu_sensors():
    print("GPU sensors + card* glob trap")
    d = tempfile.mkdtemp()
    orig = cs._DRM_DIR
    cs._DRM_DIR = d
    try:
        # A real amdgpu card...
        dev = os.path.join(d, "card1", "device")
        _write(os.path.join(dev, "hwmon", "hwmon5", "name"), "amdgpu\n")
        _write(os.path.join(dev, "hwmon", "hwmon5", "temp1_input"), "61000\n")
        _write(os.path.join(dev, "mem_info_vram_total"), str(8 * 1024**3) + "\n")
        _write(os.path.join(dev, "mem_info_vram_used"), str(3300 * 1024**2) + "\n")
        # ...and a CONNECTOR dir that also matches a bare card* glob and also has
        # a `device` with bogus VRAM. re.fullmatch(card\d+) must skip it.
        cdev = os.path.join(d, "card1-DP-1", "device")
        _write(os.path.join(cdev, "mem_info_vram_total"), "999999999999999\n")
        _write(os.path.join(d, "renderD128", "noise"), "x")  # unrelated node

        gpu = cs._gpu_sensors()
        check(gpu.get("name") == "amdgpu", "reads the amdgpu card")
        check(gpu.get("temp_c") == 61.0, "temp from the matched hwmon (not hwmonN)")
        check(gpu.get("vram_total_mb") == 8192, "vram_total in MB from card1, NOT the connector")
        check(gpu.get("vram_used_mb") == 3300, "vram_used in MB")

        # Intel i915: a device hwmon that is not amdgpu -> no GPU block at all.
        d2 = tempfile.mkdtemp()
        cs._DRM_DIR = d2
        _write(os.path.join(d2, "card0", "device", "hwmon", "hwmon1", "name"), "i915\n")
        check(cs._gpu_sensors() == {}, "Intel i915 -> {} (no GPU block, not CPU temp)")
    finally:
        cs._DRM_DIR = orig


def test_vram_sanity():
    print("VRAM magnitude sanity gate")
    d = tempfile.mkdtemp()
    orig = cs._DRM_DIR
    cs._DRM_DIR = d
    try:
        dev = os.path.join(d, "card1", "device")
        _write(os.path.join(dev, "hwmon", "hwmon0", "name"), "amdgpu\n")
        # A total under ~64 MB is almost certainly not bytes -> drop VRAM, keep
        # the (present) name so the block still renders what it can.
        _write(os.path.join(dev, "mem_info_vram_total"), "4096\n")
        gpu = cs._gpu_sensors()
        check("vram_total_mb" not in gpu, "implausibly small VRAM total dropped")
        check(gpu.get("name") == "amdgpu", "GPU still reported (name present)")
    finally:
        cs._DRM_DIR = orig


# --- controller battery join (uniq, never phys) ------------------------------

XBOX_PAD = """\
I: Bus=0005 Vendor=045e Product=0b13 Version=0513
N: Name="Xbox Wireless Controller"
P: Phys=ac:f2:3c:8b:64:fe
S: Sysfs=/devices/virtual/misc/uhid/0005:045E:0B13.0009/input/input39
U: Uniq=44:16:22:1f:74:5d
H: Handlers=sysrq kbd event20 js2
B: PROP=0
B: EV=120013
B: KEY=7fff000000000000 1000000000000 8000000000 e080ffdf01cfffff fffffffffffffffe
"""


def test_controllers_and_battery():
    print("controller battery join")
    proc = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    proc.write(XBOX_PAD)
    proc.close()
    ps = tempfile.mkdtemp()
    # Battery supply named with the pad's MAC (uppercase, no colons — the join is
    # separator- and case-insensitive; keeping the fixture colon-free stays
    # portable across the CI/dev filesystems).
    supply = os.path.join(ps, "hid-4416221F745D-battery")
    _write(os.path.join(supply, "capacity"), "62\n")
    _write(os.path.join(supply, "status"), "Discharging\n")

    o_proc, o_ps = cs._PROC_INPUT_DEVICES, cs._POWER_SUPPLY_DIR
    cs._PROC_INPUT_DEVICES = proc.name
    cs._POWER_SUPPLY_DIR = ps
    try:
        ctrls = cs._gaming_controllers()
        check(len(ctrls) == 1, "the one real pad is listed")
        c = ctrls[0] if ctrls else {}
        check(c.get("uniq") == "44:16:22:1f:74:5d", "keyed on uniq, not phys")
        check(c.get("battery_pct") == 62, "battery percent joined by uniq")
        check(c.get("battery_status") == "Discharging", "battery status joined")

        # Empty power_supply (mains desktop, no pad battery) is NOT an error.
        cs._POWER_SUPPLY_DIR = tempfile.mkdtemp()
        check(cs._pad_battery("44:16:22:1f:74:5d") == {}, "empty power_supply -> {} (no error)")
        again = cs._gaming_controllers()
        check(len(again) == 1 and "battery_pct" not in again[0],
              "pad still listed with no battery fields")
    finally:
        cs._PROC_INPUT_DEVICES, cs._POWER_SUPPLY_DIR = o_proc, o_ps
        os.unlink(proc.name)


# --- active output pick ------------------------------------------------------

def test_active_output():
    print("active output pick")
    orig = cs._connected_outputs
    try:
        cs._connected_outputs = lambda: [
            {"name": "eDP-1", "internal": True},
            {"name": "DP-1", "internal": False},
        ]
        check(cs._active_output() == {"name": "DP-1", "internal": False},
              "external preferred over internal")
        cs._connected_outputs = lambda: [{"name": "eDP-1", "internal": True}]
        check(cs._active_output() == {"name": "eDP-1", "internal": True},
              "internal-only box reports its panel")
        cs._connected_outputs = lambda: []
        check(cs._active_output() is None, "headless -> None (field omitted)")
    finally:
        cs._connected_outputs = orig


# --- payload shape: per-field optional ---------------------------------------

def test_payload_omits_absent_fields():
    print("payload per-field probe-and-appear")
    o_gpu, o_game, o_out, o_ctrl, o_sess = (
        cs._gpu_sensors, cs._running_game, cs._active_output,
        cs._gaming_controllers, cs._couchmode_session)
    cs._GAMING_CACHE["val"] = None
    try:
        # An idle Intel box in desktop: no gpu, no game, no pad — but a session.
        cs._gpu_sensors = lambda: {}
        cs._running_game = lambda: None
        cs._active_output = lambda: {"name": "DP-1", "internal": False}
        cs._gaming_controllers = lambda: []
        cs._couchmode_session = lambda: "desktop"
        p = cs._gaming_payload()
        check("gpu" not in p, "no gpu key when GPU absent (no blank block)")
        check("game" not in p, "no game key when nothing running")
        check("controllers" not in p, "no controllers key when no pad")
        check(p.get("output") == {"name": "DP-1", "internal": False}, "output present")
        check(p.get("session") == "desktop", "session always present")
    finally:
        (cs._gpu_sensors, cs._running_game, cs._active_output,
         cs._gaming_controllers, cs._couchmode_session) = (
            o_gpu, o_game, o_out, o_ctrl, o_sess)
        cs._GAMING_CACHE["val"] = None


if __name__ == "__main__":
    test_appid_from_cmdline()
    test_gpu_sensors()
    test_vram_sanity()
    test_controllers_and_battery()
    test_active_output()
    test_payload_omits_absent_fields()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all gaming-card tests passed")
