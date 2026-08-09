#!/usr/bin/env python3
"""Tests for Setup -> Utilities (Stage 1: read-only detection, agent side).

Run: python3 tests/test_utilities.py

WHAT THIS GUARDS. Utilities is a NEW surface that will grow state-changing tenants
(flash a board, enable CEC). Stage 1 ships only DETECTION, and this file pins the
properties CLAUDE.md §3 cares about BEFORE any RUN handler exists:

  1. The tenant set is a FROZEN id list (`_UTILITY_IDS`); the state is built by
     iterating that list and looking each id up in `_UTILITY_META` — a client never
     names a utility, supplies a device, or supplies firmware.
  2. Detection is READ-ONLY and degrades CLOSED: an unreadable /sys, /run/media, or a
     missing /dev/cec is 'no_board' / 'no_adapter', never a ready/enabled state.
  3. The OpenPuck flash TARGET is matched by a known bootloader label + the UF2 marker
     file (INFO_UF2.TXT) — a volume with the right label but no marker is NOT ready
     (the control), so we never point a future flash at the wrong mount.
  4. GET /api/utilities is behind the bearer gate like every other /api route.

These are fixtures, not live hardware; the box-side truth (openpuck=puck_present,
cec=enabled on bazzite 2026-08-08) was observed separately.
"""
import errno
import http.client
import importlib.util
import json
import os
import struct
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
TOKEN = "test-secret-token"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


class Patch:
    """Swap module attributes for the duration of a `with`, restore after."""

    def __init__(self, **kw):
        self._kw = kw
        self._old = {}

    def __enter__(self):
        for k, v in self._kw.items():
            self._old[k] = getattr(cs, k)
            setattr(cs, k, v)
        return self

    def __exit__(self, *a):
        for k, v in self._old.items():
            setattr(cs, k, v)


def _media_tree(volumes):
    """Build a fake udisks automount root: {volume_label: has_marker_bool}.
    Returns a dir usable as a single entry of _MEDIA_ROOTS (root/<user>/<vol>)."""
    root = tempfile.mkdtemp(prefix="util-media-")
    user = os.path.join(root, "deck")
    os.makedirs(user)
    for label, has_marker in volumes.items():
        vol = os.path.join(user, label)
        os.makedirs(vol)
        if has_marker:
            with open(os.path.join(vol, "INFO_UF2.TXT"), "w") as f:
                f.write("UF2 Bootloader\nModel: nice!nano\n")
    return root


def _usb_tree(devices):
    """Build a fake /sys/bus/usb/devices: list of (vid, pid). Names are dev1.. and
    an interface node (with ':') is added to prove it is skipped."""
    root = tempfile.mkdtemp(prefix="util-usb-")
    for i, (vid, pid) in enumerate(devices):
        d = os.path.join(root, "dev%d" % i)
        os.makedirs(d)
        with open(os.path.join(d, "idVendor"), "w") as f:
            f.write(vid + "\n")
        with open(os.path.join(d, "idProduct"), "w") as f:
            f.write(pid + "\n")
    # An interface node — has ':' in the name, must be ignored, no id files.
    os.makedirs(os.path.join(root, "1-1:1.0"))
    return root


# ---------------------------------------------------------------------------
print("\n_openpuck_bootloader_mount — the flash target")
# ---------------------------------------------------------------------------

def test_bootloader_mount_needs_label_and_marker():
    print("test_bootloader_mount_needs_label_and_marker")
    r = _media_tree({"NICENANO": True})
    try:
        with Patch(_MEDIA_ROOTS=(r,)):
            got = cs._openpuck_bootloader_mount()
            check("labelled + marker -> path", got and got.endswith("NICENANO"), True)
    finally:
        shutil.rmtree(r, ignore_errors=True)


def test_bootloader_label_without_marker_refused():
    """CONTROL: a volume with the bootloader label but NO INFO_UF2.TXT is not a
    ready board — a random USB stick someone named NICENANO must not be a flash
    target."""
    print("test_bootloader_label_without_marker_refused")
    r = _media_tree({"NICENANO": False})
    try:
        with Patch(_MEDIA_ROOTS=(r,)):
            check("label but no marker -> None", cs._openpuck_bootloader_mount(), None)
    finally:
        shutil.rmtree(r, ignore_errors=True)


def test_bootloader_wrong_label_refused():
    print("test_bootloader_wrong_label_refused")
    r = _media_tree({"MYUSB": True, "STEAMSD": True})
    try:
        with Patch(_MEDIA_ROOTS=(r,)):
            check("non-bootloader labels -> None", cs._openpuck_bootloader_mount(), None)
    finally:
        shutil.rmtree(r, ignore_errors=True)


