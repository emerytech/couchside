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
import time

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

def _screencast_backend_ok():
    """True only when the portal ACTUALLY implements ScreenCast AND RemoteDesktop
    — i.e. a real backend is present (a KDE / wlroots DESKTOP session). In Steam
    Game Mode the xdg-desktop-portal frontend runs but has NO screencast backend:
    both interfaces are absent (Get raises UnknownMethod), _ensure_session's
    CreateSession can never succeed, and /ws/screen would 101-then-close. Reporting
    it here keeps caps.screenstream[_h264] HONEST — without it the box advertises a
    fluid tier that does not exist, and the app burns its full connect timeout on
    each dead tier (H.264 then MJPEG) before falling back to the still-frame poller.

    Cheap Properties.Get(version) — NO session, NO consent dialog: a live backend
    answers in ms, a missing one raises immediately. Short-circuits on the first
    absent interface. Degrade closed (§3.7): any error, or a hung portal, reads as
    no-backend (False)."""
    for iface in (_IF_SC, _IF_RD):
        try:
            _con.call_sync(
                _PORTAL, _OBJ, "org.freedesktop.DBus.Properties", "Get",
                GLib.Variant("(ss)", (iface, "version")),
                GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, 800, None)
        except Exception:
            return False
    return True


def verb_status():
    h264 = _h264_available()
    # Whether a working portal screencast backend exists (desktop) or not (game
    # mode). The agent gates caps.screenstream[_h264] on this so a game-mode box
    # never advertises a fluid tier it can't serve. Cheap + consent-free.
    backend = _screencast_backend_ok()
    # Read the session WITHOUT taking _SLOCK. _ensure_session holds _SLOCK for its
    # ENTIRE run, including the Start call that BLOCKS on the user's consent (up to
    # _CONSENT_TIMEOUT_S). The agent probes this verb on a ~2s budget to fill
    # caps.screenstream[_h264]; blocking on _SLOCK made that probe time out whenever
    # a consent dialog was pending, so caps read False and the app never offered the
    # fluid tiers. A single-pointer read needs no lock: _ensure_session publishes
    # `_SESSION = {...}` as its last step and _close_session sets it to None, both
    # atomic under the GIL, so a reader sees either None or a fully-built dict.
    sess = _SESSION
    base = {"ok": True, "screencast": backend,
            "h264": h264, "h264_profiles": sorted(_H264_PROFILES)}
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


# NOTE deliberately NO keyboard verbs here: phone-keyboard typing rides the
# AGENT's existing uinput path ({t:'kt'}/{t:'k'} on /ws/gamepad), which is
# PROVEN on the KDE desktop (typed into a konsole + opened Kickoff via a
# virtual uinput keyboard on hardware, 2026-08-11). The portal alternative
# (NotifyKeyboardKeysym) was probed the same day: the call chain exists in
# xdg-desktop-portal-kde 6.6.4 but no keystrokes ever landed — and the uinput
# path needs no extra portal capability in the consent dialog.


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


_VA_H264ENC = None


def _va_h264enc():
    """The VA H.264 encoder element to use, or None. Prefer the full `vah264enc`
    (rate-control=cbr gives a predictable streaming bitrate); fall back to the
    low-power `vah264lpenc` (CQP-only on some GPUs). Cached; degrade closed."""
    global _VA_H264ENC
    if _VA_H264ENC is None:
        try:
            import gi as _gi
            _gi.require_version("Gst", "1.0")
            from gi.repository import Gst as _Gst
            _Gst.init(None)
            if _Gst.ElementFactory.find("vah264enc") is not None:
                _VA_H264ENC = "vah264enc"
            elif _Gst.ElementFactory.find("vah264lpenc") is not None:
                _VA_H264ENC = "vah264lpenc"
            else:
                _VA_H264ENC = ""
        except Exception:
            _VA_H264ENC = ""
    return _VA_H264ENC or None


