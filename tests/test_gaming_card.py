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


# --- Steam Input phantom accounting ------------------------------------------
# Every block below is verbatim off a live Bazzite box (2026-07-19). A 2025
# Steam Controller NEVER presents a gamepad node: it pairs through the Puck
# dongle, which publishes only lizard-mode mouse/keyboard nodes, and Steam
# republishes the pad itself phys-less under 28de:11ff. list_real_pads cannot
# see that by design (our own uinput pad is phys-less too), so the card counts
# phantoms and subtracts the pads it already knows about.


def _phantom(n):
    """One Steam Input phantom. KEY word 0 bit 60 is BTN_MODE — real bits, so
    _declares_key does actual work here rather than being fixture theatre."""
    return ('I: Bus=0003 Vendor=28de Product=11ff Version=0001\n'
            'N: Name="Microsoft X-Box 360 pad %d"\n'
            'P: Phys=\n'
            'S: Sysfs=/devices/virtual/input/input%d\n'
            'U: Uniq=\n'
            'H: Handlers=event%d js%d\n'
            'B: PROP=0\n'
            'B: EV=20000b\n'
            'B: KEY=7cdb000000000000 0 0 0 0\n'
            'B: ABS=3003f\n'
            'B: FF=10000 0\n' % (n, 331 + n, 15 + n, n))


STEAM_PUCK = """\
I: Bus=0003 Vendor=28de Product=1304 Version=0111
N: Name="Valve Software Steam Controller Puck Mouse"
P: Phys=usb-0000:00:14.0-2/input2
U: Uniq=FXB99616032A7
H: Handlers=mouse0 event4
B: PROP=0
B: EV=17
B: KEY=30000 0 0 0 0
"""


def _ctrls_for(blocks, own=0):
    """_gaming_controllers() over a fixtured /proc + a fixtured count of pads
    the agent itself has open. Empty power_supply = the mains-desktop case."""
    proc = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    proc.write("\n".join(blocks))
    proc.close()
    o_proc, o_ps, o_sess = (cs._PROC_INPUT_DEVICES, cs._POWER_SUPPLY_DIR,
                            cs.GAMEPAD_SESSIONS)
    cs._PROC_INPUT_DEVICES = proc.name
    cs._POWER_SUPPLY_DIR = tempfile.mkdtemp()
    # A waiter sits in GAMEPAD_SESSIONS with device None and must NOT count.
    cs.GAMEPAD_SESSIONS = ([{"device": object()} for _ in range(own)]
                           + [{"device": None}])
    try:
        return cs._gaming_controllers()
    finally:
        cs._PROC_INPUT_DEVICES, cs._POWER_SUPPLY_DIR = o_proc, o_ps
        cs.GAMEPAD_SESSIONS = o_sess
        os.unlink(proc.name)


def test_steam_input_phantoms():
    print("Steam Input phantom accounting")

    c = _ctrls_for([STEAM_PUCK, _phantom(0)])
    check(len(c) == 1, "Steam Controller (phantom only) is listed at all")
    check(c and c[0]["name"] == "Steam Controller",
          "named from the Puck dongle, not the phantom's Xbox name")
    check(c and "battery_pct" not in c[0],
          "no battery invented for it (publishes no power_supply node)")

    # THE REGRESSION THIS EXISTS FOR: Steam wraps the agent's own pad too, so a
    # connected phone must not read as a second controller.
    c = _ctrls_for([STEAM_PUCK, _phantom(0), _phantom(1)], own=1)
    check(len(c) == 1, "phone's own pad subtracted — still ONE controller")

    c = _ctrls_for([STEAM_PUCK, _phantom(0)], own=1)
    check(len(c) == 0, "phone connected, no real controller -> none listed")

    # A real pad Steam has wrapped: seen twice, counted once, named honestly.
    c = _ctrls_for([XBOX_PAD, _phantom(0)])
    check(len(c) == 1, "real pad + its own phantom counted once")
    check(c and c[0]["name"] == "Xbox Wireless Controller",
          "real pad keeps its real name")

    c = _ctrls_for([STEAM_PUCK, XBOX_PAD, _phantom(0), _phantom(1)])
    check(len(c) == 2, "real pad + Steam Controller = two")
    check(sorted(x["name"] for x in c)
          == ["Steam Controller", "Xbox Wireless Controller"],
          "one named row each")
    check(len(set(x["uniq"] for x in c)) == 2,
          "uniqs distinct (the app keys its list on uniq)")

    c = _ctrls_for([XBOX_PAD])
    check(len(c) == 1, "Steam not running (no phantoms) -> real pad still shown")

    c = _ctrls_for([_phantom(0)])
    check(c and c[0]["name"] == "Controller",
          "no Puck -> generic name, not a guessed Steam Controller")

    c = _ctrls_for([STEAM_PUCK])
    check(len(c) == 0, "Puck present but controller off -> nothing listed")


def test_own_pad_count():
    print("own-pad count")
    o_sess = cs.GAMEPAD_SESSIONS
    try:
        cs.GAMEPAD_SESSIONS = []
        check(cs._own_pad_count() == 0, "no sessions -> 0")
        cs.GAMEPAD_SESSIONS = [{"device": None}, {"device": None}]
        check(cs._own_pad_count() == 0, "waiters hold no device -> 0")
        cs.GAMEPAD_SESSIONS = [{"device": object()}, {"device": None}]
        check(cs._own_pad_count() == 1, "only the holder's pad counts")
    finally:
        cs.GAMEPAD_SESSIONS = o_sess


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
    test_steam_input_phantoms()
    test_own_pad_count()
    test_active_output()
    test_payload_omits_absent_fields()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all gaming-card tests passed")
