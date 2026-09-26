#!/usr/bin/env python3
"""The token must survive an OS image update — and its absence must never make
the box unreachable (CLAUDE.md §4 "Reachability is protected").

Run: python3 tests/test_token_resilience.py

WHY. A Steam Deck user reported (SteamOS 3.8.28) that the update wiped /etc,
taking /etc/couchside/token with it while /var/lib/couchside/config.json
survived. The agent printed "cannot read token file" and exited 1; with
Restart=always the box crash-looped every 3 s — unreachable, /pair dead, no
way to re-pair. Reproduced 2026-09-26: a missing --token-file exited 1 in 0.5 s.

resolve_token() now (1) prefers the persisted state dir, (2) migrates a legacy
/etc token into it, (3) mints + persists a new token when none exists and KEEPS
SERVING, (4) falls back to an in-memory token if nothing is writable. Both
directions are asserted: the happy paths AND that the minted token authorizes
nobody (degrade closed) yet /api/ping and loopback /pair still answer.
"""
import http.client
import importlib.util
import os
import stat
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
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


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def _with_state_dir(fn):
    """Run fn(tmp, state_dir, legacy_file, cfg) with TOKEN_STATE_DIR/LEGACY
    redirected into a tmpdir so nothing touches the real box."""
    tmp = tempfile.mkdtemp()
    state = os.path.join(tmp, "state")
    legacy = os.path.join(tmp, "etc", "token")
    cfg = os.path.join(state, "config.json")
    os.makedirs(state, mode=0o700)
    open(cfg, "w").write("{}")
    saved = (cs.TOKEN_STATE_DIR, cs.LEGACY_TOKEN_FILE)
    cs.TOKEN_STATE_DIR, cs.LEGACY_TOKEN_FILE = state, legacy
    try:
        fn(tmp, state, legacy, cfg)
    finally:
        cs.TOKEN_STATE_DIR, cs.LEGACY_TOKEN_FILE = saved


def test_explicit_token_wins():
    print("test_explicit_token_wins")
    def body(tmp, state, legacy, cfg):
        tok, path, minted = cs.resolve_token(legacy, cfg, explicit_token="cli-token")
        check("explicit --token is used", tok, "cli-token")
        check("explicit token: no path, nothing written", (path, os.path.exists(os.path.join(state, "token"))), (None, False))
        check("explicit token: not minted", minted, False)
    _with_state_dir(body)


def test_state_dir_token_preferred():
    print("test_state_dir_token_preferred")
    def body(tmp, state, legacy, cfg):
        os.makedirs(os.path.dirname(legacy)); open(legacy, "w").write("legacy-token\n")
        open(os.path.join(state, "token"), "w").write("state-token\n")
        tok, path, minted = cs.resolve_token(legacy, cfg)
        check("state-dir token wins over legacy /etc", tok, "state-token")
        check("path is the state-dir file", path, os.path.join(state, "token"))
        check("not minted", minted, False)
    _with_state_dir(body)


def test_legacy_token_used_and_migrated():
    print("test_legacy_token_used_and_migrated")
    def body(tmp, state, legacy, cfg):
        os.makedirs(os.path.dirname(legacy)); open(legacy, "w").write("legacy-token\n")
        tok, path, minted = cs.resolve_token(legacy, cfg)
        check("legacy /etc token is used (existing pairings keep working)", tok, "legacy-token")
        sp = os.path.join(state, "token")
        check("legacy token MIGRATED into the state dir", cs._read_token_file(sp), "legacy-token")
        check("migrated copy is 0600", _mode(sp), 0o600)
        check("resolved path is now the state-dir copy (what /pair re-reads)", path, sp)
        check("not minted", minted, False)
    _with_state_dir(body)


def test_missing_everywhere_mints_and_persists():
    """THE user's case: /etc wiped, state dir intact but no token anywhere."""
    print("test_missing_everywhere_mints_and_persists")
    def body(tmp, state, legacy, cfg):
        tok, path, minted = cs.resolve_token(legacy, cfg)
        check("a token was minted (no exit, no exception)", bool(tok) and minted, True)
        check("minted token is 24-byte hex like install.sh's", len(tok) == 48 and all(c in "0123456789abcdef" for c in tok), True)
        sp = os.path.join(state, "token")
        check("minted token persisted to the state dir", cs._read_token_file(sp), tok)
        check("persisted 0600", _mode(sp), 0o600)
        check("resolved path is the persisted file", path, sp)
        # Second start: the minted token is FOUND, not re-minted (pairings stick).
        tok2, path2, minted2 = cs.resolve_token(legacy, cfg)
        check("next start reuses the persisted token", (tok2, minted2), (tok, False))
    _with_state_dir(body)


def test_nothing_writable_keeps_serving_in_memory():
    print("test_nothing_writable_keeps_serving_in_memory")
    if os.geteuid() == 0:
        print("  SKIP  running as root — permission bits do not bind")
        return
    def body(tmp, state, legacy, cfg):
        os.chmod(state, 0o500)                      # state dir read-only
        try:
            # legacy path's parent does not exist AND cannot be created: make
            # the parent's parent read-only too.
            os.makedirs(os.path.dirname(os.path.dirname(legacy)), exist_ok=True)
            os.chmod(os.path.dirname(os.path.dirname(legacy)), 0o500)
            tok, path, minted = cs.resolve_token(legacy, cfg)
            check("still returns a token (no crash) when nothing is writable", bool(tok) and minted, True)
            check("in-memory: no path", path, None)
        finally:
            os.chmod(state, 0o700)
            os.chmod(os.path.dirname(os.path.dirname(legacy)), 0o700)
    _with_state_dir(body)


def test_agent_serves_with_minted_token():
    """End to end: token file missing -> the server still answers /api/ping,
    the minted token authorizes /api/status, a made-up token does NOT, and the
    loopback /pair page carries the minted token so the owner can re-pair."""
    print("test_agent_serves_with_minted_token")
    def body(tmp, state, legacy, cfg):
        tok, path, minted = cs.resolve_token(legacy, cfg)
        cs.Handler.token, cs.Handler.token_file, cs.Handler.mock = tok, path, True
        srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
        cs.Handler.port = port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            def get(p, hdr=None):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request("GET", p, headers=hdr or {}); r = c.getresponse(); b = r.read().decode("utf-8", "replace"); c.close()
                return r.status, b
            check("/api/ping answers (reachable)", get("/api/ping")[0], 200)
            check("minted token authorizes /api/status", get("/api/status", {"Authorization": "Bearer " + tok})[0], 200)
            check("a guessed token is refused (degrade closed)", get("/api/status", {"Authorization": "Bearer " + "0" * 48})[0], 401)
            st, body_ = get("/pair")
            check("loopback /pair renders", st, 200)
            check("/pair carries the minted token for re-pairing", tok in body_, True)
        finally:
            srv.shutdown(); srv.server_close()
    _with_state_dir(body)


if __name__ == "__main__":
    for fn in (test_explicit_token_wins, test_state_dir_token_preferred,
               test_legacy_token_used_and_migrated, test_missing_everywhere_mints_and_persists,
               test_nothing_writable_keeps_serving_in_memory, test_agent_serves_with_minted_token):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
