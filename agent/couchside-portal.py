#!/usr/bin/env python3
"""Couchside's remote-desktop portal helper — the OPT-IN module core.

WHY THIS EXISTS
---------------
Wayland remote-desktop (absolute pointer + fluid screen capture) goes through
xdg-desktop-portal, NOT raw uinput: kwin honors the RemoteDesktop/ScreenCast
PORTAL, and a virtual absolute uinput device is silently ignored (proven on a
KDE box — raw-uinput absolute is a dead end). The portal driver needs
`gi`/`Gio` (PyGObject), a THIRD-PARTY import the base agent forbids
(couchsided.py is pure-stdlib, single file). So the portal code lives HERE, in a
separate process the agent spawns and talks to over a local socket — the same
shape as couchside-helper.py, with one deliberate difference:

  THIS RUNS AS THE USER, NOT ROOT. The portal, PipeWire and the Wayland session
  bus are all the desktop user's. There is no privileged operation here; running
  it as root would be both wrong (root can't reach the user's portal) and a
  needless escalation. Auth is still two layers, both fail closed: a 0600 socket
  under the user's XDG_RUNTIME_DIR, and an SO_PEERCRED uid check == our own uid.

ONE SESSION, BOTH FEATURES
--------------------------
A single portal session selects RemoteDesktop POINTER + ScreenCast MONITOR, so
ONE consent dialog grants input AND capture. Absolute input (NotifyPointerMotion
Absolute) and the MJPEG stream (gstreamer pipewiresrc → jpegenc) are two
independent consumers of that one session. Consent is per-session on older KDE
(no persist checkbox); newer KDE can persist via restore_token.

THE RULES THIS FILE LIVES BY (CLAUDE.md §3)
-------------------------------------------
1. VERBS is a frozen table. A verb is looked up, never interpolated.
2. Each verb validates its argument against a CLOSED SET / numeric range. Unknown
   verb or bad argument is an error reply and NOTHING RUNS.
3. subprocess is an argv LIST, never shell=True, never a formatted command. The
   gstreamer profile (resolution/fps/quality) is chosen from a frozen dict by the
   client naming a KEY; no client string ever reaches gst args or a shell.
4. No verb takes a path, a node, a command, or a pipeline from the caller. The
   PipeWire node id comes only from the portal's own Start result.
5. Degrade closed: no session / no consent / unreadable peer → refuse, never act.
"""
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import threading

import gi
gi.require_version("Gio", "2.0")
from gi.repository import GLib, Gio  # noqa: E402

VERSION = "0.1.0"

# The uid allowed to talk to us. Defaults to our OWN uid (agent and helper run as
# the same desktop user); --uid/--user only narrows, never widens beyond a real
# account. There is no "any user" mode.
ALLOWED_UID = None

# xdg-desktop-portal object + interfaces.
_PORTAL = "org.freedesktop.portal.Desktop"
_OBJ = "/org/freedesktop/portal/desktop"
_IF_RD = "org.freedesktop.portal.RemoteDesktop"
_IF_SC = "org.freedesktop.portal.ScreenCast"

# Pointer button evdev codes — a CLOSED SET. A client names one of these keys.
_BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}

# gstreamer capture profiles — a CLOSED SET. The client names a KEY; the agent/
# helper own every pipeline parameter. Nothing here is client-supplied. Sized for
# a 16:9 source (the box is 1920x1080); a general build would derive w/h from the
# stream aspect.
_STREAM_PROFILES = {
    "540p25":  {"width": 960,  "height": 540,  "fps": 25, "quality": 72},
    "720p20":  {"width": 1280, "height": 720,  "fps": 20, "quality": 75},
    "1080p15": {"width": 1920, "height": 1080, "fps": 15, "quality": 70},
}

# How long Start may wait for the user to click Share/Allow on the box.
_CONSENT_TIMEOUT_S = 150

# ---- portal D-Bus machinery (raw Gio — pydbus mangles CreateSession's return) --
#
# Every Create/Select/Start is Request/Response: the method returns a /request/
# handle and the real result arrives on the Response signal, delivered only while
# a GLib main loop runs. SelectDevices/SelectSources auto-Respond in microseconds,
# so the AddMatch rule MUST be installed synchronously (blocking) BEFORE the call
# or the fast Response races past. All proven on hardware.

_con = Gio.bus_get_sync(Gio.BusType.SESSION, None)
_sender_token = _con.get_unique_name()[1:].replace(".", "_")


