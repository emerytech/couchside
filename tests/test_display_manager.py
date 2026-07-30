#!/usr/bin/env python3
"""Display-manager detection + the greetd boot-session writer.

Run: python3 tests/test_display_manager.py

WHY. Couchside's boot-session feature was SDDM-only, which covers Bazzite and
SteamOS and nothing else — while the custom-built Steam machines people actually
assemble (Arch/CachyOS + gamescope, ChimeraOS, a plain distro running Big
Picture) commonly use greetd, GDM or LightDM. On those the feature silently did
not exist.

Detection reads the symlink systemd already maintains,
/etc/systemd/system/display-manager.service, which names the ENABLED display
manager on any systemd distro. That beats guessing from /etc/os-release (a user
can install any DM anywhere) and beats probing config files (several can exist
while one DM is enabled).

The greetd writer is the risky half and most of these tests are about it: greetd
has NO drop-in directory, so unlike SDDM we must rewrite the user's single
config.toml in place. Every "preserves" and "refuses" case below exists because
mangling the file that decides whether a box boots is KI-038 with a bigger blast
radius.

NOT VERIFIED ON GREETD HARDWARE — no greetd box was reachable. Built against
greetd's documented format and these fixtures; the .desktop Exec lines ARE
verbatim from a real box.
"""
import importlib.util, sys, os, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s=importlib.util.spec_from_file_location('cs', os.path.join(ROOT,'agent','couchsided.py'))
cs=importlib.util.module_from_spec(s); sys.modules['cs']=cs; s.loader.exec_module(cs)
F=[]
def check(n,g,w):
    print(("  PASS  " if g==w else "  FAIL  ")+n+("" if g==w else " (got %r want %r)"%(g,w)))
    if g!=w: F.append(n)

print("DM detection off the systemd symlink")
d=tempfile.mkdtemp()
def link(target):
    p=os.path.join(d,"display-manager.service")
    if os.path.lexists(p): os.remove(p)
    if target: os.symlink(target, p)
    cs.DISPLAY_MANAGER_UNIT=p
for unit,want in [("/usr/lib/systemd/system/sddm.service","sddm"),
                  # VERBATIM from the CachyOS box (10.7.1.92, 2026-07-30):
                  # readlink -f -> /usr/lib/systemd/system/plasmalogin.service.
                  # plasmalogin not being detected here is the root of the
                  # fail-open bug: the backend fell back to "sddm if the grant
                  # exists", and install.sh wrote that grant unconditionally.
                  ("/usr/lib/systemd/system/plasmalogin.service","plasmalogin"),
                  ("/usr/lib/systemd/system/greetd.service","greetd"),
                  ("/usr/lib/systemd/system/gdm.service","gdm"),
                  ("/lib/systemd/system/gdm3.service","gdm"),
                  ("/usr/lib/systemd/system/lightdm.service","lightdm"),
                  ("/usr/lib/systemd/system/ly.service",None)]:
    os.makedirs(os.path.dirname(unit), exist_ok=True) if False else None
    link(unit); check("%-42s -> %s"%(os.path.basename(unit),want), cs.detect_display_manager(), want)
link(None); check("no symlink at all -> None (refuse, don't guess)", cs.detect_display_manager(), None)

print()
print("per-manager paths derive from the DETECTED manager, never a hardcode")
check("sddm drop-in dir", cs._dm_dropin("sddm"),
      "/etc/sddm.conf.d/zzz-couchside-session.conf")
check("plasmalogin drop-in dir", cs._dm_dropin("plasmalogin"),
      "/etc/plasmalogin.conf.d/zzz-couchside-session.conf")
check("unknown manager -> no path at all", cs._dm_dropin("ly"), "")

print()
print("restart-session retargets to the DETECTED manager (or disappears)")
STOCK = {"label": "Restart Session",
         "description": "Restart the display session (sddm), fixes a wedged/black screen",
         "danger": "high", "cmd": ["sudo", "systemctl", "restart", "sddm"],
         "user_env": False, "detached": False}