def test_bootloader_missing_root_degrades_closed():
    print("test_bootloader_missing_root_degrades_closed")
    with Patch(_MEDIA_ROOTS=("/nonexistent-couchside-xyz",)):
        check("unreadable roots -> None", cs._openpuck_bootloader_mount(), None)


# ---------------------------------------------------------------------------
print("\n_usb_present + _openpuck_state")
# ---------------------------------------------------------------------------

def test_usb_present_matches_vid_pid():
    print("test_usb_present_matches_vid_pid")
    r = _usb_tree([("28de", "1304"), ("1234", "5678")])
    try:
        with Patch(_USB_DEVICES_DIR=r):
            check("puck vid:pid present", cs._usb_present("28de", "1304"), True)
            check("absent vid:pid (control)", cs._usb_present("dead", "beef"), False)
    finally:
        shutil.rmtree(r, ignore_errors=True)


def test_usb_present_missing_dir_degrades_closed():
    print("test_usb_present_missing_dir_degrades_closed")
    with Patch(_USB_DEVICES_DIR="/nonexistent-couchside-xyz"):
        check("no sysfs -> False", cs._usb_present("28de", "1304"), False)


def test_openpuck_state_precedence():
    """board_ready (a bootloader mount) beats puck_present beats no_board."""
    print("test_openpuck_state_precedence")
    media_ready = _media_tree({"NICENANO": True})
    media_empty = _media_tree({})
    usb_puck = _usb_tree([("28de", "1304")])
    usb_none = _usb_tree([("1234", "5678")])
    try:
        # A board in DFU takes priority even if a puck is also enumerated.
        with Patch(_MEDIA_ROOTS=(media_ready,), _USB_DEVICES_DIR=usb_puck):
            check("dfu board -> board_ready", cs._openpuck_state(), "board_ready")
        with Patch(_MEDIA_ROOTS=(media_empty,), _USB_DEVICES_DIR=usb_puck):
            check("flashed puck -> puck_present", cs._openpuck_state(), "puck_present")
        with Patch(_MEDIA_ROOTS=(media_empty,), _USB_DEVICES_DIR=usb_none):
            check("nothing -> no_board", cs._openpuck_state(), "no_board")
    finally:
        for d in (media_ready, media_empty, usb_puck, usb_none):
            shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n_cec_util_state")
# ---------------------------------------------------------------------------

def _kern(dev="/dev/cec0"):
    return {"tool": "cec-ctl", "bin": "/usr/bin/cec-ctl", "device": dev}


def _dongle():
    return {"tool": "cec-client", "bin": "/usr/bin/cec-client", "device": None}


def test_cec_state_openability_matrix():
    """'enabled' means the agent can drive the TV via a live backend. For the KERNEL
    (cec-ctl) backend it is additionally gated on being able to OPEN the node — the
    §11 fix so a permission gap is observable as 'needs_enable' and flips to
    'enabled' once the install-time udev regroup grants access. The libcec dongle
    backend drives its own serial device and is enabled whenever it is live."""
    print("test_cec_state_openability_matrix")
    # No live backend, no node -> no hardware.
    with Patch(cec_current=lambda: None, _cec_devices_exist=lambda: False):
        check("no backend, no node -> no_adapter", cs._cec_util_state(), "no_adapter")
    # Kernel backend on a node the agent can open -> enabled.
    with Patch(cec_current=_kern, _cec_dev_openable=lambda d: True):
        check("kernel + openable node -> enabled", cs._cec_util_state(), "enabled")
    # CONTROL for the false-positive: kernel descriptor present (cec_current sees a
    # connected port from sysfs) but the node is NOT openable. Old code said
    # 'enabled'; it must be needs_enable.
    with Patch(cec_current=_kern, _cec_dev_openable=lambda d: False):
        check("kernel + node not openable -> needs_enable",
              cs._cec_util_state(), "needs_enable")
    # REGRESSION GUARD (finding #2/#3): a libcec USB dongle has NO /dev/cecN node,
    # but CEC genuinely works. Must be 'enabled', not 'no_adapter'.
    with Patch(cec_current=_dongle, _cec_devices_exist=lambda: False):
        check("libcec dongle, no node -> enabled", cs._cec_util_state(), "enabled")
    # No live backend but a kernel node exists (port off / not yet accessible).
    with Patch(cec_current=lambda: None, _cec_devices_exist=lambda: True):
        check("no backend but node exists -> needs_enable",
              cs._cec_util_state(), "needs_enable")