def _stream_h264_argv(profile, pwfd, node):
    """gstreamer argv LIST for one H.264 profile — the P4b fluid tier. Produces an
    Annex-B (byte-stream) elementary stream, one access unit at a time, to fdsink
    fd=1. Every element/parameter is chosen HERE; the client only named a profile
    KEY. `config-interval=-1` inlines SPS/PPS ahead of each IDR and `alignment=au`
    (plus the encoder's AUD, NAL type 9) delimits access units, so the app can
    segment the stream on the AUD start code — the WebCodecs decoder consumes
    Annex-B directly (no AVCC/description). Proven on hardware (bazzite Intel UHD
    620): NAL types [1,5,7,8,9] flow. §3: no client string reaches gst."""
    p = _H264_PROFILES[profile]
    enc = _va_h264enc()
    argv = ["gst-launch-1.0", "-q",
            "pipewiresrc", "fd=%d" % pwfd, "path=%d" % node, "keepalive-time=1000",
            "!", "videorate", "!", "video/x-raw,framerate=%d/1" % p["fps"],
            "!", "vapostproc",
            "!", "video/x-raw(memory:VAMemory),format=NV12,width=%d,height=%d"
            % (p["width"], p["height"])]
    if enc == "vah264enc":
        argv += ["!", "vah264enc", "rate-control=cbr", "bitrate=%d" % p["bitrate"],
                 "target-usage=7", "key-int-max=%d" % (p["fps"] * 2),
                 "b-frames=0", "ref-frames=1"]
    else:                                            # vah264lpenc (CQP-only)
        argv += ["!", "vah264lpenc", "rate-control=cqp", "target-usage=7",
                 "key-int-max=%d" % (p["fps"] * 2), "b-frames=0", "ref-frames=1"]
    argv += ["!", "h264parse", "config-interval=-1",
             "!", "video/x-h264,stream-format=byte-stream,alignment=au",
             "!", "fdsink", "fd=1"]
    return argv


# The stream gst is spawned ONCE per portal session and NEVER killed while the
# session lives. Proven on hardware, in stages:
#   1. TWO concurrent gsts on the session's node -> the second fails ("Buffer
#      allocation failed" / "not-negotiated (-4)", 0 bytes).
#   2. Kill-then-respawn (preempting) LOOKED fixed but was not: the respawned
#      gst receives (almost) no fresh buffers — pipewiresrc's keepalive-time
#      re-encodes the last STALE buffer at full fps, so the stream "flows"
#      while showing seconds-old content (constant-size JPEGs are the tell;
#      a killed consumer's held buffers starve the node's small pool).
# So: one persistent encoder per session, and a reader thread fans its frames
# out to the ONE current subscriber (last-opener wins). Reopen = re-subscribe,
# which is also instant. Idle (no subscriber) keeps encoding + discards — the
# hardware JPEG path makes that ~free, and NOT respawning is the entire point.
_STREAM_LOCK = threading.Lock()
_STREAM = {"proc": None, "profile": None,
           # "mjpeg" or "h264" — the running encoder's codec. MJPEG and H.264 are
           # MUTUALLY EXCLUSIVE (one encoder per session); the reader forwards
           # bytes differently per codec (JPEG framing vs raw Annex-B passthrough).
           "codec": None,
           "sub": None, "done": None,
           # wall-clock when the last subscriber left (None while subscribed);
           # the reader enforces the idle TTL from it.
           "idle_since": None}

# No viewer for this long -> tear down the encoder AND the portal session, so an
# abandoned Control screen stops costing GPU/CPU (and stops holding the KWin
# screencast, which disables direct scanout for fullscreen apps). The next use
# re-ensures the session — on KDE without RemoteDesktop persist that re-pops ONE
# consent; short exit/reopen cycles stay instant (well under the TTL).
_STREAM_IDLE_TTL_S = 900


def _close_session():
    """Tear down the portal session (Session.Close) + cached PipeWire fd. The
    next ensure re-creates from scratch (fresh consent where persist is
    unavailable). Degrade-closed: failures still clear local state."""
    global _SESSION
    with _SLOCK:
        sess, _SESSION = _SESSION, None
    if sess is None:
        return
    pwfd = sess.get("pwfd")
    if pwfd is not None:
        try:
            os.close(pwfd)
        except OSError:
            pass
    try:
        _con.call_sync(_PORTAL, sess["handle"], "org.freedesktop.portal.Session",
                       "Close", None, None, Gio.DBusCallFlags.NONE, -1, None)
    except Exception:
        pass
    print("[portal] idle TTL: session closed (re-consent on next use)", flush=True)


def _drop_subscriber(sub, done):
    """Drop the current subscriber whose socket just errored: clear it (only if
    it is still the current one), close it, and wake its stream() call. Shared by
    both codec paths in the reader."""
    with _STREAM_LOCK:
        if _STREAM["sub"] is sub:
            _STREAM["sub"] = None
            _STREAM["done"] = None
            _STREAM["idle_since"] = time.time()
    try:
        sub.close()
    except OSError:
        pass
    if done is not None:
        done.set()