real_detect, real_sudo = cs.detect_display_manager, cs._sudo_nopasswd_allows
real_unit = cs._display_manager_unit_name
def reset(detect, grant_units, unit=None):
    cs.ACTIONS = {"restart-session": dict(STOCK, cmd=list(STOCK["cmd"]))}
    cs.ACTION_ORDER = ["restart-session", "reboot"]
    cs.WATCHLIST = [("sddm.service", "system"), ("couchside.service", "system")]
    cs.WATCHLIST_NAMES = {n for n, _ in cs.WATCHLIST}
    cs.detect_display_manager = lambda: detect
    # The real unit name usually equals the family name; gdm3 is the exception
    # the `unit` override exists for.
    cs._display_manager_unit_name = lambda: (unit if unit is not None
                                             else (detect or ""))
    cs._sudo_nopasswd_allows = lambda needle: needle in grant_units
try:
    # The CachyOS shape: plasmalogin enabled, NEW installer grant present.
    reset("plasmalogin", {"systemctl restart plasmalogin"})
    cs._retarget_restart_session(False)
    check("cmd now restarts plasmalogin",
          cs.ACTIONS["restart-session"]["cmd"],
          ["sudo", "systemctl", "restart", "plasmalogin"])
    check("watchlist follows the manager",
          ("plasmalogin.service", "system") in cs.WATCHLIST, True)
    check("sddm.service left the watchlist",
          ("sddm.service", "system") in cs.WATCHLIST, False)
    check("description names the real manager",
          "plasmalogin" in cs.ACTIONS["restart-session"]["description"], True)

    # The CachyOS shape TODAY (old installer): plasmalogin enabled, only the
    # stale sddm grant. Firing `systemctl restart sddm` there would START a
    # second display manager over the live session — the button must vanish.
    reset("plasmalogin", {"systemctl restart sddm"})
    cs._retarget_restart_session(False)
    check("stale sddm grant does NOT keep the button (fail closed)",
          "restart-session" in cs.ACTIONS, False)
    check("...and it leaves the action order",
          "restart-session" in cs.ACTION_ORDER, False)

    # Bazzite regression control: sddm detected, sddm grant -> untouched.
    reset("sddm", {"systemctl restart sddm"})
    cs._retarget_restart_session(False)
    check("sddm box keeps the stock action verbatim",
          cs.ACTIONS["restart-session"]["cmd"], STOCK["cmd"])
    check("sddm box keeps its watchlist",
          ("sddm.service", "system") in cs.WATCHLIST, True)

    # Unidentifiable manager: no unit worth aiming a rescue action at.
    reset(None, {"systemctl restart sddm"})
    cs._retarget_restart_session(False)
    check("unknown manager -> action removed", "restart-session" in cs.ACTIONS, False)

    # An owner-customised command is not ours to second-guess.
    reset("plasmalogin", {"systemctl restart plasmalogin"})
    cs.ACTIONS["restart-session"]["cmd"] = ["sudo", "systemctl", "restart", "my-kiosk"]
    cs._retarget_restart_session(False)
    check("customised cmd untouched",
          cs.ACTIONS["restart-session"]["cmd"],
          ["sudo", "systemctl", "restart", "my-kiosk"])

    # THE PLASMALOGIN STOCK SPELLING is stock too: a fresh new-installer box
    # writes ["sudo","systemctl","restart","plasmalogin"] into config.json, and
    # if that box later flips back to SDDM the action must retarget the other
    # way, not be classed owner-customised.
    reset("sddm", {"systemctl restart sddm"})
    cs.ACTIONS["restart-session"]["cmd"] = ["sudo", "systemctl", "restart", "plasmalogin"]
    cs._retarget_restart_session(False)
    check("plasmalogin-stock cmd retargets BACK to sddm",
          cs.ACTIONS["restart-session"]["cmd"], ["sudo", "systemctl", "restart", "sddm"])
    reset(None, {"systemctl restart sddm", "systemctl restart plasmalogin"})
    cs.ACTIONS["restart-session"]["cmd"] = ["sudo", "systemctl", "restart", "plasmalogin"]
    cs._retarget_restart_session(False)
    check("plasmalogin-stock cmd removed when no manager detected",
          "restart-session" in cs.ACTIONS, False)

    # gdm3: the FAMILY is "gdm" but the unit (and any real grant) says gdm3.
    # Probe and argv must both use the real spelling — probing the collapsed
    # name substring-matches a gdm3 grant and then aims sudo at "gdm", which
    # exact-argument matching refuses: a rescue button that fails every press.
    reset("gdm", {"systemctl restart gdm3"}, unit="gdm3")
    cs._retarget_restart_session(False)
    check("gdm3 box: argv uses the REAL unit",
          cs.ACTIONS["restart-session"]["cmd"], ["sudo", "systemctl", "restart", "gdm3"])
    check("gdm3 box: watchlist uses the real unit too",
          ("gdm3.service", "system") in cs.WATCHLIST, True)
    reset("gdm", {"systemctl restart gdm"}, unit="gdm3")
    cs._retarget_restart_session(False)
    check("grant naming only 'gdm' on a gdm3 box -> action removed (fail closed)",
          "restart-session" in cs.ACTIONS, False)

    # --mock keeps the stock action so the app stays exercisable off-box.
    reset(None, set())
    cs._retarget_restart_session(True)
    check("mock keeps the action", "restart-session" in cs.ACTIONS, True)
