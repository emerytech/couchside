#!/usr/bin/env python3
"""Tests for the box's OWN battery (read_box_battery).

Run: python3 tests/test_box_battery.py

WHY THIS EXISTS: a handheld running Couchside showed no battery anywhere,
because the agent only ever read a CONTROLLER's battery (_pad_battery, joined by
MAC). The machine's own pack was never read at all.

Every fixture below is copied VERBATIM from real hardware -- a Lenovo Legion Go
S running Bazzite, 2026-07-22 -- because two things in the real file are not
what documentation would lead you to write:

  * POWER_SUPPLY_TYPE appears TWICE in BAT0's uevent. A parser that assumed one
    occurrence per key would pass here by luck rather than by design, so the
    duplicate is kept in the fixture and asserted.
  * The gauge is ENERGY-based (ENERGY_NOW / POWER_NOW, microwatt-hours and
    microwatts). Plenty of hardware is CHARGE-based instead (CHARGE_NOW /
    CURRENT_NOW). Both are exercised.

The mains-desktop case matters just as much: a machine with no battery must
report "unavailable" (an empty dict), never a fabricated 0%.
"""
import importlib.util
import os
import shutil
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


# VERBATIM off the Legion Go S. Note the repeated POWER_SUPPLY_TYPE line.
BAT0 = """DEVTYPE=power_supply
POWER_SUPPLY_NAME=BAT0
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_CHARGE_TYPES=Fast
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_TECHNOLOGY=Li-poly
POWER_SUPPLY_CYCLE_COUNT=53
POWER_SUPPLY_VOLTAGE_MIN_DESIGN=11700000
POWER_SUPPLY_VOLTAGE_NOW=11705000
POWER_SUPPLY_POWER_NOW=22543000
POWER_SUPPLY_ENERGY_FULL_DESIGN=55500000
POWER_SUPPLY_ENERGY_FULL=55500000
POWER_SUPPLY_ENERGY_NOW=32350000
POWER_SUPPLY_CAPACITY=58
POWER_SUPPLY_CAPACITY_LEVEL=Normal
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_MODEL_NAME=L24M3PK8
POWER_SUPPLY_MANUFACTURER=SMP
POWER_SUPPLY_SERIAL_NUMBER=2399
"""

ACAD_OFFLINE = """DEVTYPE=power_supply
POWER_SUPPLY_NAME=ACAD
POWER_SUPPLY_TYPE=Mains
POWER_SUPPLY_ONLINE=0
POWER_SUPPLY_TYPE=Mains
"""

ACAD_ONLINE = ACAD_OFFLINE.replace("ONLINE=0", "ONLINE=1")

# Also verbatim from the same box: USB-C PD ports show up as power supplies too
# and must not be mistaken for either a battery or mains.
USBC = """DEVTYPE=power_supply
POWER_SUPPLY_NAME=ucsi-source-psy-USBC000:001
POWER_SUPPLY_TYPE=USB
POWER_SUPPLY_ONLINE=0
"""

# A wireless PERIPHERAL -- gamepad / mouse / headset -- ALSO shows up here as
# TYPE=Battery. The kernel's HID battery driver marks it POWER_SUPPLY_SCOPE=Device,
# which is the field that separates it from the machine's own pack. This is the
# case a DESKTOP tester hit (TestFlight 2026-07-23): a non-laptop PC with a paired
# controller at 15% reported "On battery 15%" for the box itself.
#
# Representative of the hid-input battery format (the discriminating line is
# POWER_SUPPLY_SCOPE=Device); the NAME leads with a digit on purpose, so it sorts
# BEFORE "BAT0" -- proving the SCOPE filter, not sort-order luck, is what keeps a
# handheld reading its own pack when a controller is paired.
HID_CONTROLLER = """DEVTYPE=power_supply
POWER_SUPPLY_NAME=0005:054C:0CE6.0009-battery
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_SCOPE=Device
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_CAPACITY=15
POWER_SUPPLY_CAPACITY_LEVEL=Normal
POWER_SUPPLY_MODEL_NAME=Wireless Controller
"""


