#!/usr/bin/env python3
"""Tests for Steam cover-art resolution (_steam_cover).

Run: python3 tests/test_steam_cover_art.py

WHY THIS EXISTS: the resolver looked for library_600x900.jpg and nothing else.
MEASURED on a Legion Go S, 2026-07-22: 30 of 80 INSTALLED games -- The Witcher
3, GTA V, RimWorld, Stray -- rendered the blank text card while their real
capsule sat on disk one directory deeper, under a content-hash subdirectory
that the resolver never looked in. Nothing had to be fetched from the internet.

Note the correction embedded here: an earlier count of "826 header vs 386
portrait" was taken across the whole librarycache, which includes every game in
the LIBRARY, not the installed ones, and its header-only entries turned out to
be Steam runtimes that never appear as launchers at all. The number that
mattered was the installed one, and it pointed at a different cause.

The KIND is as load-bearing as the path. Portrait is 600x900 and fills a tile;
header is 460x215 and does not. Returning a header while claiming portrait
would centre-crop a banner into a tall tile, which looks worse than the clean
fallback -- so "does a header-only game report kind=header" is asserted
explicitly, not assumed from the path.

SECURITY: this widened a filename set, which is exactly the kind of change that
turns into a path escape if it drifts into a glob or a client-supplied name.
The last three tests exist to catch that, and they are the ones to keep if
anything here is ever trimmed.
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


class Cache:
    """A fake Steam root the REAL resolver walks."""

    def __init__(self, files):
        self.dir = tempfile.mkdtemp(prefix="steamroot-")
        self.cache = os.path.join(self.dir, "appcache", "librarycache")
        os.makedirs(self.cache)
        for rel in files:
            p = os.path.join(self.cache, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(b"\xff\xd8\xff")      # enough to be a file
        self._old = cs._steam_root
        cs._steam_root = lambda: self.dir

    def close(self):
        cs._steam_root = self._old
        shutil.rmtree(self.dir, ignore_errors=True)


def test_hashed_layout_found():
    """THE case this fix exists for: current Steam nests the named file inside a
    content-hash directory. Real path shape, from the Witcher 3 entry on the
    Legion Go S."""
    print("test_hashed_layout_found")
    c = Cache(["292030/fe26986a2bd1601004ef0e4e1dfadd02948e3897/library_600x900.jpg",
               "292030/9ea69a715e85617cf408e1392c27b50fc2c51750/library_header.jpg"])
    try:
        path, kind = cs._steam_cover("292030")
        check("kind", kind, "portrait")
        check("reached into the hash dir", os.path.basename(path),
              "library_600x900.jpg")
    finally:
        c.close()


def test_library_capsule_is_portrait():
    """library_capsule.jpg measured 300x450 on hardware -- same 2:3 as the
    600x900 capsule. RimWorld and Stray ship ONLY this one."""
    print("test_library_capsule_is_portrait")
    c = Cache(["294100/644bff2fcf3a104d1e022b53a7f9c8c58af91c8a/library_capsule.jpg",
               "294100/88d319d95e4762c667668567b611ccbf50039a25/library_header.jpg"])
    try:
        path, kind = cs._steam_cover("294100")
        check("capsule wins over header", kind, "portrait")
        check("path", os.path.basename(path), "library_capsule.jpg")
    finally:
        c.close()


def test_portrait_beats_header_across_layouts():
    """A nested portrait must beat a top-level header. Ordering the loop the
    other way round would demote a real capsule to a banner."""
    print("test_portrait_beats_header_across_layouts")
    c = Cache(["440/header.jpg", "440/abc123/library_600x900.jpg"])
    try:
        _, kind = cs._steam_cover("440")
        check("portrait still wins", kind, "portrait")
    finally:
        c.close()


def test_portrait_preferred():
    """A game with BOTH must report the portrait capsule."""
    print("test_portrait_preferred")
    c = Cache(["440/library_600x900.jpg", "440/header.jpg"])
    try:
        path, kind = cs._steam_cover("440")
        check("kind", kind, "portrait")
        check("path is the capsule", os.path.basename(path), "library_600x900.jpg")
    finally:
        c.close()


def test_header_only_reports_header():
    """THE case this feature exists for -- and it must NOT claim portrait."""
    print("test_header_only_reports_header")
    c = Cache(["620/header.jpg"])
    try:
        path, kind = cs._steam_cover("620")
        check("found art at all", path is not None, True)
        check("kind is header, not portrait", kind, "header")
    finally:
        c.close()


def test_flat_layout_still_works():
    """The pre-2023 flat naming must not regress."""
    print("test_flat_layout_still_works")
    c = Cache(["570_library_600x900.jpg"])
    try:
        _, kind = cs._steam_cover("570")
        check("flat portrait", kind, "portrait")
    finally:
        c.close()

    c = Cache(["570_header.jpg"])
    try:
        _, kind = cs._steam_cover("570")
        check("flat header", kind, "header")
    finally:
        c.close()


def test_no_art_is_none():
    """No art must be (None, None) -- the app's text card, not a broken image."""
    print("test_no_art_is_none")
    c = Cache(["440/library_hero.jpg"])     # present but not a shape we serve
    try:
        check("nothing usable", cs._steam_cover("440"), (None, None))
    finally:
        c.close()


