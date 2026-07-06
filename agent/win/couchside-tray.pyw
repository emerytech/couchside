#!/usr/bin/env pythonw
"""couchside-tray.pyw: Windows taskbar tray widget for the Couchside agent.

A small always-there tray icon (green = agent running, gray = stopped). Click it
for a dark Decky-style flyout panel that can start/stop/restart the agent, shows
the pairing QR + connection details, and toggles start-at-logon — the quick
console you'd otherwise open a browser or Task Scheduler for.

Pure python3 stdlib: ctypes drives the Win32 tray icon (Shell_NotifyIcon) and a
runtime-drawn GDI icon; tkinter (bundled with the python.org install the agent
already needs) draws the panel; qr.py (shipped alongside the agent) renders the
pairing matrix. No pip dependencies, no elevation — it controls the current
user's own "Couchside Agent" scheduled task, exactly like the agent's own
least-privilege model.

Runs windowless under pythonw.exe; the installer drops a Startup-folder shortcut
so it is in the tray at logon.
"""

import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from ctypes import wintypes

import tkinter as tk
from urllib.request import urlopen
from urllib.parse import quote

# qr.py sits next to this file once installed (the installer copies it into the
# agent dir); in a repo checkout it is one level up under agent/.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
try:
    import qr as _qr
except Exception:
    _qr = None

TASK_NAME = "Couchside Agent"
_PROGRAMDATA = os.environ.get("ProgramData", r"C:\ProgramData")
CONFIG_PATH = os.path.join(_PROGRAMDATA, "Couchside", "config.json")
TOKEN_PATH = os.path.join(_PROGRAMDATA, "Couchside", "token")
DEFAULT_PORT = 8787
POLL_MS = 3000

# App palette (matches the phone app's ops-console theme).
BG = "#0b1220"
CARD = "#141c2e"
BORDER = "#1e2942"
INSET = "#0e1526"
TEXT = "#e5ecf8"
DIM = "#8b97ad"
FAINT = "#5b6780"
GREEN = "#34d399"
AMBER = "#fbbf24"
RED = "#f87171"
BLUE = "#60a5fa"
SLATE = "#64748b"

# Don't flash a console for the child processes we spawn (schtasks etc).
_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


# ---------------------------------------------------------------------------
# Config / token / pairing (mirrors the agent's own helpers)
# ---------------------------------------------------------------------------

def read_port():
    try:
        with open(CONFIG_PATH, encoding="utf-8-sig") as f:
            p = json.load(f).get("port")
        if isinstance(p, int) and 1 <= p <= 65535:
            return p
    except Exception:
        pass
    return DEFAULT_PORT


def read_token():
    try:
        with open(TOKEN_PATH, encoding="utf-8-sig") as f:
            return f.read().strip()
    except Exception:
        return None


def _pair_hostname():
    host = socket.gethostname().split(".")[0] or "localhost"
    return host + ".local"


def _pair_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1: no packet is sent
            ip = s.getsockname()[0]
        finally:
            s.close()
        return None if ip.startswith("127.") else ip
    except OSError:
        return None


def build_pair_url(token, port):
    url = "https://couchside.tv/pair#host=%s&port=%d&token=%s" % (
        quote(_pair_hostname(), safe=""), port, quote(token, safe=""))
    ip = _pair_lan_ip()
    if ip:
        url += "&ip=" + quote(ip, safe="")
    return url


# ---------------------------------------------------------------------------
# Agent control + status
# ---------------------------------------------------------------------------

def _schtasks(*args):
    try:
        r = subprocess.run(["schtasks"] + list(args), capture_output=True,
                           text=True, creationflags=_NO_WINDOW, timeout=10)
        return r.returncode == 0, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return False, str(e)


def agent_start():
    return _schtasks("/Run", "/TN", TASK_NAME)[0]


def agent_stop():
    return _schtasks("/End", "/TN", TASK_NAME)[0]


def logon_enabled():
    """True if the task's logon trigger is enabled (start-at-logon on)."""
    ok, out = _schtasks("/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V")
    if not ok:
        return None
    for line in out.splitlines():
        low = line.lower()
        if "scheduled task state" in low or low.strip().startswith("status:"):
            if "disabled" in low:
                return False
    return "disabled" not in out.lower()