def _add_match_sync(path):
    rule = ("type='signal',sender='org.freedesktop.portal.Desktop',"
            "interface='org.freedesktop.portal.Request',member='Response',"
            "path='%s'" % path)
    _con.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                   "org.freedesktop.DBus", "AddMatch",
                   GLib.Variant("(s)", (rule,)), None,
                   Gio.DBusCallFlags.NONE, -1, None)


def _request(iface, method, body_sig, body, opts, timeout_s):
    """Issue a Request-pattern portal method; block until its Response signal
    (or timeout). Returns (code, results_dict) — code 0 == success."""
    htok = "h%s" % secrets.token_hex(4)
    predicted = "/org/freedesktop/portal/desktop/request/%s/%s" % (_sender_token, htok)
    _add_match_sync(predicted)                      # rule active BEFORE the call
    holder = {}
    loop = GLib.MainLoop()

    def on_response(conn, sender, obj, iface_, sig, params):
        if "code" in holder:
            return
        holder["code"], holder["results"] = params.unpack()
        loop.quit()

    sub = _con.signal_subscribe(
        None, "org.freedesktop.portal.Request", "Response",
        predicted, None, Gio.DBusSignalFlags.NONE, on_response)
    full = dict(opts)
    full["handle_token"] = GLib.Variant("s", htok)
    args = GLib.Variant("(%sa{sv})" % body_sig, tuple(body) + (full,))
    _con.call_sync(_PORTAL, _OBJ, iface, method, args,
                   GLib.VariantType.new("(o)"), Gio.DBusCallFlags.NONE, -1, None)
    timed_out = {"v": False}
    def _on_timeout():
        timed_out["v"] = True
        loop.quit()
        return False                                # one-shot
    tid = GLib.timeout_add_seconds(timeout_s, _on_timeout)
    loop.run()
    if not timed_out["v"]:
        GLib.source_remove(tid)                     # only remove a source that didn't fire
    _con.signal_unsubscribe(sub)
    if "code" not in holder:
        return None, None                           # timed out (no click)
    return holder["code"], holder["results"]


def _notify(method, sig, body):
    """A NotifyPointer*/NotifyKeyboard* call — direct, no Response, thread-safe."""
    _con.call_sync(_PORTAL, _OBJ, _IF_RD, method, GLib.Variant(sig, body),
                   None, Gio.DBusCallFlags.NONE, -1, None)


# ---- shared portal session state -------------------------------------------
_SLOCK = threading.RLock()
_SESSION = None    # {"handle": str, "node": int, "w": int, "h": int} or None


def _ensure_session():
    """Create + consent the ONE portal session if we don't have it yet.
    Serialized: setup happens once. Returns the session dict or None (denied/
    timed out). Consent BLOCKS on the user clicking Share/Allow on the box."""
    global _SESSION
    with _SLOCK:
        if _SESSION is not None:
            return _SESSION
        stok = "cs%s" % secrets.token_hex(4)
        code, res = _request(_IF_RD, "CreateSession", "", (),
                             {"session_handle_token": GLib.Variant("s", stok)}, 15)
        if code != 0 or not res:
            return None
        handle = res["session_handle"]
        code, _ = _request(_IF_RD, "SelectDevices", "o", (handle,),
                           {"types": GLib.Variant("u", 2)}, 15)          # POINTER
        if code != 0:
            return None
        code, _ = _request(_IF_SC, "SelectSources", "o", (handle,),
                           {"types": GLib.Variant("u", 1),               # MONITOR
                            "cursor_mode": GLib.Variant("u", 2),          # embedded
                            "multiple": GLib.Variant("b", False)}, 15)
        if code != 0:
            return None
        # Start pops the KDE consent dialog. persist_mode=2 asks to remember (a
        # no-op on older KDE that lacks the checkbox — then it re-prompts).
        code, res = _request(_IF_RD, "Start", "os", (handle, ""),
                             {"persist_mode": GLib.Variant("u", 2)},
                             _CONSENT_TIMEOUT_S)
        if code != 0 or not res:
            return None
        streams = res.get("streams") or []
        if not streams:
            return None
        node = int(streams[0][0])
        size = streams[0][1].get("size") or (1920, 1080)
        _SESSION = {"handle": handle, "node": node,
                    "w": int(size[0]), "h": int(size[1])}
        return _SESSION