class Supplies:
    """A fake /sys/class/power_supply the REAL reader walks."""

    def __init__(self, nodes):
        self.dir = tempfile.mkdtemp(prefix="psy-")
        for name, uevent in nodes.items():
            d = os.path.join(self.dir, name)
            os.makedirs(d)
            with open(os.path.join(d, "uevent"), "w") as f:
                f.write(uevent)
        self._old = cs._POWER_SUPPLY_DIR
        cs._POWER_SUPPLY_DIR = self.dir

    def close(self):
        cs._POWER_SUPPLY_DIR = self._old
        shutil.rmtree(self.dir, ignore_errors=True)


def test_real_handheld():
    """The exact hardware that prompted this."""
    print("test_real_handheld")
    s = Supplies({"BAT0": BAT0, "ACAD": ACAD_OFFLINE, "ucsi-source-psy-USBC000:001": USBC})
    try:
        got = cs.read_box_battery()
        check("percent", got.get("pct"), 58)
        check("status", got.get("status"), "Discharging")
        check("not on AC", got.get("on_ac"), False)
        # 32350000 uWh / 22543000 uW = 1.4350h -> 86 minutes
        check("minutes remaining", got.get("minutes"), 86)
        check("cap is available", cs.box_battery_available(), True)
    finally:
        s.close()


def test_watts_from_power_now():
    """Instantaneous draw. VERBATIM off the Legion Go S: POWER_SUPPLY_POWER_NOW
    7708000 uW -> 7.7 W."""
    print("test_watts_from_power_now")
    s = Supplies({"BAT0": BAT0.replace("POWER_SUPPLY_POWER_NOW=22543000",
                                       "POWER_SUPPLY_POWER_NOW=7708000")})
    try:
        check("watts", cs.read_box_battery().get("watts"), 7.7)
    finally:
        s.close()


def test_watts_from_current_times_voltage():
    """Gauges without POWER_NOW still report amps and volts."""
    print("test_watts_from_current_times_voltage")
    s = Supplies({"BAT1": """POWER_SUPPLY_NAME=BAT1
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_CAPACITY=50
POWER_SUPPLY_CURRENT_NOW=1000000
POWER_SUPPLY_VOLTAGE_NOW=12000000
"""})
    try:
        check("1A x 12V = 12.0 W", cs.read_box_battery().get("watts"), 12.0)
    finally:
        s.close()


def test_zero_draw_is_omitted_not_reported():
    """A gauge reading 0 is not measuring; it is not a box using no power.
    Reporting a confident 0.0 W would be a lie."""
    print("test_zero_draw_is_omitted_not_reported")
    s = Supplies({"BAT0": BAT0.replace("POWER_SUPPLY_POWER_NOW=22543000",
                                       "POWER_SUPPLY_POWER_NOW=0")})
    try:
        check("no watts key", "watts" in cs.read_box_battery(), False)
    finally:
        s.close()


def test_profile_reported_verbatim_even_when_not_a_listed_choice():
    """THE hardware trap. The Legion Go S reported "custom" while
    platform_profile_choices listed "low-power balanced performance" -- Steam's
    TDP control had set something outside the advertised set. A reader that
    validated against the choices would show nothing on that exact box."""
    print("test_profile_reported_verbatim_even_when_not_a_listed_choice")
    import tempfile
    d = tempfile.mkdtemp(prefix="pp-")
    path = os.path.join(d, "platform_profile")
    old = cs._PLATFORM_PROFILE
    cs._PLATFORM_PROFILE = path
    try:
        for written, want in (("custom", "custom"),
                              ("balanced\n", "balanced"),
                              ("low-power", "low-power")):
            with open(path, "w") as f:
                f.write(written)
            check("%r -> %r" % (written, want), cs.read_power_profile(), want)
    finally:
        cs._PLATFORM_PROFILE = old
        shutil.rmtree(d, ignore_errors=True)


def test_missing_platform_profile_is_none():
    """Desktops and older kernels have no such file."""
    print("test_missing_platform_profile_is_none")
    old = cs._PLATFORM_PROFILE
    cs._PLATFORM_PROFILE = "/nonexistent/acpi/platform_profile"
    try:
        check("None", cs.read_power_profile(), None)
    finally:
        cs._PLATFORM_PROFILE = old