def test_portrait_only_helper_never_returns_a_header():
    """_steam_cover_path() is the NARROW lookup; callers that want a capsule
    must not silently receive a banner now that the table is wider."""
    print("test_portrait_only_helper_never_returns_a_header")
    c = Cache(["620/header.jpg"])
    try:
        check("portrait-only helper says no", cs._steam_cover_path("620"), None)
        check("but the wide one finds it", cs._steam_cover("620")[1], "header")
    finally:
        c.close()


def test_non_digit_appid_rejected():
    """Reject rather than sanitise (CLAUDE.md 3.6)."""
    print("test_non_digit_appid_rejected")
    c = Cache(["440/header.jpg"])
    try:
        for bad in ("../440", "44 0", "", "abc", "440/../440", None, 440):
            check("appid %r rejected" % (bad,), cs._steam_cover(bad), (None, None))
    finally:
        c.close()


def test_traversal_cannot_escape_the_cache():
    """A path built from the candidate table must stay inside the cache dir.

    Belt and braces: appid is already digits-only so this cannot fire today.
    It is here because widening the candidate table is exactly how that stops
    being true -- if someone adds a template with a '..' in it, this fails."""
    print("test_traversal_cannot_escape_the_cache")
    c = Cache(["440/header.jpg"])
    try:
        # One level above the cache dir, i.e. <root>/appcache/440.jpg — a real
        # file the escaping template would resolve to if the guard were absent.
        outside = os.path.join(c.dir, "appcache", "440.jpg")
        with open(outside, "wb") as f:
            f.write(b"nope")
        old = cs._STEAM_ART_CANDIDATES
        cs._STEAM_ART_CANDIDATES = (("../440.jpg", "portrait"),)
        try:
            check("escaping candidate refused", cs._steam_cover("440"), (None, None))
        finally:
            cs._STEAM_ART_CANDIDATES = old
    finally:
        c.close()


def test_every_candidate_is_a_plain_literal():
    """No globs, no separators, no templating (CLAUDE.md 3.3). The subdirectory
    scan is the only dynamic part of the lookup; the FILENAME must stay a
    literal so nothing client-shaped can ever reach the path."""
    print("test_every_candidate_is_a_plain_literal")
    for name, kind in cs._STEAM_ART_CANDIDATES:
        check("%r has no wildcard" % name,
              any(ch in name for ch in "*?["), False)
        check("%r has no separator" % name,
              ("/" in name or "\\" in name or ".." in name), False)
        check("%r has no format slot" % name, "%" in name, False)
        check("%r kind is known" % name, kind in ("portrait", "header"), True)


def test_subdir_scan_is_bounded():
    """A cache directory with thousands of entries must not turn one cover
    lookup into an unbounded walk."""
    print("test_subdir_scan_is_bounded")
    check("cap exists and is sane",
          0 < cs._STEAM_ART_MAX_SUBDIRS <= 200, True)


def test_missing_steam_root_degrades_closed():
    """No Steam at all must not raise."""
    print("test_missing_steam_root_degrades_closed")
    old = cs._steam_root
    cs._steam_root = lambda: None
    try:
        check("no root -> no art", cs._steam_cover("440"), (None, None))
    finally:
        cs._steam_root = old


if __name__ == "__main__":
    for fn in (test_hashed_layout_found,
               test_library_capsule_is_portrait,
               test_portrait_beats_header_across_layouts,
               test_portrait_preferred,
               test_header_only_reports_header,
               test_flat_layout_still_works,
               test_no_art_is_none,
               test_portrait_only_helper_never_returns_a_header,
               test_non_digit_appid_rejected,
               test_traversal_cannot_escape_the_cache,
               test_every_candidate_is_a_plain_literal,
               test_subdir_scan_is_bounded,
               test_missing_steam_root_degrades_closed):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