def set_logon(enabled):
    return _schtasks("/Change", "/TN", TASK_NAME,
                     "/ENABLE" if enabled else "/DISABLE")[0]


def ping_running(port, timeout=1.5):
    """True if the agent answers /api/ping on loopback (proves it is actually
    serving, not merely that the task exists)."""
    try:
        with urlopen("http://127.0.0.1:%d/api/ping" % port, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Win32 tray icon (Shell_NotifyIcon) + runtime GDI icon
# ---------------------------------------------------------------------------

user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
gdi32 = ctypes.windll.gdi32

NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP = 0x01, 0x02, 0x04
WM_APP = 0x8000
TRAY_CALLBACK = WM_APP + 1
WM_LBUTTONUP, WM_RBUTTONUP = 0x0202, 0x0205
GWLP_WNDPROC = -4
GA_ROOT = 2

ULONG_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_uint32
LRESULT = ctypes.c_int64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_long
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                             wintypes.WPARAM, wintypes.LPARAM)


class NOTIFYICONDATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
    ]


class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", wintypes.BOOL),
        ("xHotspot", wintypes.DWORD),
        ("yHotspot", wintypes.DWORD),
        ("hbmMask", wintypes.HBITMAP),
        ("hbmColor", wintypes.HBITMAP),
    ]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


# Pin prototypes: on 64-bit Python the default c_int restype/argtype truncates
# returned HANDLE/HWND/HICON pointers to 32 bits, producing invalid handles and
# crashes. Every call that traffics in a pointer-sized value must be declared.
_SetLongPtr = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
_SetLongPtr.restype = ctypes.c_void_p
_SetLongPtr.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
user32.CallWindowProcW.restype = LRESULT
user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT,
                                   wintypes.WPARAM, wintypes.LPARAM]
user32.GetAncestor.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.CreateIconIndirect.restype = wintypes.HICON
user32.CreateIconIndirect.argtypes = [ctypes.POINTER(ICONINFO)]
user32.FillRect.argtypes = [wintypes.HDC, ctypes.POINTER(RECT), wintypes.HBRUSH]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateBitmap.restype = wintypes.HBITMAP
gdi32.CreateBitmap.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.UINT,
                               wintypes.UINT, ctypes.c_void_p]
gdi32.CreateSolidBrush.restype = wintypes.HBRUSH
gdi32.CreateSolidBrush.argtypes = [wintypes.COLORREF]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.GetStockObject.restype = wintypes.HGDIOBJ
gdi32.GetStockObject.argtypes = [ctypes.c_int]
gdi32.RoundRect.argtypes = [wintypes.HDC] + [ctypes.c_int] * 6
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
shell32.Shell_NotifyIconW.restype = wintypes.BOOL
shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.c_void_p]


def _rgb(hexcolor):
    h = hexcolor.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r | (g << 8) | (b << 16)  # Win32 COLORREF is 0x00BBGGRR


