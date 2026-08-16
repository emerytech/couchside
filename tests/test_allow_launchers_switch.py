#!/usr/bin/env python3
"""`couchside allow-launchers` actually gates POST /api/launchers.

Run: python3 tests/test_allow_launchers_switch.py

WHY THIS EXISTS. The verb was a DEAD SWITCH. It wrote
/etc/couchside/config.json while the unit the same installer generates runs the
agent with `--config /var/lib/couchside/config.json` — and load_config() opens
exactly that path, no fallback. So the write and the verb's own `status` grep
agreed with each other and with nothing else: turning it ON did nothing, and
status then reported "on". The sibling verbs (allow-updates, tls) were already
correct, which is what made it invisible.

Nothing caught it. tests/test_installer_cli.sh pins four unrelated properties;
test_os_update.py and test_flatpak_update.py only use the string
"allow-launchers)" as a range terminator while slicing a different block. And
ALLOW_APP_LAUNCHERS had no coverage at all despite gating a route that runs a
client-supplied argv — a §6 gap in its own right.

So this suite asserts the END-TO-END property that was missing: drive the REAL
CLI (extracted from install.sh, not a copy) against a temp config, boot a live
Handler on that config, and prove the route's answer actually changes. Plus a
CONTROL that re-runs the same flow against a copy pinned to the old /etc path
and shows the switch doing nothing — the bug, reproduced, in the same run.

Pure stdlib, no pytest.
"""
import http.client
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INSTALLER = os.path.join(ROOT, "install.sh")

_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
TOKEN = "t0ken-allow-launchers"
# A config _parse_config ACCEPTS. `units` must be a non-empty list, and an
# invalid config is not neutral here: load_config reads the opt-in flags first
# and then falls back to built-in defaults, so a malformed fixture would still
# pass these assertions while exercising the degraded path instead of the real
# one. Keep this valid.
VALID_CFG = {"units": [{"name": "couchside.service", "scope": "system"}],
             "actions": {}}


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


# --- extract the REAL CLI, so this tests what ships -------------------------

def _extract_cli():
    """The couchside CLI exactly as install.sh writes it to disk."""
    src = open(INSTALLER).read()
    m = re.search(r"^cat > \"\$CLI\" <<'CLIEOF'\n(.*?)^CLIEOF$",
                  src, re.MULTILINE | re.DOTALL)
    if not m:
        raise SystemExit("could not find the CLI heredoc in install.sh")
    return m.group(1)


def _cli_pinned_to(cfg_path, body=None):
    """Write the CLI to a temp file with its single CFG= line repointed at
    `cfg_path`. Rewriting that ONE line is the whole point: it proves the
    shipped CLI has exactly one config path and that everything follows it."""
    body = _extract_cli() if body is None else body
    out, n = re.subn(r'^CFG=.*$', 'CFG="%s"' % cfg_path, body, count=1,
                     flags=re.MULTILINE)
    if n != 1:
        raise SystemExit("expected exactly one CFG= line in the CLI, found %d" % n)
    fd, path = tempfile.mkstemp(prefix="couchside-cli-", suffix=".sh")
    with os.fdopen(fd, "w") as f:
        f.write(out)
    os.chmod(path, 0o755)
    return path


def _stub_path(tmp):
    """A PATH whose `sudo` and `systemctl` are no-ops, so the verb runs here."""
    bindir = os.path.join(tmp, "bin")
    os.makedirs(bindir, exist_ok=True)
    # `sudo` must exec its arguments, not swallow them: the restart line is
    # `sudo systemctl ...` and systemctl itself is stubbed true.
    with open(os.path.join(bindir, "sudo"), "w") as f:
        f.write('#!/bin/sh\nexec "$@"\n')
    with open(os.path.join(bindir, "systemctl"), "w") as f:
        f.write('#!/bin/sh\nexit 0\n')
    for n in ("sudo", "systemctl"):
        os.chmod(os.path.join(bindir, n), 0o755)
    return bindir + os.pathsep + os.environ.get("PATH", "")


def _run_verb(cli, tmp, *args):
    return subprocess.run(["bash", cli, "allow-launchers", *args],
                          capture_output=True, text=True,
                          env={**os.environ, "PATH": _stub_path(tmp), "HOME": tmp})


# --- live agent on that config ---------------------------------------------

