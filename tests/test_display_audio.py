#!/usr/bin/env python3
"""Tests for the display + audio readout (/api/display-info, /api/status).

Run: python3 tests/test_display_audio.py

WHY THIS EXISTS: this feature is almost entirely probes, and almost every source
on the box answers "what CAN this display do" while the Console tab is supposed
to show "what IS it doing". Those are different questions, and every trap below
is a real one that was measured on hardware, not imagined:

  * `ValidRefreshRates: 60` from gamescopectl and /sys/.../modes are LISTS of
    what the panel offers. Neither is the current mode, and /sys/.../modes has
    no refresh rate in it at all.
  * EDID's preferred timing is burned into the monitor and identical whether the
    box is driving it or has it blanked. On the measured box it HAPPENS to equal
    the real output mode, so code that reports it as "current" looks correct
    there and is wrong on any box not running at its preferred mode.
  * GAMESCOPE_DISPLAY_HDR_ENABLED read 1 on a box whose panel reports
    SUPPORTS_HDR 0 and whose EDID has no HDR block. It is Steam's REQUEST, not
    state. Sourcing "HDR: On" from it would put HDR On on the Console tab of a
    machine driving an 8-bit SDR monitor. There is a test for exactly that.
  * kscreen-doctor EXISTS on the box and SIGABRTs (rc=134) with zero bytes of
    output. A probe that trusted the exit code would read a core dump as "this
    box has no displays" -- so the parser ignores rc and requires parsed output.

FIXTURES are VERBATIM from real hardware (CLAUDE.md §6), captured 2026-07-27:
the Bazzite box (bazzite@100.103.155.101, Lenovo TIO24Gen3T on DP-1, IN GAME
MODE) for everything except the Hisense EDID, which came from EMERY-PC's
registry and is here as the POSITIVE CONTROL for the HDR branch -- without it
hdr_supported would only ever have been observed False (§11.2).
"""
import importlib.util
import json
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


# ---------------------------------------------------------------------------
# VERBATIM hardware fixtures
# ---------------------------------------------------------------------------

# /sys/class/drm/card1-DP-1/edid, hexdumped. CONTROL: gamescopectl on the same
# box at the same moment independently reported Display Make "Lenovo Group
# Limited" / Display Model "TIO24Gen3T" for this connector, and 0x30ae is
# Lenovo's PNP id "LEN".
EDID_LENOVO_TIO24 = (
    "00ffffffffffff0030aeb31034433730311d0104a5351e783e0565a756529c270f5054"
    "bdcf00714f81008180818c9500950fb300a940023a801871382d40582c45000f282100"
    "001e000000ff0056333035303743340a20202020000000fd001e4b1e5315000a202020"
    "202020000000fc0054494f323447656e33540a2020013902031ef14b01020304051411"
    "1213901f230907078301000065030c002000d60980a0205e63103060b20c0f28210000"
    "1a0e1f008051001e30408037000f282100001e662156aa51001e30468f33000f282100"
    "001ed449403062b0324040c013000f282100001e1a4f403062b0324040c013000f2821"
    "00001e00000000000000ba"
)

# POSITIVE CONTROL for the HDR branch: a real Hisense 4K HDR TV, read from
# EMERY-PC's HKLM\...\Enum\DISPLAY\HEC002F\...\Device Parameters\EDID.
EDID_HISENSE_HDR = (
    "00ffffffffffff0020a32f00010000000c1d0103807341780acf74a3574cb02309484c"
    "21080081c0814081800101010101010101010104740030f2705a80b0588a00501d7400"
    "001e023a801871382d40582c4500501d7400001e000000fc00484953454e53450a2020"
    "202020000000fd00184b0f511e000a202020202020017c02036771525f5e5d01020405"
    "101113141f202122626364320907071507505706013d07c06704035f7e0183010000e2"
    "00f9e305ff016e030c004000383c20008001020304e50e60616a6be61146d0007080e3"
    "060d01eb0146d0004463727c6c6f7ce5018b849001011d8018711c1620582c2500c48e"
    "2100009e0000000000000f"
)

# `gamescopectl` with NO arguments, in Game Mode.
GAMESCOPECTL_OUT = """gamescopectl version c31743d+ (gcc 15.2.1)
gamescope_control info:
  - Connector Name: DP-1
  - Display Make: Lenovo Group Limited
  - Display Model: TIO24Gen3T
  - Display Flags: 0x0
  - ValidRefreshRates: 60
  Features:
  - Reshade Shaders (1) - Version: 1 - Flags: 0x0
  - Display Info (2) - Version: 1 - Flags: 0x0
  - Pixel Filter (3) - Version: 1 - Flags: 0x0
  - Refresh Cycle Only Change Refresh Rate (4) - Version: 1 - Flags: 0x0
  - Mura Correction (5) - Version: 1 - Flags: 0x0
  - Unknown (6) - Version: 1 - Flags: 0x0
  - Unknown (7) - Version: 1 - Flags: 0x0
"""

# Every gamescopectl SUBCOMMAND on this build, including the convar reads that
# would have given HDR/VRR state if they worked.
GAMESCOPECTL_NOT_FOUND = "Command not found.\n"