def _stream_reader(proc, codec):
    """Read the persistent gst's stdout forever and forward to the current
    subscriber (or discard when nobody is watching). MJPEG is split into whole
    JPEGs (FFD8..FFD9). H.264 Annex-B is forwarded RAW, byte-for-byte, in order —
    the app segments access units on the AUD start code, so dropping bytes would
    corrupt the stream (there is no newest-only drop for H.264; latency is bounded
    by the encoder + the app decoder instead). A dead/slow subscriber is dropped
    (its socket has a timeout); the encoder is NEVER stopped here except on the
    idle TTL."""
    buf = bytearray()
    idle_teardown = False

    def _idle_expired():
        # True once the idle TTL has passed with no subscriber — begin teardown.
        nonlocal idle_teardown
        with _STREAM_LOCK:
            idle_since = _STREAM["idle_since"]
        if (idle_since is not None
                and time.time() - idle_since > _STREAM_IDLE_TTL_S):
            idle_teardown = True
            proc.terminate()                         # read() EOFs; cleanup below
            return True
        return False

    while True:
        try:
            chunk = proc.stdout.read(65536)
        except (OSError, ValueError):
            break
        if not chunk:
            break                                    # gst ended

        if codec == "h264":
            # Raw Annex-B passthrough: forward every byte in order.
            with _STREAM_LOCK:
                sub, done = _STREAM["sub"], _STREAM["done"]
            if sub is None:
                _idle_expired()                      # discard; keep node serviced
                continue
            try:
                sub.sendall(chunk)                   # timeout set at subscribe
            except OSError:
                _drop_subscriber(sub, done)
            continue

        # MJPEG: split whole JPEGs (FFD8..FFD9), forward each as one frame.
        buf.extend(chunk)
        while True:
            soi = buf.find(b"\xff\xd8")
            if soi < 0:
                if len(buf) > (8 << 20):             # runaway guard: no SOI in 8MB
                    del buf[:]
                break
            if soi > 0:
                del buf[:soi]                        # drop bytes before a SOI
            eoi = buf.find(b"\xff\xd9", 2)
            if eoi < 0:
                break                                # partial frame; wait for more
            jpg = bytes(buf[:eoi + 2])
            del buf[:eoi + 2]
            with _STREAM_LOCK:
                sub, done = _STREAM["sub"], _STREAM["done"]
            if sub is None:
                # Idle: discard + keep draining (the node must stay serviced) —
                # until the TTL, then tear the whole thing down (gst + session).
                if _idle_expired():
                    break                            # tearing down; stop parsing
                continue
            try:
                sub.sendall(jpg)                     # timeout set at subscribe
            except OSError:
                _drop_subscriber(sub, done)
    # gst ended (idle TTL, helper shutdown, crash, or a codec switch preempted
    # us). Clear state ONLY if we still own the encoder slot — a newer stream()
    # may already have installed a fresh proc; don't clobber it. Wake any
    # subscriber so its stream() returns; finish an idle teardown by closing the
    # session (the next use re-ensures from a FRESH session = a healthy node).
    with _STREAM_LOCK:
        if _STREAM["proc"] is proc:
            done = _STREAM["done"]
            _STREAM.update(proc=None, profile=None, codec=None,
                           sub=None, done=None, idle_since=None)
        else:
            done = None
    if done is not None:
        done.set()
    if idle_teardown:
        _close_session()


def _spawn_encoder(profile, codec):
    """Spawn the persistent gst encoder for `codec` + start its reader thread, and
    register it in _STREAM. CALLER MUST HOLD _STREAM_LOCK. Returns the proc, or
    None on failure. The pwfd is a dup of the session's cached PipeWire remote."""
    with _SLOCK:
        node = _SESSION["node"]
    pwfd = _open_pipewire_fd()
    if pwfd is None:
        return None
    argv = (_stream_h264_argv(profile, pwfd, node) if codec == "h264"
            else _stream_argv(profile, pwfd, node))
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, pass_fds=(pwfd,))
    finally:
        try:
            os.close(pwfd)                           # the child holds it now
        except OSError:
            pass
    _STREAM.update(proc=proc, profile=profile, codec=codec)
    threading.Thread(target=_stream_reader, args=(proc, codec), daemon=True).start()
    return proc


