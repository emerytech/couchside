#!/usr/bin/env python3
"""CEC One Touch Play (source_box) — switch the TV to THIS box's input.

Confirmed on real hardware 2026-09-04; these lock the CONTRACT so it can't
regress: the argv is fixed literals, the ONLY variable is the box's OWN physical
address read from the kernel adapter (never a client value), and it degrades
closed. Pure stdlib, no pytest.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(HERE, "..", "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


class FakeProc:
    def __init__(self, rc=0, out=b""):
        self.returncode = rc
        self.stdout = out
        self.stderr = b""


ADAPTER_DUMP = (b"\tDriver Name : cros-ec-cec\n"
                b"\tPhysical Address           : 4.0.0.0\n"
                b"\tLogical Address            : 4\n")


def install(runs, *, phys=ADAPTER_DUMP, cec_tool="cec-ctl", panel=False):
    """Capture every subprocess argv into `runs`; the no-op adapter dump returns
    `phys`, everything else returns rc 0."""
    saved = {k: getattr(cs, k) for k in
             ("subprocess", "cec_current", "panel_available", "time")}

    class FakeSub:
        TimeoutExpired = cs.subprocess.TimeoutExpired
        @staticmethod
        def run(argv, **kw):
            runs.append(list(argv))
            # `cec-ctl -d <dev>` with no op flags is the address read.
            if len(argv) == 3 and argv[1] == "-d":
                return FakeProc(0, phys)
            return FakeProc(0, b"")
    cs.subprocess = FakeSub
    cs.cec_current = (lambda: {"tool": cec_tool, "bin": "/usr/bin/cec-ctl",
                               "device": "/dev/cec0", "adapter": "kernel CEC"}
                      if cec_tool else lambda: None)
    if cec_tool is None:
        cs.cec_current = lambda: None
    cs.panel_available = lambda: panel

    class FakeTime:
        monotonic = staticmethod(cs.time.monotonic)
        sleep = staticmethod(lambda s: None)   # don't actually wait 3s
    cs.time = FakeTime

    def restore():
        for k, v in saved.items():
            setattr(cs, k, v)
    return restore


print("source_box over CEC: One Touch Play with the box's own address")
runs = []
restore = install(runs)
try:
    r = cs.real_cec_source_box()
    check(r["ok"], "succeeds on a cec-ctl box with a readable address")
    # image-view-on THEN active-source (>=2x for the re-send), all fixed literals
    iva = [a for a in runs if "--image-view-on" in a]
    asrc = [a for a in runs if "--active-source" in a]
    check(len(iva) == 1, "sends Image View On exactly once")
    check(len(asrc) >= 2, "broadcasts Active Source at least twice (re-send)")
    # the ONLY variable is the phys-addr, and it is the one READ from the adapter
    check(all(a[:4] == ["/usr/bin/cec-ctl", "-d", "/dev/cec0", "--playback"] for a in iva + asrc),
          "every command is the fixed cec-ctl/-d/device/--playback prefix")
    check(all("phys-addr=4.0.0.0" in a for a in asrc),
          "Active Source carries the adapter's OWN address (4.0.0.0), not a literal")
    # nothing client-shaped ever reaches argv: no op string, no interpolation
    joined = " ".join(" ".join(a) for a in runs)
    check("source_box" not in joined and ";" not in joined and "&" not in joined,
          "no client/op string reaches the argv")
finally:
    restore()

print("\ndegrade closed")
runs = []
restore = install(runs, cec_tool=None)   # no CEC backend
try:
    r = cs.real_cec_source_box()
    check(not r["ok"] and not runs, "no cec backend -> refused, nothing run")
finally:
    restore()

runs = []
restore = install(runs, phys=b"\tPhysical Address : f.f.f.f\n")  # unconfigured
try:
    r = cs.real_cec_source_box()
    check(not r["ok"], "unconfigured address (f.f.f.f) -> refused")
    check(not any("--active-source" in a for a in runs),
          "never broadcasts Active Source without a valid own address")
finally:
    restore()

runs = []
restore = install(runs, phys=b"\tPhysical Address : 0.0.0.0\n")  # that's the TV
try:
    check(not cs.real_cec_source_box()["ok"], "0.0.0.0 (the TV's address) -> refused")
finally:
    restore()

print("\nrouting + capability")
# tv_send prefers the panel; falls to CEC; else None
restore = install([], panel=True)
try:
    saved = cs.mock_panel
    cs.mock_panel = lambda op: {"ok": True, "via": "panel"}
    check(cs.tv_send("source_box", mock=True).get("via") == "panel",
          "panel present -> source_box goes to the panel")
    cs.mock_panel = saved
finally:
    restore()

restore = install([], panel=False, cec_tool="cec-ctl")
try:
    r = cs.tv_send("source_box", mock=True)   # mock -> mock_cec, no hardware
    check(r is not None and r.get("ok"), "no panel, CEC present -> source_box goes to CEC (mock)")
    check(cs._cec_source_box_available() is True, "cec-ctl box advertises source_box")
finally:
    restore()

restore = install([], panel=False, cec_tool=None)
try:
    check(cs.tv_send("source_box", mock=True) is None, "no panel, no CEC -> None (404)")
    check(cs._cec_source_box_available() is False, "no CEC -> source_box not advertised")
finally:
    restore()

print("\n%d checks failed" % len(_fail))
raise SystemExit(1 if _fail else 0)
