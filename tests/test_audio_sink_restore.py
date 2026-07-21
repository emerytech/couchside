#!/usr/bin/env python3
"""Tests for restoring the audio device Couch Mode moved.

Run: python3 tests/test_audio_sink_restore.py

Leaving Couch Mode used to GUESS its way back: it picked whichever sink had
"speaker"/"analog"/"pci" in its name and made that the system default. That is a
substitution, not a restore, and it cost a user their audio -- reported from the
field as the box's default device being changed out from under them, with sound
gone from the TV until they put it back by hand. Anyone whose default was a USB
DAC, a Bluetooth speaker or a virtual sink got the same treatment.

The rule these tests pin down: Couchside puts audio back exactly where it found
it, or it leaves audio alone. It never picks a device the user did not choose.

The last test is the regression proper -- a box with a tempting "speaker" sink
sitting right there, and nothing recorded, must run NO pactl command at all.

Pure stdlib, no pytest -- same style as the other agent tests.
"""
import importlib.util
import os
import sys

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


def _stub(*, sinks, default, ran):
    """Stub pactl. `ran` collects every argv the agent actually executes, which
    is how "left audio alone" is asserted as NOTHING RAN rather than as a
    return value that merely looks passive."""
    cs.shutil.which = lambda b: "/usr/bin/" + b
    cs._pactl_sinks = lambda: [{"name": n, "hdmi": False, "available": False}
                               for n in sinks]

    def fake_run(argv, **kw):
        ran.append(list(argv))
        if argv[:2] == ["pactl", "get-default-sink"]:
            return {"ok": True, "stdout": default[0], "stderr": "", "exit_code": 0}
        if argv[:2] == ["pactl", "set-default-sink"]:
            default[0] = argv[2]
            return {"ok": True, "stdout": "", "stderr": "", "exit_code": 0}
        return {"ok": True, "stdout": "", "stderr": "", "exit_code": 0}

    cs._couch_run = fake_run


def _reset():
    cs._PRIOR_DEFAULT_SINK = None


def test_round_trip():
    """The user's own device comes back verbatim -- including a virtual sink,
    which is exactly the case the old name-guess could never restore."""
    print("test_round_trip")
    _reset()
    ran, default = [], ["sink-sunshine-stereo"]
    _stub(sinks=["sink-sunshine-stereo", "alsa_output.pci-0000_00.hdmi"],
          default=default, ran=ran)
    cs._remember_default_sink()
    cs._couch_run(["pactl", "set-default-sink", "alsa_output.pci-0000_00.hdmi"])
    check("audio moved to the TV", default[0], "alsa_output.pci-0000_00.hdmi")
    r = cs._restore_default_sink()
    check("restore ran", r.get("skipped"), None)
    check("exact prior device restored", default[0], "sink-sunshine-stereo")


def test_first_writer_wins():
    """Entering Couch Mode twice must not overwrite the ORIGINAL device with the
    TV sink we ourselves set -- otherwise the second entry makes the TV the
    thing we 'restore' to, and the user never gets their device back."""
    print("test_first_writer_wins")
    _reset()
    ran, default = [], ["my-usb-dac"]
    _stub(sinks=["my-usb-dac", "hdmi-sink"], default=default, ran=ran)
    cs._remember_default_sink()
    default[0] = "hdmi-sink"          # as if Couch Mode already moved it
    cs._remember_default_sink()       # second entry must be a no-op
    cs._restore_default_sink()
    check("still restores the ORIGINAL device", default[0], "my-usb-dac")


def test_nothing_recorded_is_a_no_op():
    """Agent restarted mid-session, or the box never entered Couch Mode through
    us: leave audio alone rather than guess."""
    print("test_nothing_recorded_is_a_no_op")
    _reset()
    ran, default = [], ["whatever-the-user-picked"]
    _stub(sinks=["whatever-the-user-picked", "speaker-sink"], default=default, ran=ran)
    r = cs._restore_default_sink()
    check("skipped", r.get("skipped"), True)
    check("default untouched", default[0], "whatever-the-user-picked")
    check("no pactl command ran", ran, [])


def test_vanished_device_is_a_no_op():
    """The remembered sink is gone (DAC unplugged). A stale name would fail, or
    worse match something else -- so skip."""
    print("test_vanished_device_is_a_no_op")
    _reset()
    ran, default = [], ["my-usb-dac"]
    _stub(sinks=["my-usb-dac"], default=default, ran=ran)
    cs._remember_default_sink()
    default[0] = "hdmi-sink"
    cs._pactl_sinks = lambda: [{"name": "hdmi-sink", "hdmi": True,
                                "available": True}]  # DAC unplugged
    r = cs._restore_default_sink()
    check("skipped", r.get("skipped"), True)
    check("default left where it is", default[0], "hdmi-sink")


def test_already_default_is_a_no_op():
    """Nothing to do -- and it must not issue a pointless set-default-sink."""
    print("test_already_default_is_a_no_op")
    _reset()
    ran, default = [], ["my-usb-dac"]
    _stub(sinks=["my-usb-dac"], default=default, ran=ran)
    cs._remember_default_sink()
    before = len(ran)
    r = cs._restore_default_sink()
    check("skipped", r.get("skipped"), True)
    check("no set-default-sink issued",
          [a for a in ran[before:] if a[:2] == ["pactl", "set-default-sink"]], [])


def test_desktop_mode_never_guesses():
    """THE REGRESSION. A box with an obvious "speaker" sink present and nothing
    recorded: desktop_mode must not touch audio. The old code would have seized
    on that sink by name and made it the system default."""
    print("test_desktop_mode_never_guesses")
    _reset()
    ran, default = [], ["sink-sunshine-stereo"]
    _stub(sinks=["alsa_output.pci-0000_00.analog-stereo", "sink-sunshine-stereo"],
          default=default, ran=ran)
    cs._session_to_desktop = lambda: {"ok": True}
    res = cs.desktop_mode()
    check("audio step skipped", res["steps"]["audio"].get("skipped"), True)
    check("default untouched", default[0], "sink-sunshine-stereo")
    check("no set-default-sink issued",
          [a for a in ran if a[:2] == ["pactl", "set-default-sink"]], [])


if __name__ == "__main__":
    for fn in (test_round_trip,
               test_first_writer_wins,
               test_nothing_recorded_is_a_no_op,
               test_vanished_device_is_a_no_op,
               test_already_default_is_a_no_op,
               test_desktop_mode_never_guesses):
        fn()
    if FAILURES:
        print("\nFAILED: %d" % len(FAILURES))
        sys.exit(1)
    print("\nall good")
