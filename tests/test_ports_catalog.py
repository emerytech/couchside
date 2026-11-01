#!/usr/bin/env python3
"""Couchside-Ports catalogue parity + URL safety (agent side).

Run: python3 tests/test_ports_catalog.py

WHAT THIS GUARDS (CLAUDE.md §3 — the catalogue IS the allowlist):

  1. The agent's frozen `_PORTS` stays byte-for-field identical to the canonical
     `ports/index.json`. If the two drift, the app shows one thing and the box
     installs another — the exact class of bug §11 exists to stop.
  2. Every executable URL in the catalogue is https to a GitHub RELEASE asset.
     A phone never names a URL; the only thing ports_run executes is one of
     these, so they are the trust boundary and are pinned here.
  3. Each entry has the fields the install path and the app depend on
     (id/name/platforms/arch), and platforms are a non-empty known set.

Engines are redistributable; game dumps are never distributed. A port that
requires the player's own files MUST say so (requires_user_files + a prompt),
because the app surfaces that step and the legal line depends on it.
"""
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
KNOWN_PLATFORMS = {"steamos", "bazzite"}


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _norm(v):
    """Tuples (how _PORTS stores lists) compare equal to JSON arrays, deeply."""
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    return v


def _load_json_catalog():
    with open(os.path.join(ROOT, "ports", "index.json")) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
print("\nCouchside-Ports catalogue parity")
# ---------------------------------------------------------------------------

def test_agent_ports_match_index_json():
    """_PORTS == ports/index.json["ports"], field for field."""
    print("test_agent_ports_match_index_json")
    cat = _load_json_catalog()
    json_ports = {p["id"]: p for p in cat["ports"]}
    check("same set of ids", sorted(cs._PORTS_BY_ID), sorted(json_ports))
    for pid, jp in json_ports.items():
        ap = cs._PORTS_BY_ID.get(pid)
        if ap is None:
            check("agent has %s" % pid, False, True)
            continue
        # Compare the union of keys so an added-only-on-one-side field fails.
        keys = set(jp) | set(ap)
        for k in sorted(keys):
            check("%s.%s matches" % (pid, k), _norm(ap.get(k)), _norm(jp.get(k)))


def test_by_id_index_is_consistent():
    print("test_by_id_index_is_consistent")
    check("_PORTS_BY_ID keys == each port id",
          sorted(cs._PORTS_BY_ID),
          sorted(p["id"] for p in cs._PORTS))
    check("no duplicate ids",
          len(cs._PORTS), len({p["id"] for p in cs._PORTS}))


# ---------------------------------------------------------------------------
print("\nURL safety — the only things ports_run executes")
# ---------------------------------------------------------------------------

def test_every_bootstrap_url_is_pinned_github_release():
    print("test_every_bootstrap_url_is_pinned_github_release")
    for p in cs._PORTS:
        for mode in ("install", "uninstall"):
            step = p.get(mode)
            if not step:
                continue
            url = step.get("bootstrap_url")
            check("%s.%s is str" % (p["id"], mode), isinstance(url, str), True)
            check("%s.%s is https github release" % (p["id"], mode),
                  isinstance(url, str)
                  and url.startswith("https://github.com/")
                  and "/releases/download/" in url,
                  True)


def test_install_step_required_for_every_port():
    """A port with no install step could never be installed — and ports_run's
    frozen-URL check would refuse it (409). Catch it here instead."""
    print("test_install_step_required_for_every_port")
    for p in cs._PORTS:
        url = (p.get("install") or {}).get("bootstrap_url")
        check("%s has an install bootstrap_url" % p["id"], bool(url), True)


# ---------------------------------------------------------------------------
print("\nRequired fields + the bring-your-own-dump contract")
# ---------------------------------------------------------------------------

def test_required_fields_present():
    print("test_required_fields_present")
    for p in cs._PORTS:
        check("%s has id" % p.get("id"), bool(p.get("id")), True)
        check("%s has name" % p["id"], bool(p.get("name")), True)
        check("%s has arch" % p["id"], bool(p.get("arch")), True)
        plats = set(p.get("platforms", ()))
        check("%s platforms non-empty" % p["id"], bool(plats), True)
        check("%s platforms are known" % p["id"], plats <= KNOWN_PLATFORMS, True)


def test_byo_dump_ports_declare_it():
    """A port that needs the player's own files must say so AND carry a prompt,
    so the app can surface the step and the engine-only legal line holds."""
    print("test_byo_dump_ports_declare_it")
    for p in cs._PORTS:
        if p.get("requires_user_files"):
            check("%s requires_user_files -> has a prompt" % p["id"],
                  bool(p.get("user_files_prompt")), True)
    # couchside-bbport is the template and MUST be byo-dump (engine-only).
    bb = cs._PORTS_BY_ID.get("couchside-bbport")
    check("couchside-bbport present", bb is not None, True)
    if bb:
        check("couchside-bbport is byo-dump", bool(bb.get("requires_user_files")), True)


# ---------------------------------------------------------------------------
print("\nPublic catalogue shape (what GET /api/ports returns)")
# ---------------------------------------------------------------------------

def test_public_catalog_omits_nothing_the_app_needs_and_mock_installed_false():
    print("test_public_catalog_omits_nothing_the_app_needs_and_mock_installed_false")
    pub = cs.ports_catalog(mock=True)
    check("public catalog has every port", len(pub), len(cs._PORTS))
    for row in pub:
        for k in ("id", "name", "category", "description", "platforms", "arch",
                  "requires_user_files", "user_files_prompt", "setup_flow",
                  "installed"):
            check("%s row has %s" % (row["id"], k), k in row, True)
        check("%s installed False in mock" % row["id"], row["installed"], False)


if __name__ == "__main__":
    for fn in (test_agent_ports_match_index_json,
               test_by_id_index_is_consistent,
               test_every_bootstrap_url_is_pinned_github_release,
               test_install_step_required_for_every_port,
               test_required_fields_present,
               test_byo_dump_ports_declare_it,
               test_public_catalog_omits_nothing_the_app_needs_and_mock_installed_false):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