def stream(profile, conn, codec):
    """Subscribe `conn` to the session's persistent encoder for `codec` ("mjpeg"
    or "h264"), spawning it on first use, then block until the subscription ends —
    a newer subscriber kicked us (last-opener wins), the peer vanished, or gst
    ended. The FIRST subscriber's profile wins for the encoder's lifetime.

    MJPEG and H.264 are MUTUALLY EXCLUSIVE — one encoder per session (they can't
    both read the single portal ScreenCast node). If an encoder of the OTHER codec
    is already running we PREEMPT it (last-opener wins across codecs): this happens
    when the app moves MJPEG->H.264 after the box gains a VA encoder, and REFUSING
    left the app wedged on the old codec (the /ws/h264 socket closed and it demoted
    straight back to MJPEG). Preempt safely: detach the old encoder under the lock,
    then terminate it and WAIT for it to fully exit OUTSIDE the lock, so two gsts
    never briefly share the node (the proven 'not-negotiated (-4)' / stale-keepalive
    trap) — a fully-exited gst releases the node's buffer pool before the new one
    opens it."""
    if _ensure_session() is None:
        return
    # 1. Detect a codec switch under the lock + DETACH the old encoder (don't reap
    #    while holding the lock — the wait would block the reader).
    preempt = old_sub2 = old_done2 = None
    with _STREAM_LOCK:
        proc = _STREAM["proc"]
        if proc is not None and proc.poll() is not None:
            proc = None                              # crashed: allow respawn
            _STREAM.update(proc=None, profile=None, codec=None)
        if proc is not None and _STREAM["codec"] != codec:
            preempt = proc
            old_sub2, old_done2 = _STREAM["sub"], _STREAM["done"]
            _STREAM.update(proc=None, profile=None, codec=None,
                           sub=None, done=None, idle_since=None)
    # 2. Reap the preempted encoder OUTSIDE the lock: wake its subscriber, then
    #    terminate + wait for it to fully exit before we spawn the new codec.
    if preempt is not None:
        if old_done2 is not None:
            old_done2.set()
        if old_sub2 is not None:
            try:
                old_sub2.close()
            except OSError:
                pass
        try:
            preempt.terminate()
            preempt.wait(timeout=5)
        except Exception:
            try:
                preempt.kill()
            except Exception:
                pass
    # 3. Spawn the new codec (if needed) + subscribe.
    with _STREAM_LOCK:
        proc = _STREAM["proc"]
        if proc is not None and proc.poll() is not None:
            proc = None
            _STREAM.update(proc=None, profile=None, codec=None)
        if proc is not None and _STREAM["codec"] != codec:
            return                                   # a racing switch won; bail
        if proc is None:
            if _spawn_encoder(profile, codec) is None:
                return
        # Subscribe, last-opener wins: kick + close any current subscriber.
        conn.settimeout(10)                          # a wedged peer can't block the reader
        done = threading.Event()
        old_sub, old_done = _STREAM["sub"], _STREAM["done"]
        _STREAM["sub"], _STREAM["done"] = conn, done
        _STREAM["idle_since"] = None                 # someone is watching again
    if old_done is not None:
        old_done.set()
    if old_sub is not None:
        try:
            old_sub.close()
        except OSError:
            pass
    done.wait()                                      # until kicked / gone / gst end


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
    """True when the box can produce the H.264 Annex-B stream the WebCodecs app
    tier consumes: a VA H.264 encoder plus the pipewiresrc → vapostproc →
    h264parse elements. Drives verb_status's `h264` field -> the agent's
    caps.screenstream_h264 -> the app's /ws/h264 (WebCodecs) tier.

    It deliberately does NOT require the libnice `nice` elements: those are only
    for the PARKED webrtcbin path (the `webrtc` verb), which /ws/h264 does not use
    (WebCodecs decodes an Annex-B elementary stream over a plain WebSocket — no
    SDP/ICE/DTLS). Relaxing this from the old nice-check is what lets a box with a
    VA encoder but no libnice (e.g. Bazzite) advertise the H.264 tier. Degrade
    closed on any failure."""
    try:
        import gi as _gi
        _gi.require_version("Gst", "1.0")
        from gi.repository import Gst as _Gst
        _Gst.init(None)
        need = ("pipewiresrc", "vapostproc", "h264parse", "videorate")
        if any(_Gst.ElementFactory.find(e) is None for e in need):
            return False
        return _va_h264enc() is not None
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
            stream(profile, conn, "mjpeg")
            return
        # The stream_h264 verb switches this connection to a raw H.264 Annex-B
        # byte stream (the P4b WebCodecs tier). Same discipline as `stream`, a
        # different codec + profile set; mutually exclusive with MJPEG.
        if isinstance(req, dict) and req.get("verb") == "stream_h264":
            profile = _h264_profile_arg(req.get("arg"))
            if profile is None:
                conn.sendall(json.dumps(
                    {"ok": False,
                     "error": "invalid argument for stream_h264"}).encode() + b"\n")
                return
            conn.settimeout(None)                    # long-lived stream
            stream(profile, conn, "h264")
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
