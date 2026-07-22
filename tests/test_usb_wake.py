#!/usr/bin/env python3
"""Tests for the USB wake-source probe (/api/usb-wake).

Run: python3 tests/test_usb_wake.py

Two field reports shaped this, and both are encoded here as tests.

(1) Arming only the ROOT HUBS is not enough. A DIY SteamOS box had keyboard and
    mouse waking the machine while controllers did not, because a controller's
    signal arrives through a dongle further down the tree. So the probe must
    report leaf devices, not just usbN.

(2) Arming EVERY device with a writable wakeup file causes spurious wakes. The
    same reporter did that and found his controller powering itself off after 15
    minutes woke the machine straight back up — a disconnect is a bus state
    change, and the kernel counts it as a wake. Hence `transient`: a device that
    can go away is the dangerous one to arm; a hub that stays put is not.

The fixture below is copied VERBATIM off a live Bazzite box (2026-07-21),
including its Steam Controller Puck, its two USB 2.0 hubs, the USB LAN adapter
that is already armed for Wake-on-LAN, and a device with no wakeup file at all.
The interface nodes are real too — every "1-2:1.0"-style node had no power/wakeup
on that hardware, which is exactly why they must be skipped.
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


# name -> (wakeup|None, idVendor, idProduct, product, bDeviceClass)
# VERBATIM off a live Bazzite box, 2026-07-21.
FIXTURE = {
    "1-0:1.0":   (None, None, None, None, None),          # interface: no wakeup
    "1-10":      ("disabled", "8087", "0029", None, "e0"),  # Intel BT
    "1-10:1.0":  (None, None, None, None, None),
    "1-2":       ("disabled", "28de", "1304", "Steam Controller Puck", "ef"),
    "1-2:1.0":   (None, None, None, None, None),
    "1-2:1.4":   (None, None, None, None, None),
    "1-5":       ("disabled", "1a40", "0101", "USB 2.0 Hub", "09"),
    "1-5:1.0":   (None, None, None, None, None),
    # Xbox wireless dongle, captured with it plugged in. Already armed on that
    # box, and the counterexample to the `transient` heuristic — see
    # test_transient_is_a_heuristic_not_a_fact.
    "1-5.1":     ("enabled", "045e", "02e6", "XBOX ACC", "00"),
    "1-6":       ("enabled", "0bda", "8152", "USB 10/100 LAN", "00"),   # WoL
    "1-6:1.0":   (None, None, None, None, None),
    "1-7":       ("disabled", "1a40", "0101", "USB 2.0 Hub", "09"),
    "1-7.2":     (None, "2757", "0100", "Hitevision Board", "00"),  # NO wakeup
    "2-0:1.0":   (None, None, None, None, None),
    "usb1":      ("disabled", "1d6b", "0002", "xHCI Host Controller", "09"),
    "usb2":      ("disabled", "1d6b", "0003", "xHCI Host Controller", "09"),
}


def build_tree(spec, readonly_wakeup=()):
    """Materialise a fake /sys/bus/usb/devices. Returns the temp root."""
    root = tempfile.mkdtemp(prefix="usbwake-")
    for name, (wake, vid, pid, prod, cls) in spec.items():
        d = os.path.join(root, name)
        os.makedirs(os.path.join(d, "power"), exist_ok=True)
        if wake is not None:
            p = os.path.join(d, "power", "wakeup")
            with open(p, "w") as f:
                f.write(wake + "\n")
            if name in readonly_wakeup:
                os.chmod(p, 0o444)
        for attr, val in (("idVendor", vid), ("idProduct", pid),
                          ("product", prod), ("bDeviceClass", cls)):
            if val is not None:
                with open(os.path.join(d, attr), "w") as f:
                    f.write(val + "\n")
    return root


def run(spec, readonly_wakeup=()):
    root = build_tree(spec, readonly_wakeup)
    old = cs._USB_DEVICES_DIR
    cs._USB_DEVICES_DIR = root
    try:
        return cs.usb_wake_devices()
    finally:
        cs._USB_DEVICES_DIR = old
        shutil.rmtree(root, ignore_errors=True)


def test_interfaces_are_skipped():
    """":"-nodes never own power/wakeup; listing them is pure noise."""
    print("test_interfaces_are_skipped")
    ids = [d["id"] for d in run(FIXTURE)]
    check("no interface nodes reported", [i for i in ids if ":" in i], [])


def test_device_without_wakeup_omitted():
    """A control that cannot do anything is worse than no control."""
    print("test_device_without_wakeup_omitted")
    ids = [d["id"] for d in run(FIXTURE)]
    check("1-7.2 (no wakeup file) omitted", "1-7.2" in ids, False)
    check("1-2 (has wakeup) reported", "1-2" in ids, True)


def test_real_box_inventory():
    """The whole fixture, as the app would see it."""
    print("test_real_box_inventory")
    got = {d["id"]: d for d in run(FIXTURE)}
    check("exactly the wake-capable devices",
          sorted(got), ["1-10", "1-2", "1-5", "1-5.1", "1-6", "1-7",
                        "usb1", "usb2"])
    check("puck named", got["1-2"]["name"], "Steam Controller Puck")
    check("puck vendor:product", (got["1-2"]["vendor"], got["1-2"]["product_id"]),
          ("28de", "1304"))
    check("USB LAN already armed (Wake-on-LAN)", got["1-6"]["armed"], True)
    check("puck not armed", got["1-2"]["armed"], False)


def test_transient_vs_persistent():
    """The field-report distinction: what is safe to arm.

    A hub stays plugged in. A controller dongle's CHILD can power itself off,
    and that disconnect is what woke the reporter's machine 15 minutes after he
    put it to sleep."""
    print("test_transient_vs_persistent")
    got = {d["id"]: d for d in run(FIXTURE)}
    check("root hub is persistent", got["usb1"]["transient"], False)
    check("root hub flagged as root", got["usb1"]["root_hub"], True)
    check("class-09 hub is persistent", got["1-5"]["transient"], False)
    check("hub not flagged as root", got["1-5"]["root_hub"], False)
    check("puck is transient", got["1-2"]["transient"], True)
    check("BT radio is transient", got["1-10"]["transient"], True)


def test_transient_is_a_heuristic_not_a_fact():
    """The Xbox dongle is the counterexample, and it is REAL hardware.

    `transient` means only "not a hub". The Xbox wireless adapter (045e:02e6)
    is a leaf device, so it reports transient — yet it never unplugs itself and
    is exactly the device you would want armed. Sysfs exposes nothing that
    separates "dongle that stays" from "controller that sleeps", so this field
    is a hint to phrase a warning around, never something to gate arming on.

    Asserted so the limitation stays visible instead of being rediscovered by a
    user whose machine will not stay asleep."""
    print("test_transient_is_a_heuristic_not_a_fact")
    got = {d["id"]: d for d in run(FIXTURE)}
    check("xbox dongle present", got["1-5.1"]["name"], "XBOX ACC")
    check("and reports transient despite never leaving",
          got["1-5.1"]["transient"], True)
    check("it was already armed on the real box", got["1-5.1"]["armed"], True)


def test_writable_is_reported():
    """Arming needs root. The probe says whether it is even possible."""
    print("test_writable_is_reported")
    got = {d["id"]: d for d in run(FIXTURE, readonly_wakeup=("1-2",))}
    check("read-only wakeup reported not writable", got["1-2"]["writable"], False)
    check("writable one still writable", got["1-5"]["writable"], True)


def test_missing_sysfs_degrades_closed():
    """No /sys (macOS, a container, a locked-down box) must not raise."""
    print("test_missing_sysfs_degrades_closed")
    old = cs._USB_DEVICES_DIR
    cs._USB_DEVICES_DIR = "/nonexistent/usb/devices"
    try:
        check("returns empty list, never raises", cs.usb_wake_devices(), [])
    finally:
        cs._USB_DEVICES_DIR = old


def test_unreadable_wakeup_value_omitted():
    """Garbage in the wakeup file is not a wake source."""
    print("test_unreadable_wakeup_value_omitted")
    spec = dict(FIXTURE)
    spec["1-2"] = ("something-else", "28de", "1304", "Steam Controller Puck", "ef")
    ids = [d["id"] for d in run(spec)]
    check("unknown wakeup value omitted", "1-2" in ids, False)


if __name__ == "__main__":
    for fn in (test_interfaces_are_skipped,
               test_device_without_wakeup_omitted,
               test_real_box_inventory,
               test_transient_vs_persistent,
               test_transient_is_a_heuristic_not_a_fact,
               test_writable_is_reported,
               test_missing_sysfs_degrades_closed,
               test_unreadable_wakeup_value_omitted):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
