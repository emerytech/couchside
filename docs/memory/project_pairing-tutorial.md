# Project — On-box pairing tutorial (auto-plays after install)

Status: **SPEC / not built.** Written 2026-07-21.
Scope decided with the owner: **box TV only**, **inline CSS/SVG animation (no GIF)**,
**PIN flow only** (no full onboarding wall of text).

Sibling spec: `project_interactive-setup-card.md` is the *phone-side* half of the same
funnel problem. This one needs no app release and no store review; that one does. They are
independent and can ship in either order.

---

## 1. What it is

The installer finishes and the box's own screen lights up with a short animated tutorial:
*open Couchside on your phone → Setup → Scan → tap this box*. The page waits. The moment the
phone starts a pairing, the same page becomes the big 6-digit PIN it was teaching about.

Motivation is the measured funnel — ~9–15 strangers downloaded the app in the first six days
after the 2026-07-15 store launch, ~0 got an agent paired. The last mile is a user standing at
a finished terminal with no idea what to do next. The terminal already prints a QR; the closing
text never says "open the Couchside app."

---

## 2. Why this is nearly free (all read from source 2026-07-21)

| Fact | Where | Consequence |
|---|---|---|
| `/pair` already renders **two** states — big PIN if a session is live, else the token QR | `agent/couchsided.py:10628-10643` | A third (idle-tutorial) state is a change to one existing branch, not a new route. |
| `/pair` is gated by **both** `_is_loopback()` and `_host_header_is_local()` | `agent/couchsided.py:10632-10635` | Anything rendered there is unreachable from the LAN. No new network surface. |
| `render_pin_page` already polls `/api/pair/status` every 3000 ms, latches `done`, and **leaves the page untouched on any fetch error** | `agent/couchsided.py:10324-10360` | The poll+swap idiom to copy already exists and already survives an agent restart. |
| `/api/pair/status` is loopback-only and returns only `{"active": bool}` | `agent/couchsided.py:10645-10653` | The idle page can detect "a pairing just started" without learning the PIN. |
| `render_pair_page` (QR) is self-contained inline HTML/CSS/JS + `PAIR_QR_JS` canvas | `agent/couchsided.py:10396`, `PAIR_QR_JS` at `:10019` | House style for these pages is already inline-everything, no external resources. |
| `couchside-pair` launcher already opens `/pair` full-screen | written by `install.sh:916-957`, path const at `:152` | gamescope → `steam -ifrunning steam://openurl/`; else flatpak Chrome/Chromium `--app --start-fullscreen`; else `xdg-open`; else print URL. Nothing new to write. |
| `install.sh` runs **as the normal desktop user**, escalating per-command with `sudo` | header `:1-15`, first sudo at `:581` | A browser launched from the installer lands in the user's own session. |
| The agent binds at the **midpoint** of `install.sh` (`:880-889`), ~850 lines before the QR prints | | The box is already answering by the time the closing banner runs. |
| Fresh-install signal already exists: the `else` branch that prints "generating new pairing token" | `install.sh:602-609` | Gate the auto-open on it — re-runs and updates keep their token and stay quiet. |
| `PAIR_PIN_TTL = 120`, `MAX_ATTEMPTS = 5`, `START_DEBOUNCE = 3` | `agent/couchsided.py:10248-10250` | The PIN page can keep showing a real countdown; unchanged by this work. |

**Why not a real GIF:** the repo's existing GIFs (`docs/media/*.gif`) are 3.9–5.9 MB each; the
entire agent is 539,416 bytes of pure-stdlib single-file Python. Embedding one is a non-starter,
and shipping it as a separate signed release asset would add a static-file route, a signing
entry, and a missing-asset fallback path. Inline CSS keyframes + inline SVG is a few KB, stays
crisp at any TV resolution, and is editable in the same file as the page it lives on.

---

## 3. Required changes

### 3a. `agent/couchsided.py` — idle `/pair` gains the tutorial

Today the no-PIN branch is `render_pair_page(self._current_token(), self.port)` (`:10640-10641`).
It stays — **do not replace the QR.** The Steam tile's documented job (installer closing text,
`install.sh:1731-1734`) is re-showing the QR, and the `.desktop` is literally titled "Pair Phone".

Instead `render_pair_page` grows a step strip **beside** the QR card:

- Three steps, one line each: `Open Couchside on your phone` / `Setup tab → Scan` /
  `Tap this box — a PIN appears here`.
- An inline `<svg>` phone mock with CSS `@keyframes` cycling the three states (app icon → scan
  list → PIN entry). No JS drives the animation; keyframes only.
