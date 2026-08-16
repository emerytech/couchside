#!/usr/bin/env python3
"""Every test file in tests/ actually RUNS in CI.

Run: python3 tests/test_ci_wiring.py

WHY THIS EXISTS: on 2026-08-01, eight suites in this directory were found to
have never once gated a push. They were written, reviewed, committed — and the
matching step in .github/workflows/ci.yml was never added, so they sat green on
somebody's laptop and red nowhere.

    test_upload.py        auth + traversal containment on POST /api/upload
    test_steam_goto.py    the frozen steam:// destination table
    test_game_stop.py     the no-argument signature that keeps stop-my-game
                          from becoming remote kill-anything
    test_bigpicture.py    couchmode exclusivity + the spawn-counter refusal
    test_box_battery.py, test_mem_pressure.py, test_steam_cover_art.py,
    test_guide_unreadable_reason.py

Three of those are the security-shaped suites CLAUDE.md §6 requires for a route
that takes client input. The guard existed. It was not guarding. That is worse
than no guard, because the checklist item was ticked.

This is the cheapest possible fix for the whole class: adding a test file
without wiring it is now itself a failing test. It is deliberately dumb — a
substring search for the filename in the workflow — because anything cleverer
(parsing the YAML, resolving shell) has its own way of being wrong, and the
failure mode of dumb-and-textual is a false alarm, not a false pass.
"""
import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# Read every workflow, not just ci.yml: a suite wired into any of them runs.
blob = ""
for fn in sorted(os.listdir(WORKFLOWS)):
    if fn.endswith((".yml", ".yaml")):
        with open(os.path.join(WORKFLOWS, fn)) as f:
            blob += f.read()

suites = sorted(fn for fn in os.listdir(TESTS)
                if re.match(r"^test_.*\.(py|sh)$", fn))

print("every suite in tests/ is referenced by a workflow")
print("  (%d suites found)" % len(suites))

orphans = [fn for fn in suites if fn not in blob]
for fn in orphans:
    print("  FAIL  %s is never run by any workflow" % fn)
check("no orphaned suites", orphans, [])

# The reverse direction, which is the half that actually bites: a step that
# names a file that no longer exists would go green forever on a nonexistent
# path only if the runner ignored the error — it does not, `python3 missing.py`
# exits 2 — but a RENAMED suite leaves a stale step whose failure reads as a
# broken test rather than a broken reference. Catch it here where the message
# is unambiguous.
referenced = set(re.findall(r"tests/(test_[A-Za-z0-9_]+\.(?:py|sh))", blob))
missing = sorted(f for f in referenced if not os.path.exists(os.path.join(TESTS, f)))
for fn in missing:
    print("  FAIL  a workflow runs tests/%s, which does not exist" % fn)
check("no workflow step points at a deleted suite", missing, [])

# This file only means something if it is itself wired in. A guard that does
# not run is exactly the bug it was written for.
check("this guard itself runs in CI", "test_ci_wiring.py" in blob, True)

# An unquoted ": " inside a step name is a YAML mapping, not text. Writing
#     - name: Unit tests (upload: auth + path containment)
# makes the whole workflow unparseable, and the failure mode is the worst one
# available: GitHub cannot start the run at all, so nothing goes red — the
# checks simply do not appear. Hit while writing this very commit.
#
# Checked textually rather than by importing yaml, because the tests here are
# stdlib-only (CLAUDE.md §5) and because the rule is exact: a colon-space in an
# unquoted scalar is always this bug.
print()
print("no step name contains an unquoted ': ' (it would break the whole file)")
bad_names = []
for fn in sorted(os.listdir(WORKFLOWS)):
    if not fn.endswith((".yml", ".yaml")):
        continue
    with open(os.path.join(WORKFLOWS, fn)) as f:
        for i, line in enumerate(f, 1):
            m = re.match(r"\s*-?\s*name:\s+(.*?)\s*$", line)
            if not m:
                continue
            val = m.group(1)
            if val[:1] in ("'", '"'):      # quoted is fine, that is the escape
                continue
            if ": " in val:
                bad_names.append("%s:%d  %s" % (fn, i, val))
for b in bad_names:
    print("  FAIL  %s" % b)
check("no unquoted colon-space in a step name", bad_names, [])


# A guard that cannot fail is the same class of bug as a suite that never runs,
# so it belongs in this file. An assertion of the form `check(<expr> or True, …)`
# is unconditionally true; found live in tests/test_steam_menus.py, where
# "caps dict is built at boot" stayed GREEN with set_caps() stubbed out entirely
# (measured 2026-08-16, both states). The author neutered a real failure instead
# of fixing it — CAPS is {} until set_caps() runs.
#
# AST, not a regex, and the first attempt here is exactly why: a textual scan
# cannot tell code from prose, so it flagged this very comment, its own check()
# call below, and the docstring in test_steam_menus.py that quotes the old line
# to explain it. Parsing matches real call sites only. It also stays narrow by
# construction — the legitimate stub idiom `lambda n: (seen.append(n) or True)`
# in tests/test_flatpak_update.py is not a check() argument, so it never matches.
print()
print("no assertion is neutered with `or True`")
neutered = []
for fn in sorted(f for f in os.listdir(TESTS) if f.endswith(".py")):
    path = os.path.join(TESTS, fn)
    with open(path) as f:
        try:
            tree = ast.parse(f.read(), filename=fn)
        except SyntaxError as e:            # a suite that cannot parse is its own failure
            neutered.append("%s: does not parse (%s)" % (fn, e))
            continue
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "check"):
            continue
        for arg in node.args:
            # `X or True` — a BoolOp whose last operand is the literal True.
            if (isinstance(arg, ast.BoolOp) and isinstance(arg.op, ast.Or)
                    and isinstance(arg.values[-1], ast.Constant)
                    and arg.values[-1].value is True):
                neutered.append("%s:%d  check(... or True, ...)" % (fn, node.lineno))
for n in neutered:
    print("  FAIL  %s" % n)
check("no check(... or True ...) in tests/", neutered, [])

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    print()
    print("Fix: add a step to .github/workflows/ci.yml running the suite, with a")
    print("comment saying WHY the suite exists — matching the steps around it.")
    sys.exit(1)
print("all CI wiring tests passed")