# `wpctl inspect @DEFAULT_AUDIO_SINK@` and `@DEFAULT_AUDIO_SOURCE@`. Note the
# defaults are DIFFERENT devices: analog OUT built into the box, USB mic IN on
# the monitor. A test that used one device for both would prove nothing.
WPCTL_SINK = """id 53, type PipeWire:Interface:Node
  * node.description = "Built-in Audio Analog Stereo"
  * node.name = "alsa_output.pci-0000_00_1f.3.analog-stereo"
"""
WPCTL_SOURCE = """id 62, type PipeWire:Interface:Node
  * node.description = "Thinkcentre TIO24Gen3Touch for USB-audio Analog Stereo"
  * node.name = "alsa_input.usb-Lenovo_Thinkcentre_TIO24Gen3Touch_for_USB-audio_000000000000-00.analog-stereo"
"""

# /sys/class/drm/card1-*  (status / enabled), and the head of DP-1's `modes`.
# The repetition is verbatim: the file lists 1920x1080 four times because the
# same size appears at several timings, and carries NO refresh rate at all.
DRM_CONNECTORS = [
    ("card1-DP-1", "connected", "enabled"),
    ("card1-DP-2", "disconnected", "disabled"),
    ("card1-HDMI-A-1", "disconnected", "disabled"),
    ("card1-HDMI-A-2", "disconnected", "disabled"),
    ("card1-HDMI-A-3", "disconnected", "disabled"),
]
DRM_MODES_DP1 = "1920x1080\n1920x1080\n1920x1080\n1920x1080i\n1920x1080i\n"

# The gamescope X11 root atoms, exactly as measured. Note SUPPORTS_HDR 0 while
# DISPLAY_HDR_ENABLED is 1 -- the trap.
ATOMS_MEASURED = {
    "GAMESCOPE_XWAYLAND_SERVER_ID": 0,
    "GAMESCOPE_DISPLAY_REFRESH_RATE_FEEDBACK": 60,
    "GAMESCOPE_VRR_FEEDBACK": 0,
    "GAMESCOPE_VRR_CAPABLE": 0,
    "GAMESCOPE_DISPLAY_SUPPORTS_HDR": 0,
    "GAMESCOPE_DISPLAY_HDR_ENABLED": 1,
    # GAMESCOPE_HDR_OUTPUT_FEEDBACK is ABSENT on this box: gamescope only writes
    # it inside the output-mode-change handler. Absent is not off.
}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeProc:
    def __init__(self, stdout=b"", stderr=b"", rc=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, rc


class FakeRun:
    """subprocess.run stand-in that dispatches on the binary name. Records every
    argv so a test can prove WHAT ran (and that nothing else did)."""

    def __init__(self, table):
        self.table = table          # basename -> FakeProc or callable(argv)
        self.calls = []

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))
        entry = self.table.get(os.path.basename(argv[0]))
        if entry is None:
            raise FileNotFoundError(argv[0])
        return entry(argv) if callable(entry) else entry


class FakeX11:
    """An _X11Client that answers from a dict. `None` for an atom means the
    property does not exist, which is the case the whole HDR story turns on."""

    def __init__(self, atoms, width=0, height=0):
        self.atoms, self.width, self.height = atoms, width, height
        self.closed = False

    def read_cardinal(self, name):
        return self.atoms.get(name)

    def close(self):
        self.closed = True


def drm_fixture():
    """A /sys/class/drm tree copied from the measured box."""
    root = tempfile.mkdtemp(prefix="drm-")
    for name, status, enabled in DRM_CONNECTORS:
        d = os.path.join(root, name)
        os.makedirs(d)
        open(os.path.join(d, "status"), "w").write(status + "\n")
        open(os.path.join(d, "enabled"), "w").write(enabled + "\n")
        if status == "connected":
            open(os.path.join(d, "modes"), "w").write(DRM_MODES_DP1)
            open(os.path.join(d, "edid"), "wb").write(
                bytes.fromhex(EDID_LENOVO_TIO24))
    # A GPU dir, so the connector matcher is proven not to eat one.
    os.makedirs(os.path.join(root, "card1"))
    return root


def reset_caches():
    cs._DISPLAY_CACHE.update({"val": None, "at": 0.0})
    cs._AUDIO_CACHE.update({"val": None, "at": 0.0})
    cs._KSCREEN_FAILED_AT["t"] = 0.0


# ---------------------------------------------------------------------------
# EDID
# ---------------------------------------------------------------------------