finally:
    cs.detect_display_manager, cs._sudo_nopasswd_allows = real_detect, real_sudo
    cs._display_manager_unit_name = real_unit

print()
print("_display_manager_unit_name: the real spelling, no family collapse")
d2=tempfile.mkdtemp()
def link2(target):
    p=os.path.join(d2,"display-manager.service")
    if os.path.lexists(p): os.remove(p)
    if target: os.symlink(target, p)
    cs.DISPLAY_MANAGER_UNIT=p
link2("/lib/systemd/system/gdm3.service")
check("gdm3 stays gdm3", cs._display_manager_unit_name(), "gdm3")
check("...while the family collapses", cs.detect_display_manager(), "gdm")
link2("/usr/lib/systemd/system/plasmalogin.service")
check("plasmalogin unit", cs._display_manager_unit_name(), "plasmalogin")
link2(None)
check("no symlink -> empty, not 'display-manager'", cs._display_manager_unit_name(), "")

print()
print("greetd config rewrite PRESERVES everything else")
EXISTING = '''[terminal]
vt = 1

[default_session]
command = "agreety --cmd /bin/sh"
user = "greeter"

[initial_session]
command = "gamescope-session-plus steam"
user = "deck"
'''
out = cs._greetd_compose(EXISTING, "startplasma-wayland", "deck")
check("terminal section survives byte-identical", "[terminal]\nvt = 1" in out, True)
check("default_session (the greeter) survives", 'command = "agreety --cmd /bin/sh"' in out, True)
check("initial_session command replaced", 'command = "startplasma-wayland"' in out, True)
check("old command is GONE", "gamescope-session-plus steam" in out, False)
check("user preserved", 'user = "deck"' in out, True)
check("exactly one [initial_session]", out.count("[initial_session]"), 1)

print()
print("appends when the box has no [initial_session] yet (greeter-only box)")
NOINIT = '[terminal]\nvt = 1\n\n[default_session]\ncommand = "agreety"\nuser = "greeter"\n'
out2 = cs._greetd_compose(NOINIT, "startplasma-wayland", "deck")
check("adds the table", out2.count("[initial_session]"), 1)
check("still preserves default_session", 'command = "agreety"' in out2, True)

print()
print("REFUSES rather than mangling")
check("two initial_session tables -> refuse",
      cs._greetd_compose(EXISTING + '\n[initial_session]\ncommand="x"\n', "a", "b"), None)
check("quote in command -> refuse", cs._greetd_compose(EXISTING, 'sh -c "x"', "deck"), None)
check("empty user -> refuse", cs._greetd_compose(EXISTING, "startplasma", ""), None)

print()
print("Exec= -> greetd command, from REAL measured .desktop lines")
sd=tempfile.mkdtemp()
open(os.path.join(sd,"plasma.desktop"),"w").write(
  "[Desktop Entry]\nName=Plasma\nExec=/usr/libexec/plasma-dbus-run-session-if-needed /usr/bin/startplasma-wayland\n")
open(os.path.join(sd,"withcodes.desktop"),"w").write("[Desktop Entry]\nExec=foo --bar %U\n")
open(os.path.join(sd,"noexec.desktop"),"w").write("[Desktop Entry]\nName=Broken\n")
cs._SESSION_DIRS=(sd,)
check("real plasma Exec parsed", cs._session_exec_command("plasma.desktop"),
      "/usr/libexec/plasma-dbus-run-session-if-needed /usr/bin/startplasma-wayland")
check("freedesktop field codes stripped", cs._session_exec_command("withcodes.desktop"), "foo --bar")
check("no Exec -> empty (caller refuses)", cs._session_exec_command("noexec.desktop"), "")
check("missing file -> empty", cs._session_exec_command("nope.desktop"), "")
print()
print("FAILED: "+", ".join(F) if F else "all greetd/DM tests passed")
sys.exit(1 if F else 0)