def _open_pipewire_fd():
    """OpenPipeWireRemote on the live session → a unix fd for gstreamer. The
    session must already exist. Returns an int fd (caller owns it) or None."""
    with _SLOCK:
        sess = _SESSION
    if sess is None:
        return None
    ret, fdlist = _con.call_with_unix_fd_list_sync(
        _PORTAL, _OBJ, _IF_SC, "OpenPipeWireRemote",
        GLib.Variant("(oa{sv})", (sess["handle"], {})),
        GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE, -1, None, None)
    idx = ret.unpack()[0]
    return fdlist.get(idx)


# ---------------------------------------------------------------- the verbs ---

def verb_status():
    with _SLOCK:
        sess = _SESSION
    if sess is None:
        return {"ok": True, "session": False}
    return {"ok": True, "session": True, "w": sess["w"], "h": sess["h"],
            "node": sess["node"], "profiles": sorted(_STREAM_PROFILES)}


def verb_ensure():
    sess = _ensure_session()
    if sess is None:
        return {"ok": False, "error": "no consent / session"}
    return {"ok": True, "w": sess["w"], "h": sess["h"], "node": sess["node"]}


def verb_move(arg):
    x, y = arg                                       # validated 0..1 floats
    sess = _ensure_session()
    if sess is None:
        return {"ok": False, "error": "no session"}
    px = float(x) * sess["w"]
    py = float(y) * sess["h"]
    _notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)",
            (sess["handle"], {}, sess["node"], px, py))
    return {"ok": True}


def verb_button(arg):
    code, state = arg                                # validated (evdev code, 0/1)
    sess = _ensure_session()
    if sess is None:
        return {"ok": False, "error": "no session"}
    _notify("NotifyPointerButton", "(oa{sv}iu)", (sess["handle"], {}, code, state))
    return {"ok": True}


# ---- argument validators (return the parsed value, or None to REFUSE) -------

def _move_arg(v):
    if not isinstance(v, dict):
        return None
    x, y = v.get("x"), v.get("y")
    if not (isinstance(x, (int, float)) and isinstance(y, (int, float))):
        return None
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return None
    return (float(x), float(y))


def _button_arg(v):
    if not isinstance(v, dict):
        return None
    name, state = v.get("button"), v.get("state")
    if name not in _BUTTONS or state not in (0, 1):
        return None
    return (_BUTTONS[name], state)


def _profile_arg(v):
    """A stream profile KEY. Looked up, never interpolated (§3.1)."""
    if isinstance(v, dict):
        v = v.get("profile")
    return v if isinstance(v, str) and v in _STREAM_PROFILES else None


# one-shot JSON verbs (streaming is handled separately in serve_one)
VERBS = {
    "status": (verb_status, None),
    "ensure": (verb_ensure, None),
    "move":   (verb_move,   _move_arg),
    "button": (verb_button, _button_arg),
}


def dispatch(req):
    if not isinstance(req, dict):
        return {"ok": False, "error": "malformed request"}
    verb = req.get("verb")
    if not isinstance(verb, str) or verb not in VERBS:
        return {"ok": False, "error": "unknown verb"}
    handler, validate = VERBS[verb]
    if validate is None:
        return handler()
    arg = validate(req.get("arg"))
    if arg is None:
        return {"ok": False, "error": "invalid argument for %s" % verb}
    return handler(arg)


# ---- streaming (raw MJPEG bytes, not a JSON reply) --------------------------

def _stream_argv(profile, pwfd, node):
    """gstreamer argv LIST for one profile. Every pipeline element and parameter
    is chosen HERE; the client only picked the profile key. pipewiresrc reads the
    portal's own node over the passed fd; jpegenc → fdsink fd=1 (stdout)."""
    p = _STREAM_PROFILES[profile]
    caps = "video/x-raw,framerate=%d/1,width=%d,height=%d" % (
        p["fps"], p["width"], p["height"])
    return ["gst-launch-1.0", "-q",
            "pipewiresrc", "fd=%d" % pwfd, "path=%d" % node, "keepalive-time=1000",
            "!", "videorate", "!", "videoscale", "!", "videoconvert",
            "!", caps,
            # TODO(backpressure): a `queue leaky=downstream` here stalled the
            # pipeline mid-frame on hardware (2026-08-10) — needs isolated gst
            # tuning (placement/max-size). For now no leaky queue: a slow phone
            # backpressures gst via TCP flow control. Drop-oldest to be added
            # once verified in isolation, not guessed on a live session.
            "!", "jpegenc", "quality=%d" % p["quality"],
            "!", "fdsink", "fd=1"]