def test_edid():
    print("EDID: identity, against gamescopectl as the control")
    e = cs._parse_edid(bytes.fromhex(EDID_LENOVO_TIO24))
    check("manufacturer word 0x30ae -> LEN (Lenovo PNP id)",
          e.get("manufacturer"), "LEN")
    check("0xFC descriptor == gamescopectl's Display Model",
          e.get("name"), "TIO24Gen3T")
    check("0xFF descriptor is the unit serial", e.get("serial"), "V30507C4")
    check("EDID version", e.get("edid_version"), "1.4")

    print("EDID: preferred timing is COMPUTED, and is a capability")
    p = e["preferred"]
    check("preferred size", (p["width"], p["height"]), (1920, 1080))
    check("preferred is progressive (sysfs lists 1080 before 1080i)",
          p["interlaced"], False)
    # 148500 kHz / (2200 * 1125). Agrees with gamescopectl ValidRefreshRates: 60.
    check("refresh derived from pixel clock, not read", p["pixel_clock_khz"],
          148500)
    check("...and lands on 60.000 Hz", round(p["refresh_hz"], 3), 60.0)
    s = cs._edid_summary(bytes.fromhex(EDID_LENOVO_TIO24))
    check("summary names it PREFERRED, never current",
          sorted(k for k in s if "refresh" in k or "width" in k),
          # vrefresh_* is the panel's supported refresh RANGE -- also a
          # capability, also named so nobody can read it as the current rate.
          ["preferred_refresh_hz", "preferred_width",
           "vrefresh_max_hz", "vrefresh_min_hz"])
    check("no key in the EDID summary is called `current_*`",
          [k for k in s if k.startswith("current")], [])
    check("...and none is an unqualified `refresh_hz` / `width` / `height`",
          [k for k in s if k in ("refresh_hz", "width", "height")], [])

    print("EDID: rejected rather than repaired")
    blob = bytes.fromhex(EDID_LENOVO_TIO24)
    for label, bad in (("empty", b""),
                       ("short (64 bytes)", blob[:64]),
                       ("all zeros", bytes(128)),
                       ("bad magic header", b"\xff" + blob[1:]),
                       ("corrupt byte -> checksum fails",
                        blob[:60] + b"\x00" + blob[61:])):
        check("refuses %s" % label, cs._parse_edid(bad), None)
    check("...and the summary of an unusable EDID is {} not a half record",
          cs._edid_summary(b"\x00" * 128), {})

    print("EDID: HDR/VRR capability, observed in BOTH states")
    check("SDR Lenovo panel: hdr_supported False", e.get("hdr_supported"), False)
    check("SDR Lenovo panel: vrr_supported False", e.get("vrr_supported"), False)
    h = cs._parse_edid(bytes.fromhex(EDID_HISENSE_HDR))
    check("Hisense 4K TV: manufacturer HEC", h.get("manufacturer"), "HEC")
    check("Hisense 4K TV: hdr_supported FIRES True", h.get("hdr_supported"), True)
    check("Hisense 4K TV: no VRR block -> still False",
          h.get("vrr_supported"), False)
    # A truncated read must not become a confident "no HDR".
    half = cs._parse_edid(bytes.fromhex(EDID_HISENSE_HDR)[:128])
    check("128-byte read omits hdr_supported rather than claiming False",
          "hdr_supported" in half, False)


# ---------------------------------------------------------------------------
# DRM sysfs: the headless floor
# ---------------------------------------------------------------------------

def test_drm():
    root = drm_fixture()
    orig = cs._DRM_DIR
    cs._DRM_DIR = root
    try:
        print("DRM sysfs: the connector that is plugged in")
        f = cs._drm_display_facts("DP-1")
        check("connected", f.get("connected"), True)
        check("enabled", f.get("enabled"), True)
        check("EDID read through sysfs gives the monitor name",
              f.get("monitor_name"), "TIO24Gen3T")
        check("preferred size from EDID",
              (f.get("preferred_width"), f.get("preferred_height")), (1920, 1080))

        print("DRM sysfs: the mode LIST is never the current mode")
        # THE test this file exists for. `modes` is a list of sizes with no
        # refresh rate in it; presenting it as the current mode is the bug.
        check("modes deduped, in file order",
              f.get("supported_modes"), ["1920x1080", "1920x1080i"])
        check("...named `supported_modes`, and NO current_* came out of sysfs",
              [k for k in f if k.startswith("current")], [])
        wire = cs._display_wire(f, "DP-1", None)
        check("the wire object built from sysfs alone has NO `mode`",
              "mode" in wire, False)
        check("...but does carry preferred_mode",
              wire.get("preferred_mode"),
              {"width": 1920, "height": 1080, "refresh_hz": 60.0})

        print("DRM sysfs: the disconnected connector (the other state)")
        d = cs._drm_display_facts("HDMI-A-2")
        check("connected False", d.get("connected"), False)
        check("enabled False", d.get("enabled"), False)
        check("no EDID -> no monitor name invented", "monitor_name" in d, False)
        check("no modes file -> no supported_modes", "supported_modes" in d, False)

        print("DRM sysfs: an unknown connector is not a pattern")
        check("unknown name -> no directory", cs._drm_connector_dir("DP-9"), None)
        check("...and no facts", cs._drm_display_facts("DP-9"), {})
        check("a bare GPU dir is not a connector", cs._drm_connector_dir("1"), None)
        check("a glob-shaped name matches nothing",
              cs._drm_connector_dir("*"), None)
        check("connector dir resolves under the fixture root",
              os.path.basename(cs._drm_connector_dir("DP-1")), "card1-DP-1")
    finally:
        cs._DRM_DIR = orig
        import shutil
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# gamescopectl
# ---------------------------------------------------------------------------