def test_cec_state_probe_raises_degrades_closed():
    """A throwing backend probe must never read as enabled."""
    print("test_cec_state_probe_raises_degrades_closed")
    def boom():
        raise RuntimeError("cec probe exploded")
    with Patch(cec_current=boom, _cec_devices_exist=lambda: True):
        check("probe raises, node exists -> needs_enable", cs._cec_util_state(), "needs_enable")
    with Patch(cec_current=boom, _cec_devices_exist=lambda: False):
        check("probe raises, no node -> no_adapter", cs._cec_util_state(), "no_adapter")


# ---------------------------------------------------------------------------
print("\nutilities_state — the list shape + frozen tenant set")
# ---------------------------------------------------------------------------

def test_state_iterates_frozen_id_set():
    """Every row's id is in the frozen tenant set, and each carries meta. A client
    can never introduce a row — the list is built from _UTILITY_IDS, not input."""
    print("test_state_iterates_frozen_id_set")
    rows = cs.utilities_state(mock=True)
    ids = [r["id"] for r in rows]
    check("ids are exactly the frozen tenants", set(ids), set(cs._UTILITY_IDS))
    check("openpuck + cec, in order", ids, ["openpuck", "cec"])
    for r in rows:
        check("row %s has label" % r["id"], bool(r.get("label")), True)
        check("row %s has description" % r["id"], bool(r.get("description")), True)
        check("row %s has a state" % r["id"], bool(r.get("state")), True)


def test_mock_state_is_renderable():
    print("test_mock_state_is_renderable")
    cs._MOCK_OPENPUCK_FLASHED = False
    rows = {r["id"]: r["state"] for r in cs.utilities_state(mock=True)}
    check("mock openpuck board_ready", rows["openpuck"], "board_ready")
    check("mock cec needs_enable", rows["cec"], "needs_enable")


def test_mock_flash_flips_state():
    """The harness arc: a mock flash flips the mock row board_ready ->
    puck_present, so the app's post-flash re-poll shows a changed state."""
    print("test_mock_flash_flips_state")
    cs._MOCK_OPENPUCK_FLASHED = False
    try:
        before = {r["id"]: r["state"] for r in cs.utilities_state(mock=True)}
        check("before flash: board_ready", before["openpuck"], "board_ready")
        r = cs.mock_openpuck_flash()
        check("mock flash ok", r["ok"], True)
        after = {r["id"]: r["state"] for r in cs.utilities_state(mock=True)}
        check("after flash: puck_present", after["openpuck"], "puck_present")
    finally:
        cs._MOCK_OPENPUCK_FLASHED = False


def test_real_state_uses_probes():
    """Real (non-mock) state comes from the detectors, not the mock literals."""
    print("test_real_state_uses_probes")
    media = _media_tree({})
    usb = _usb_tree([])
    try:
        with Patch(_MEDIA_ROOTS=(media,), _USB_DEVICES_DIR=usb,
                   cec_current=lambda: None, _cec_devices_exist=lambda: False):
            rows = {r["id"]: r["state"] for r in cs.utilities_state(mock=False)}
            check("real openpuck -> no_board", rows["openpuck"], "no_board")
            check("real cec -> no_adapter", rows["cec"], "no_adapter")
    finally:
        shutil.rmtree(media, ignore_errors=True)
        shutil.rmtree(usb, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\nHTTP: GET /api/utilities")
# ---------------------------------------------------------------------------

def _server():
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = True  # deterministic body; detection is unit-tested above
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data or b"{}")
    except ValueError:
        return resp.status, {}


def test_http_endpoint():
    print("test_http_endpoint")
    srv, port = _server()
    try:
        status, body = _req(port, "GET", "/api/utilities")
        check("GET utilities -> 200", status, 200)
        ids = [u["id"] for u in body.get("utilities", [])]
        check("body lists the tenants", ids, ["openpuck", "cec"])

        # Auth gate: same as every other /api route.
        check("no bearer -> 401", _req(port, "GET", "/api/utilities", token=None)[0], 401)
        check("wrong bearer -> 401", _req(port, "GET", "/api/utilities", token="nope")[0], 401)
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
print("\nreal_openpuck_flash — the Stage 2 flash (both success + failure)")
# ---------------------------------------------------------------------------

def _fw_file():
    """A minimal but STRUCTURALLY-VALID UF2 file: one 512-byte block carrying the
    UF2 magic words, so it passes the agent's _is_uf2 sanity check."""
    fd, p = tempfile.mkstemp(prefix="openpuck-", suffix=".uf2")
    os.write(fd, struct.pack("<II", 0x0A324655, 0x9E5D5157) + b"\x00" * (512 - 8))
    os.close(fd)
    return p


