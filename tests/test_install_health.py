#!/usr/bin/env python3
"""install_health: report the root-owned install pieces an OS update took away.

Run: python3 tests/test_install_health.py

WHY. On the maintainer's Steam Deck OLED (SteamOS 3.8.24) /etc/couchside/, every
/etc/udev/rules.d/99-couchside-*.rules and /etc/modules-load.d/couchside-uinput.conf
were gone for a month (2026-08-26 on) while /etc/systemd/system/couchside.service
and /var/lib/couchside survived. Nothing said so: the gamepad, scheduled wake and
the journal just degraded. /api/status now carries
    "install_health": {"ok": bool, "missing": [ids], "unknown": [ids]}
and the app tells the owner to re-run the installer.

Every rule is exercised in BOTH directions (CLAUDE.md section 11): all present ->
ok; each piece removed -> exactly that id missing; could-not-look -> unknown and
NEVER ok. The file checks run against a tmp tree through the module-constant
paths; `sudo` is never really run -- subprocess.run is stubbed.

Fixture note: the stat checks parse nothing. LISTING_DECK is VERBATIM `sudo -n -l`
output off the Steam Deck OLED (SteamOS 3.9.2, 2026-09-26) with its Couchside
grant gone -- it lists (rc 0, SteamOS ships NOPASSWD rules of its own for `deck`)
but no longer names our wrapper. Running this branch's install_health_compute()
read-only on that Deck returned exactly the `missing` list asserted in
test_the_deck_case_whole_etc_dir_gone; with the expected set narrowed to the one
piece that survived there (the unit) it returned ok -- the hardware control.
LISTING_GRANTED is SYNTHETIC (no box with the grant was reachable today): the
same layout with install.sh's rules appended last, as zz- ordering puts them.
"""
import http.client
import importlib.util
import os
import shutil
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


ALL_IDS = list(cs._INSTALL_PIECE_IDS)
FILE_IDS = [p for p in ALL_IDS if p != "sudoers_grant"]

# VERBATIM, `ssh deck@10.1.1.210 sudo -n -l` on the Steam Deck OLED, SteamOS 3.9.2
# (BUILD_ID 20260925.101), 2026-09-26, rc 0. The SteamOS update had dropped
# /etc/sudoers.d/zz-couchside: the two NOPASSWD rules are Valve's own.
LISTING_DECK = """Matching Defaults entries for deck on taylor-steamdeck:
    secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/bin, !fqdn

Runas and Command-specific defaults for deck:
    Defaults!/usr/bin/visudo env_keep+="SUDO_EDITOR EDITOR VISUAL"

User deck may run the following commands on taylor-steamdeck:
    (ALL) ALL
    (root) NOPASSWD: /usr/bin/steamos-prepare-oobe-test
    (root) NOPASSWD: /usr/bin/steamos-chroot --partset other -- rm -rf /var/lib/overlays/etc/upper/NetworkManager/
"""
# SYNTHETIC: the Deck listing above with install.sh's grants back in effect,
# appended LAST (zz-couchside sorts after everything, and last match wins).
LISTING_GRANTED = LISTING_DECK + """    (root) NOPASSWD: /usr/bin/systemctl reboot
    (root) NOPASSWD: /usr/bin/systemctl poweroff
    (root) NOPASSWD: /usr/bin/systemctl suspend
    (root) NOPASSWD: /usr/bin/systemctl restart plugin_loader
    (root) NOPASSWD: /usr/bin/systemctl restart --no-block couchside.service
    (root) NOPASSWD: {wrapper}
"""
LISTING_NOT_GRANTED = LISTING_DECK


class _Run:
    """Stub for cs.subprocess.run: records calls, returns a canned result."""

    def __init__(self, rc=0, stdout="", raises=None):
        self.rc, self.stdout, self.raises, self.calls = rc, stdout, raises, 0

    def __call__(self, argv, **kw):
        self.calls += 1
        assert argv == ["sudo", "-n", "-l"], argv  # the ONLY command this path may run
        if self.raises:
            raise self.raises

        class R:
            pass
        r = R()
        r.returncode, r.stdout, r.stderr = self.rc, self.stdout, ""
        return r