def test_gamescopectl():
    real_run, real_which = cs.subprocess.run, cs.shutil.which
    cs.shutil.which = lambda b: "/usr/bin/" + b
    try:
        print("gamescopectl: the info block parses")
        cs.subprocess.run = FakeRun(
            {"gamescopectl": FakeProc(stdout=GAMESCOPECTL_OUT.encode())})
        g = cs._gamescopectl_display_info("gamescope-0")
        check("connector", g.get("connector"), "DP-1")
        check("make", g.get("monitor_make"), "Lenovo Group Limited")
        check("model", g.get("monitor_model"), "TIO24Gen3T")

        print("gamescopectl: ValidRefreshRates is a SUPPORTED list, not the rate")
        check("parsed as a list", g.get("supported_refresh_hz"), [60])
        check("named `supported_refresh_hz`",
              [k for k in g if k.startswith("current")], [])
        wire = cs._display_wire(g, "DP-1", "gamescope")
        check("a wire object built from it alone has NO `mode`",
              "mode" in wire, False)
        check("the supported list lands in refresh_rates_hz",
              wire.get("refresh_rates_hz"), [60])

        print("gamescopectl: the not-firing state")
        cs.subprocess.run = FakeRun(
            {"gamescopectl": FakeProc(stdout=GAMESCOPECTL_NOT_FOUND.encode(),
                                      rc=1)})
        check("non-zero exit -> {}", cs._gamescopectl_display_info("gamescope-0"),
              {})
        cs.subprocess.run = FakeRun({"gamescopectl": FakeProc(stdout=b"")})
        check("empty output -> {}", cs._gamescopectl_display_info("gamescope-0"),
              {})
        cs.shutil.which = lambda b: None
        check("binary absent -> {} (no subprocess at all)",
              cs._gamescopectl_display_info("gamescope-0"), {})

        print("gamescopectl: only the bare binary ever runs")
        # `gamescopectl <convar> <value>` is a live WRITE surface on the box.
        cs.shutil.which = lambda b: "/usr/bin/" + b
        run = FakeRun({"gamescopectl": FakeProc(stdout=GAMESCOPECTL_OUT.encode())})
        cs.subprocess.run = run
        cs._gamescopectl_display_info("gamescope-0")
        check("argv is exactly ['gamescopectl']", run.calls, [["gamescopectl"]])
    finally:
        cs.subprocess.run, cs.shutil.which = real_run, real_which


# ---------------------------------------------------------------------------
# kscreen-doctor: the crash IS the measured state
# ---------------------------------------------------------------------------

# SYNTHETIC, and labelled as such: kscreen-doctor was never observed answering
# (the owner's box was in Game Mode throughout), so this is libkscreen's
# documented JSON shape, not a capture. It is the CONTROL that proves the crash
# test above is measuring a crash and not a parser that never works.
# The current mode is the SECOND entry on purpose, behind a 144Hz decoy: taking
# modes[0] is the obvious wrong implementation.
KSCREEN_JSON_SYNTHETIC = json.dumps({
    "outputs": [
        {"name": "eDP-1", "connected": False, "enabled": False, "modes": []},
        {"name": "DP-1", "connected": True, "enabled": True,
         "currentModeId": "83",
         "modes": [
             {"id": "81", "name": "1920x1080@144",
              "size": {"width": 1920, "height": 1080}, "refreshRate": 144.0},
             {"id": "83", "name": "2560x1440@59.95",
              "size": {"width": 2560, "height": 1440}, "refreshRate": 59.951},
         ]},
    ]
})


def test_kscreen():
    real_which, real_couch = cs.shutil.which, cs._couch_run
    cs.shutil.which = lambda b: "/usr/bin/" + b
    try:
        print("kscreen-doctor: SIGABRT reads as unavailable, not as 'no displays'")
        # VERBATIM: rc=134 ("the monitored command dumped core"), zero bytes on
        # BOTH streams. _couch_run reports that faithfully.
        reset_caches()
        cs._couch_run = lambda *a, **k: {"ok": False, "exit_code": 134,
                                         "stdout": "", "stderr": ""}
        check("crash -> {}", cs._kscreen_display_facts("DP-1"), {})
        check("...and the failure is remembered, so it stops core-dumping",
              cs._KSCREEN_FAILED_AT["t"] > 0, True)

        print("kscreen-doctor: CONTROL -- healthy output IS parsed")
        reset_caches()
        cs._couch_run = lambda *a, **k: {"ok": True, "exit_code": 0,
                                         "stdout": KSCREEN_JSON_SYNTHETIC,
                                         "stderr": ""}
        f = cs._kscreen_display_facts("DP-1")
        check("current size taken from currentModeId, not modes[0]",
              (f.get("current_width"), f.get("current_height")), (2560, 1440))
        check("current refresh", f.get("current_refresh_hz"), 59.95)
        check("connected/enabled", (f.get("connected"), f.get("enabled")),
              (True, True))
        check("...and the failure memo cleared", cs._KSCREEN_FAILED_AT["t"], 0.0)

        print("kscreen-doctor: OUTPUT is the gate, never the exit code")
        # Both directions of the same lesson.
        reset_caches()
        cs._couch_run = lambda *a, **k: {"ok": True, "exit_code": 0,
                                         "stdout": "", "stderr": ""}
        check("exit 0 with no output -> {}", cs._kscreen_display_facts("DP-1"), {})
        reset_caches()
        cs._couch_run = lambda *a, **k: {"ok": False, "exit_code": 134,
                                         "stdout": KSCREEN_JSON_SYNTHETIC,
                                         "stderr": "warning noise"}
        check("crashed-but-answered IS parsed (rc is not consulted)",
              cs._kscreen_display_facts("DP-1").get("current_width"), 2560)

        print("kscreen-doctor: garbage is refused, not repaired")
        for label, out in (("not JSON", "Segmentation fault"),
                           ("JSON but not an object", "[1,2,3]"),
                           ("no outputs key", '{"screen":{}}'),
                           ("empty outputs", '{"outputs":[]}')):
            reset_caches()
            cs._couch_run = (lambda o: lambda *a, **k: {
                "ok": True, "exit_code": 0, "stdout": o, "stderr": ""})(out)
            check("refuses %s" % label, cs._kscreen_display_facts("DP-1"), {})

        print("kscreen-doctor: an implausible refresh is dropped, not guessed")
        for label, hz, want in (("mHz (60000) normalized", 60000.0, 60.0),
                                ("0 dropped", 0.0, None),
                                ("nonsense (9e9) dropped", 9e9, None),
                                ("a string dropped", "60", None)):
            out = {"currentModeId": "1",
                   "modes": [{"id": "1", "size": {"width": 1920, "height": 1080},
                              "refreshRate": hz}]}
            check(label, cs._kscreen_mode(out).get("current_refresh_hz"), want)
        check("...and the SIZE still survives a dropped refresh",
              cs._kscreen_mode({"currentModeId": "1", "modes": [
                  {"id": "1", "size": {"width": 1920, "height": 1080},
                   "refreshRate": None}]}).get("current_width"), 1920)

        print("kscreen-doctor: absent binary is not an error")
        reset_caches()
        cs.shutil.which = lambda b: None
        check("no binary -> {}", cs._kscreen_display_facts("DP-1"), {})
    finally:
        cs.shutil.which, cs._couch_run = real_which, real_couch
        reset_caches()