class copyfile_raising:
    """Force cs's shutil.copyfile to raise a chosen OSError, restore after."""

    def __init__(self, err):
        self._err = err

    def __enter__(self):
        self._old = cs.shutil.copyfile
        def boom(*a, **k):
            raise OSError(self._err, os.strerror(self._err))
        cs.shutil.copyfile = boom

    def __exit__(self, *a):
        cs.shutil.copyfile = self._old


class flash_env:
    """Make real_openpuck_flash() deterministic and OFFLINE for a flash test.

    Since 2.9.77 the flash resolves firmware through cache -> fork download -> seed.
    This context forces the download to RAISE (simulating no network / a box that
    only has its install seed), points the runtime cache at an empty temp dir, and
    pins the agent's expected sha256 to fixture `fw` — so a VALID seed is accepted
    and an INVALID/missing one is still refused. The install seed (_OPENPUCK_FIRMWARE)
    is set to `fw` and becomes the only possible source. No test ever hits GitHub."""

    def __init__(self, fw):
        self._fw = fw

    def __enter__(self):
        self._tmp = tempfile.mkdtemp(prefix="op-cache-")
        try:
            sha = cs._sha256_file(self._fw) if os.path.isfile(self._fw) else "0" * 64
        except OSError:
            sha = "0" * 64
        cache = os.path.join(self._tmp, "cache.uf2")

        def _offline(*a, **k):
            raise OSError("offline (test)")

        self._p = Patch(
            _OPENPUCK_FIRMWARE=self._fw,
            _OPENPUCK_FW_SHA256=sha,
            _OPENPUCK_FW_MIN_SIZE=1,
            _openpuck_cache_path=(lambda c=cache: c),
            _openpuck_download=_offline,
        )
        self._p.__enter__()
        return self

    def __exit__(self, *a):
        self._p.__exit__(*a)
        shutil.rmtree(self._tmp, ignore_errors=True)


def test_flash_no_board_degrades_closed():
    """No board in DFU -> refuse, never a guessed target."""
    print("test_flash_no_board_degrades_closed")
    empty = _media_tree({})
    fw = _fw_file()
    try:
        with Patch(_MEDIA_ROOTS=(empty,), _OPENPUCK_FIRMWARE=fw):
            r = cs.real_openpuck_flash()
            check("no board -> ok False", r["ok"], False)
            check("no board -> exit -1", r["exit_code"], -1)
    finally:
        shutil.rmtree(empty, ignore_errors=True)
        os.unlink(fw)


def test_flash_missing_firmware_degrades_closed():
    """A board is ready but the firmware asset was never installed -> refuse."""
    print("test_flash_missing_firmware_degrades_closed")
    ready = _media_tree({"NICENANO": True})
    try:
        with Patch(_MEDIA_ROOTS=(ready,)), \
                flash_env("/nonexistent-couchside-fw.uf2"):
            r = cs.real_openpuck_flash()
            check("no firmware -> ok False", r["ok"], False)
    finally:
        shutil.rmtree(ready, ignore_errors=True)


def test_flash_rejects_invalid_firmware():
    """CONTROL for degrade-CLOSED: a present-but-invalid firmware (0 bytes, or the
    right size but not a UF2) must NOT flash and report success. A bootloader
    silently ignores such an image and never reboots, so 'copy didn't error' is not
    proof of a flash (§3.7, §11)."""
    print("test_flash_rejects_invalid_firmware")
    ready = _media_tree({"NICENANO": True})
    fd, empty = tempfile.mkstemp(suffix=".uf2"); os.close(fd)          # 0 bytes
    fd, garbage = tempfile.mkstemp(suffix=".uf2")                      # 512B, no magic
    os.write(fd, b"\x00" * 512); os.close(fd)
    fd, short = tempfile.mkstemp(suffix=".uf2")                        # magic but not a block multiple
    os.write(fd, struct.pack("<II", 0x0A324655, 0x9E5D5157)); os.close(fd)
    try:
        for bad in (empty, garbage, short):
            with Patch(_MEDIA_ROOTS=(ready,)), flash_env(bad):
                r = cs.real_openpuck_flash()
                check("invalid firmware -> ok False", r["ok"], False)
    finally:
        shutil.rmtree(ready, ignore_errors=True)
        for p in (empty, garbage, short):
            os.unlink(p)


def test_flash_clean_copy_is_success():
    """Board ready + firmware present + copy completes cleanly -> success, and the
    bytes actually land in the bootloader mount."""
    print("test_flash_clean_copy_is_success")
    ready = _media_tree({"NICENANO": True})
    fw = _fw_file()
    try:
        with Patch(_MEDIA_ROOTS=(ready,)), flash_env(fw):
            r = cs.real_openpuck_flash()
            check("clean copy -> ok True", r["ok"], True)
            landed = os.path.join(ready, "deck", "NICENANO", os.path.basename(fw))
            check("firmware copied into the mount", os.path.isfile(landed), True)
    finally:
        shutil.rmtree(ready, ignore_errors=True)
        os.unlink(fw)