def make_icon(accent):
    """Build a 32x32 HICON: a rounded badge in <accent> with a white couch, on a
    transparent background. Returns the HICON (caller owns it)."""
    sz = 32
    screen = user32.GetDC(0)
    dc = gdi32.CreateCompatibleDC(screen)
    color_bmp = gdi32.CreateCompatibleBitmap(screen, sz, sz)
    mask_bmp = gdi32.CreateBitmap(sz, sz, 1, 1, None)  # 1bpp AND mask
    user32.ReleaseDC(0, screen)

    def fill(hdc, colorref):
        br = gdi32.CreateSolidBrush(colorref)
        rc = RECT(0, 0, sz, sz)
        user32.FillRect(hdc, ctypes.byref(rc), br)
        gdi32.DeleteObject(br)

    def rrect(hdc, l, t, r, b, rad, colorref):
        br = gdi32.CreateSolidBrush(colorref)
        old_br = gdi32.SelectObject(hdc, br)
        pen = gdi32.GetStockObject(8)  # NULL_PEN
        old_pen = gdi32.SelectObject(hdc, pen)
        gdi32.RoundRect(hdc, l, t, r, b, rad, rad)
        gdi32.SelectObject(hdc, old_br)
        gdi32.SelectObject(hdc, old_pen)
        gdi32.DeleteObject(br)

    # Mask: white = transparent, black = opaque. Badge area opaque.
    old = gdi32.SelectObject(dc, mask_bmp)
    fill(dc, 0x00FFFFFF)
    rrect(dc, 1, 1, sz - 1, sz - 1, 12, 0x00000000)
    gdi32.SelectObject(dc, old)

    # Color: badge in accent, white couch (backrest + seat + two arms).
    old = gdi32.SelectObject(dc, color_bmp)
    fill(dc, 0x00000000)
    rrect(dc, 1, 1, sz - 1, sz - 1, 12, _rgb(accent))
    white = 0x00FFFFFF
    rrect(dc, 7, 11, 25, 18, 4, white)    # backrest
    rrect(dc, 6, 16, 26, 22, 3, white)    # seat
    rrect(dc, 5, 15, 9, 24, 2, white)     # left arm
    rrect(dc, 23, 15, 27, 24, 2, white)   # right arm
    gdi32.SelectObject(dc, old)
    gdi32.DeleteDC(dc)

    info = ICONINFO(True, 0, 0, mask_bmp, color_bmp)
    hicon = user32.CreateIconIndirect(ctypes.byref(info))
    gdi32.DeleteObject(color_bmp)
    gdi32.DeleteObject(mask_bmp)
    return hicon


# ---------------------------------------------------------------------------
# The flyout panel
# ---------------------------------------------------------------------------