# ---------------------------------------------------------------------------
# gamescope atoms: the HDR trap
# ---------------------------------------------------------------------------

def test_gamescope_atoms():
    real_x11, real_ctl = cs._gamescope_x11, cs._gamescopectl_display_info
    cs._gamescopectl_display_info = lambda sock: {}
    try:
        print("gamescope atoms: the measured box, verbatim")
        client = FakeX11(ATOMS_MEASURED, width=1920, height=1080)
        cs._gamescope_x11 = lambda: client
        f = cs._gamescope_display_facts("gamescope-0")
        check("current size from the X screen of server 0",
              (f.get("current_width"), f.get("current_height")), (1920, 1080))
        check("current refresh from the FEEDBACK atom",
              f.get("current_refresh_hz"), 60.0)
        check("vrr_active read (0 -> False, a real answer)",
              f.get("vrr_active"), False)
        check("vrr_supported read from VRR_CAPABLE", f.get("vrr_supported"), False)
        check("hdr_supported read from DISPLAY_SUPPORTS_HDR",
              f.get("hdr_supported"), False)
        check("the client is closed", client.closed, True)

        print("gamescope atoms: DISPLAY_HDR_ENABLED is a REQUEST and is ignored")
        # On the measured box that atom is 1 while the panel reports no HDR at
        # all. Reading it would print "HDR On" for an 8-bit SDR monitor. The
        # probe must not produce hdr_active from it AT ALL -- absent, not True.
        check("the probe reads no hdr_active from DISPLAY_HDR_ENABLED",
              f.get("hdr_active"), None)
        info = cs._display_wire(cs._infer_inactive(dict(f)), "DP-1", "gamescope")
        check("...and after the supported=False inference the wire says OFF",
              info["hdr"], {"supported": False, "enabled": False})

        print("gamescope atoms: unknown HDR stays unknown (both states)")
        # Panel SUPPORTS HDR, but the state atom is absent (gamescope only
        # writes it on a mode change). Absent must not become False.
        atoms = dict(ATOMS_MEASURED, GAMESCOPE_DISPLAY_SUPPORTS_HDR=1)
        cs._gamescope_x11 = lambda: FakeX11(atoms, 3840, 2160)
        f2 = cs._gamescope_display_facts("gamescope-0")
        check("hdr_supported True", f2.get("hdr_supported"), True)
        check("hdr_active ABSENT, not False", "hdr_active" in f2, False)
        w2 = cs._display_wire(f2, "DP-1", "gamescope")
        check("wire carries supported with no `enabled` key",
              w2["hdr"], {"supported": True})

        print("gamescope atoms: the state atom firing (the other half)")
        atoms = dict(ATOMS_MEASURED, GAMESCOPE_DISPLAY_SUPPORTS_HDR=1,
                     GAMESCOPE_HDR_OUTPUT_FEEDBACK=1, GAMESCOPE_VRR_CAPABLE=1,
                     GAMESCOPE_VRR_FEEDBACK=1)
        cs._gamescope_x11 = lambda: FakeX11(atoms, 3840, 2160)
        f3 = cs._gamescope_display_facts("gamescope-0")
        check("hdr_active True from HDR_OUTPUT_FEEDBACK", f3.get("hdr_active"), True)
        check("vrr_active True from VRR_FEEDBACK", f3.get("vrr_active"), True)
        check("vrr_supported True from VRR_CAPABLE", f3.get("vrr_supported"), True)

        print("gamescope atoms: a compositor that answers nothing")
        cs._gamescope_x11 = lambda: None
        check("no X11 client -> no facts at all",
              cs._gamescope_display_facts("gamescope-0"), {})
        cs._gamescope_x11 = lambda: FakeX11({}, 0, 0)
        check("client with no atoms and no screen size -> {}",
              cs._gamescope_display_facts("gamescope-0"), {})

        print("gamescope atoms: an out-of-range refresh is dropped")
        for hz in (0, 5, 5000):
            cs._gamescope_x11 = lambda hz=hz: FakeX11(
                {"GAMESCOPE_DISPLAY_REFRESH_RATE_FEEDBACK": hz}, 1920, 1080)
            got = cs._gamescope_display_facts("gamescope-0")
            check("refresh %r dropped" % hz, "current_refresh_hz" in got, False)
    finally:
        cs._gamescope_x11, cs._gamescopectl_display_info = real_x11, real_ctl