def test_flash_device_yank_errno_is_success():
    """THE inverted rule: the board reboots and yanks its drive mid-write, so the
    copy raises ENXIO/EIO on a SUCCESSFUL flash. Must read as success."""
    print("test_flash_device_yank_errno_is_success")
    ready = _media_tree({"NICENANO": True})
    fw = _fw_file()
    try:
        for err in (errno.ENXIO, errno.EIO):
            with Patch(_MEDIA_ROOTS=(ready,)), flash_env(fw):
                with copyfile_raising(err):
                    r = cs.real_openpuck_flash()
                    check("errno %d -> ok True" % err, r["ok"], True)
    finally:
        shutil.rmtree(ready, ignore_errors=True)
        os.unlink(fw)


def test_flash_other_errno_is_failure():
    """CONTROL for the inverted rule: an unrelated OSError (EPERM/EACCES) is a
    genuine failure, not success. Without this, 'any error = success' would pass
    every other test too."""
    print("test_flash_other_errno_is_failure")
    ready = _media_tree({"NICENANO": True})
    fw = _fw_file()
    try:
        for err in (errno.EPERM, errno.EACCES, errno.ENOSPC):
            with Patch(_MEDIA_ROOTS=(ready,)), flash_env(fw):
                with copyfile_raising(err):
                    r = cs.real_openpuck_flash()
                    check("errno %d -> ok False" % err, r["ok"], False)
    finally:
        shutil.rmtree(ready, ignore_errors=True)
        os.unlink(fw)


def test_flash_target_is_not_client_supplied():
    """§3: the ONLY thing a client can influence about the flash is the `variant`
    enum (pinned|latest, allowlisted at the HTTP layer, tested there). The flash
    TARGET still comes from _openpuck_bootloader_mount() and the firmware URL/path/
    bytes are always agent-owned — never a client-supplied path, url, or blob."""
    print("test_flash_target_is_not_client_supplied")
    import inspect
    params = list(inspect.signature(cs.real_openpuck_flash).parameters)
    check("flash's only client param is variant", params, ["variant"])
    check("variant defaults to pinned",
          inspect.signature(cs.real_openpuck_flash).parameters["variant"].default,
          "pinned")


# ---------------------------------------------------------------------------
print("\nruntime firmware fetch (2.9.77): verify + resolve, OFFLINE (no network)")
# ---------------------------------------------------------------------------

def _uf2_bytes(nblocks=736):
    """Bytes of a structurally-valid UF2 of `nblocks` 512-byte blocks (default 736
    ~= 376 KB, a real OpenPuck size), first block carrying the magic words."""
    head = struct.pack("<II", 0x0A324655, 0x9E5D5157) + b"\x00" * (512 - 8)
    return head + b"\x00" * (512 * (nblocks - 1))


def test_fw_valid_both_directions():
    """_openpuck_fw_valid: a real-shaped UF2 of the right size + matching sha PASSES;
    every failure mode (missing, wrong magic, too small, wrong sha) FAILS. A verifier
    is unverified until seen firing AND not firing (CLAUDE.md §11.2)."""
    print("test_fw_valid_both_directions")
    fd, good = tempfile.mkstemp(suffix=".uf2")
    os.write(fd, _uf2_bytes(736)); os.close(fd)
    fd, tiny = tempfile.mkstemp(suffix=".uf2")           # valid UF2 but too small
    os.write(fd, _uf2_bytes(1)); os.close(fd)
    fd, nomagic = tempfile.mkstemp(suffix=".uf2")        # right size, no magic
    os.write(fd, b"\x00" * (512 * 736)); os.close(fd)
    good_sha = cs._sha256_file(good)
    try:
        # FIRES: right size + right sha.
        check("good uf2 (no sha) -> True", cs._openpuck_fw_valid(good), True)
        check("good uf2 + correct sha -> True",
              cs._openpuck_fw_valid(good, good_sha), True)
        # DOES NOT FIRE: each failure mode.
        check("missing path -> False", cs._openpuck_fw_valid("/no/such.uf2"), False)
        check("wrong magic -> False", cs._openpuck_fw_valid(nomagic), False)
        with Patch(_OPENPUCK_FW_MIN_SIZE=300_000):
            check("too small -> False", cs._openpuck_fw_valid(tiny), False)
        check("wrong sha -> False", cs._openpuck_fw_valid(good, "0" * 64), False)
    finally:
        for p in (good, tiny, nomagic):
            os.unlink(p)