class Panel:
    def __init__(self, app):
        self.app = app
        self.win = None
        self.show_token = False

    def _btn(self, parent, text, cmd, fg=TEXT, bg=INSET, width=None):
        b = tk.Button(parent, text=text, command=cmd, fg=fg, bg=bg,
                      activebackground=CARD, activeforeground=fg, bd=0,
                      relief="flat", font=("Consolas", 10, "bold"),
                      cursor="hand2", padx=10, pady=8, highlightthickness=0)
        if width:
            b.configure(width=width)
        return b

    def toggle(self):
        if self.win and self.win.winfo_exists():
            self.hide()
        else:
            self.show()

    def hide(self, *_):
        if self.win and self.win.winfo_exists():
            self.win.destroy()
        self.win = None

    def show(self):
        self.hide()
        w = tk.Toplevel(self.app.root)
        self.win = w
        w.overrideredirect(True)
        w.configure(bg=BORDER)  # 1px border via padded inner frame
        w.attributes("-topmost", True)
        try:
            w.attributes("-alpha", 0.98)
        except tk.TclError:
            pass
        outer = tk.Frame(w, bg=BG, padx=14, pady=12)
        outer.pack(padx=1, pady=1)

        # Header
        head = tk.Frame(outer, bg=BG)
        head.pack(fill="x")
        tk.Label(head, text="Couchside", fg=TEXT, bg=BG,
                 font=("Consolas", 13, "bold")).pack(side="left")
        self.status_dot = tk.Label(head, text="●", fg=FAINT, bg=BG,
                                   font=("Consolas", 12))
        self.status_dot.pack(side="right")
        self.status_lbl = tk.Label(head, text="", fg=DIM, bg=BG,
                                   font=("Consolas", 9))
        self.status_lbl.pack(side="right", padx=(0, 6))

        # Start / Stop / Restart
        row = tk.Frame(outer, bg=BG)
        row.pack(fill="x", pady=(12, 4))
        self._btn(row, "▶  Start", self.on_start, fg=GREEN).pack(
            side="left", expand=True, fill="x", padx=(0, 4))
        self._btn(row, "■  Stop", self.on_stop, fg=RED).pack(
            side="left", expand=True, fill="x", padx=4)
        self._btn(row, "↻  Restart", self.on_restart, fg=AMBER).pack(
            side="left", expand=True, fill="x", padx=(4, 0))

        # QR card
        qrcard = tk.Frame(outer, bg="#ffffff")
        qrcard.pack(pady=(12, 6))
        self.qr_canvas = tk.Canvas(qrcard, width=190, height=190, bg="#ffffff",
                                   highlightthickness=0)
        self.qr_canvas.pack(padx=10, pady=10)

        self.pair_lbl = tk.Label(outer, text="", fg=DIM, bg=BG,
                                 font=("Consolas", 9))
        self.pair_lbl.pack()
        self.token_lbl = tk.Label(outer, text="", fg=FAINT, bg=BG,
                                  font=("Consolas", 8), wraplength=300,
                                  cursor="hand2")
        self.token_lbl.pack(pady=(2, 0))
        self.token_lbl.bind("<Button-1>", self._toggle_token)

        self._btn(outer, "Open pairing page", self.on_pair_page,
                  fg=BLUE).pack(fill="x", pady=(8, 0))

        # Start-at-logon toggle
        self.logon_var = tk.BooleanVar(value=bool(logon_enabled()))
        chk = tk.Checkbutton(
            outer, text="  Start at logon", variable=self.logon_var,
            command=self.on_logon, fg=TEXT, bg=BG, selectcolor=INSET,
            activebackground=BG, activeforeground=TEXT, bd=0,
            highlightthickness=0, font=("Consolas", 10))
        chk.pack(anchor="w", pady=(10, 0))

        # Footer
        foot = tk.Frame(outer, bg=BG)
        foot.pack(fill="x", pady=(10, 0))
        tk.Label(foot, text="agent :%d" % self.app.port, fg=FAINT, bg=BG,
                 font=("Consolas", 8)).pack(side="left")
        tk.Label(foot, text="Quit tray", fg=FAINT, bg=BG,
                 font=("Consolas", 8, "underline"), cursor="hand2").pack(
                     side="right")
        foot.winfo_children()[-1].bind("<Button-1>", lambda e: self.app.quit())

        self._render_qr()
        self._sync(self.app.running)

        # Position as a flyout above the tray (bottom-right), then focus so a
        # click elsewhere dismisses it like a real menu.
        w.update_idletasks()
        pw, ph = w.winfo_width(), w.winfo_height()
        sw, sh = w.winfo_screenwidth(), w.winfo_screenheight()
        x = sw - pw - 12
        y = sh - ph - 56  # clear the taskbar
        w.geometry("+%d+%d" % (max(0, x), max(0, y)))
        w.bind("<FocusOut>", self._maybe_hide)
        w.bind("<Escape>", self.hide)
        w.focus_force()

    def _maybe_hide(self, _):
        # Hide only when focus left the panel entirely (not to a child widget).
        try:
            if not str(self.win.focus_get()).startswith(str(self.win)):
                self.hide()
        except Exception:
            self.hide()

    def _toggle_token(self, _):
        self.show_token = not self.show_token
        self._render_pairinfo()

    def _render_pairinfo(self):
        tok = self.app.token
        self.pair_lbl.configure(text="%s : %d" % (_pair_hostname(), self.app.port))
        if not tok:
            self.token_lbl.configure(text="(token unreadable — run installer)")
        elif self.show_token:
            self.token_lbl.configure(text=tok)
        else:
            self.token_lbl.configure(text="token ••••  (tap to reveal)")

    def _render_qr(self):
        self._render_pairinfo()
        c = self.qr_canvas
        c.delete("all")
        tok = self.app.token
        if not tok or _qr is None:
            c.create_text(95, 95, text="QR unavailable", fill="#888",
                          font=("Consolas", 10))
            return
        try:
            model = _qr.build_qr(build_pair_url(tok, self.app.port))
            n = model.get_module_count()
        except Exception:
            c.create_text(95, 95, text="QR encode failed", fill="#888",
                          font=("Consolas", 10))
            return
        quiet = 2
        scale = int(190 / (n + quiet * 2)) or 1
        off = (190 - (n + quiet * 2) * scale) // 2 + quiet * scale
        for r in range(n):
            for col in range(n):
                if model.is_dark(r, col):
                    x0 = off + col * scale
                    y0 = off + r * scale
                    c.create_rectangle(x0, y0, x0 + scale, y0 + scale,
                                       fill="#000000", outline="")

    def _sync(self, running):
        if not (self.win and self.win.winfo_exists()):
            return
        if running:
            self.status_dot.configure(fg=GREEN)
            self.status_lbl.configure(text="running", fg=GREEN)
        else:
            self.status_dot.configure(fg=SLATE)
            self.status_lbl.configure(text="stopped", fg=SLATE)

    # --- actions ---
    def on_start(self):
        threading.Thread(target=self._act, args=(agent_start,), daemon=True).start()

    def on_stop(self):
        threading.Thread(target=self._act, args=(agent_stop,), daemon=True).start()

    def on_restart(self):
        def seq():
            agent_stop()
            import time
            time.sleep(0.8)
            agent_start()
        threading.Thread(target=self._after_act(seq), daemon=True).start()

    def _act(self, fn):
        fn()
        self.app.root.after(600, self.app.poll_now)

    def _after_act(self, fn):
        def run():
            fn()
            self.app.root.after(600, self.app.poll_now)
        return run

    def on_logon(self):
        want = self.logon_var.get()
        threading.Thread(target=lambda: set_logon(want), daemon=True).start()

    def on_pair_page(self):
        webbrowser.open("http://127.0.0.1:%d/pair" % self.app.port)


