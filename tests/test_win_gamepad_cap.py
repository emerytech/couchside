#!/usr/bin/env python3
"""The Windows `gamepad` capability must reflect an ACTUAL ViGEmBus connect, not
just the ViGEmClient.dll loading.

Run: python3 tests/test_win_gamepad_cap.py

WHY THIS EXISTS (client crash, 2026-09-17). The installer drops ViGEmClient.dll
next to the agent, but the ViGEmBus *driver* (a kernel driver — signing/reboot/
admin) can fail to install silently. The old cap probe, `vigem_available()`, only
checked that the DLL loads, so a driver-less box reported `gamepad: true`. The
app trusts that cap to open the pad, the agent's `vigem_connect` then fails
0xE0000001, and the phone app wedged in a render loop (a persistent "Something
went wrong / Maximum update depth exceeded" that survived restarts). The fix:
`vigem_ready()` probes a real connect (cached), and real_status re-computes the
cap live so a driver that appears/disappears after startup heals without a
restart. Per CLAUDE.md §4 this is the safety-critical gamepad path, so the probe
is exercised in BOTH directions with a control (the plain DLL check).

Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "win", "couchsided-win.py")
spec = importlib.util.spec_from_file_location("couchsided_win", AGENT)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


def _raise(*_a, **_k):
    raise RuntimeError("vigem_connect failed (0x%08X): is the ViGEmBus driver "
                       "installed?" % 0xE0000001)


def test_vigem_ready_reflects_the_bus_not_the_dll():
    print("gamepad cap: vigem_ready() = real bus connect, both directions + cache")
    orig = cw._load_vigem
    try:
        # BUS DOWN (the reported bug: DLL present, driver missing) -> connect
        # raises -> cap False. The whole point: no false positive.
        cw._GAMEPAD_CAP.update(at=0.0, ok=None)
        cw._load_vigem = _raise
        check(cw.vigem_ready() is False,
              "bus down (vigem_connect raises 0xE0000001) -> gamepad False")

        # CONTROL, the other direction: a real connect succeeds -> cap True. So
        # this cannot pass by always returning False.
        cw._GAMEPAD_CAP.update(at=0.0, ok=None)
        cw._load_vigem = lambda: (object(), object())
        check(cw.vigem_ready() is True, "bus up (connect ok) -> gamepad True")

        # Cached within the TTL: a transient failure right after a success does
        # NOT flip the cap (and, symmetrically, we do not reconnect on every
        # status poll — /api/status must never block on the bus).
        cw._load_vigem = _raise
        check(cw.vigem_ready() is True,
              "a transient failure within the TTL keeps the cached True")

        # ...but once the TTL has elapsed, it re-probes and heals to the truth.
        cw._GAMEPAD_CAP["at"] = 0.0  # force-expire
        check(cw.vigem_ready() is False, "after the TTL expires it re-probes (heals)")
    finally:
        cw._load_vigem = orig
        cw._GAMEPAD_CAP.update(at=0.0, ok=None)


def test_never_raises_even_if_probe_explodes():
    print("gamepad cap: vigem_ready never raises (status path is reachability-critical)")
    orig = cw._load_vigem
    try:
        cw._GAMEPAD_CAP.update(at=0.0, ok=None)
        cw._load_vigem = lambda: (_ for _ in ()).throw(OSError("access violation"))
        try:
            v = cw.vigem_ready()
            check(v is False, "an unexpected exception degrades to False, not a raise")
        except Exception as e:  # noqa: BLE001
            check(False, "vigem_ready raised: %r" % e)
    finally:
        cw._load_vigem = orig
        cw._GAMEPAD_CAP.update(at=0.0, ok=None)


def test_cap_wiring_in_source():
    print("gamepad cap: set_caps + real_status wire vigem_ready, not vigem_available")
    src = open(AGENT, encoding="utf-8").read()
    check('"gamepad": safe(vigem_ready)' in src,
          "set_caps computes gamepad from vigem_ready()")
    check('gamepad=vigem_ready()' in src,
          "real_status re-probes gamepad live (self-healing)")
    # The DLL-only check must no longer back the cap. It may still exist (as a
    # cheap hint) but must not be the gamepad source in set_caps.
    check('"gamepad": safe(vigem_available)' not in src,
          "the DLL-only vigem_available() no longer backs the gamepad cap")


if __name__ == "__main__":
    test_vigem_ready_reflects_the_bus_not_the_dll()
    test_never_raises_even_if_probe_explodes()
    test_cap_wiring_in_source()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all Windows gamepad-cap tests passed")