def test_duplicate_type_key():
    """THE fixture trap: POWER_SUPPLY_TYPE really is repeated on this hardware."""
    print("test_duplicate_type_key")
    check("fixture still has the duplicate",
          BAT0.count("POWER_SUPPLY_TYPE=Battery"), 2)
    s = Supplies({"BAT0": BAT0})
    try:
        check("parsed anyway", cs.read_box_battery().get("pct"), 58)
    finally:
        s.close()


def test_mains_desktop_degrades_closed():
    """No battery must be UNAVAILABLE, never a fabricated 0%."""
    print("test_mains_desktop_degrades_closed")
    s = Supplies({"ACAD": ACAD_ONLINE})
    try:
        check("empty, not zero", cs.read_box_battery(), {})
        check("cap is false", cs.box_battery_available(), False)
    finally:
        s.close()


def test_no_power_supply_dir_at_all():
    """A desktop with no /sys/class/power_supply must not raise."""
    print("test_no_power_supply_dir_at_all")
    old = cs._POWER_SUPPLY_DIR
    cs._POWER_SUPPLY_DIR = "/nonexistent/power_supply"
    try:
        check("empty", cs.read_box_battery(), {})
        check("cap is false", cs.box_battery_available(), False)
    finally:
        cs._POWER_SUPPLY_DIR = old


def test_charge_based_gauge():
    """Hardware that reports CHARGE_NOW/CURRENT_NOW instead of ENERGY_*."""
    print("test_charge_based_gauge")
    charge = """POWER_SUPPLY_NAME=BAT1
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_CHARGE_NOW=3000000
POWER_SUPPLY_CURRENT_NOW=1500000
POWER_SUPPLY_CAPACITY=42
"""
    s = Supplies({"BAT1": charge})
    try:
        got = cs.read_box_battery()
        check("percent", got.get("pct"), 42)
        check("minutes from charge/current", got.get("minutes"), 120)
    finally:
        s.close()


def test_time_to_full_while_charging():
    """VERBATIM off a Legion Go S while actually plugged in, 2026-07-22:
    ENERGY_NOW 34530000, ENERGY_FULL 55500000, POWER_NOW 30197000
    -> (55500000-34530000)*60/30197000 = 41 minutes."""
    print("test_time_to_full_while_charging")
    charging = (BAT0.replace("POWER_SUPPLY_STATUS=Discharging",
                             "POWER_SUPPLY_STATUS=Charging")
                    .replace("POWER_SUPPLY_ENERGY_NOW=32350000",
                             "POWER_SUPPLY_ENERGY_NOW=34530000")
                    .replace("POWER_SUPPLY_POWER_NOW=22543000",
                             "POWER_SUPPLY_POWER_NOW=30197000"))
    s = Supplies({"BAT0": charging, "ACAD": ACAD_ONLINE})
    try:
        got = cs.read_box_battery()
        check("minutes_to_full", got.get("minutes_to_full"), 41)
        check("and NOT the discharge clock", "minutes" in got, False)
    finally:
        s.close()


def test_full_on_the_charger_reports_no_time_to_full():
    """A topped-up battery still on the charger trickles. 'time to full' of
    hours would be nonsense, so report nothing."""
    print("test_full_on_the_charger_reports_no_time_to_full")
    full = (BAT0.replace("POWER_SUPPLY_STATUS=Discharging",
                         "POWER_SUPPLY_STATUS=Charging")
                .replace("POWER_SUPPLY_ENERGY_NOW=32350000",
                         "POWER_SUPPLY_ENERGY_NOW=55500000")
                .replace("POWER_SUPPLY_POWER_NOW=22543000",
                         "POWER_SUPPLY_POWER_NOW=120000"))
    s = Supplies({"BAT0": full, "ACAD": ACAD_ONLINE})
    try:
        check("no bogus estimate", "minutes_to_full" in cs.read_box_battery(), False)
    finally:
        s.close()


def test_charging_reports_no_time_left():
    """On AC, POWER_NOW is the CHARGE rate. Dividing by it would produce a
    confident, entirely wrong 'time remaining' -- so there must be none."""
    print("test_charging_reports_no_time_left")
    s = Supplies({"BAT0": BAT0.replace("STATUS=Discharging", "STATUS=Charging"),
                  "ACAD": ACAD_ONLINE})
    try:
        got = cs.read_box_battery()
        check("status", got.get("status"), "Charging")
        check("on AC", got.get("on_ac"), True)
        check("no minutes while charging", "minutes" in got, False)
    finally:
        s.close()