def test_pick_asset_prefers_standard_never_factory_reset():
    """The /releases/latest asset picker: prefer OpenPuck-*-standard*.uf2, take a
    non-factory-reset .uf2 otherwise, and NEVER default to a factory-reset image."""
    print("test_pick_asset_prefers_standard_never_factory_reset")
    assets = [
        {"name": "OpenPuck-0.9.41-factory-reset.uf2", "browser_download_url": "u1"},
        {"name": "OpenPuck-0.9.41-standard.uf2", "browser_download_url": "u2"},
        {"name": "notes.txt", "browser_download_url": "u3"},
    ]
    check("prefers -standard", cs._openpuck_pick_asset(assets)["browser_download_url"], "u2")
    # No standard present: take the non-factory-reset .uf2, not the reset one.
    only = [
        {"name": "OpenPuck-0.9.41-factory-reset.uf2", "browser_download_url": "r"},
        {"name": "OpenPuck-0.9.41.uf2", "browser_download_url": "keep"},
    ]
    check("skips factory-reset", cs._openpuck_pick_asset(only)["browser_download_url"], "keep")
    # ONLY a factory-reset image -> refuse (None), never default to it.
    check("factory-reset only -> None",
          cs._openpuck_pick_asset(
              [{"name": "OpenPuck-factory-reset.uf2", "browser_download_url": "r"}]),
          None)
    check("no assets -> None", cs._openpuck_pick_asset([]), None)