- Layout: flex row on wide viewports (steps left, QR right), column fallback. Must fit **one
  screen with no scrolling** — a TV read from a couch cannot scroll.
- Reuse the existing `vmin`-based type scale in `render_pair_page` (`min(6vmin,42px)` etc.) so
  it matches the page it is joining.

### 3b. `agent/couchsided.py` — the handoff

The idle page polls `/api/pair/status` on the same 3000 ms cadence as `render_pin_page`, and on
`active === true` calls `location.reload()`. The existing route then serves the PIN page. Copy
`render_pin_page`'s error discipline verbatim: **swallow fetch errors and leave the page alone**,
so an agent restart never paints a browser error on the TV.

No new endpoint. No new field. `/api/pair/status` keeps returning one boolean.

### 3c. `install.sh` — auto-open on a fresh install only

1. Set `FRESH_TOKEN=1` inside the existing `else` branch at `:602-609` (the one that prints
   `generating new pairing token`). The two branches above it — token already present, token
   migrated from a prior install — leave it `0`, so **update runs and re-installs stay silent**.
2. At the closing banner (after the QR block, before `:1736`), when `FRESH_TOKEN=1` and
   `--no-open` was not passed: launch `$PAIR_SCRIPT` detached, best-effort, never blocking and
   never failing the install.
3. Add `--no-open` to the flag parser (`:192` area) and to the `--help` text (`:9-14`).
4. Update the closing text at `:1731-1734` — it currently ends on the Steam tile and never says
   "open the Couchside app on your phone."

---

## 4. Allowlist / security review (CLAUDE.md §3)

- **No new route, no new client-supplied identifier, no `subprocess` with client input.** The
  only new execution is the installer launching a script whose path is a constant (`:152`).
- `/pair` keeps both gates unchanged; `/api/pair/status` keeps its loopback gate and its
  one-boolean response.
- The tutorial text is a static literal. Nothing from a client reaches the page.
- **KI-019 is not made worse but is made more visible** — any LAN peer can already pop the PIN
  page full-screen because `pair_show_on_box` fires unconditionally at `:10999`. Worth fixing in
  the same pass or explicitly deferring, not silently ignoring.

---

## 5. Tests

New `tests/test_pair_page.py`, `check(cond, label)` style (canonical per DECISIONS 2026-07-19),
pure stdlib, its own CI step:

- `/pair` from a non-loopback peer → 403.
- `/pair` from loopback with a foreign `Host` header → 403 (anti-DNS-rebinding).
- Idle page: contains the three step labels **and** the `/api/pair/status` poll.
- Live-PIN state: `render_pin_page` output unchanged — the PIN, not the tutorial.
- Bonus, closes part of **KI-020**: exercise `pair_pin_start` / `pair_pin_check` (wrong PIN
  counts an attempt, cap burns the session, expiry clears it).

---

## 6. Verification — the honest version

**The web harness cannot prove this.** It renders the app, not the agent's own HTML, and the
target browser is Steam's CEF, not Chrome.

1. **Unproven and load-bearing: whether Steam's built-in browser renders CSS `@keyframes` and
   inline `<svg>` at all.** Test it before writing the finished page — throw a minimal animated
   page at a box and look. If CEF disappoints, fall back to a JS `setInterval` class swap.
2. Prove on the real box (`10.1.1.60`, was running agent 2.9.37 on 2026-07-21) with
   `/api/screen/frame` capture — the only way to see the TV. **Both sessions: Game Mode and
   desktop.** They take different launcher branches.
3. **Observe both states** (CLAUDE.md §11.2): the idle tutorial AND the reload-into-PIN handoff.
   A tutorial that never hands off is exactly the bug this design can ship.
4. SSH-run install has no `DISPLAY`. The launcher's gamescope branch may still work via steam
   IPC — **test it**, and make sure a failure is silent (the terminal QR still prints).
5. Re-run the installer on an already-paired box and confirm **nothing pops**.

---

## 7. Ship cost

Agent + installer only — **no app release, no store review**. But `install.sh` is a signed
release asset mirrored to couchside.tv, so shipping means: `scripts/release-agent.sh`,
`scripts/sign-release.sh`, then the ets3d `sync-installer.mjs` pass (its `--check` drift gate
fails the website deploy otherwise).

---

## 8. Explicitly out of scope

- The phone-side card — separate spec, `project_interactive-setup-card.md`.
- A recorded GIF asset — see §2.
- Full onboarding (what Couchside is, troubleshooting, Wi-Fi/VPN/iOS-permission help). A wall of
  text on a TV is where onboarding dies.
- Windows agent: it has **no PIN pairing at all**. Untouched here.
