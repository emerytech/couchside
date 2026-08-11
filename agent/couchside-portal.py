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

# H.264/WebRTC profiles (P4b) — a CLOSED SET, same discipline as _STREAM_PROFILES.
# The client names a KEY; the helper owns every pipeline parameter. bitrate in kbps.
_H264_PROFILES = {
    "720p30":  {"width": 1280, "height": 720,  "fps": 30, "bitrate": 5000},
    "720p60":  {"width": 1280, "height": 720,  "fps": 60, "bitrate": 8000},
    "1080p30": {"width": 1920, "height": 1080, "fps": 30, "bitrate": 10000},
    "1080p60": {"width": 1920, "height": 1080, "fps": 60, "bitrate": 16000},
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


# Audible alert players tried in order when a consent dialog is about to pop —
# the phone cannot click Approve, someone has to at the box, so a chime helps a
# user who is not looking at the screen. argv LISTs, fixed strings, no client
# input (§3). Fire-and-forget; a box with no player / no audio stays silent.
_CHIME_PLAYERS = (
    ["canberra-gtk-play", "-i", "dialog-warning"],
    ["pw-play", "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga"],
    ["paplay", "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga"],
)


def _consent_chime():
    """Best-effort audible alert that the box is showing a consent dialog. Non-
    blocking, degrade-closed: any failure (no player, no audio) is ignored."""
    import shutil
    for argv in _CHIME_PLAYERS:
        if shutil.which(argv[0]):
            try:
                subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
            except OSError:
                continue
            return


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
        _consent_chime()                              # alert: Approve at the box
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
    """A unix fd to the session's PipeWire remote, for gstreamer. Returns an int
    fd the CALLER OWNS (must close) or None.

    OpenPipeWireRemote is called at most ONCE per session; the fd is CACHED on the
    session and every caller gets an `os.dup()` of it. A SECOND OpenPipeWireRemote
    on a KDE portal session hands back a DEAD remote (0 frames) — proven on
    hardware: the FIRST /ws/screen streamed, every reopen showed nothing because
    the agent re-opened the remote per connect. Caching + dup keeps the one good
    remote alive for the session's life, so reopens (and the WebRTC path) work.
    Closing a dup only drops that consumer; the cached original stays open."""
    with _SLOCK:
        sess = _SESSION
        if sess is None:
            return None
        cached = sess.get("pwfd")
        if cached is None:
            try:
                ret, fdlist = _con.call_with_unix_fd_list_sync(
                    _PORTAL, _OBJ, _IF_SC, "OpenPipeWireRemote",
                    GLib.Variant("(oa{sv})", (sess["handle"], {})),
                    GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE, -1, None, None)
                cached = fdlist.get(ret.unpack()[0])
            except Exception:
                return None
            if cached is None:
                return None
            sess["pwfd"] = cached
        try:
            return os.dup(cached)
        except OSError:
            return None


# ---------------------------------------------------------------- the verbs ---

def verb_status():
    h264 = _h264_available()
    with _SLOCK:
        sess = _SESSION
    base = {"ok": True, "h264": h264, "h264_profiles": sorted(_H264_PROFILES)}
    if sess is None:
        base["session"] = False
        return base
    base.update({"session": True, "w": sess["w"], "h": sess["h"],
                 "node": sess["node"], "profiles": sorted(_STREAM_PROFILES)})
    return base


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


def _h264_profile_arg(v):
    """An H.264/WebRTC profile KEY. Looked up, never interpolated (§3.1)."""
    if isinstance(v, dict):
        v = v.get("profile")
    return v if isinstance(v, str) and v in _H264_PROFILES else None


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

_HW_JPEG = None


def _hw_jpeg():
    """True if the box has a hardware JPEG encoder (vapostproc + vajpegenc).
    Cached. Degrade closed to software jpegenc."""
    global _HW_JPEG
    if _HW_JPEG is None:
        try:
            import gi as _gi
            _gi.require_version("Gst", "1.0")
            from gi.repository import Gst as _Gst
            _Gst.init(None)
            _HW_JPEG = (_Gst.ElementFactory.find("vajpegenc") is not None
                        and _Gst.ElementFactory.find("vapostproc") is not None)
        except Exception:
            _HW_JPEG = False
    return _HW_JPEG


def _stream_argv(profile, pwfd, node):
    """gstreamer argv LIST for one profile. Every pipeline element and parameter
    is chosen HERE; the client only picked the profile key. pipewiresrc reads the
    portal's own node over the passed fd; encoder → fdsink fd=1 (stdout).

    Prefer HARDWARE JPEG (vapostproc VAMemory → vajpegenc): on an Intel iGPU the
    software jpegenc capped the box at ~6fps @720p — the display 'lag'. vajpegenc
    clears 300+fps, so the box no longer bottlenecks the MJPEG. Software jpegenc
    is the fallback where no VA encoder exists."""
    p = _STREAM_PROFILES[profile]
    argv = ["gst-launch-1.0", "-q",
            "pipewiresrc", "fd=%d" % pwfd, "path=%d" % node, "keepalive-time=1000",
            "!", "videorate", "!", "video/x-raw,framerate=%d/1" % p["fps"]]
    if _hw_jpeg():
        argv += ["!", "vapostproc",
                 "!", "video/x-raw(memory:VAMemory),format=NV12,width=%d,height=%d"
                 % (p["width"], p["height"]),
                 "!", "vajpegenc", "quality=%d" % p["quality"]]
    else:
        argv += ["!", "videoscale", "!", "videoconvert",
                 "!", "video/x-raw,width=%d,height=%d" % (p["width"], p["height"]),
                 "!", "jpegenc", "quality=%d" % p["quality"]]
    argv += ["!", "fdsink", "fd=1"]
    return argv


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


# ---- H.264 / WebRTC (P4b) --------------------------------------------------
# In-process `webrtcbin` (NOT gst-launch — it needs async create-offer / ICE
# callbacks). H264-only, sendonly, host candidates only (stun-server=NULL: the
# app and box share a LAN). The agent's /ws/webrtc relays OPAQUE SDP/ICE JSON
# between the app and this socket; THIS builds the whole pipeline. §3: no client
# string ever reaches gst — the client only names a profile KEY (looked up), and
# the PipeWire node/fd come only from the portal's own Start result.
#
# All GStreamer gi imports are LAZY + guarded so a box missing GstWebRTC/GstSdp
# (or the libnice `nice` plugin webrtcbin needs) degrades closed to no-h264 —
# it must NOT break import (that would take the shipped P4a MJPEG path down too).

_ALLOWED_WEBRTC_IN = ("answer", "ice", "bye")   # frozen set of inbound msg types
_WEBRTC_LOCK = threading.Lock()                 # one WebRTC session at a time (heavy)


class _ByeSignal(Exception):
    """Internal: the peer sent {t:bye}; unwind the signaling read loop."""


def _h264_available():
    """True only if webrtcbin can ACTUALLY run here — which requires the libnice
    `nice` elements (nicesrc/nicesink), NOT just that webrtcbin is registered.
    Proven on hardware: `gst-inspect webrtcbin` succeeds but any media pad errors
    'libnice elements are not available' without the nice plugin. Also needs a VA
    H.264 encoder + the RTP/portal path. Degrade closed on any failure."""
    try:
        import gi as _gi
        _gi.require_version("Gst", "1.0")
        _gi.require_version("GstWebRTC", "1.0")
        _gi.require_version("GstSdp", "1.0")
        from gi.repository import Gst as _Gst
        _Gst.init(None)
        need = ("webrtcbin", "nicesrc", "nicesink", "rtph264pay",
                "vapostproc", "pipewiresrc", "h264parse", "videorate")
        if any(_Gst.ElementFactory.find(e) is None for e in need):
            return False
        if _Gst.ElementFactory.find("vah264enc") is None and \
           _Gst.ElementFactory.find("vah264lpenc") is None:
            return False
        return True
    except Exception:
        return False


def _webrtc_desc(profile, pwfd, node, Gst):
    """gstreamer-parse description for one profile. Every element/parameter is
    chosen HERE. Prefer the full `vah264enc` (CBR = predictable bitrate for
    streaming); fall back to the low-power `vah264lpenc` (CQP-only on some GPUs).
    webrtcbin is declared and linked via the trailing-dot request-pad syntax
    (inline `! webrtcbin` fails to link — proven)."""
    p = _H264_PROFILES[profile]
    if Gst.ElementFactory.find("vah264enc") is not None:
        enc = ("vah264enc rate-control=cbr bitrate=%d target-usage=7 "
               "key-int-max=%d b-frames=0 ref-frames=1"
               % (p["bitrate"], p["fps"] * 2))
    else:
        enc = ("vah264lpenc rate-control=cqp target-usage=7 "
               "key-int-max=%d b-frames=0 ref-frames=1" % (p["fps"] * 2))
    return ("webrtcbin name=sendrecv bundle-policy=max-bundle latency=0 "
            "pipewiresrc fd=%d path=%d do-timestamp=true keepalive-time=1000 "
            "! videorate ! video/x-raw,framerate=%d/1 "
            "! vapostproc ! video/x-raw(memory:VAMemory),format=NV12,width=%d,height=%d "
            "! %s ! h264parse config-interval=-1 "
            "! rtph264pay pt=96 config-interval=-1 aggregate-mode=zero-latency mtu=1200 "
            "! queue ! application/x-rtp,media=video,encoding-name=H264,payload=96 "
            "! sendrecv."
            % (pwfd, node, p["fps"], p["width"], p["height"], enc))


def _webrtc_session(profile, conn):
    """One WebRTC streaming session: build the webrtcbin pipeline for `profile`,
    exchange OPAQUE SDP/ICE as JSON lines over `conn` (the agent relays them to
    the app), stream until the peer sends {t:bye} or disconnects, then REAP the
    pipeline (a leaked encoder keeps filming the screen).

    webrtcbin is built and driven on a DEDICATED GLib main-loop thread (default
    context) — proven on hardware: driving it from a private thread-default
    context yields an empty offer (webrtcbin's DTLS/ICE machinery expects the
    global default context). The socket read loop runs on THIS thread and hands
    inbound answer/ICE to the loop thread via idle_add. One session at a time
    (_WEBRTC_LOCK) — webrtcbin is heavy and shares the default context."""
    try:
        import gi as _gi
        _gi.require_version("Gst", "1.0")
        _gi.require_version("GstWebRTC", "1.0")
        _gi.require_version("GstSdp", "1.0")
        from gi.repository import GLib as _GLib, Gst, GstWebRTC, GstSdp
        Gst.init(None)
    except Exception:
        _send_json(conn, {"t": "error", "error": "no webrtc support"})
        return
    if _ensure_session() is None:
        _send_json(conn, {"t": "error", "error": "no session"})
        return
    if not _WEBRTC_LOCK.acquire(blocking=False):
        _send_json(conn, {"t": "error", "error": "busy"})       # cap 1
        return

    with _SLOCK:
        node = _SESSION["node"]
    loop = _GLib.MainLoop()                                      # default context
    state = {"pipeline": None, "webrtc": None, "pwfd": None,
             "wlock": threading.Lock()}

    def send(obj):
        # webrtcbin fires offer/ICE on internal gst threads → serialize writes.
        with state["wlock"]:
            try:
                conn.sendall((json.dumps(obj) + "\n").encode())
            except OSError:
                loop.quit()

    def on_offer_created(promise, _elem, _u):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value("offer") if reply else None
        if offer is None:
            return
        state["webrtc"].emit("set-local-description", offer, Gst.Promise.new())
        send({"t": "offer", "sdp": offer.sdp.as_text()})

    def on_negotiation_needed(elem):
        pr = Gst.Promise.new_with_change_func(on_offer_created, elem, None)
        elem.emit("create-offer", None, pr)

    def on_ice(_elem, mline, cand):
        send({"t": "ice", "sdpMLineIndex": int(mline), "candidate": cand})

    def build():                                                # on the loop thread
        pwfd = _open_pipewire_fd()
        if pwfd is None:
            send({"t": "error", "error": "no pw fd"})
            loop.quit()
            return False
        state["pwfd"] = pwfd
        try:
            pipeline = Gst.parse_launch(_webrtc_desc(profile, pwfd, node, Gst))
            state["pipeline"] = pipeline
            wb = pipeline.get_by_name("sendrecv")
            state["webrtc"] = wb
            try:
                wb.set_property("stun-server", None)   # host candidates only (LAN)
            except Exception:
                pass
            wb.connect("on-negotiation-needed", on_negotiation_needed)
            wb.connect("on-ice-candidate", on_ice)

            # Pump the pipeline bus: webrtcbin relies on its bus being serviced
            # (without a watch the negotiation stalls / yields an empty offer,
            # proven on hardware). Log errors; end the session on a fatal one.
            def _on_bus(_b, m):
                if m.type == Gst.MessageType.ERROR:
                    err, dbg = m.parse_error()
                    print("[portal] webrtc bus error: %s | %s"
                          % (err.message, dbg), flush=True)
                    loop.quit()
            bus = pipeline.get_bus()
            bus.add_signal_watch()
            bus.connect("message", _on_bus)
            state["bus"] = bus
            pipeline.set_state(Gst.State.PLAYING)
        except Exception:
            send({"t": "error", "error": "pipeline failed"})
            loop.quit()
        return False

    def do_answer(sdp):
        _res, m = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp.encode(), m)
        ans = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.ANSWER, m)
        state["webrtc"].emit("set-remote-description", ans, Gst.Promise.new())
        return False

    def do_ice(cand, mline):
        state["webrtc"].emit("add-ice-candidate", mline, cand)
        return False

    lt = threading.Thread(target=loop.run, daemon=True)
    lt.start()
    _GLib.idle_add(build)

    # Inbound signaling: read JSON lines on THIS thread, marshal to the loop.
    buf = b""
    try:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                t = msg.get("t")
                if t not in _ALLOWED_WEBRTC_IN:            # frozen inbound set (§3.2)
                    continue
                if t == "answer" and isinstance(msg.get("sdp"), str):
                    _GLib.idle_add(do_answer, msg["sdp"])
                elif t == "ice":
                    cand, mline = msg.get("candidate"), msg.get("sdpMLineIndex", 0)
                    if isinstance(cand, str) and isinstance(mline, int):
                        _GLib.idle_add(do_ice, cand, mline)
                elif t == "bye":
                    raise _ByeSignal()
    except (OSError, _ByeSignal):
        pass
    finally:
        loop.quit()
        lt.join(timeout=3)
        if state.get("bus") is not None:
            try:
                state["bus"].remove_signal_watch()
            except Exception:
                pass
        if state["pipeline"] is not None:
            state["pipeline"].set_state(Gst.State.NULL)   # REAP the encoder
        if state["pwfd"] is not None:
            try:
                os.close(state["pwfd"])
            except OSError:
                pass
        _WEBRTC_LOCK.release()


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


def _send_json(conn, obj):
    try:
        conn.sendall((json.dumps(obj) + "\n").encode())
    except OSError:
        pass


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
        # The webrtc verb switches this connection to a JSON SDP/ICE signaling
        # channel (H.264 over webrtcbin); every other verb is one line in/out.
        if isinstance(req, dict) and req.get("verb") == "webrtc":
            profile = _h264_profile_arg(req.get("arg"))
            if profile is None:
                conn.sendall(json.dumps(
                    {"ok": False, "error": "invalid argument for webrtc"}).encode()
                    + b"\n")
                return
            conn.settimeout(None)                    # long-lived signaling
            _webrtc_session(profile, conn)
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
