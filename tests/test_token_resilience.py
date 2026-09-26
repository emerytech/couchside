#!/usr/bin/env python3
"""The pairing token must survive losing its file, and rotation must still revoke.

Run: python3 tests/test_token_resilience.py

WHY. A Steam Deck user (SteamOS 3.8.28) lost /etc/couchside/token across an OS
update while /var/lib/couchside survived. The agent printed "cannot read token
file" and exited 1; with Restart=always the box crash-looped every 3 s, so it was
unreachable and could not be re-paired (CLAUDE.md section 4). Reproduced
2026-09-26: a missing --token-file exited 1 in 0.5 s.

DESIGN under test (resolve_token): /etc/couchside/token stays CANONICAL because
every rotation path writes it; the agent keeps a 0600 MIRROR in the state dir and
falls back to it only when the canonical file is gone; with nothing readable it
mints, persists, and keeps serving. A first design read the mirror FIRST, which
would have kept a rotated-away token alive after `couchside new-token` or the
Decky plugin's Regenerate: revocation that does not revoke. test_rotation_is_honored
pins that shut, in both directions.
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


def _put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text + "\n")


def _box(fn):
    """fn(canonical, mirror) with TOKEN_STATE_DIR / LEGACY_TOKEN_FILE redirected
    into a tmpdir, so nothing touches a real box."""
    tmp = tempfile.mkdtemp()
    state = os.path.join(tmp, "var-lib-couchside")
    canonical = os.path.join(tmp, "etc-couchside", "token")
    os.makedirs(state, mode=0o700)
    saved = (cs.TOKEN_STATE_DIR, cs.LEGACY_TOKEN_FILE)
    cs.TOKEN_STATE_DIR, cs.LEGACY_TOKEN_FILE = state, canonical
    try:
        fn(canonical, os.path.join(state, "token"))
    finally:
        cs.TOKEN_STATE_DIR, cs.LEGACY_TOKEN_FILE = saved


def test_explicit_token_wins():
    print("test_explicit_token_wins")
    def body(canonical, mirror):
        _put(canonical, "etc-token")
        tok, path, minted = cs.resolve_token(canonical, explicit_token="cli-token")
        check("explicit --token is used", tok, "cli-token")
        check("explicit token: no path, mirror untouched", (path, os.path.exists(mirror)), (None, False))
        check("explicit token: not minted", minted, False)
    _box(body)


def test_canonical_wins_and_mirror_created():
    print("test_canonical_wins_and_mirror_created")
    def body(canonical, mirror):
        _put(canonical, "etc-token")
        tok, path, minted = cs.resolve_token(canonical)
        check("canonical /etc token is served", tok, "etc-token")
        check("path is the canonical file (what /pair re-reads)", path, canonical)
        check("mirror created with the same token", cs._read_token_file(mirror), "etc-token")
        check("mirror is 0600", _mode(mirror), 0o600)
        check("not minted", minted, False)
    _box(body)


def test_rotation_is_honored():
    """THE revocation guard. Mirror holds the OLD token, canonical the NEW one
    (what `couchside new-token` / Decky Regenerate leave behind before the
    restart). The agent must serve NEW and drag the mirror along."""
    print("test_rotation_is_honored")
    def body(canonical, mirror):
        _put(mirror, "old-revoked-token")
        _put(canonical, "new-rotated-token")
        tok, path, minted = cs.resolve_token(canonical)
        check("rotated (canonical) token is served", tok, "new-rotated-token")
        check("the revoked token is NOT served", tok != "old-revoked-token", True)
        check("mirror re-synced to the rotated token", cs._read_token_file(mirror), "new-rotated-token")
        check("path is canonical", path, canonical)
    _box(body)


def test_lost_canonical_falls_back_to_mirror():
    """The user's case on a box that had already been mirrored: the canonical
    file vanished; phones must stay paired."""
    print("test_lost_canonical_falls_back_to_mirror")
    def body(canonical, mirror):
        _put(mirror, "paired-token")
        tok, path, minted = cs.resolve_token(canonical)
        check("mirror token is served (phones stay paired)", tok, "paired-token")
        check("path is the mirror", path, mirror)
        check("not minted", minted, False)
        check("canonical is not recreated by the agent (not its file to write)", os.path.exists(canonical), False)
    _box(body)


def test_missing_everywhere_mints_and_persists():
    """The user's actual box (2.9.113 never mirrored): nothing anywhere."""
    print("test_missing_everywhere_mints_and_persists")
    def body(canonical, mirror):
        tok, path, minted = cs.resolve_token(canonical)
        check("a token was minted (no exit, no exception)", bool(tok) and minted, True)
        check("minted token is 24-byte hex like install.sh's",
              len(tok) == 48 and all(c in "0123456789abcdef" for c in tok), True)
        check("minted token persisted to the mirror", cs._read_token_file(mirror), tok)
        check("persisted 0600", _mode(mirror), 0o600)
        check("path is the mirror", path, mirror)
        tok2, _p2, minted2 = cs.resolve_token(canonical)
        check("next start reuses it (no re-mint, pairings stick)", (tok2, minted2), (tok, False))
    _box(body)


def test_nothing_writable_keeps_serving_in_memory():
    print("test_nothing_writable_keeps_serving_in_memory")
    if os.geteuid() == 0:
        print("  SKIP  running as root; permission bits do not bind")
        return
    def body(canonical, mirror):
        state = os.path.dirname(mirror)
        etc_parent = os.path.dirname(os.path.dirname(canonical))
        os.chmod(state, 0o500)
        os.chmod(etc_parent, 0o500)
        try:
            tok, path, minted = cs.resolve_token(canonical)
            check("still returns a token when nothing is writable", bool(tok) and minted, True)
            check("in-memory: no path", path, None)
        finally:
            os.chmod(state, 0o700)
            os.chmod(etc_parent, 0o700)
    _box(body)


def test_agent_serves_with_minted_token():
    """End to end: no token anywhere -> /api/ping answers, the minted token
    authorizes /api/status, a guessed one gets 401, loopback /pair carries the
    minted token so the owner can re-pair."""
    print("test_agent_serves_with_minted_token")
    def body(canonical, mirror):
        tok, path, _minted = cs.resolve_token(canonical)
        cs.Handler.token, cs.Handler.token_file, cs.Handler.mock = tok, path, True
        srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
        cs.Handler.port = port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            def get(p, hdr=None):
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request("GET", p, headers=hdr or {})
                r = c.getresponse()
                b = r.read().decode("utf-8", "replace")
                c.close()
                return r.status, b
            check("/api/ping answers (reachable)", get("/api/ping")[0], 200)
            check("minted token authorizes /api/status",
                  get("/api/status", {"Authorization": "Bearer " + tok})[0], 200)
            check("a guessed token is refused (degrade closed)",
                  get("/api/status", {"Authorization": "Bearer " + "0" * 48})[0], 401)
            st, page = get("/pair")
            check("loopback /pair renders", st, 200)
            check("/pair carries the minted token for re-pairing", tok in page, True)
        finally:
            srv.shutdown()
            srv.server_close()
    _box(body)


if __name__ == "__main__":
    for fn in (test_explicit_token_wins, test_canonical_wins_and_mirror_created,
               test_rotation_is_honored, test_lost_canonical_falls_back_to_mirror,
               test_missing_everywhere_mints_and_persists,
               test_nothing_writable_keeps_serving_in_memory,
               test_agent_serves_with_minted_token):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