def test_empty_bay_is_not_a_battery():
    """PRESENT=0 is a bay with no pack. Reporting its 0% would be a lie."""
    print("test_empty_bay_is_not_a_battery")
    s = Supplies({"BAT0": """POWER_SUPPLY_NAME=BAT0
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_PRESENT=0
POWER_SUPPLY_CAPACITY=0
"""})
    try:
        check("empty bay ignored", cs.read_box_battery(), {})
    finally:
        s.close()


def test_garbage_capacity_rejected():
    """Reject rather than sanitise (CLAUDE.md 3.6)."""
    print("test_garbage_capacity_rejected")
    for bad in ("", "abc", "-5", "9999"):
        s = Supplies({"BAT0": """POWER_SUPPLY_NAME=BAT0
POWER_SUPPLY_TYPE=Battery
POWER_SUPPLY_PRESENT=1
POWER_SUPPLY_STATUS=Discharging
POWER_SUPPLY_CAPACITY=%s
""" % bad})
        try:
            check("capacity %r rejected" % bad, cs.read_box_battery(), {})
        finally:
            s.close()


def test_desktop_with_paired_controller_is_not_on_battery():
    """THE reported bug: a mains DESKTOP with a wireless controller paired showed
    "On battery 15%". The controller is TYPE=Battery but SCOPE=Device -- a
    peripheral, not the machine's pack. The box has no battery of its own, so the
    reading (and the whole card) must be absent, not the controller's 15%."""
    print("test_desktop_with_paired_controller_is_not_on_battery")
    s = Supplies({"0005:054C:0CE6.0009-battery": HID_CONTROLLER, "ACAD": ACAD_ONLINE})
    try:
        check("no box battery reported", cs.read_box_battery(), {})
        check("cap is false on a desktop", cs.box_battery_available(), False)
    finally:
        s.close()


def test_device_scope_alone_degrades_closed():
    """A box whose ONLY battery-typed node is a peripheral has no own battery."""
    print("test_device_scope_alone_degrades_closed")
    s = Supplies({"0005:054C:0CE6.0009-battery": HID_CONTROLLER})
    try:
        check("device-scope peripheral ignored", cs.read_box_battery(), {})
    finally:
        s.close()


def test_handheld_with_paired_controller_reads_its_own_pack():
    """Control -- must NOT regress the hardware-verified handheld. With a paired
    controller (SCOPE=Device, named to sort BEFORE BAT0) AND the real BAT0
    (System, no SCOPE line) both present, the reader returns the machine's 58%,
    never the controller's 15%. The old code took the first Battery node in sort
    order, so the digit-leading controller name would have won."""
    print("test_handheld_with_paired_controller_reads_its_own_pack")
    s = Supplies({"0005:054C:0CE6.0009-battery": HID_CONTROLLER,
                  "BAT0": BAT0, "ACAD": ACAD_OFFLINE})
    try:
        got = cs.read_box_battery()
        check("its own pack, not the controller", got.get("pct"), 58)
        check("its own status", got.get("status"), "Discharging")
        check("cap is true on a handheld", cs.box_battery_available(), True)
    finally:
        s.close()


if __name__ == "__main__":
    for fn in (test_real_handheld,
               test_watts_from_power_now,
               test_watts_from_current_times_voltage,
               test_zero_draw_is_omitted_not_reported,
               test_profile_reported_verbatim_even_when_not_a_listed_choice,
               test_missing_platform_profile_is_none,
               test_duplicate_type_key,
               test_mains_desktop_degrades_closed,
               test_no_power_supply_dir_at_all,
               test_charge_based_gauge,
               test_time_to_full_while_charging,
               test_full_on_the_charger_reports_no_time_to_full,
               test_charging_reports_no_time_left,
               test_empty_bay_is_not_a_battery,
               test_garbage_capacity_rejected,
               test_desktop_with_paired_controller_is_not_on_battery,
               test_device_scope_alone_degrades_closed,
               test_handheld_with_paired_controller_reads_its_own_pack):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