def test_x11_server_selection():
    """gamescope publishes the atoms ONLY on XWayland server 0; server 1 answers
    not-found for every one. Verified both ways on the box, so the picker reads
    GAMESCOPE_XWAYLAND_SERVER_ID instead of hardcoding :0."""
    print("X11: the PRIMARY gamescope XWayland is chosen by its atom")
    root = tempfile.mkdtemp(prefix="x11-")
    # X0 first in sort order, and deliberately NOT the gamescope primary.
    for n in ("X0", "X1", "junk"):
        open(os.path.join(root, n), "w").close()
    orig_dir, orig_cls = cs._X11_UNIX_DIR, cs._X11Client
    cs._X11_UNIX_DIR = root
    made = {}
    try:
        def factory(num):
            atoms = ({"GAMESCOPE_XWAYLAND_SERVER_ID": 0} if num == 1
                     else {})                       # X0 = a Plasma XWayland
            made[num] = FakeX11(atoms, 1920, 1080)
            return made[num]
        cs._X11Client = factory
        got = cs._gamescope_x11()
        check("skips the server with no gamescope atom", got is made[1], True)
        check("...and closes the one it rejected", made[0].closed, True)
        check("...and leaves the chosen one open", made[1].closed, False)

        print("X11: nothing to find (the other state)")
        made.clear()
        cs._X11Client = lambda num: made.setdefault(num, FakeX11({}, 0, 0))
        check("no gamescope atom anywhere -> None", cs._gamescope_x11(), None)
        check("...and every client opened is closed",
              all(c.closed for c in made.values()), True)

        print("X11: a server that refuses the connection is skipped, not fatal")
        def boom(num):
            raise OSError("connection refused")
        cs._X11Client = boom
        check("all connects fail -> None", cs._gamescope_x11(), None)
        cs._X11_UNIX_DIR = os.path.join(root, "does-not-exist")
        check("no socket dir at all -> None", cs._gamescope_x11(), None)
    finally:
        cs._X11_UNIX_DIR, cs._X11Client = orig_dir, orig_cls
        import shutil
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def test_audio():
    real_run, real_which = cs.subprocess.run, cs.shutil.which
    try:
        print("audio: wpctl inspect, both directions")
        reset_caches()
        cs.shutil.which = lambda b: "/usr/bin/" + b

        def wpctl(argv):
            if argv[2] == "@DEFAULT_AUDIO_SINK@":
                return FakeProc(stdout=WPCTL_SINK.encode())
            return FakeProc(stdout=WPCTL_SOURCE.encode())
        run = FakeRun({"wpctl": wpctl})
        cs.subprocess.run = run
        a = cs.audio_info()
        check("default OUT description", a.get("output"),
              "Built-in Audio Analog Stereo")
        check("default OUT node name", a.get("output_name"),
              "alsa_output.pci-0000_00_1f.3.analog-stereo")
        check("default IN description", a.get("input"),
              "Thinkcentre TIO24Gen3Touch for USB-audio Analog Stereo")
        check("default IN node name", a.get("input_name"),
              "alsa_input.usb-Lenovo_Thinkcentre_TIO24Gen3Touch_for_USB-audio_"
              "000000000000-00.analog-stereo")
        check("OUT and IN are different devices, as measured",
              a["output"] != a["input"], True)
        check("only the two agent-chosen literals are ever passed to wpctl",
              sorted(c[2] for c in run.calls),
              ["@DEFAULT_AUDIO_SINK@", "@DEFAULT_AUDIO_SOURCE@"])

        print("audio: unavailable is absent, not an error")
        reset_caches()
        cs.shutil.which = lambda b: None
        check("no wpctl -> None", cs.audio_info(), None)
        reset_caches()
        cs.shutil.which = lambda b: "/usr/bin/" + b
        cs.subprocess.run = FakeRun({"wpctl": FakeProc(stdout=b"", rc=1)})
        check("wpctl fails (no pipewire) -> None", cs.audio_info(), None)
        reset_caches()
        cs.subprocess.run = FakeRun(
            {"wpctl": FakeProc(stdout=b"id 53, type PipeWire:Interface:Node\n")})
        check("no node properties -> None", cs.audio_info(), None)

        print("audio: one direction readable, the other not")
        reset_caches()

        def only_sink(argv):
            if argv[2] == "@DEFAULT_AUDIO_SINK@":
                return FakeProc(stdout=WPCTL_SINK.encode())
            return FakeProc(stdout=b"", rc=1)       # no default source
        cs.subprocess.run = FakeRun({"wpctl": only_sink})
        a = cs.audio_info()
        check("output present", a.get("output"), "Built-in Audio Analog Stereo")
        check("input key simply absent", "input" in a, False)

        print("audio: a node with a name but no description")
        reset_caches()
        cs.subprocess.run = FakeRun({"wpctl": FakeProc(
            stdout=b'id 7, type PipeWire:Interface:Node\n'
                   b'  * node.name = "alsa_output.usb-Generic-00.iec958"\n')})
        check("falls back to the node name, never an empty string",
              cs.audio_info().get("output"), "alsa_output.usb-Generic-00.iec958")
    finally:
        cs.subprocess.run, cs.shutil.which = real_run, real_which
        reset_caches()