def _serve(cfg_path):
    cs.load_config(cfg_path)
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = False
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    cs.Handler.port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _post_launcher(port, token=TOKEN, cmd=("/bin/true",), label="t"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    body = json.dumps({"label": label, "cmd": list(cmd)}).encode()
    conn.request("POST", "/api/launchers", body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


def _route_status(cfg_path):
    srv, port = _serve(cfg_path)
    try:
        return _post_launcher(port)[0]
    finally:
        srv.shutdown()
        srv.server_close()


def _flag(cfg_path):
    try:
        with open(cfg_path) as f:
            return json.load(f).get("allow_app_launchers")
    except Exception:
        return None


# --- the tests --------------------------------------------------------------

def test_cli_has_one_config_path():
    print("the shipped CLI has exactly one config path")
    body = _extract_cli()
    check("exactly one CFG= definition", len(re.findall(r'^CFG=', body, re.M)), 1)
    check("no /etc/couchside/config.json anywhere in the CLI",
          "/etc/couchside/config.json" in body, False)
    # The dead switch shelled out with sudo, which would re-root the file the
    # agent must itself rewrite (see the allow-updates comment in install.sh).
    blk = body[body.index("  allow-launchers)"):]
    blk = blk[:blk.index("\n  new-token)")]
    check("allow-launchers does not sudo the config write",
          "sudo python3" in blk, False)


def test_switch_actually_gates_the_route():
    print("allow-launchers on|off changes what POST /api/launchers answers")
    tmp = tempfile.mkdtemp(prefix="couchside-als-")
    cfg = os.path.join(tmp, "config.json")
    with open(cfg, "w") as f:
        json.dump(VALID_CFG, f)
    cli = _cli_pinned_to(cfg)
    try:
        r = _run_verb(cli, tmp, "on")
        check("`on` exits 0", r.returncode, 0)
        check("`on` writes the flag true", _flag(cfg), True)
        check("`on` -> route accepts (200)", _route_status(cfg), 200)
        # status must report the file it read, not a different one
        s = _run_verb(cli, tmp, "status")
        check("status says on", "on" in s.stdout, True)
        check("status names the config it read", cfg in s.stdout, True)

        r = _run_verb(cli, tmp, "off")
        check("`off` exits 0", r.returncode, 0)
        check("`off` writes the flag false", _flag(cfg), False)
        check("`off` -> route refuses (403)", _route_status(cfg), 403)
    finally:
        os.unlink(cli)
        shutil.rmtree(tmp, ignore_errors=True)


def test_route_still_demands_auth_and_validates(     # §6, never covered before
):
    print("§6: the gated route still refuses bad credentials and bad input")
    tmp = tempfile.mkdtemp(prefix="couchside-als-auth-")
    cfg = os.path.join(tmp, "config.json")
    with open(cfg, "w") as f:
        json.dump({**VALID_CFG, "allow_app_launchers": True}, f)
    srv, port = _serve(cfg)
    try:
        check("no bearer -> 401", _post_launcher(port, token=None)[0], 401)
        check("wrong bearer -> 401", _post_launcher(port, token="nope")[0], 401)
        st, _ = _post_launcher(port, cmd=())
        check("empty argv -> 400", st, 400)
        # A string where an argv LIST is required must be rejected, not split.
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/api/launchers",
                     body=json.dumps({"label": "t", "cmd": "/bin/true"}).encode(),
                     headers={"Authorization": "Bearer " + TOKEN,
                              "Content-Type": "application/json"})
        resp = conn.getresponse()
        resp.read()          # drain before close, else the server logs a reset
        st = resp.status
        conn.close()
        check("cmd as a string (not a list) -> 400", st, 400)
    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)


def test_control_the_old_switch_did_nothing():
    """CONTROL (§11.2/§11.3): the bug, reproduced in this same run.

    Same flow, but the CLI is pinned to the pre-fix /etc path while the agent
    reads the state config — which is exactly the shipped mismatch. The state
    config must come back BYTE-IDENTICAL and the route must keep refusing,
    while the verb still cheerfully reports success.
    """
    print("control: the pre-fix verb wrote a config nothing reads")
    tmp = tempfile.mkdtemp(prefix="couchside-als-ctl-")
    state_cfg = os.path.join(tmp, "state", "config.json")
    os.makedirs(os.path.dirname(state_cfg))
    with open(state_cfg, "w") as f:
        json.dump(VALID_CFG, f)
    before = open(state_cfg, "rb").read()

    stale_cfg = os.path.join(tmp, "etc", "config.json")   # the /etc stand-in
    cli = _cli_pinned_to(stale_cfg)
    try:
        r = _run_verb(cli, tmp, "on")
        check("pre-fix `on` still exits 0 (it looked like it worked)",
              r.returncode, 0)
        check("pre-fix `on` wrote its own file", _flag(stale_cfg), True)
        check("...but the config the agent reads is UNTOUCHED",
              open(state_cfg, "rb").read(), before)
        check("...and the route still refuses (403)", _route_status(state_cfg), 403)
    finally:
        os.unlink(cli)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    for fn in (test_cli_has_one_config_path,
               test_switch_actually_gates_the_route,
               test_route_still_demands_auth_and_validates,
               test_control_the_old_switch_did_nothing):
        fn()
    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all allow-launchers switch tests passed")