def test_resolve_pinned_prefers_cache_no_network():
    """A verified pinned copy already in the cache is used WITHOUT any download
    (the download hook raises if called)."""
    print("test_resolve_pinned_prefers_cache_no_network")
    tmp = tempfile.mkdtemp(prefix="op-")
    cache = os.path.join(tmp, "cache.uf2")
    with open(cache, "wb") as f:
        f.write(_uf2_bytes(736))
    sha = cs._sha256_file(cache)

    def _boom(*a, **k):
        raise AssertionError("download must NOT be called on a cache hit")

    try:
        with Patch(_OPENPUCK_FW_SHA256=sha, _OPENPUCK_FW_MIN_SIZE=1,
                   _openpuck_cache_path=(lambda: cache), _openpuck_download=_boom,
                   _OPENPUCK_FIRMWARE="/no/seed.uf2"):
            path, err = cs._openpuck_resolve_pinned()
            check("cache hit -> that path", path, cache)
            check("cache hit -> no error", err, None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_resolve_pinned_downloads_then_verifies():
    """No cache: the resolver downloads from the fork, and only returns the copy if
    it matches the pin. A download that verifies is returned; one that does not is
    deleted and reported (degrade closed)."""
    print("test_resolve_pinned_downloads_then_verifies")
    tmp = tempfile.mkdtemp(prefix="op-")
    cache = os.path.join(tmp, "cache.uf2")
    good = _uf2_bytes(736)
    good_sha = cs.hashlib.sha256(good).hexdigest()

    def _dl_good(url, dest, timeout=60):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(good)
        return dest

    def _dl_bad(url, dest, timeout=60):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(b"\x00" * (512 * 736))  # right size, wrong bytes -> sha mismatch
        return dest

    try:
        with Patch(_OPENPUCK_FW_SHA256=good_sha, _OPENPUCK_FW_MIN_SIZE=1,
                   _openpuck_cache_path=(lambda: cache), _openpuck_download=_dl_good,
                   _OPENPUCK_FIRMWARE="/no/seed.uf2"):
            path, err = cs._openpuck_resolve_pinned()
            check("verified download -> cache path", path, cache)
            check("verified download -> no error", err, None)
        cache2 = os.path.join(tmp, "cache2.uf2")  # fresh path: no stale cache hit
        with Patch(_OPENPUCK_FW_SHA256=good_sha, _OPENPUCK_FW_MIN_SIZE=1,
                   _openpuck_cache_path=(lambda: cache2), _openpuck_download=_dl_bad,
                   _OPENPUCK_FIRMWARE="/no/seed.uf2"):
            path, err = cs._openpuck_resolve_pinned()
            check("bad download -> refused", path, None)
            check("bad download -> deleted", os.path.exists(cache2), False)
            check("bad download -> error set", bool(err), True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_resolve_pinned_offline_falls_back_to_seed():
    """Offline (download raises) + a valid pinned SEED -> use the seed. Offline +
    NO usable seed -> (None, error): degrade closed, never a guessed image."""
    print("test_resolve_pinned_offline_falls_back_to_seed")
    tmp = tempfile.mkdtemp(prefix="op-")
    cache = os.path.join(tmp, "cache.uf2")
    seed = os.path.join(tmp, "seed.uf2")
    with open(seed, "wb") as f:
        f.write(_uf2_bytes(736))
    sha = cs._sha256_file(seed)

    def _offline(*a, **k):
        raise OSError("offline (test)")

    try:
        with Patch(_OPENPUCK_FW_SHA256=sha, _OPENPUCK_FW_MIN_SIZE=1,
                   _openpuck_cache_path=(lambda: cache), _openpuck_download=_offline,
                   _OPENPUCK_FIRMWARE=seed):
            path, err = cs._openpuck_resolve_pinned()
            check("offline -> seed used", path, seed)
            check("offline seed -> no error", err, None)
        # A seed whose sha does NOT match the pin is refused (never flash a wrong build).
        with Patch(_OPENPUCK_FW_SHA256="0" * 64, _OPENPUCK_FW_MIN_SIZE=1,
                   _openpuck_cache_path=(lambda: cache), _openpuck_download=_offline,
                   _OPENPUCK_FIRMWARE=seed):
            path, err = cs._openpuck_resolve_pinned()
            check("offline + wrong-sha seed -> refused", path, None)
            check("offline + no usable seed -> error", bool(err), True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_resolve_pinned_prefers_seed_over_network():
    """A valid install SEED (or cache) is used WITHOUT any download — an offline box
    with a good local copy must never wait on a doomed network round-trip first
    (that latency can trip the app's flash timeout)."""
    print("test_resolve_pinned_prefers_seed_over_network")
    tmp = tempfile.mkdtemp(prefix="op-")
    seed = os.path.join(tmp, "seed.uf2")
    with open(seed, "wb") as f:
        f.write(_uf2_bytes(736))
    sha = cs._sha256_file(seed)

    def _boom(*a, **k):
        raise AssertionError("download must NOT be called when a valid seed exists")

    try:
        with Patch(_OPENPUCK_FW_SHA256=sha, _OPENPUCK_FW_MIN_SIZE=1,
                   _openpuck_cache_path=(lambda: os.path.join(tmp, "absent.uf2")),
                   _openpuck_download=_boom, _OPENPUCK_FIRMWARE=seed):
            path, err = cs._openpuck_resolve_pinned()
            check("seed used with no network", path, seed)
            check("seed -> no error", err, None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class urlopen_patch:
    """Swap cs.urllib.request.urlopen for the duration of a `with`."""

    def __init__(self, fn):
        self._fn = fn

    def __enter__(self):
        self._old = cs.urllib.request.urlopen
        cs.urllib.request.urlopen = self._fn

    def __exit__(self, *a):
        cs.urllib.request.urlopen = self._old


def test_download_rejects_truncated_content_length():
    """_openpuck_download raises on a clean-EOF truncation when Content-Length is
    known — the 'latest' path has no sha pin, so this is its truncation guard. A
    complete body (bytes == Content-Length) is accepted (control)."""
    print("test_download_rejects_truncated_content_length")
    import io

    class FakeResp:
        def __init__(self, body, clen):
            self._b = io.BytesIO(body)
            self._clen = clen

        def getheader(self, k, d=None):
            return self._clen if k == "Content-Length" else d

        def read(self, n=-1):
            return self._b.read(n)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    tmp = tempfile.mkdtemp(prefix="op-")
    dest = os.path.join(tmp, "fw.uf2")
    body = _uf2_bytes(700)
    try:
        # Header claims MORE bytes than the body delivers -> a truncation -> raise.
        with urlopen_patch(lambda req, timeout=60: FakeResp(body, str(len(body) + 512))):
            raised = False
            try:
                cs._openpuck_download("https://example/y.uf2", dest)
            except Exception:
                raised = True
            check("short vs Content-Length -> raises", raised, True)
            check("truncation -> no .part left", os.path.exists(dest + ".part"), False)
            check("truncation -> no dest written", os.path.exists(dest), False)
        # Control: bytes == Content-Length -> accepted.
        with urlopen_patch(lambda req, timeout=60: FakeResp(body, str(len(body)))):
            cs._openpuck_download("https://example/y.uf2", dest)
            check("complete download -> written", os.path.exists(dest), True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\nHTTP: POST /api/utilities/<id>/run")
# ---------------------------------------------------------------------------

def test_http_run_endpoint():
    print("test_http_run_endpoint")
    srv, port = _server()  # mock=True -> mock_openpuck_flash
    try:
        # Happy path: flash the board (mock).
        st, bd = _req(port, "POST", "/api/utilities/openpuck/run")
        check("POST openpuck/run -> 200", st, 200)
        check("mock flash -> ok True", bd.get("ok"), True)

        # variant is an allowlisted enum. pinned + latest are accepted (mock);
        # anything else is REJECTED with 400 and nothing flashes (§3.6).
        check("variant=pinned -> 200",
              _req(port, "POST", "/api/utilities/openpuck/run?variant=pinned")[0], 200)
        check("variant=latest -> 200",
              _req(port, "POST", "/api/utilities/openpuck/run?variant=latest")[0], 200)
        st, bd = _req(port, "POST", "/api/utilities/openpuck/run?variant=bogus")
        check("variant=bogus -> 400", st, 400)
        check("bogus variant -> not flashed", bd.get("ok"), False)
        st, bd = _req(port, "POST",
                      "/api/utilities/openpuck/run?variant=../../etc/passwd")
        check("path-shaped variant -> 400", st, 400)

        # Auth gate.
        check("no bearer -> 401",
              _req(port, "POST", "/api/utilities/openpuck/run", token=None)[0], 401)
        check("wrong bearer -> 401",
              _req(port, "POST", "/api/utilities/openpuck/run", token="nope")[0], 401)

        # cec is DETECTABLE but not runnable -> distinct 404, nothing runs.
        st, bd = _req(port, "POST", "/api/utilities/cec/run")
        check("cec/run -> 404", st, 404)
        check("cec/run says no run action", bd.get("error"), "utility has no run action")

        # Unknown utility id -> 404, nothing runs (reject not sanitise).
        st, bd = _req(port, "POST", "/api/utilities/bogus/run")
        check("bogus/run -> 404", st, 404)
        check("bogus/run unknown utility", bd.get("error"), "unknown utility")

        # Path-shaped / injection-shaped ids are just unknown ids -> 404.
        for bad in ("/api/utilities/..%2Frun/run", "/api/utilities/openpuck%20/run"):
            check("%s -> 404" % bad, _req(port, "POST", bad)[0], 404)

        # No /run suffix is not a run route at all (falls through to a 404).
        check("openpuck without /run -> 404",
              _req(port, "POST", "/api/utilities/openpuck")[0], 404)
    finally:
        srv.shutdown()


def test_http_latest_endpoint():
    """GET /api/utilities/openpuck/latest: the opt-in newer-check. Read-only, behind
    the bearer gate; the mock reports a newer build. It NEVER flashes."""
    print("test_http_latest_endpoint")
    srv, port = _server()  # mock=True -> mock_openpuck_latest
    try:
        st, bd = _req(port, "GET", "/api/utilities/openpuck/latest")
        check("GET openpuck/latest -> 200", st, 200)
        check("mock reports available", bd.get("available"), True)
        check("mock reports is_newer", bd.get("is_newer"), True)
        check("carries the pinned tag", bd.get("pinned_tag"), cs._OPENPUCK_FW_TAG)
        # Auth gate: same as every other /api route.
        check("no bearer -> 401",
              _req(port, "GET", "/api/utilities/openpuck/latest", token=None)[0], 401)
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
print("\ncap wiring")
# ---------------------------------------------------------------------------

def test_cap_present_in_mock_and_real():
    print("test_cap_present_in_mock_and_real")
    cs.set_caps(True)
    check("mock CAPS has utilities=True", cs.CAPS.get("utilities"), True)
    cs.set_caps(False)
    check("real CAPS has utilities=True", cs.CAPS.get("utilities"), True)


if __name__ == "__main__":
    for fn in (test_bootloader_mount_needs_label_and_marker,
               test_bootloader_label_without_marker_refused,
               test_bootloader_wrong_label_refused,
               test_bootloader_missing_root_degrades_closed,
               test_usb_present_matches_vid_pid,
               test_usb_present_missing_dir_degrades_closed,
               test_openpuck_state_precedence,
               test_cec_state_openability_matrix,
               test_cec_state_probe_raises_degrades_closed,
               test_state_iterates_frozen_id_set,
               test_mock_state_is_renderable,
               test_mock_flash_flips_state,
               test_real_state_uses_probes,
               test_http_endpoint,
               test_flash_no_board_degrades_closed,
               test_flash_missing_firmware_degrades_closed,
               test_flash_rejects_invalid_firmware,
               test_flash_clean_copy_is_success,
               test_flash_device_yank_errno_is_success,
               test_flash_other_errno_is_failure,
               test_flash_target_is_not_client_supplied,
               test_fw_valid_both_directions,
               test_pick_asset_prefers_standard_never_factory_reset,
               test_resolve_pinned_prefers_cache_no_network,
               test_resolve_pinned_downloads_then_verifies,
               test_resolve_pinned_offline_falls_back_to_seed,
               test_resolve_pinned_prefers_seed_over_network,
               test_download_rejects_truncated_content_length,
               test_http_run_endpoint,
               test_http_latest_endpoint,
               test_cap_present_in_mock_and_real):
        fn()
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall good")
