#!/usr/bin/env python3
"""The README's security model lists every root grant install.sh actually writes.

Run: python3 tests/test_readme_sudo_grants.py

WHY THIS EXISTS: on 2026-08-01 the README said the installer grants "exactly six
fixed-argument commands" and named them. install.sh wrote NINE, and the three it
did not name included TWO ROOT-OWNED FILE WRITES (`tee` of the boot-session
drop-in, and of the legacy SDDM path). It also still named a hardcoded `sddm`,
months after the grant became the DETECTED display manager, and it did not
mention the privileged helper at all -- a root process the installer places.

That is the one document a person reads to decide whether to run
`curl … | bash` on their gaming machine. Undercounting root access there is not
a docs nit; the file is the trust surface. Prose drifts silently because nothing
compiles it, so this test compiles it.

DELIBERATELY DUMB, like tests/test_ci_wiring.py: it extracts the grants from
install.sh textually and checks the README mentions each one's distinctive
token. Dumb-and-textual fails toward a FALSE ALARM (someone reworded the README
and must adjust a token here), never toward a false pass, which is the only
direction that matters for this file.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


with open(os.path.join(ROOT, "install.sh")) as f:
    install = f.read()
with open(os.path.join(ROOT, "README.md")) as f:
    readme = f.read()
readme_l = readme.lower()

# Every NOPASSWD line install.sh writes into the sudoers file.
#
# The OPT-IN wrappers (system updates) are emitted from a shell conditional:
#     $([ -x "$WRAP" ] && echo "$(id -un) ALL=(root) NOPASSWD: $WRAP")
# so they must be filtered on the whole LINE. Filtering on the captured command
# does not work -- the capture there is `$WRAP")`, which starts with neither
# `$([` nor anything else stable. (First version of this test did exactly that
# and reported two phantom missing grants.) They are documented as their own
# paragraph rather than by name, because the paths are computed at install time.
base = []
for line in install.splitlines():
    if "NOPASSWD:" not in line:
        continue
    if line.lstrip().startswith("$(["):
        continue                                   # opt-in wrapper, see above
    base.append(line.split("NOPASSWD:", 1)[1].strip())

print("install.sh writes %d base grants (plus the opt-in wrappers)" % len(base))
for g in base:
    print("    %s" % g)
print()

# A pin, so a NEW grant is noticed even if someone finds a clever way to word it.
# If you add a grant: document it in README's security section, then bump this.
check("the base grant count is what the README describes", len(base), 9)

print()
print("every grant's distinctive token appears in the README")


def token(cmd):
    """The substring the README must contain for this grant to count as named."""
    if "/tee " in cmd:
        return os.path.basename(cmd.split()[-1])        # zzz-couchside-session.conf
    if "JOURNAL_WRAPPER" in cmd:
        return "journal"
    if "systemctl" in cmd:
        rest = cmd.split("systemctl", 1)[1].strip()     # "restart --no-block couchside.service"
        if "$DM_NAME" in rest:
            # The unit name is resolved at install time, so there is no literal
            # to match. Checked separately below, as prose.
            return None
        return rest
    return cmd


for g in base:
    t = token(g)
    if t is None:
        continue
    check("README names %r" % t, t.lower() in readme_l, True)

print()
print("the parts that are prose, not literals")
# The display-manager grant is dynamic, so assert the README explains THAT
# rather than naming a unit -- and specifically that it no longer claims sddm.
check("README says the display manager is detected, not assumed",
      "detected" in readme_l and "display manager" in readme_l, True)
check("README no longer hardcodes `systemctl restart sddm`",
      "systemctl restart sddm" in readme_l, False)
# The tee grants are root-owned FILE WRITES. The old text implied there were
# none, which is the most misleading thing about the old count.
check("README says the tee grants write as root",
      "root-owned file write" in readme_l, True)
check("README says each tee names one exact path",
      "one exact path" in readme_l or "one fixed file path" in readme_l, True)

print()
print("the privileged helper is documented at all")
# install.sh places a ROOT process; a security section that never mentions it is
# incomplete regardless of how good the sudoers list is.
installs_helper = "couchside-helper" in install
check("install.sh does place the helper (else this section is moot)",
      installs_helper, True)
if installs_helper:
    check("README mentions the helper", "couchside-helper" in readme_l, True)
    check("...and that it is root", "root process" in readme_l, True)
    check("...and names its auth: SO_PEERCRED", "so_peercred" in readme_l, True)
    check("...and that the verb table is frozen/closed",
          "frozen verb table" in readme_l, True)
    check("...and that the socket is local, not networked",
          "unix socket" in readme_l, True)

print()
print("the helper's verb table, as the README spells it out")
# WHY: the helper's VERBS dict IS the closed set of root operations a process
# on the box can reach, and the README paragraph that names them is what a
# person audits before running `curl … | bash`. The count is spelled out in
# prose ("of eight entries"), so nothing compiled it: helper 1.1.0 (2026-09-06)
# added `decky.loader` and the README would have kept saying "eight" forever.
# This imports the helper's real table and holds the README to it, key by key
# and count word by count word — the same dumb-and-textual shape as the grant
# checks above (a reword fails toward a FALSE ALARM, never a false pass).
import importlib.util
_hspec = importlib.util.spec_from_file_location(
    "couchside_helper", os.path.join(ROOT, "agent", "couchside-helper.py"))
_helper = importlib.util.module_from_spec(_hspec)
sys.modules["couchside_helper"] = _helper
_hspec.loader.exec_module(_helper)
VERBS = _helper.VERBS
NUMBER_WORDS = {5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
                11: "eleven", 12: "twelve"}

# The helper paragraph = the blank-line-delimited block holding the phrase
# the check above already requires ("frozen verb table").
paragraph = ""
for block in readme.split("\n\n"):
    if "frozen verb table" in block.lower():
        paragraph = block
        break
check("the helper paragraph exists", bool(paragraph), True)
for verb in sorted(VERBS):
    check("README's helper paragraph names `%s`" % verb, "`%s`" % verb in paragraph, True)
m = re.search(r"frozen verb table\*\*\s+of\s+(\w+)\s+entries", paragraph)
check("the count is spelled out next to 'frozen verb table'", bool(m), True)
check("...and the word matches len(VERBS) == %d" % len(VERBS),
      m.group(1).lower() if m else None, NUMBER_WORDS.get(len(VERBS)))

print()
print("the Decky opt-in (helper 1.1.0 / agent 2.9.105) is documented")
# install.sh writes a second opt-in sudoers file for Decky management; its
# two grant lines take the `$([` shape and are filtered above (base pin stays
# 9). The README must still name the switch, the root wrapper it enables, and
# the grant file — that is the whole point of the filter: opt-in wrappers are
# documented as prose, and this is the prose.
installs_decky = "allow-decky" in install and "couchside-decky-loader" in install
check("install.sh does ship the Decky opt-in (else this section is moot)",
      installs_decky, True)
if installs_decky:
    check("README names the `couchside allow-decky` switch", "allow-decky" in readme, True)
    check("README names the root wrapper couchside-decky-loader",
          "couchside-decky-loader" in readme, True)
    check("README names the grant file zz-couchside-decky", "zz-couchside-decky" in readme, True)
    check("install.sh's decky grant lines are the filtered `$([` opt-in shape (base pin unchanged)",
          all(ln.lstrip().startswith("$([") for ln in install.splitlines()
              if "NOPASSWD:" in ln and "couchside-decky-loader@" in ln), True)
    check("...and there are two of them (install + uninstall units)",
          sum(1 for ln in install.splitlines()
              if "NOPASSWD:" in ln and "couchside-decky-loader@" in ln), 2)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    print()
    print("The README's `## Security model` section must describe every root")
    print("grant install.sh writes. If you changed the grants, update the")
    print("README in the SAME commit -- that section is why people trust")
    print("`curl … | bash` on a machine that holds their whole game library.")
    sys.exit(1)
print("all README sudo-grant tests passed")