def _put(path, text="x\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


class Box:
    """A fake root: every piece path + the manifest repointed into a tmp tree.
    Everything present, the sudo grant listed, and a manifest naming every id,
    unless a test changes it. Restores the module on exit."""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = (dict(cs._INSTALL_PIECE_PATHS), cs.INSTALL_MANIFEST,
                      cs._INSTALL_GRANT_NEEDLE, cs.subprocess.run,
                      dict(cs._INSTALL_HEALTH_CACHE))
        self.paths = {}
        for pid, real in cs._INSTALL_PIECE_PATHS.items():
            p = os.path.join(self.tmp, real.lstrip("/"))
            _put(p)
            self.paths[pid] = p
        cs._INSTALL_PIECE_PATHS.clear()
        cs._INSTALL_PIECE_PATHS.update(self.paths)
        self.wrapper = self.paths["journal_wrapper"]
        cs._INSTALL_GRANT_NEEDLE = self.wrapper
        cs.INSTALL_MANIFEST = os.path.join(self.tmp, "var/lib/couchside/install-manifest")
        self.manifest(ALL_IDS)
        self.sudo(_Run(0, LISTING_GRANTED.format(wrapper=self.wrapper)))
        cs._INSTALL_HEALTH_CACHE.update({"at": None, "value": None})
        return self

    def __exit__(self, *exc):
        paths, man, needle, run, cache = self.saved
        cs._INSTALL_PIECE_PATHS.clear()
        cs._INSTALL_PIECE_PATHS.update(paths)
        cs.INSTALL_MANIFEST, cs._INSTALL_GRANT_NEEDLE, cs.subprocess.run = man, needle, run
        cs._INSTALL_HEALTH_CACHE.clear()
        cs._INSTALL_HEALTH_CACHE.update(cache)
        for root, dirs, _files in os.walk(self.tmp):
            for d in dirs:
                try:
                    os.chmod(os.path.join(root, d), 0o700)
                except OSError:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False

    def manifest(self, ids, extra=""):
        _put(cs.INSTALL_MANIFEST, "# written by install.sh\n" + "".join(i + "\n" for i in ids) + extra)

    def no_manifest(self):
        os.remove(cs.INSTALL_MANIFEST)

    def sudo(self, stub):
        self.run = stub
        cs.subprocess.run = stub


def test_all_present_is_ok():
    print("test_all_present_is_ok")
    with Box():
        h = cs.install_health_compute()
        check("every piece present + grant in effect -> ok", h, {"ok": True, "missing": [], "unknown": []})


def test_each_file_piece_missing_is_reported():
    """Remove ONE piece at a time: exactly that id, ok false. The control is the
    previous test -- the same tree with nothing removed reads ok."""
    print("test_each_file_piece_missing_is_reported")
    for pid in FILE_IDS:
        with Box() as b:
            os.remove(b.paths[pid])
            h = cs.install_health_compute()
            check("%s removed -> reported missing, ok false" % pid,
                  (h["ok"], h["missing"], h["unknown"]), (False, [pid], []))


def test_sudoers_grant_missing_is_reported():
    print("test_sudoers_grant_missing_is_reported")
    with Box() as b:
        b.sudo(_Run(0, LISTING_NOT_GRANTED))
        h = cs.install_health_compute()
        check("listable, last match for the wrapper is the password rule -> missing",
              (h["ok"], h["missing"], h["unknown"]), (False, ["sudoers_grant"], []))
        check("the probe ran `sudo -n -l` exactly once", b.run.calls, 1)


def test_the_deck_case_whole_etc_dir_gone():
    """What the Deck OLED actually lost (read on the box 2026-09-26): /etc/couchside/
    as a directory, the udev rules, modules-load and the sudoers file; the unit
    survived. No manifest there yet (it predates this branch), so the default set
    applies. Parent-dir ENOENT must read as MISSING, not unknown. The expected list
    is what install_health_compute() returned ON that Deck."""
    print("test_the_deck_case_whole_etc_dir_gone")
    with Box() as b:
        b.no_manifest()
        shutil.rmtree(os.path.dirname(b.paths["token_canonical"]))   # /etc/couchside
        for pid in ("udev_uinput", "udev_rtc", "udev_cec", "udev_openpuck", "modules_uinput"):
            os.remove(b.paths[pid])
        b.sudo(_Run(0, LISTING_DECK))                                 # verbatim, rc 0
        h = cs.install_health_compute()
        check("the lost pieces are missing, in table order (== the Deck's own answer)",
              h["missing"], ["token_canonical", "sudoers_grant", "journal_wrapper",
                             "udev_uinput", "modules_uinput", "udev_rtc"])
        check("nothing unknown: the Deck's sudo listed fine", h["unknown"], [])
        check("ok is false", h["ok"], False)
        check("the surviving unit is not reported", "systemd_unit" in h["missing"] + h["unknown"], False)
        check("mock `damaged` is the same shape the Deck returned",
              (cs.set_install_health_mock("damaged") or cs.mock_install_health()), h)
        cs.set_install_health_mock("ok")


def test_unreadable_is_unknown_never_ok():
    print("test_unreadable_is_unknown_never_ok")
    if os.geteuid() == 0:
        print("  SKIP  running as root; permission bits do not bind")
        return
    with Box() as b:
        rules = os.path.dirname(b.paths["udev_uinput"])
        os.chmod(rules, 0o000)          # cannot even stat inside
        try:
            h = cs.install_health_compute()
        finally:
            os.chmod(rules, 0o755)
        udev = ["udev_uinput", "udev_rtc", "udev_cec", "udev_openpuck"]
        check("pieces behind an unreadable dir are unknown", h["unknown"], udev)
        check("...and NOT reported missing (no false alarm)", h["missing"], [])
        check("...and NOT ok (degrade closed)", h["ok"], False)
    with Box() as b:
        b.sudo(_Run(1, ""))
        h = cs.install_health_compute()
        check("sudo refuses to list -> sudoers_grant unknown, ok false",
              (h["ok"], h["missing"], h["unknown"]), (False, [], ["sudoers_grant"]))
    with Box() as b:
        b.sudo(_Run(raises=FileNotFoundError("sudo")))
        h = cs.install_health_compute()
        check("no sudo binary -> unknown, not missing", (h["missing"], h["unknown"]), ([], ["sudoers_grant"]))
    with Box() as b:
        b.sudo(_Run(raises=cs.subprocess.TimeoutExpired(["sudo"], 4)))
        h = cs.install_health_compute()
        check("sudo timeout -> unknown", h["unknown"], ["sudoers_grant"])


def test_empty_or_wrong_type_is_missing():
    print("test_empty_or_wrong_type_is_missing")
    with Box() as b:
        _put(b.paths["token_canonical"], "")                     # empty token file
        os.remove(b.paths["udev_rtc"])
        os.makedirs(b.paths["udev_rtc"])                          # a DIRECTORY in its place
        h = cs.install_health_compute()
        check("empty token + dir-for-rule -> both missing", h["missing"], ["token_canonical", "udev_rtc"])
    with Box() as b:
        link = b.paths["systemd_unit"]
        os.remove(link)
        os.symlink(os.path.join(b.tmp, "nowhere"), link)          # dangling symlink
        check("dangling symlink -> missing", cs.install_health_compute()["missing"], ["systemd_unit"])


def test_manifest_decides_what_is_expected():
    print("test_manifest_decides_what_is_expected")
    newer = ["udev_cec", "udev_openpuck"]
    # NO manifest: a box installed before the newer rules existed, updated only by
    # the passwordless quick path. Its absent cec/openpuck rules were never
    # installed, so they must NOT read as damage...
    with Box() as b:
        b.no_manifest()
        for pid in newer:
            os.remove(b.paths[pid])
        check("no manifest: never-installed newer rules are not a false alarm",
              cs.install_health_compute(), {"ok": True, "missing": [], "unknown": []})
    # ...CONTROL: the same box WITH a manifest naming them -> reported.
    with Box() as b:
        for pid in newer:
            os.remove(b.paths[pid])
        check("manifest names them: the same absence IS reported",
              cs.install_health_compute()["missing"], newer)
    # No manifest still checks the default set (the Deck has no manifest yet).
    with Box() as b:
        b.no_manifest()
        os.remove(b.paths["udev_uinput"])
        check("no manifest: a default-set piece is still reported",
              cs.install_health_compute()["missing"], ["udev_uinput"])
    # --no-sudoers install: the manifest omits the grant + wrapper, so their
    # absence is the owner's choice, not damage.
    with Box() as b:
        b.manifest([i for i in ALL_IDS if i not in ("sudoers_grant", "journal_wrapper")])
        os.remove(b.paths["journal_wrapper"])
        b.sudo(_Run(1, ""))
        h = cs.install_health_compute()
        check("--no-sudoers manifest: wrapper + grant not checked -> ok",
              h, {"ok": True, "missing": [], "unknown": []})
        check("...and sudo was never run for it", b.run.calls, 0)
    # A manifest naming nothing we know (garbage / a future-only id) falls back to
    # the default set rather than checking NOTHING (which would read as ok).
    with Box() as b:
        b.manifest(["future_piece", "../../etc/shadow"], extra="token_canonical_x\n")
        os.remove(b.paths["token_canonical"])
        check("unknown-only manifest -> default set, loss still reported",
              cs.install_health_compute()["missing"], ["token_canonical"])
    # Unknown ids are ignored, known ones kept; a manifest can never add a PATH.
    with Box() as b:
        b.manifest(["token_canonical", "/etc/shadow", "future_piece"])
        h = cs.install_health_compute()
        check("mixed manifest: only the known id is checked", h, {"ok": True, "missing": [], "unknown": []})
        check("sudo not run (grant not in this manifest)", b.run.calls, 0)


def test_cache_and_copies():
    print("test_cache_and_copies")
    with Box() as b:
        h1 = cs.install_health()
        h2 = cs.install_health()
        check("second call within the TTL is served from cache (one sudo run)", b.run.calls, 1)
        h1["missing"].append("tampered")
        check("callers get copies (mutating one does not poison the cache)",
              cs.install_health()["missing"], [])
        check("cached value equals a fresh compute", h2, cs.install_health_compute())
        os.remove(b.paths["udev_uinput"])
        cs._INSTALL_HEALTH_CACHE["at"] -= cs._INSTALL_HEALTH_TTL + 1   # expire it
        check("after the TTL a loss shows up", cs.install_health()["missing"], ["udev_uinput"])


def test_sudo_state_tristate_and_old_callers():
    """_sudo_nopasswd_allows was refactored onto _sudo_nopasswd_state; the
    action-injection callers must see EXACTLY the old booleans."""
    print("test_sudo_state_tristate_and_old_callers")
    with Box() as b:
        cases = [
            (_Run(0, LISTING_GRANTED.format(wrapper="/w")), True, True),
            (_Run(0, LISTING_NOT_GRANTED), False, False),
            (_Run(1, ""), None, False),
            (_Run(raises=OSError("boom")), None, False),
        ]
        for stub, state, allows in cases:
            b.sudo(stub)
            check("state %r / allows %r" % (state, allows),
                  (cs._sudo_nopasswd_state("/w"), cs._sudo_nopasswd_allows("/w")), (state, allows))


def test_status_carries_it_only_behind_auth():
    """Additive field on the EXISTING authed route: present with the token,
    401 without (auth-failure direction), healthy in plain --mock, the Deck's
    shape with --mock-install-health damaged."""
    print("test_status_carries_it_only_behind_auth")
    cs.Handler.token, cs.Handler.token_file, cs.Handler.mock = "t" * 48, None, True
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    cs.Handler.port = port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    import json

    def get(hdr=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request("GET", "/api/status", headers=hdr or {})
        r = c.getresponse()
        body = r.read().decode("utf-8", "replace")
        c.close()
        return r.status, body
    try:
        st, body = get()
        check("no token -> 401", st, 401)
        check("no install_health leaks pre-auth", "install_health" in body, False)
        cs.set_install_health_mock("ok")
        st, body = get({"Authorization": "Bearer " + "t" * 48})
        check("with token -> 200", st, 200)
        check("mock default is healthy", json.loads(body).get("install_health"),
              {"ok": True, "missing": [], "unknown": []})
        cs.set_install_health_mock("damaged")
        h = json.loads(get({"Authorization": "Bearer " + "t" * 48})[1]).get("install_health")
        check("damaged mock: ok false", h["ok"], False)
        check("damaged mock ids all come from the frozen table",
              all(i in cs._INSTALL_PIECE_IDS for i in h["missing"] + h["unknown"]), True)
        cs.set_install_health_mock("nonsense")
        check("unknown mock state falls back to ok", cs.mock_install_health()["ok"], True)
    finally:
        cs.set_install_health_mock("ok")
        srv.shutdown()
        srv.server_close()


def test_real_status_wires_it():
    """real_status() must actually include the block -- a helper nobody calls is
    the 'wired to nothing' trap. Everything else real_status reads is left real;
    only install_health is stubbed so the assertion is about the wiring."""
    print("test_real_status_wires_it")
    saved = cs.install_health
    cs.install_health = lambda: {"ok": False, "missing": ["udev_uinput"], "unknown": []}
    try:
        st = cs.real_status()
        check("real_status carries install_health", st.get("install_health"),
              {"ok": False, "missing": ["udev_uinput"], "unknown": []})
    finally:
        cs.install_health = saved


def test_paths_match_install_sh():
    """The frozen paths must be the ones install.sh writes -- a table that
    drifted from the installer would report a healthy box as damaged forever."""
    print("test_paths_match_install_sh")
    src = open(os.path.join(ROOT, "install.sh")).read()
    for pid, path in cs._INSTALL_PIECE_PATHS.items():
        literal = path in src
        # token + wrapper are spelled through variables in install.sh.
        via_var = {"token_canonical": 'TOKEN_FILE="${ETC_DIR}/token"',
                   "journal_wrapper": 'JOURNAL_WRAPPER="${ETC_DIR}/couchside-journal"',
                   "systemd_unit": 'UNIT_DST="/etc/systemd/system/couchside.service"'}.get(pid)
        check("%s path is written by install.sh" % pid, literal or (via_var is not None and via_var in src), True)
    check("install.sh ETC_DIR is /etc/couchside", 'ETC_DIR="/etc/couchside"' in src, True)
    check("manifest path is STATE_DIR/install-manifest",
          cs.INSTALL_MANIFEST == "/var/lib/couchside/install-manifest"
          and 'STATE_DIR="/var/lib/couchside"' in src
          and '"$STATE_DIR/install-manifest"' in src, True)


if __name__ == "__main__":
    for fn in (test_all_present_is_ok, test_each_file_piece_missing_is_reported,
               test_sudoers_grant_missing_is_reported, test_the_deck_case_whole_etc_dir_gone,
               test_unreadable_is_unknown_never_ok, test_empty_or_wrong_type_is_missing,
               test_manifest_decides_what_is_expected, test_cache_and_copies,
               test_sudo_state_tristate_and_old_callers,
               test_status_carries_it_only_behind_auth, test_real_status_wires_it,
               test_paths_match_install_sh):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall install-health tests passed")