# ---------------------------------------------------------------------------
# Composition: a capability is never reported as a state
# ---------------------------------------------------------------------------

def test_composition():
    root = drm_fixture()
    saved = (cs._DRM_DIR, cs._wayland_display_sockets, cs._active_output,
             cs._gamescope_x11, cs._gamescopectl_display_info, cs._couch_run,
             cs.shutil.which, cs.subprocess.run)
    cs._DRM_DIR = root
    cs._active_output = lambda: {"name": "DP-1", "internal": False}
    cs.shutil.which = lambda b: "/usr/bin/" + b
    try:
        print("composition: Game Mode, exactly as measured")
        reset_caches()
        cs._wayland_display_sockets = lambda: ["gamescope-0"]
        cs._gamescope_x11 = lambda: FakeX11(ATOMS_MEASURED, 1920, 1080)
        cs.subprocess.run = FakeRun(
            {"gamescopectl": FakeProc(stdout=GAMESCOPECTL_OUT.encode())})
        d = cs.display_info()
        check("connector", d.get("connector"), "DP-1")
        check("external panel", d.get("internal"), False)
        check("monitor name from EDID", d.get("monitor"), "TIO24Gen3T")
        check("make from gamescopectl", d.get("make"), "Lenovo Group Limited")
        check("current mode", d.get("mode"),
              {"width": 1920, "height": 1080, "refresh_hz": 60.0})
        check("mode is attributed to its source", d.get("mode_source"),
              "gamescope")
        check("preferred mode is a SEPARATE key",
              d.get("preferred_mode"),
              {"width": 1920, "height": 1080, "refresh_hz": 60.0})
        check("supported list is a THIRD key", d.get("refresh_rates_hz"), [60])
        check("sysfs mode list is a FOURTH key",
              d.get("supported_modes"), ["1920x1080", "1920x1080i"])
        check("HDR off (from a measured capability, never from the request atom)",
              d.get("hdr"), {"supported": False, "enabled": False})
        check("VRR off", d.get("vrr"), {"supported": False, "active": False})
        check("no top-level key is called `refresh_hz` or `resolution`",
              [k for k in d if k in ("refresh_hz", "resolution", "current")], [])

        print("composition: a capability is NEVER emitted as the current mode")
        # Kill every live source. EDID's preferred timing and gamescopectl's
        # supported list both still read 60Hz/1920x1080 -- and neither may
        # become `mode`. On this box they happen to equal the real mode, which
        # is exactly why a back-fill would look correct here and be wrong
        # everywhere else.
        reset_caches()
        cs._wayland_display_sockets = lambda: []
        cs._couch_run = lambda *a, **k: {"ok": False, "exit_code": 134,
                                         "stdout": "", "stderr": ""}
        d2 = cs.display_info()
        check("no live session -> NO `mode`", "mode" in d2, False)
        check("...and no mode_source", "mode_source" in d2, False)
        check("...but preferred_mode still reported, labelled as such",
              d2.get("preferred_mode"),
              {"width": 1920, "height": 1080, "refresh_hz": 60.0})
        check("...and the sysfs mode LIST is still only a list",
              d2.get("supported_modes"), ["1920x1080", "1920x1080i"])
        check("...HDR still known off, because the EDID capability is a measured "
              "False", d2.get("hdr"), {"supported": False, "enabled": False})

        print("composition: unknown capability -> no state at all")
        # An EDID with no CTA extension says nothing about HDR. That must stay
        # silence, not "off".
        reset_caches()
        wire = cs._display_wire({"connected": True}, "DP-1", None)
        check("no hdr key", "hdr" in wire, False)
        check("no vrr key", "vrr" in wire, False)
        check("no mode key", "mode" in wire, False)
        check("connector and internal always present",
              (wire["connector"], wire["internal"]), ("DP-1", False))
        check("an eDP connector reads as internal",
              cs._display_wire({}, "eDP-1", None)["internal"], True)

        print("composition: the inference fires ONLY on a measured False")
        check("supported False -> active False (a fact, not a guess)",
              cs._infer_inactive({"hdr_supported": False,
                                  "vrr_supported": False}),
              {"hdr_supported": False, "hdr_active": False,
               "vrr_supported": False, "vrr_active": False})
        check("supported ABSENT -> state stays absent (unknown is not off)",
              cs._infer_inactive({}), {})
        check("supported True -> state stays absent (unknown is not on either)",
              cs._infer_inactive({"hdr_supported": True}),
              {"hdr_supported": True})
        check("a real state reading is never overwritten",
              cs._infer_inactive({"hdr_supported": False, "hdr_active": True}),
              {"hdr_supported": False, "hdr_active": True})

        print("composition: gamescope names the connector it is driving")
        reset_caches()
        cs._wayland_display_sockets = lambda: ["gamescope-0"]
        cs._gamescope_x11 = lambda: None
        cs.subprocess.run = FakeRun(
            {"gamescopectl": FakeProc(stdout=GAMESCOPECTL_OUT.encode())})
        cs._active_output = lambda: {"name": "HDMI-A-1", "internal": False}
        d3 = cs.display_info()
        check("gamescopectl's connector wins over the sysfs guess",
              d3.get("connector"), "DP-1")
        check("...so the EDID read belongs to that panel",
              d3.get("monitor"), "TIO24Gen3T")

        print("composition: headless")
        reset_caches()
        cs._active_output = lambda: None
        cs._wayland_display_sockets = lambda: []
        cs.subprocess.run = FakeRun({})
        check("nothing connected -> None (the key is omitted entirely)",
              cs.display_info(), None)

        print("composition: a probe that raises can never break /api/status")
        reset_caches()
        def boom():
            raise RuntimeError("probe exploded")
        orig_unc = cs._display_info_uncached
        cs._display_info_uncached = boom
        try:
            check("exception -> None, not a traceback", cs.display_info(), None)
        finally:
            cs._display_info_uncached = orig_unc
    finally:
        (cs._DRM_DIR, cs._wayland_display_sockets, cs._active_output,
         cs._gamescope_x11, cs._gamescopectl_display_info, cs._couch_run,
         cs.shutil.which, cs.subprocess.run) = saved
        reset_caches()
        import shutil
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# Wiring: caps, payload, mock
# ---------------------------------------------------------------------------