# ---------------------------------------------------------------------------
# Tray app: Tk main loop + Shell_NotifyIcon on the root's HWND
# ---------------------------------------------------------------------------

class TrayApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.port = read_port()
        self.token = read_token()
        self.running = False
        self.panel = Panel(self)

        self.icon_running = make_icon(GREEN)
        self.icon_stopped = make_icon(SLATE)

        # The HWND Windows delivers messages to (the toplevel frame of the Tk
        # root). Subclass its WNDPROC so the tray callback shares Tk's loop.
        self.hwnd = user32.GetAncestor(self.root.winfo_id(), GA_ROOT)
        self._wndproc = WNDPROC(self._on_message)
        self._oldproc = _SetLongPtr(
            self.hwnd, GWLP_WNDPROC,
            ctypes.cast(self._wndproc, ctypes.c_void_p))

        self._add_icon()
        self.poll_now()
        self.root.after(POLL_MS, self._tick)

    def _nid(self, flags):
        nid = NOTIFYICONDATA()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATA)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = flags
        nid.uCallbackMessage = TRAY_CALLBACK
        nid.hIcon = self.icon_running if self.running else self.icon_stopped
        nid.szTip = self._tip()
        return nid

    def _tip(self):
        return ("Couchside — running on :%d" % self.port if self.running
                else "Couchside — stopped")

    def _add_icon(self):
        shell32.Shell_NotifyIconW(
            NIM_ADD, ctypes.byref(self._nid(NIF_MESSAGE | NIF_ICON | NIF_TIP)))

    def _update_icon(self):
        shell32.Shell_NotifyIconW(
            NIM_MODIFY, ctypes.byref(self._nid(NIF_ICON | NIF_TIP)))

    def _remove_icon(self):
        shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self._nid(0)))

    def _on_message(self, hwnd, msg, wparam, lparam):
        if msg == TRAY_CALLBACK:
            evt = lparam & 0xFFFF
            if evt in (WM_LBUTTONUP, WM_RBUTTONUP):
                # Re-read port/token in case the config changed, then flyout.
                self.port = read_port()
                self.token = read_token()
                self.panel.toggle()
            return 0
        return user32.CallWindowProcW(self._oldproc, hwnd, msg, wparam, lparam)

    # --- status polling ---
    def _tick(self):
        self.poll_now()
        self.root.after(POLL_MS, self._tick)

    def poll_now(self):
        port = self.port
        def worker():
            running = ping_running(port)
            self.root.after(0, lambda: self._apply(running))
        threading.Thread(target=worker, daemon=True).start()

    def _apply(self, running):
        if running != self.running:
            self.running = running
            self._update_icon()
        self.panel._sync(running)

    def quit(self):
        self._remove_icon()
        try:
            self.root.destroy()
        except Exception:
            pass
        os._exit(0)

    def run(self):
        try:
            self.root.mainloop()
        finally:
            self._remove_icon()


def _single_instance():
    """A named mutex so a second Startup launch is a no-op (avoids two icons)."""
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW(None, False, "Local\\CouchsideTraySingleton")
    return kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def main():
    if not _single_instance():
        return
    TrayApp().run()


if __name__ == "__main__":
    main()
