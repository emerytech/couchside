#!/usr/bin/env python3
"""The Play release-notes script reads its own work back.

Run: python3 tests/test_play_release_notes.py

WHY THIS EXISTS: the script used to print OK on the strength of the
`:commit` call returning 200, which says Play ACCEPTED the edit — not that the
listing now shows what we sent. CLAUDE.md §11.4 exists because this repo has
already published a stale changelog and exited 0. So the script now reads the
notes back off Play, and this pins the three outcomes it must distinguish:

    match       -> success
    mismatch    -> HARD FAIL (wrong text on a live store listing)
    unreadable  -> WARN ONLY

That last one is the subtle one and the reason api_soft() exists. By the time
the readback runs the notes are ALREADY committed, so a transient 500 must not
be reported as a failed release. The write path still uses api(), which exits —
correct there, wrong here.

NO NETWORK. api_soft is replaced with a recorder, so these tests assert the
script's decisions, not Google's behaviour.

`cryptography` is stubbed rather than required: CI installs no pip packages, and
a test that could only run where that wheel happens to exist would be a test
that quietly does not run. Only the pure decision logic is exercised, which
needs none of it.
"""
import importlib.util
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- stub cryptography so the module imports anywhere -----------------------
for name in ("cryptography", "cryptography.hazmat",
             "cryptography.hazmat.primitives",
             "cryptography.hazmat.primitives.asymmetric"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["cryptography.hazmat.primitives"].hashes = types.SimpleNamespace()
sys.modules["cryptography.hazmat.primitives"].serialization = types.SimpleNamespace()
sys.modules["cryptography.hazmat.primitives.asymmetric"].padding = types.SimpleNamespace()

_spec = importlib.util.spec_from_file_location(
    "play_release_notes", os.path.join(ROOT, "scripts", "play-release-notes.py"))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --- notes_match: round-trip artifacts are not differences ------------------

print("notes_match ignores round-trip noise and nothing else")
SENT = "Fixes the big one.\n\nAlso: a second paragraph."
check("identical text matches", P.notes_match(SENT, SENT), True)
check("CRLF from the server still matches",
      P.notes_match(SENT, SENT.replace("\n", "\r\n")), True)
check("trailing spaces on a line still match",
      P.notes_match(SENT, "Fixes the big one.   \n\nAlso: a second paragraph. "), True)
check("leading/trailing blank lines still match",
      P.notes_match(SENT, "\n" + SENT + "\n\n"), True)
# The controls — differences that MUST fail, including the one that actually
# happened once (stale notes from the previous release).
check("truncated text does NOT match",
      P.notes_match(SENT, SENT[:20]), False)
check("empty text does NOT match", P.notes_match(SENT, ""), False)
check("a different release's notes do NOT match",
      P.notes_match(SENT, "Fixes a bug where the app could stop responding."), False)
check("internal whitespace still counts",
      P.notes_match("a\nb", "ab"), False)


# --- read_back_notes: outcomes, and cleanup on every path -------------------

def install_recorder(script):
    """Replace api_soft with a scripted responder; return the call log."""
    calls = []

    def fake(token, method, path, payload=None):
        calls.append((method, path))
        for m, frag, resp in script:
            if m == method and frag in path:
                return resp
        return True, {}

    P.api_soft = fake
    return calls


print()
print("read_back_notes returns what Play actually has")
calls = install_recorder([
    ("POST", "/edits", (True, {"id": "edit-1"})),
    ("GET", "/tracks/production", (True, {"releases": [
        {"versionCodes": ["70"], "releaseNotes": [{"language": "en-US", "text": "hello"}]},
    ]})),
])
text, why = P.read_back_notes("tok", "production", 70, "en-US")
check("the stored text comes back", text, "hello")
check("no failure reason", why, None)
check("the throwaway edit is DELETED", ("DELETE", "/edits/edit-1") in calls, True)

print()
print("a release with NO notes for that language is a real failure, not unmeasurable")
# This is the empty "What's new" the whole script exists to prevent, so it must
# come back as text (which will mismatch and hard-fail), never as a warn-only
# "could not check".
calls = install_recorder([
    ("POST", "/edits", (True, {"id": "edit-2"})),
    ("GET", "/tracks/production", (True, {"releases": [
        {"versionCodes": ["70"], "releaseNotes": [{"language": "de-DE", "text": "hallo"}]},
    ]})),
])
text, why = P.read_back_notes("tok", "production", 70, "en-US")
check("returns empty text, not a reason", (text, why), ("", None))
check("...and the caller would hard-fail on it", P.notes_match("hello", text), False)
check("the edit is still deleted", ("DELETE", "/edits/edit-2") in calls, True)

print()
print("versionCode absent from the track is reported, not silently passed")
calls = install_recorder([
    ("POST", "/edits", (True, {"id": "edit-3"})),
    ("GET", "/tracks/production", (True, {"releases": [
        {"versionCodes": ["69"], "releaseNotes": [{"language": "en-US", "text": "old"}]},
    ]})),
])
text, why = P.read_back_notes("tok", "production", 70, "en-US")
check("no text", text, None)
check("a reason naming the versionCode", "70" in (why or ""), True)
check("the edit is still deleted", ("DELETE", "/edits/edit-3") in calls, True)

print()
print("a transport failure is UNREADABLE (warn), never a mismatch (fail)")
calls = install_recorder([
    ("POST", "/edits", (True, {"id": "edit-4"})),
    ("GET", "/tracks/production", (False, "GET /tracks -> 503 backend error")),
])
text, why = P.read_back_notes("tok", "production", 70, "en-US")
check("no text is returned", text, None)
check("the reason is surfaced", "503" in (why or ""), True)
# THE POINT: text is None, so main() takes the WARN branch. If this ever
# returned "" instead, a 503 would print a hard failure for a release that
# actually shipped fine.
check("None (warn) is distinguishable from '' (fail)", text is None, True)
check("the edit is deleted even on the failure path",
      ("DELETE", "/edits/edit-4") in calls, True)

print()
print("if the edit itself cannot be opened, nothing is left behind")
calls = install_recorder([
    ("POST", "/edits", (False, "POST /edits -> 401 unauthorized")),
])
text, why = P.read_back_notes("tok", "production", 70, "en-US")
check("no text", text, None)
check("the reason is surfaced", "401" in (why or ""), True)
check("no DELETE attempted for an edit that never opened",
      any(m == "DELETE" for m, _ in calls), False)

print()
print("api_soft never exits (the whole reason it exists)")
# api() calls sys.exit on HTTPError, which is correct on the write path and
# catastrophic after the commit. Assert the two are genuinely different.
import inspect
soft_src = inspect.getsource(P.api_soft)
hard_src = inspect.getsource(P.api)
check("api() does exit on error", "sys.exit" in hard_src, True)
check("api_soft() does NOT", "sys.exit" in soft_src, False)

print()
if FAILURES:
    print("FAILED: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("all play-release-notes tests passed")
