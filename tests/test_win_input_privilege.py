#!/usr/bin/env python3
"""The Windows agent reports its input privilege (elevated / uiAccess) so the app
can explain why the mouse can't drive an admin window and point at the fix.

Run: python3 tests/test_win_input_privilege.py

WHY (tester report 2026-09-17). A non-elevated agent cannot SendInput into a
higher-integrity foreground window (Windows UIPI) — "the mouse stops when I
alt-tab to an admin app / a game with anticheat." `input_privilege` on
/api/status carries `{elevated, uiaccess}`: both False = the standard non-elevated
agent (control normal apps, not admin windows); elevated = admin (reaches every
window, install.ps1 -Elevated); uiaccess = the signed uiAccess build (reaches
admin windows without being admin). The probe must DEGRADE CLOSED (all-False on
any failure / off Windows) so it can never itself report a privilege it lacks.

Pure stdlib, no pytest.
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


def test_privilege_shape_and_degrade_closed():
    print("input_privilege: correct shape + degrades closed")
    p = cw._process_privilege()
    check(isinstance(p, dict) and set(p.keys()) == {"elevated", "uiaccess"},
          "returns exactly {elevated, uiaccess}")
    check(p["elevated"] is False and p["uiaccess"] is False,
          "off Windows / no privilege -> both False (degrade closed)")
    # Cached: a second call returns the same object (fixed for process lifetime).
    check(cw._process_privilege() == p, "stable across calls (cached)")


def test_never_raises():
    print("input_privilege: never raises")
    try:
        cw._process_privilege()
        check(True, "no exception")
    except Exception as e:  # noqa: BLE001
        check(False, "raised: %r" % e)


def test_status_carries_input_privilege():
    print("input_privilege: rides /api/status (real + mock), additive")
    src = open(AGENT, encoding="utf-8").read()
    check('"input_privilege": _process_privilege()' in src,
          "real_status splices input_privilege live")
    check('"input_privilege": {"elevated": False, "uiaccess": False}' in src,
          "mock_status reports a standard (non-elevated) box")
    ms = cw.mock_status()
    check(ms.get("input_privilege") == {"elevated": False, "uiaccess": False},
          "mock_status().input_privilege is the standard shape")


def test_install_elevated_flag_wired():
    print("input_privilege: install.ps1 -Elevated sets the task RunLevel + prompts")
    ps = open(os.path.join(HERE, "..", "install.ps1"), encoding="utf-8").read()
    check("[switch]$Elevated" in ps, "install.ps1 declares -Elevated")
    check("[switch]$NoElevated" in ps, "install.ps1 declares -NoElevated (suppress prompt)")
    check("if ($Elevated) { 'Highest' } else { 'Limited' }" in ps,
          "-Elevated -> RunLevel Highest, else Limited (default non-elevated)")
    # Discoverable, not silent: an interactive install with no flag PROMPTS, and
    # the default is No (only an explicit y/yes flips $Elevated).
    check("Control admin windows? [y/N]" in ps, "interactive install prompts (default No)")
    check("-not $Elevated -and -not $NoElevated -and -not $FromInstaller" in ps,
          "prompt is skipped when a flag decided it or the install is silent")
    # Both flags forwarded through the UAC self-elevation relaunch (or the choice
    # is lost when the script re-runs elevated).
    check("if ($Elevated)       { $fwd += '-Elevated' }" in ps
          and "if ($NoElevated)     { $fwd += '-NoElevated' }" in ps,
          "-Elevated/-NoElevated forwarded across the elevation relaunch")


def test_tray_admin_toggle_wired():
    print("input_privilege: the tray exposes a discoverable 'Control admin windows' toggle")
    tray = open(os.path.join(HERE, "..", "agent", "win", "couchside-tray.pyw"),
                encoding="utf-8").read()
    check("def agent_elevated(" in tray and "def set_agent_elevated(" in tray,
          "tray reads + writes the elevated state")
    check("Control admin windows" in tray, "tray shows the labeled checkbox")
    check('"runas"' in tray, "enabling elevates via UAC (ShellExecute runas)")
    check("RunLevel %s" in tray and "Set-ScheduledTask" in tray,
          "re-registers the task RunLevel (Highest/Limited), preserving action+trigger")
    check("askyesno" in tray, "confirms before ENABLING (a security escalation)")


if __name__ == "__main__":
    test_privilege_shape_and_degrade_closed()
    test_never_raises()
    test_status_carries_input_privilege()
    test_install_elevated_flag_wired()
    test_tray_admin_toggle_wired()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all Windows input-privilege tests passed")