def stream(profile, conn):
    """Spawn gst for `profile` and pipe its MJPEG stdout to `conn` until the peer
    disconnects, then reap. The agent side splits the MJPEG byte stream on
    FFD8..FFD9 and frames each JPEG onto /ws/screen."""
    if _ensure_session() is None:
        return
    with _SLOCK:
        node = _SESSION["node"]
    pwfd = _open_pipewire_fd()
    if pwfd is None:
        return
    proc = None
    try:
        proc = subprocess.Popen(
            _stream_argv(profile, pwfd, node),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=(pwfd,))
    finally:
        try:
            os.close(pwfd)                           # the child holds it now
        except OSError:
            pass
    if proc is None:
        return
    nbytes = 0
    try:
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break                                # gst ended
            nbytes += len(chunk)
            conn.sendall(chunk)                      # raises when the peer is gone
    except OSError:
        pass                                         # peer disconnected — normal
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        if nbytes == 0:
            err = b""
            try:
                err = proc.stderr.read() or b""
            except OSError:
                pass
            print("[portal] stream: NO BYTES; gst stderr: %s"
                  % err.decode("utf-8", "replace").strip()[:500], flush=True)
        try:
            proc.stderr.close()
        except OSError:
            pass


# ------------------------------------------------------------------- serving

def peer_uid(conn):
    """The caller's uid via SO_PEERCRED, or None (REFUSE). Unknown is never
    allowed (§3.5)."""
    try:
        creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", creds)
        return uid
    except (OSError, struct.error, AttributeError):
        return None


def _read_line(conn, limit=65536):
    buf = b""
    while b"\n" not in buf and len(buf) < limit:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    return buf.split(b"\n", 1)[0]


def serve_one(conn):
    try:
        uid = peer_uid(conn)
        if uid is None or ALLOWED_UID is None or uid != ALLOWED_UID:
            try:
                conn.sendall(json.dumps(
                    {"ok": False, "error": "not authorized"}).encode() + b"\n")
            except OSError:
                pass
            return
        conn.settimeout(_CONSENT_TIMEOUT_S + 30)
        try:
            req = json.loads(_read_line(conn).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            conn.sendall(json.dumps(
                {"ok": False, "error": "malformed request"}).encode() + b"\n")
            return
        # The stream verb switches this connection to raw MJPEG bytes; every
        # other verb is one JSON line in, one JSON line out.
        if isinstance(req, dict) and req.get("verb") == "stream":
            profile = _profile_arg(req.get("arg"))
            if profile is None:
                conn.sendall(json.dumps(
                    {"ok": False, "error": "invalid argument for stream"}).encode()
                    + b"\n")
                return
            conn.settimeout(None)                    # long-lived stream
            stream(profile, conn)
            return
        reply = dispatch(req)
        conn.sendall(json.dumps(reply).encode() + b"\n")
    except OSError:
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _listen_socket(path):
    """Our own 0600 socket under the user's runtime dir. Only our uid can even
    reach it; SO_PEERCRED is the second, in-band check."""
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        os.unlink(path)
    except OSError:
        pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chmod(path, 0o600)
    s.listen(8)
    return s


def _default_socket_path():
    rt = os.environ.get("XDG_RUNTIME_DIR") or ("/run/user/%d" % os.getuid())
    return os.path.join(rt, "couchside", "portal.sock")


def main(argv=None):
    global ALLOWED_UID
    argv = list(sys.argv[1:] if argv is None else argv)
    path = None
    for i, a in enumerate(argv):
        if a == "--uid" and i + 1 < len(argv):
            ALLOWED_UID = int(argv[i + 1])
        elif a == "--socket" and i + 1 < len(argv):
            path = argv[i + 1]
        elif a == "--version":
            print(VERSION)
            return 0
    if ALLOWED_UID is None:
        ALLOWED_UID = os.getuid()                    # same-user agent by default
    if path is None:
        path = _default_socket_path()

    # systemd socket activation (fd 3), else bind our own.
    srv = None
    if os.environ.get("LISTEN_PID") == str(os.getpid()) and \
            int(os.environ.get("LISTEN_FDS", "0") or 0) >= 1:
        srv = socket.socket(fileno=3)
    if srv is None:
        srv = _listen_socket(path)
    print("[portal] serving on %s (allowed uid %d)" % (path, ALLOWED_UID),
          flush=True)
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            continue
        threading.Thread(target=serve_one, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