def test_wiring():
    print("status: the blocks are additive and OMITTED when unavailable")
    saved = (cs.display_info, cs.audio_info)
    try:
        cs.display_info = lambda: None
        cs.audio_info = lambda: None
        s = cs.real_status()
        check("no display key on a box that could not read one",
              "display" in s, False)
        check("no audio key either", "audio" in s, False)
        check("...and the pre-existing keys are untouched",
              all(k in s for k in ("hostname", "uptime_s", "caps", "net",
                                   "agent_version", "history")), True)
        cs.display_info = lambda: {"connector": "DP-1"}
        cs.audio_info = lambda: {"output": "x"}
        s = cs.real_status()
        check("present when readable (the other state)",
              (s.get("display"), s.get("audio")),
              ({"connector": "DP-1"}, {"output": "x"}))

        print("/api/display-info payload")
        p = cs.display_payload()
        check("available True with data", p["available"], True)
        check("carries both blocks", sorted(p), ["audio", "available", "display"])
        cs.display_info = lambda: None
        cs.audio_info = lambda: None
        p = cs.display_payload()
        check("available False with nothing", p, {"available": False})
    finally:
        cs.display_info, cs.audio_info = saved

    print("caps: display_info is wired at every enforced site")
    # The five-site rule plus protocol.json. tests/test_protocol_parity.py is the
    # authority; this is the local canary so a failure here names the feature.
    cs.set_caps(True)
    check("agent mock branch", cs.CAPS.get("display_info"), True)
    cs.set_caps(False)
    check("agent real branch declares the key",
          "display_info" in cs.CAPS, True)
    check("...and its value is a real bool, never None",
          isinstance(cs.CAPS["display_info"], bool), True)
    spec = json.load(open(os.path.join(ROOT, "protocol", "protocol.json")))
    check("protocol.json declares it linux-only",
          "display_info" in spec["linuxOnlyCapabilities"]["keys"], True)
    api = open(os.path.join(ROOT, "app", "lib", "api.ts")).read()
    st = open(os.path.join(ROOT, "app", "lib", "settings.ts")).read()
    check("app BoxCaps", "  display_info?: boolean;" in api, True)
    check("app capsEqual", "a.display_info === b.display_info" in api, True)
    check("app normalizeCaps", "bool('display_info')" in st, True)
    win = open(os.path.join(ROOT, "agent", "win", "couchsided-win.py")).read()
    check("the Windows agent does NOT declare it",
          "display_info" in win, False)
    cs.set_caps(True)

    print("mock: the harness gets something worth rendering")
    m = cs.mock_display_payload()
    d, a = m["display"], m["audio"]
    check("current mode differs from preferred, so conflating them SHOWS",
          d["mode"]["refresh_hz"] != d["preferred_mode"]["refresh_hz"], True)
    check("HDR on and VRR off, so both state rows are exercisable",
          (d["hdr"]["enabled"], d["vrr"]["active"]), (True, False))
    check("audio OUT and IN are different devices",
          a["output"] != a["input"], True)
    check("...and the IN description is long enough to catch a row overflow",
          len(a["input"]) > 45, True)
    check("mock_status carries both blocks",
          sorted(k for k in cs.mock_status() if k in ("display", "audio")),
          ["audio", "display"])


def main():
    test_edid()
    test_drm()
    test_gamescopectl()
    test_kscreen()
    test_gamescope_atoms()
    test_x11_server_selection()
    test_audio()
    test_composition()
    test_wiring()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        return 1
    print("all display/audio tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
