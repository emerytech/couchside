# Conventions

Inferred from the code as it stands (agent 2.9.31 / app 2.9.11). These are the conventions this
repo *already follows* — read this before adding code so new work matches, and update it when a
convention genuinely changes rather than letting the doc drift.

---

## 1. Python agent (`agent/couchsided.py`)

### Pure stdlib, single file

The agent is one ~11k-line file with **zero third-party dependencies** — the import block is all
stdlib (`agent/couchsided.py:14-35`). This is load-bearing: the agent is fetched as a raw signed
`.py` onto SteamOS/Bazzite (immutable-ish, no pip) and run by systemd. Do not add a dependency, and
do not split the file without solving the single-file install path first.

Platform-optional imports degrade instead of failing at import time:

```python
try:
    import fcntl  # POSIX only; uinput needs it (Linux), absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None
```
(`agent/couchsided.py:36-39`)

`VERSION` is a module constant bumped per release (`agent/couchsided.py:47`).

### Docstrings explain WHY, and record hardware measurements

Docstrings here are unusually long by design. They do not restate the signature — they record the
trap the code exists to avoid, the alternative that was rejected, and **the measurement taken on
real hardware**. Examples:

- `_stream_data_bound()` (`agent/couchsided.py:8489-8510`) names the wild failure ("a card still
  claiming a live macOS stream 27 minutes after the client disconnected"), states
  *"Measured on hardware in BOTH states, which is the bar this detector failed to clear the first
  time around"*, and records the rejected alternative (log mtime staleness, 41s of silence measured
  *during* a live stream).
- `_gpu_sensors()` (`agent/couchsided.py:8032-8043`) documents the `card*` glob trap — a
  `cardN-DP-1` connector dir also matches and carries a `device` symlink — and names
  `re.fullmatch(r"card\d+")` as the fix.
- Inline measurements are cited with the box they came from:
  `# ... would misdiagnose a stall (measured on the TT-7516UB)` (`:3918`),
  `# measured 508ms first-frame stall -> ~7ms` (`:7074`),
  `# Both measured on a live box, 2026-07-19.` (`:8179`).

If you cannot measure it, say so in the docstring rather than guessing. `:8537` states the standard
outright: *"Hence measured, never guessed."*

### Errors degrade; probes never raise

Read-only probes return an empty value instead of throwing, and say so in the docstring. The phrase
**"Never raises"** appears ~30 times and is a contract, not a comment. The return convention is:

| Shape | Absent/failed value | Example |
|---|---|---|
| dict payload block | `{}` | `_gpu_sensors` (`:8032`) |
| list of things | `[]` | `_proc_net_rows` yields nothing (`:8459`) |
| single value | `None` | `_read_int` (`:8013`), `_steam_root` (`:2598`) |
| boolean capability | `False` | `gaming_available` (`:8023`), `_stream_listening` (`:8481`) |

Catch narrowly where the failure is known (`except (OSError, ValueError)` in `_read_int`,
`:8013-8019`); use bare `except Exception` only at a "this must never take the agent down" boundary
(`gaming_available`, `:8023-8029`).

**Probe-and-appear, per field.** A payload omits a key entirely rather than shipping a blank or a
wrong-but-populated block — `_gaming_payload` (`:8300`) drops `gpu`/`game`/`controllers` when
absent, and the test asserts the omission (`tests/test_gaming_card.py:325-330`). The rule stated at
`:8537`: a dead button costs more trust than a missing one. Never substitute a plausible number for
a real one (an Intel box gets *no* GPU block, never a CPU temp mislabelled as GPU).

### Naming

- `_leading_underscore` for module-private helpers — the vast majority of the file.
- Public (no underscore) only for things the HTTP layer or caps block calls: `gaming_available()`,
  `couch_ceremony_start()`.
- `_UPPER_SNAKE` module constants for tunables, caches, and locks, grouped just above their section:
  `_GAMING_TTL` / `_GAMING_CACHE` / `_GAMING_LOCK` (`:8004-8006`), `_STEAM_LIB_TTL` (`:2666`).
- **Filesystem roots are module constants specifically so tests can repoint them at fixtures**, and
  the comment says so:

```python
# Sysfs roots, as module constants so tests can point them at fixtures (the same
# pattern as _PROC_INPUT_DEVICES for the pad list).
_DRM_DIR = "/sys/class/drm"
_POWER_SUPPLY_DIR = "/sys/class/power_supply"
```
(`agent/couchsided.py:8008-8010`; `_PROC_INPUT_DEVICES` at `:7600`)

New code that reads a path under `/sys`, `/proc`, or a cache dir **must** route through a
module-level constant, or it cannot be tested without root and real hardware.

### Display-manager paths derive from `_DM_CONF_DIRS` — never hardcode SDDM

Since 2.9.66, anything touching the boot-session config or the restart-session rescue
action goes through `detect_display_manager()` (the `display-manager.service` symlink)
and the frozen `_DM_CONF_DIRS` table (`sddm`, `plasmalogin`) — conf dir, drop-in path
(`_dm_dropin`), and restart unit all derive from the DETECTED manager. Hardcoding
`/etc/sddm.conf.d` or `systemctl restart sddm` is the fail-open bug that shipped a dead
"Boots into" card on CachyOS (2026-07-30, real hardware): a sudoers grant that
`install.sh` wrote unconditionally was read as proof SDDM was in charge. The grant proves
only itself; the symlink proves which manager runs. No detected manager (or no grant for
the detected one) = no capability, no action — never a fallback to SDDM.

### Anything written for the NEXT boot is resolved against the NEXT image — or not written

The boot-session drop-in is armed at shutdown from the RUNNING image's session files. On
the reboot that applies a staged ostree update, "the next boot" is a different image:
Bazzite 43 -> 44 (living-room box, 2026-09-26) armed `gamescope-session.desktop`, 44 does
not ship it, SDDM failed autologin and parked the TV at a greeter. Rules since then:

- **A staged OS update (`_OSTREE_STAGED_DEPLOYMENT`, `/run/ostree/staged-deployment`)
  means arm writes nothing** and disarms; the platform's own autologin decides that one
  boot, and the stored preference re-arms from the next shutdown on the new image.
  (`ostree-finalize-staged` runs after our ExecStop, so the marker is still present then.)
- **Cleanup keys on OWNERSHIP, not on the current backend.** consume removes *our* drop-in
  whenever it carries a Session=, even when the backend has since become steamosctl — an
  update can flip the backend and orphan a file we wrote under the old one.
- **A rescue reuses an existing allowlisted action, never a new command.** The stranded-box
  rescue fires the stock `restart-session` argv only when our drop-in named a positively
  missing session, it was verified cleared, the platform's merged config names an installed
  session, and seat0 is greeter-only on two consecutive `loginctl` reads. Unknown at any
  step = do nothing.
- Every session filename in `_GAMESCOPE_SESSION_FILES` is a measured entry, and its ORDER is
  the resolver's policy (the distro's own autologin name must win).

### Don't fight a shared device — stand down on a readback-survival check

When the agent animates a device the platform ALSO writes, cooperate instead of
overwriting. The valve-leds strip is the case: on a Steam Deck/Machine, Steam grabs the
front bar for its own use (download progress — it writes `multi_intensity` in the SAME
`manual` mode we paint in), so the sequence engine's ~30fps repaint fought it and the bar
flickered between our frame and all-black. Fix (`_seq_render`, since agent 2.9.106): read
back a canary node and STAND DOWN — stop writing, let the platform own the device — probing
a single node every `_SEQ_PROBE_INTERVAL` and resuming only once our paint holds again.

Two rules the hardware taught:
- **Measure survival across the inter-frame gap, not right after your own write.** A
  readback in the same frame you wrote always matches — you won that microsecond; the other
  writer clobbers in the ~33ms *between* frames. Check whether LAST frame's canary is still
  there BEFORE repainting. (The first version read back in-frame, passed its unit test, and
  did nothing on the box — the mock modelled "always black" and hid the timing. Test the
  thing: the log line `[led] … standing down` and a rapid sysfs sample were the proof.)
- **Hysteresis both ways + degrade closed.** A few consecutive misses to stand down, a
  streak of clean probes to resume (`_SEQ_STANDDOWN_MISS`/`_HITS`), and an unreadable
  canary (`None`) never trips it. Verified on `steam-machine` 2026-09-08: the state machine
  oscillates with the download (`standing down` ↔ `resuming (strip free again)` in the
  journal), flicker gone (was ~50% black, went 24/24 clean). No new client-reachable
  surface — the readback is a fixed-literal attr on an already-allowlisted node (§3).

---

## 2. Tests (`tests/test_*.py`)

### Pure stdlib, no pytest

Every test file is a standalone script run as `python3 tests/test_x.py`. No pytest, no test runner,
no `conftest.py`. Each loads the agent by path via `importlib.util.spec_from_file_location`
(`tests/test_gaming_card.py:20-24`) — the agent is not an installed module. Files whose subject uses
threads also register it under its name first (`sys.modules["couchsided"] = cs`,
`tests/test_couch_ceremony.py:28`).

Tests **drive the real agent functions** against fixtures via the module-constant roots; they never
reimplement the logic under test (`tests/test_gaming_card.py:5-9`).

### The `check()` / PASS / FAIL harness

Two variants are in use. Both accumulate failures in a module-level list, print a per-function
header, and exit non-zero at the end. Match the file you are editing:

- **`check(cond, label)`** with ANSI `PASS`/`FAIL` constants and a `_fail` list —
  `tests/test_gaming_card.py:26-34`. Used by `test_gaming_card`, `test_steamlink`,
  `test_stream_host`, `test_steam_menus`, `test_actions_inject`.
- **`check(name, got, want)`** printing plain `"  PASS"` / `"  FAIL  (got %r, want %r)"` into a
  `FAILURES` list — `tests/test_couch_ceremony.py:32-39`. Used by `test_couch_ceremony`,
  `test_guide_hold`, `test_gamepad_handoff`.

Labels are sentences describing the *behaviour*, not the assertion:
`"[oom_reaper] rejected"`, `"no gpu key when GPU absent (no blank block)"`. Gates are asserted in
**both directions** — the capability present *and* absent (`.github/workflows/ci.yml:84-86`).

### Fixtures are copied verbatim from real hardware

Fixture blocks are pasted byte-for-byte off a live box, dated, and annotated with what makes them
tricky — never hand-written to be convenient:

- `# Every block below is verbatim off a live Bazzite box (2026-07-19).`
  (`tests/test_gaming_card.py:133`)
- `VERBATIM from a live box, including a genuine macOS Remote Play session it`
  (`tests/test_stream_host.py:7`)
- Where a fixture is synthetic, it says so and justifies it (`_phantom()`,
  `tests/test_gaming_card.py:143-145`: *"real bits, so `_declares_key` does actual work here rather
  than being fixture theatre"*).

If a value was confirmed by screen-capturing a real box, record that in the file
(`tests/test_steam_menus.py:8,40`).

### Every test function is registered in `__main__` by hand

There is **no auto-discovery**. A new `def test_*` that is not added to the runner silently never
runs. Both spellings exist:

```python
if __name__ == "__main__":
    test_appid_from_cmdline()
    test_gpu_sensors()
    ...
```
(`tests/test_gaming_card.py:320-328`)

```python
if __name__ == "__main__":
    for fn in (test_happy, test_no_tv_backend, ...):
        fn()
```
(`tests/test_couch_ceremony.py:161-163`)

### Every test file is its own named CI step, with a WHY comment

`.github/workflows/ci.yml` runs each file as a separate, human-named step preceded by a comment
explaining **what breaks in the real world if this gate is removed** — not what the file tests.
This is the strongest convention in the repo; a new test file without one is incomplete:

```yaml
# The guide-hold trigger fires a SESSION SWITCH, which tears down the
# user's desktop and any unsaved work. Its two dangerous failure modes —
# firing on a tap, and matching the agent's OWN emulated pad ...
- name: Unit tests (guide-hold trigger)
  run: python3 tests/test_guide_hold.py
```
(`.github/workflows/ci.yml:36-43`; see also `:45-50`, `:66-72`, `:74-82`, `:93-101`)

### App-side lifecycle tests (TypeScript, no bundler, no new dependency)

The safety-critical WS input path (`app/lib/gamepad.ts`, CLAUDE.md §4) has real unit
tests despite the app having **no jest/vitest**. The trick: keep the module
**runtime-import-free** (`gamepad.ts` imports only `import type { Settings }` — erased —
and touches only a global `WebSocket` + `Date`/timers), so a test can load it standalone
and run on **Node's built-ins**:

```
node --experimental-strip-types --test app/lib/__tests__/*.test.ts   # Node >= 22.6
```

`app/lib/__tests__/gamepad.lifecycle.test.ts` installs a mock `WebSocket` on `globalThis`
+ a controllable `Date.now`, then drives `GamepadClient` through connect → hello → teardown
→ reconnect / `ensureLive`. It is **control-verified**: the "ZOMBIE FIX" case FAILS if the
`connect()` guard's `wsAlive` requirement is removed (§11 — see it fire AND not fire). CI job
`app-input` runs it with **no `npm install`** (the module needs no node_modules). Adding a
bundler-dependent test would have meant a whole toolchain; this needs none. If you make the
tested module import a real dependency, this standalone path breaks — keep it import-free.

CI is three jobs — `compile` (`py_compile` on all three entrypoints, then every unit suite),
`smoke` (boots the agent `--mock` on a spare port and proves auth: `/api/ping` 200,
`/api/status` 401 without a token, 200 with one), and `app-input` (the standalone module
above). This paragraph said "two jobs" until 2026-08-01 while naming `app-input` four lines
earlier. Jobs begin at `.github/workflows/ci.yml:16`, `:594` and `:686`.

Every suite in `tests/` must have a step, and `tests/test_ci_wiring.py` fails the build if one
does not — eight suites had been committed and never run before that guard existed.

---

## 3. TypeScript app (`app/`)

### Probe-and-appear

The app never shows a control a box cannot back. Optional features resolve `null` and the UI hides,
via the documented house pattern `probeOrNull` — **exactly 404**, so a transient 500 still throws
and a briefly-unhealthy agent does not read as "feature vanished" (`app/lib/api.ts:645-661`).
`probeGated` skips the request entirely when `Status.caps` says the feature is absent, while still
probing against pre-2.8.2 agents that report no caps (`app/lib/api.ts:663-676`). Call sites are
commented as such (`app/app/(tabs)/index.tsx:170,176,241`).

Caps are a **hint, not authority** — a live op still confirms (`app/lib/api.ts:69-76`).

### `request()` stringifies the body — callers pass plain objects

`request()` (`app/lib/api.ts:925`) sets `Content-Type` and calls `JSON.stringify` itself
(`app/lib/api.ts:837, 1019`). Callers pass a plain object: `body: { mac }`, `body: { level, target }`.
Passing `body: JSON.stringify(...)` double-encodes and the agent correctly rejects it with
`HTTP 400: body must be a JSON object` — this shipped once (fixed in #137) and is the single
easiest mistake to make in this file.

`request()` also owns the cached-IP fallback: GETs race host + last-known IP, non-idempotent
POST/DELETE probe first and then send **exactly once, never retried**, because React Native cannot
distinguish "never connected" from "delivered then lost" and a retried POST could reboot the box
twice (`app/lib/api.ts:935-967`).

### Typed payloads

Every agent response has an exported type with per-field doc comments recording the agent version
that introduced it and what `null` means (`Ping`, `NetInfo`, `BoxCaps` — `app/lib/api.ts:17-80`).
Add the type alongside the method; do not return `any` or an inline shape.

### Theming: read colors through the hooks

Components read colors via `useTheme()` (`app/lib/theme.ts:277`) or `useThemedStyles(makeStyles)`
for `StyleSheet` styles (`app/lib/theme.ts:286-299`), so they react to system scheme, the user's
Light/Dark/System override, and the accent. New or touched components must not hardcode palette
colors.

Two honest caveats: `export const theme = dark` is a **deliberate backward-compat bridge** for the
many components not yet converted, so the sweep can proceed incrementally without breaking anything
(`app/lib/theme.ts:11-13, 86`) — it is not license to write new code against it. And a handful of
literal hexes legitimately survive because they are not theme-relative: ink on a bright accent
button (`#0b1220`, `app/components/Paywall.tsx:157`) and the physically black-on-white QR code
(`app/components/QrView.tsx:58,72`).

### Every text style declares a `color`

A `Text` style that omits `color` renders **black** on native — React Native has no CSS
inheritance. On a dark sheet that is invisible, and it is not hypothetical: it shipped in
2.9.17 as "black text even in dark mode", where `bigLabel` in `RemotePowerBar` had no colour
and only the call sites that happened to pass one inline (`t.green`, `t.amber`) were legible.
Screensaver and Sleep timer were not.

Put `color: t.text` in the style itself and let call sites override inline for semantic
colour. "Every current usage passes a colour inline" is not safety — it is one new usage away
from invisible text.

**The web harness cannot be trusted to catch this.** On web, colour resolves through the CSS
cascade; on native it does not. Verify contrast in the harness by measuring
`getComputedStyle().color` against the resolved background, and note that a style with no
colour resolves to `rgb(0, 0, 0)` there too — that is the control.

### Hooks

`usePoll(fn, intervalMs, enabled, resetKey)` (`app/hooks/usePoll.ts`) is the standard data path:
fires immediately, ~2s retry while a box is unreachable, refetch on AppState `active`, paused while
unfocused, never setState after unmount. Pass `hostKey(settings)` as `resetKey` for any per-box poll
so a box switch clears stale data in the same render instead of painting the previous box's data
(`app/lib/api.ts:694-697`). Render-time consumers that mutate refs from `data` must check `dataKey`
first — the reason is documented at `app/hooks/usePoll.ts:15-23`.

### Overlays that watch touches: observe, never steal

`TapCapture` (`app/components/TouchIndicatorLayer.tsx`) is the pattern for any layer that
wants to see touches without consuming them. Three rules, all load-bearing:

1. It is an **ancestor** of what it draws over, not a sibling overlay — it reads the
   responder system in the **capture** phase.
2. Every responder handler **returns `false`**. This app's gesture surfaces (`useTrackpad`,
   the swipe d-pad, the mode-switch bar) all set `onPanResponderTerminationRequest: () =>
   false` and will not yield; a gesture stolen mid-swipe is exactly what leaves the agent's
   LATCHED d-pad axis asserted (`tests/test_dpad_latch.py`).
3. The host `View` renders **unconditionally**, gated internally on its pref. A wrapper that
   appears and disappears with a toggle remounts the whole navigator.

**Responder handlers are not touch handlers, and the difference is a real bug.** Responder
*negotiation* is not re-run for an ancestor once a child owns the gesture and refuses to
give it up, so `onMoveShouldSetResponderCapture` fires far less than a reading of the
renderer source suggests — it produced nothing on device while taps worked. For continuous
tracking during a drag, use the raw bubbling `onTouchMove`, which is dispatched
independently of negotiation. Note the web harness **cannot** tell these apart: RNW emits
mouse events, so `onTouchMove` never fires there at all.

Counter-based instrumentation (`globalThis.__touchTrace`) is kept in the component
deliberately. It is what distinguishes "the handler never fired" from "it fired and rendered
at `NaN`" — two failures that look identical on screen. `add()` also rejects non-finite
coordinates explicitly for the same reason.

### App errors: the local error log, and what it can never see

`lib/crashLog.ts` (wiring) + `lib/crashLogCore.ts` (pure, bare-Node tested) keep the last 20
app errors ON THE PHONE for the user to Copy or Share. Nothing is sent anywhere — no crash
SaaS, ever (no analytics, CLAUDE.md). Rules, each load-bearing:

1. **Chain, never swallow.** `chainGlobalHandler` records FIRST, then calls the previous
   `ErrorUtils` handler with the identical arguments. That handler is what shows the dev red
   box and what turns a release fatal into a process exit. Recording is try/caught so it can
   never change how an error is handled. Control-tested (drop the `prev(...)` call and three
   tests fail).
2. **The fatal path writes SYNCHRONOUSLY** (`SecureStore.setItem`, not `setItemAsync`), then
   chains. A release fatal ends the process moments after the handler returns; an async write
   may never land. Every write of the log is sync (an async write racing a later sync one can
   land last with an older snapshot and erase the fatal); non-fatal bursts are coalesced.
3. **Native crashes run no JS and cannot be logged.** The best the app does is a session
   marker written sync on every active/inactive transition: a marker still reading `fg` at the
   next launch becomes an inferred "closed unexpectedly" entry with no stack, and the banner
   points at `adb logcat -b crash` (help text in the Setup card names the package id).
   Native release builds only — a web or Metro reload also "dies on screen".
4. **Redact before storing.** `token=…`, `"token":"…"` and `Bearer …` are scrubbed from
   messages and stacks; a pasted bug report must never carry a box token.
5. **Degrade closed on bad storage.** `parseLog` never throws (it runs at import, before any
   UI); a corrupt blob reads as an empty log, bad entries are dropped individually.
6. **`ErrorUtils` on web: present here, not guaranteed.** It is RN's error-guard polyfill,
   and this project's Metro config applies RN's polyfills to web too (MEASURED in the harness
   2026-09-26: `ErrorUtils.getGlobalHandler()` is our wrapper; the default beneath it
   re-throws). So the harness drives the REAL path from the console —
   `ErrorUtils.reportFatalError(new Error('x'))` must throw the same object back (not
   swallowed) and leave the fatal in `localStorage['couchside.errorlog.v1']` in the SAME tick
   (sync write), and a reload must show the banner. The code still guards for its absence.
   What web cannot exercise: the session marker (native release builds only) and SecureStore.

---

## 4. Git / PRs

- **`main` is branch-protected** (verified: PR required, force-push disabled). No direct pushes.
- **PR + squash only.** Every commit on `main` carries its PR number (`… (#139)`).
- **Conventional-commit prefixes**, with a scope: `feat(gaming):`, `fix(streamhost):`,
  `chore(app):`, `copy(ios):`, `docs:`. Agent-side changes name the agent version in the subject —
  `feat(steam): expose Steam's settings panels as deep links (agent 2.9.31)`.
- **Trailer on every commit:** `Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Commit bodies and PR bodies state what was and was NOT verified**, and how a bug escaped. See
  #137: *"Rendering a control is not exercising it."* Bodies routinely include a **Verification**
  section separating mock-harness from real-box testing, and a **Release impact** section naming
  which builds are dead. Write the honest negative — an unverified path must be called out as
  unverified, because the next PR's author relies on it.
- **Never delete the base branch of a stacked PR** — it retargets or closes the dependent PR.

---

### A green agent test run on macOS proves nothing about `/proc` parsing

macOS has no `/proc/self/mountinfo`. Any agent code that reads it returns the
"unreadable" branch on this Mac and falls back to the old path, so the new code
is never exercised — the suite goes green while CI goes red.

MEASURED 2026-07-29: keying disk dedupe on mountinfo instead of `st_dev` passed
46/46 locally and failed CI from `4889b305` onward. The release shipped before
anyone looked.

Two rules:

1. **Run `/proc`- or sysfs-parsing tests on a real Linux box**, not here:
   `scp agent/couchsided.py tests/<test>.py` to `/tmp` on bazzite and run them
   there. Behaviour verification on hardware is not the same as running the
   SUITE on hardware — do both.
2. **A fake must own every identity source the code consults.** The disk test
   faked `os.stat` but could not fake `/proc`, so on Linux the real mount table
   decided and the synthetic layout stopped being synthetic. When production
   code gains a new source of truth, the fake gains a stub for it in the same
   commit.

### Check CI before releasing, not after

CI is one `gh run list --branch <branch> --limit 1` away. This release went to
both app stores with the branch red for six commits.

## 5. Releases

- **Explicit version bumps**, never automatic: agent `VERSION` (`agent/couchsided.py:47`) and app
  `version` in `app/app.json:6`. `app/package.json` version is inert (`1.0.0`) — ignore it.
- Build numbers come from EAS autoincrement and are **reconciled back into the repo from the
  artifacts, not the log**, in a `chore(app): reconcile build numbers …` commit (#138, #136, #128).
- **Tag every release** at the shipped commit (`v2.9.11`, `v2.9.10`, …); app-only releases have used
  a `-app` suffix when needed (`v2.9.4-app`).
- **Agent assets are signed.** After tagging, run `scripts/release-agent.sh <tag>` **locally** to
  upload `couchsided.py`, `couchside.service`, `qr.py`, `couchside-screensaver.sh`, `SHA256SUMS`,
  and `SHA256SUMS.sig`, signed with the offline Ed25519 key whose public half is embedded in
  `install.sh`. `scripts/sign-release.sh <tag>` does the same for the Decky plugin repo.
- **The signing key never touches CI** — that is the whole point: a compromised repo, CI, or account
  cannot forge a release (`scripts/release-agent.sh:11-12`, `scripts/sign-release.sh:8-10`).
- `release-agent.sh` clobbers assets on an existing tag, so re-run it after every agent bump that
  ships under the same app-version tag.
- **Helper `VERSION` bumps require `scripts/release-agent.sh <tag>` to publish the new helper
  BEFORE the `install.sh` change that depends on it merges.** `install.sh` fetches helper assets
  `|| true` and drops them when `SHA256SUMS` lacks them, while its heredocs always land — so an
  install.sh that assumes a newer helper, published before that helper, produces boxes with the
  new wrapper and the old helper. The Decky manager (helper 1.1.0) guards this both ways
  (`_decky_helper_verb() == "outdated"` in the agent; install.sh (f1c) refuses to install the
  wrapper when the installed helper is < 1.1.0 and prints "re-run the installer once the release
  assets are published"), but the guard is a safety net, not the process: publish the helper first.

### Cloud builds cost money — use them only where they are required

EAS cloud builds are metered and a session of per-merge builds ran up a **$100 bill**. There is a
free path that costs nothing in correctness, because the constraint that decides it is already
known and measured:

> `eas build --local` on this Mac produces a binary that installs and runs fine on **TestFlight**,
> but is **always rejected `INVALID_BINARY` at App Store review** (the host runs a beta macOS).

So:

| purpose | build where |
|---|---|
| TestFlight, Play internal, any iteration or device check | **local** — `eas build -p ios --local` |
| App Store submission, Play production | **EAS cloud** — required, the local binary is rejected |

Two rules that go with it:

- **Batch.** One build per *release*, not per merge. Seven merged items are one build. If a build
  is already running and more work lands, let it finish and fold the rest into the next one —
  cancelling and re-cutting costs two builds instead of one.
- **Never cut a build to "see if it works".** The web harness, `tsc`, the bare-Node suites and a
  Release **simulator** build (`xcodebuild -sdk iphonesimulator`, free) answer almost every
  question a cloud build would. A cloud build is for shipping, not for checking.

### Keep the EAS archive small — `.easignore` lives at the GIT ROOT

Builds failed outright with *"Project archive is too big. Maximum allowed size is 2.0 GB."* Cause:
`.claude/worktrees/` holds git worktrees used for parallel work — inside the repo, each carrying
its own `node_modules` and native build output, **8.4 GB** in total.

Two traps, both hit for real:

- It is excluded from git via `.git/info/exclude`, which is **local-only and which EAS does not
  honour**. Being invisible to `git status` does not make it invisible to the uploader.
- An `.easignore` inside `app/` **does not work**, even though `eas.json` lives there. EAS roots
  its archive at the **git root**, so the ignore file must be at the git root too.

Worktrees also accumulate: eleven of them reached ~27 GB, of which ~17 GB was regenerable
`node_modules` / `ios` / `android`. Prune them with `git worktree remove` — **removing a worktree
does not delete its branch**, so the work survives in git; commit anything uncommitted first.

### Android builds on the Linux build box archive the Hermes source map

A release stack from the field reads `index.android.bundle:1:<bytecode offset>`; only the
source map from THAT exact build turns it back into file:line. The Linux build box (gandalf —
local Android builds hang on this Mac, see the maintainer notes) re-clones for every release,
so a map not copied out at build time is gone. **Every APK up to vc109 shipped with no map.**

`scripts/android-local-build.sh` is the build recipe, run ON the build box from a fresh
checkout of the release branch (`build/direct-apk` for the direct edition, with `--direct`):

```
JAVA_HOME=<jdk21> ANDROID_HOME=<sdk> scripts/android-local-build.sh [--direct] [--out DIR]
```

It runs `npm ci` → `expo prebuild -p android --clean --no-install` → `gradlew
:app:assembleRelease --no-daemon`, then archives next to each other in `--out` (default: the
directory containing the checkout, never inside it — `app/build` is not ignored by version
control):

| file | what |
|---|---|
| `couchside[-direct]-<ver>-vc<N>.apk` | the APK as built |
| `couchside[-direct]-<ver>-vc<N>.map` | `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map` |
| `couchside[-direct]-<ver>-vc<N>.r8-mapping.txt` | only once R8 minify is on (ROADMAP) |
| `couchside[-direct]-<ver>-vc<N>.sha256` | sums, incl. the Hermes bundle inside the APK |

Identity (version, versionCode, package) is read from the BUILT APK (`aapt2 dump badging`,
falling back to AGP's `output-metadata.json`) — never from app.json. It proves the map
belongs to the APK (the bundle inside the APK is byte-identical to the one the map was
composed from), fails closed and archives nothing when the map is missing, and refuses to
overwrite a different archive at the same name without `--force` (the direct edition's
versionCode is hand-set, so a rebuild at the same vc is possible). `--archive-only` archives
an existing build without rebuilding. Tested by `tests/test_android_build_archive.py`.

Copy the `.map` off the box with the APK (`scp`) and keep it with the release. To read a
crash report from the app's error log (its header names the version + build + package):

```
cd app && npx metro-symbolicate ../<archive>/couchside-2.9.62-vc110.map < stack.txt
```

The iOS equivalent (dSYM + the JS map inside the IPA build) is NOT covered yet.

---

## Verifying app UI (the harness, and how it lies)

`scripts/web-dev.sh` renders the real app in a browser against a `--mock` agent;
`scripts/web-dev-proxy.py <dist> <port> <box-host:port>` points the same bundle at a real
box. Use it instead of a TestFlight cycle for anything presentational.

**Press the control. Do not merely render it.** A Steam chip tap shipped broken to
TestFlight because the harness was used to photograph a screen and never to click
anything — while the PR text itself said the tap was unverified.

Three measured traps, each of which produces confident garbage:

1. **The browser pane is permanently `visibilityState: hidden`.** `requestAnimationFrame`
   runs at **0 fps**, so every rAF-driven animation is frozen — but Reanimated shared
   values still advance when read from JS, so a probe sampling `.value` reports PASS
   against a dead DOM. Measure the painted result (`getComputedStyle`), never the shared
   value. Cards entering from opacity 0 photograph blank.
2. **RN Web maps `AppState` to document visibility**, so anything gated on
   `AppState === 'active'` never runs (the Fleet fan-out polls zero boxes). Fix
   harness-side, no app change:
   `Object.defineProperty(document,'visibilityState',{get:()=>'visible'})` then dispatch
   `visibilitychange`.
3. **`localStorage` is per-origin AND per-browser.** Reseed after changing port; seeding
   from one browser does not seed another.

RN Web `Pressable`s expose no a11y role, so `read_page`/`find` cannot reach them — drive
taps by dispatching pointerdown/mousedown/pointerup/mouseup/click on the Pressable
ancestor.

**What the harness cannot cover — verify on a device:** Pad/trackpad and gamepad (no WS
proxying; mouse != touch), iOS Local Network permission, the no-UDP behaviour, app
backgrounding, safe-area insets, and the purchase flow (`expo-iap` is a no-op on web).

## Capability keys need SIX edit sites, not five

`CLAUDE.md` §4 says five (agent CAPS dict + mock tuple; app BoxCaps + normalizeCaps +
capsEqual). There is a sixth, and it is the one that fails CI: **`protocol/protocol.json`**.

`tests/test_protocol_parity.py` drives both agents' real `set_caps()` and asserts no agent
declares a cap the spec has never heard of. Miss it and you get:

    FAIL  linux: no undeclared caps (extra: ['boxbattery'])

Which group matters. `capabilities` is linux+windows — putting a Linux-only key there makes
the WINDOWS agent fail for a missing key instead. Anything reading sysfs, `/proc`, or a Steam
path that only exists on Linux goes in `linuxOnlyCapabilities`.

Observed adding `boxbattery` (agent 2.9.40): the parity test caught the wiring half-done after
the two agent sites were written and before any app site was.

## App-side direct-device transports (`app/lib/tvdirect/`) — added for remote-only mode

Remote-only mode (the app as a plain TV remote, no box) is the first place the APP opens a
connection to something that is not a Couchside agent. Two rules carry over from the agent
and one is new:

1. **Command ids are LOOKED UP in a frozen table, never interpolated.** `roku.ts` exports
   `rokuKey`/`rokuOp`, which index `ROKU_KEYS` / `ROKU_OP_KEY`; the helper that takes an
   already-resolved ECP key is deliberately NOT exported. Same rule as the agent's
   `/api/tv/key/<k>`, for the same reason.
2. **The destination host goes through `isValidTvHost`** (LAN IP literals only, via the
   KI-033-hardened `lib/lanIp.ts`). Hostnames are refused: what a name resolves to is up
   to whoever answers DNS.
3. **A duplicated table gets a drift guard.** `roku.ts` copies the agent's key tables
   because in this mode there is no agent to ask. `lib/__tests__/tvdirect.test.ts` pins
   both tables verbatim, so "fixing" the Roku pause→Play collision on one side fails CI.

Transport modules stay **import-free** so the bare-Node runner can drive them against a
real stub server (`lib/__tests__/*.test.ts` is already a CI glob — a new file there runs
with no ci.yml edit).

### The harness cannot judge a direct-to-device call

**MEASURED 2026-08-04.** Adding a stub Roku in the web harness reported "No Roku answered"
while the stub's own log showed the request had ARRIVED. Cause: browser CORS. React
Native's `fetch` does not enforce CORS; the harness's browser does. So a direct-device call
failing on web is not evidence of a bug, and the fix is a CORS header on the STUB — never
CORS handling in the app. Everything else about such a call (which path, how many requests,
what encoding) IS observable in the harness by reading the stub's log rather than the screen.

## Shared app state: the external-store shape (do not use a mount effect)

Cross-component state that OUTLIVES one screen lives in a module-level store, never in a hook's
`useState` + `useEffect(..., [])`. The shape, established by `app/lib/prefs.ts` and copied by
`lib/haptics.ts`, `lib/keepAwake.ts`, `lib/theme.ts`, `lib/skin/index.tsx`,
`lib/tvdirect/store.ts` and `hooks/useFeatureTour.ts`:

```ts
let value: T = DEFAULT;
const listeners = new Set<() => void>();
function emitChange() { for (const l of listeners) l(); }
let loadStarted = false;               // one-shot load, kicked off at import
export function useX() { return useSyncExternalStore(subscribe, get, get); }
```

Writers update the module value, `emitChange()` SYNCHRONOUSLY, and persist afterwards — so
subscribers re-render on the same frame rather than waiting on the keychain.

**Why this is a rule and not a preference.** `hooks/useFeatureTour.ts` used a mount effect with
`[]` deps and lived in `app/(tabs)/_layout.tsx`, which never unmounts. A helper that wrote the
same storage key therefore updated something nothing would read again until relaunch, and the
Prefs switch that called it looked broken — while its own copy promised it would work. The bug
is invisible in review because the code reads correctly; it only shows up when a SECOND
component writes the state.

## Feature-tour anchors

A tour step names an element by id (`console.cpu`); the screen registers it with
`<TourAnchor id="...">`. Rules:
- **The anchor is the gate.** A screen registers only what it rendered, so an unregistered
  anchor means the user does not have that control and the step is SKIPPED. Never add a
  separate "should this step show" condition — it would drift from the UI it describes.
- **Anchor ids are written as literals**, never built with a template string: a test in
  `lib/__tests__/tour.test.ts` reads the screen sources to prove every id a step names is
  actually registered, and an interpolated id is invisible to it.
- **Anchor a plain View, not the skin `<Card>`.** Card is a plain function component in both
  skins (a ref is dropped), and its `style` prop lands on a different box per skin, so the same
  anchor would measure two different rectangles. Measuring a plain View also keeps it off
  reactor's `Animated.View`, which moves 8px during its 260ms entrance.
- **Mirror `hitSlop`** when wrapping a small Pressable: a parent clips hit-testing to its own
  bounds, so a bare wrapper shrinks the touch target back to the drawn icon.

## Orientation: exactly one screen rotates

Every screen states a policy with `useLockOrientation`. Only the Pad's **gamepad mode**
allows landscape — and it is conditional on the mode, not on the screen:

```ts
useLockOrientation(mode === 'gamepad' ? 'allow-landscape' : 'portrait');
```

A flat `'allow-landscape'` on the tab wrapper rotated Swipe, Mouse, Remote and the Steam
menus too, none of which have a landscape layout (reported from a device 2026-08-07).

Two traps this has already hit:
- **A route outside `(tabs)` inherits nothing.** `app/onboarding.tsx` rotated freely until
  it was locked, because it is a sibling of the tab group.
- **The failure is silent.** Nothing errors; the screen just rotates. So it is covered by
  a source-reading guard in `lib/__tests__/onboarding.test.ts` that walks every screen
  file, rather than by remembering.

## Source-reading guards, for when "wired to nothing" cannot fail

Some defects cannot fail a normal test because nothing throws — the control is simply
inert. This session shipped that bug twice (a component wired to state and never mounted;
a feature mounted and never invoked) and nearly a third time.

Where the wiring is the thing that can rot, assert it by READING THE SOURCE:
- `lib/__tests__/tour.test.ts` — every anchor a tour step names is registered by some
  screen. Anchor ids must therefore be LITERALS; a template-built id is invisible to it.
- `lib/__tests__/libraryFilter.test.ts` — the filter sheet really calls `savePreset`, the
  game sheet really calls `toggleBookmarked`, the grid really filters by the bookmark set.
- `lib/__tests__/onboarding.test.ts` — every screen states an orientation policy; the
  install copy quotes a banner `install.sh` genuinely prints.
- `lib/__tests__/entitlementDirect.test.ts` — the direct-edition license gate. `entitlement.ts`
  imports `react-native`, so bare Node can't execute it (same reason `restoreSync.ts` exists);
  this reads the source to pin a SECURITY-critical ordering: the direct build returns from
  `revalidateWithStore` BEFORE any store fail-open (else the off-store APK unlocks for anyone),
  the stored key is re-verified every read (not trusted as a flag), and a refused key writes
  nothing. See `docs/DIRECT_EDITION_LICENSING.md`.

**Build-flag editions (`EXPO_PUBLIC_*`).** `IS_BETA_BUILD` and `IS_DIRECT_BUILD` are per-build
constants inlined at export time, not runtime toggles — set on their EAS profile's `env`, unset
elsewhere. When adding one, remember the store fail-open: `revalidateWithStore` treats an
unreachable store as `purchased`, which is correct for a self-compiled build but WRONG for any
build distributed off-store (its store is unreachable by definition). Gate the fail-open on the
edition flag and keep store-only UI (IAP buttons) behind `!IS_DIRECT_BUILD`.

**Always verify a guard in BOTH directions** — break the thing, watch the test fail, put it
back. A guard that cannot fail is the bug it was written to prevent. One of these reported
a FALSE failure on correct code first time (a character class tripping over the `)` inside
`Math.floor(Date.now() / 1000)`), which is the other reason to check.

## "Unknown is included" has exactly one exception, and it is measured

`lib/libraryFilter.ts` never hides a game because a fact about it is missing — that rule
protects against a third party's gap swallowing something the user owns.

The size filter is the exception, and only because a real library proved it: "Over 10 GB"
returned 29 of 33 games when ONE qualified, because non-Steam shortcuts have no install
size by nature. They are not games of unknown size; they are entries the question does not
apply to. Every unit test passed before and after — the fixtures had sizes.

Before adding another exception, get the number off a real box.

## Full-screen (immersive) surfaces: geometry is a pure module, chrome is derived state

Established by the landscape gamepad (2026-08-07, `lib/padLayout.ts` +
`lib/immersive.ts`); follow it for any future full-screen surface (player,
screensaver preview, a second controller layout).

1. **Geometry lives in a pure module, absolute positions from ONE table, sized in
   ONE unit** (a fraction of the relevant axis). No flexbox for control placement
   — flex overflows silently, which is exactly the class of bug it shipped. The
   module reads `useSafeAreaInsets()` output ONCE into a play rect; downstream
   components never see insets, the window, or a percentage string (grep-guard in
   the layout test). A screen too small for the layout returns `{ok:false}` and
   the component renders a refusal card — never a cramped layout.
2. **The layout test asserts properties, not pixels:** everything inside the play
   rect, no two hit rects intersect, every target >= 44dp, dangerous controls keep
   their moat, floors refuse in BOTH directions — each size run twice (notch left/
   notch right, `insets.top` is 0 in landscape). Include a CONTROL proving each
   predicate can fail.
3. **Chrome visibility is a store (`lib/immersive.ts`), never `setOptions`.** The
   tab bar, TabScreen chrome and screen-local chrome all DERIVE from it. An
   imperative hide has to remember to undo itself; a derived value cannot strand
   the app chrome-less.
4. **Harness wire-proof for gamepad surfaces:** the web harness has no WS proxy —
   install an in-page fake WebSocket that ANSWERS EVERY FRAME WITH A PONG and read
   `send()`ed frames instead. A fake that stays silent is torn down by the
   half-dead-socket watchdog every ~12s and clicks in the dead windows mimic
   broken buttons. Known ceiling: onPressIn-only Pressables never fire from mouse
   on react-native-web (portrait pad has the same gap) — those need a device.

### Drag-to-reorder a list (Playlog `UP NEXT`)

Hand-rolled on `PanResponder` (gesture-handler is present transitively but NOT
wired at the root, so it is not an option). The pattern, and the traps a review
caught before it shipped:

1. **A grip owns the responder on `onStartShouldSetPanResponder`, and refuses to
   yield (`onPanResponderTerminationRequest: () => false`).** `onPanResponderMove`
   fires continuously for the *owner* (unlike an ancestor's capture handlers, per
   the note above), so the owner reads `gestureState.dy` directly.
2. **Commit only on release, against a snapshot frozen at grant.** The data never
   mutates mid-drag, so row layout stays valid; the drop slot is a pure function
   (`lib/playlogReorder.ts`, unit-tested both directions + boundaries).
3. **`CellRendererComponent` MUST have a stable identity.** Passing a
   `useCallback(...,[dragKey])` swaps the component *type* the instant the drag
   starts, which remounts every cell and tears down the grip's in-flight
   responder — the drag then never tracks the finger, and a render-only test
   can't see it. Build the cell once (a ref) and let it re-render via a
   `Context` consumer (context updates pierce the list's internal PureComponent).
4. **Centres come from measured HEIGHTS as a running sum, not absolute `y`, with a
   positive default for rows the list hasn't rendered** (`rowCenters`). A missing
   row defaulting to `0` sorts it to the top and teleports the drag — degrade to
   an estimate, never a guess.
5. **A subset reorder must not relocate off-screen items** (`reorderWithinSubset`).
   The queue mixes installed + owned-but-uninstalled games that arrive on
   different polls; permute only the shown slots, leave every unshown bookmark
   where it is. Appending the omitted ones to the tail is silent, persisted
   corruption.
6. **Keep an accessible fallback.** The grip is pointer-only (`accessible={false}`);
   up/down arrow buttons remain for assistive tech and as the guaranteed path.
   The drag gesture itself needs a device to verify (same RNW ceiling as above).

## Addressable LED strips + hardware effects (LED Studio, agent 2.9.85+)

- **Drive the DEVICE's firmware effect, not an agent frame-loop.** A strip whose driver
  publishes an `effect_index` (e.g. `valve-leds`: patrol/breath/rainbow/manual) is animated by
  the box itself. `apply_strip_effect(prefix, ...)` maps our effect id → a firmware name that
  is an EXACT member of that device's `effect_index` (looked up, never trusted) and writes
  `effect` + `delay`. It survives the app closing / reboot. Only strips WITHOUT firmware
  effects fall back to an agent per-LED render loop.
- **Strip allowlist:** the client sends a PREFIX; members are the live `os.listdir` entries
  matching `prefix[<n>]` (never interpolated); the `effect` VALUE must be published by the
  device. `set_led` on a strip node auto-writes `effect=manual` first so a hand-paint sticks.
- **App slider convention: `components/TrackSlider.tsx` on react-native-gesture-handler**, not
  PanResponder — `activeOffsetX([-8,8])` claims the horizontal drag over the iOS nav-swipe,
  `failOffsetY` yields vertical scroll. Needs `GestureHandlerRootView` at the app root.
- **Strip physical order:** `lib/ledStrip.ts` groups `prefix[N]`; `StripLightCard.displayLeds()`
  REVERSES `valve-leds` (its index runs opposite the physical bar). Cells, paints, and saved
  patterns all use physical (display) order.

## Root work from the phone: the Decky-manager patterns (agent 2.9.105 / helper 1.1.0)

Established by `docs/memory/project_decky-manager.md` (adversarially reviewed, 2026-09-06). Any
future feature that needs minutes-long root work on the box triggered from the phone copies
these four shapes exactly; do not invent a fifth.

- **Root wrapper via a pinned oneshot template unit.** The only new root logic is ONE bash
  heredoc in `install.sh` (`/etc/couchside/couchside-decky-loader install|uninstall`, `0755 root`,
  baked with `sed` only after the installer REFUSED a `$HOME`/`$USER` outside
  `^[A-Za-z0-9/._-]+$`). It is reachable only through `couchside-decky-loader@<mode>.service`
  (`Type=oneshot`, `ConditionPathExists=<marker>`, `TimeoutStartSec=900`), started with
  `systemctl start --no-block` — by the helper verb `decky.loader` (validator `_one_of(("install",
  "uninstall"))`, the argv element is the dict VALUE) or by the sudoers grant on that EXACT
  `systemctl` argv. The wrapper itself carries **no** grant, so no path can run it with other
  arguments; it runs under PID 1, never in the agent's or the helper's cgroup (an agent restart
  mid-run cannot kill it; the helper's `ProtectHome=yes`/`Accept=no` sandbox is irrelevant to it).
  Root never follows a path under the user's home: symlinked components abort (exit 6), user-tree
  dirs are created AS THE USER via `runuser`, nothing under `$HOME` is ever `chown`ed to the user.
- **flock running flag + result file + request correlation.** The wrapper takes
  `/run/couchside/decky-loader.lock` (`flock -w 15`), writes the transcript to `.log` and an
  atomic JSON verdict to `.result` (`{mode, ok, tag, at}` + `refused`/`failed`/`done`). The agent
  probes the lock with `LOCK_SH|LOCK_NB` (held = running; absent = idle; released at once), and
  reports `op` ONLY against the request it made: `starting` until a result with
  `at >= floor(requested_at) - 1` exists or the lock appears; after 20 s `systemctl show`'s
  `ConditionResult`/`ExecMainStatus` decide `did_not_start`/`needs_optin`/`busy`; lock-free +
  `running` = `interrupted`; a result older than the request is NEVER shown as its outcome
  (the stale-result control in the tests). `started` is never trusted from `systemctl start`'s
  exit code — `_decky_confirm_started` waits for the lock or `activating`. One `_decky_busy()`
  mutex covers the flock, the plugin-job slot and an in-flight check, in both directions.
- **Marker-file opt-in read by helper, unit AND wrapper.** `couchside allow-decky on|off|status`
  (never reuse `allow-system-updates`, whose README promise is "cannot install new software")
  prints the material fact first, confirms through a stub-able `confirm_tty()` on `/dev/tty`
  (no tty → exit 1, nothing written), then writes `zz-couchside-decky` (0440) + the marker
  `/etc/couchside/allow-decky` (0644). Three independent readers of the same file fail closed
  without it: the helper verb (`ok:false`), the unit (`ConditionPathExists=`), the wrapper (`refused`,
  exit 77). Route gating is stated per route: anything that opens the Decky WebSocket or leaves
  the LAN on demand needs the marker (403 `needs_optin`, no spawn, no socket); filesystem/cache
  reads are token-only. The interactive installer OFFERS the opt-in once (skipped when the marker
  or the declined stamp exists, and when there is no openable tty — a detached app-driven update
  must never "decline" for the owner); no env var or flag enables it non-interactively.
- **`--mock-<feature> <state>` argparse flag + `set_<feature>_mock(state)`.** Env-free mock state:
  `--mock-decky <state>` (`choices=` enforced, default `running`) seeds a wall-clock state machine
  that mock ops mutate, so one harness run walks every state and `--mock` exercises every new
  route off-box. `scripts/web-dev.sh <port> [args…]` now forwards every argument after the port to
  the agent, and `.claude/launch.json` carries one entry per seeded state worth pressing through
  (`couchside-web-harness-decky`, port 8199, `--mock-decky not_installed`). A mock must mirror the
  real precondition chain (403/409/503 shapes) — a mock that is more permissive than the real
  route hides the exact refusal the app has to render.

Two smaller rules the same work established:

- **Box-side fetches whose result the box will TRUST go through a no-redirect opener**
  (`_DeckyNoRedirect`: `redirect_request` returns `None`, any 3xx is a failure) with the
  host+scheme pin checked on the URL actually fetched, a read cap of `cap+1`, in a background
  thread — never inside a GET handler. The catalogue names the hash Decky will trust, so an
  off-host or plaintext body must never become the catalogue. Data is normalised **by rejection**
  (a bad entry is dropped, never repaired); the one field nulled instead of dropped is a
  display-only optional (`image_url`), and its type is sniffed before it is ever advertised.
- **App side:** `ApiError` carries the parsed JSON error `body` (additive) so refusal shapes
  (`409 {busy, what}`, `409 {error:"loader_stopped", restart_action}`, `503 {error:"loader_down"}`)
  are actionable, not just a message; presentation logic lives in an import-free module
  (`app/lib/deckyPlugins.ts`, like `ledStrip.ts`) so `node --test` covers every copy branch;
  a client timeout on a job-shaped POST is NEVER reported as failure — the poll is the truth; and
  a screen's shared confirm helpers are exported from its card component (`DeckyCard.tsx`) rather
  than a fourth file when the three surfaces must show the same Alert word for word.

## Root-owned install files: four edit sites, and SteamOS drops them by default

Added 2026-09-26 (`feat/install-health`). SteamOS throws away every `/etc` change that
is not on its keep-list at each image update. That is how a Deck lost `/etc/couchside`,
the udev rules and modules-load while `couchside.service` (on Valve's list) survived. See
[`steamos-etc-persistence.md`](steamos-etc-persistence.md). So a new root-owned file that
`install.sh` writes under `/etc` needs ALL of:

1. **The write itself, UNCONDITIONAL on a full run.** Never guard it with "already
   installed?". Re-running the installer is the documented repair, and a guard keyed on
   anything SteamOS keeps (the unit, say) would never restore the rest.
   `tests/test_installer_restore.sh` catches exactly that mutation.
2. **The (f4) keep-list drop-in** (`/etc/atomic-update.conf.d/couchside.conf`). Use the
   exact path, or `/etc/couchside/**` for our own directory. Never a path the OS or
   pacman owns (a kept copy shadows upstream edits forever). Never `/etc/**`.
   `tests/test_installer_steamos_keep.sh` pins it.
3. **If losing it breaks a feature: a frozen id** in the agent's `_INSTALL_PIECE_IDS` +
   `_INSTALL_PIECE_PATHS`, the (g1) manifest `echo` in `install.sh`, and a label in
   `app/lib/installHealth.ts` `PIECE_LABELS`. The app test reads the agent's table and
   fails on an id without a label. A file that only some boxes get (the WoL `.link`,
   opt-in wrappers) stays out of the table: the agent cannot tell "not applicable" from
   "lost".
4. **`--uninstall`** removes it (and README's manual-uninstall block names it).

The Decky plugin writes a subset of the same files and does NOT yet write the drop-in
or the manifest (follow-up). A plugin-only box has no manifest, so the agent checks
only the default set.

## Installer: an owner's choice outlives the run that made it (install.sh, 2026-09-26)

Most installer runs are UNATTENDED and pass NO flags: `couchside update` and the app's update
button (`update_apply`) both pipe couchside.tv/install.sh into `bash`. So a flag that expresses
an owner's preference is only half a feature until the choice is persisted — `--no-decky` existed
for months and the next update undid it. Established by the Decky-panel opt-out
(`DECKY_PANEL_OFF`, `decky_panel_resolve` in `install.sh`):

- **Where it lives decides whether it survives.** An owner preference that only the installer
  reads is a presence-only marker in the user-owned `STATE_DIR` (`/var/lib/couchside/…`), NOT
  `/etc/couchside`: a SteamOS update dropped `/etc/couchside` wholesale while `/var/lib/couchside`
  survived (KI-088). Contrast `/etc/couchside/allow-decky`, which is a ROOT consent read by the
  helper, a unit and a root wrapper — that one belongs in root-owned `/etc`. Presence is the gate;
  the file's text is for a human and is never parsed.
- **Every persisted "off" has an explicit "on"** (`--no-decky` / `--decky`), contradictory flags
  exit 2 (reject, don't guess), and every run that honours the marker PRINTS the way back.
- **Infer a choice only from an unambiguous signal.** "Stamp says we installed the panel, Decky
  Loader is still there, the panel dir is gone" = the owner removed it. "Stamp AND panel both
  gone" is also what a lost `/etc` looks like, so it keeps the old default. When the opt-in
  flag runs, drop any state that would re-trigger the inference if its own work fails (the stale
  stamp), or an offline `--decky` silently flips back to "off" next run.
- **Test the shipped regions, not copies.** `tests/test_installer_decky_panel.sh` lifts the flag
  loop, the `# Decky co-existence:` block and `# (h2)`…`# (i) Migration` out of `install.sh` by
  those heading comments — keep them stable — and runs them under `set -euo pipefail` with a
  sandbox-enforcing `sudo` shim and state-modelling `systemctl`/`curl` stubs. Pass the pre-fix
  installer as argv[2] to replay every "unchanged" scenario against it byte-for-byte.

## Per-build features are DECLARED in `expo.extra`, never detected (2026-09-26)

Established by the user-selectable app icon (`lib/appIcon.ts`). A feature that only some builds ship — the
direct edition's icon choices, anything keyed to a bundle id or a build-only branch — is declared as data in
`expo.extra.<feature>` by that build's `app.config.js` (which lives on the build-only branch; `main`'s
`app.json` declares nothing). The app reads it through `expo-constants`, parses it DEFENSIVELY (malformed →
"feature absent", never a crash), and the UI renders on "≥ N valid choices", not on `IS_DIRECT_BUILD`. Keep
the parser import-free so the bare-Node test glob covers it, and test the ABSENT case as the control: the store
build must render nothing. Anything a native module is asked to act on must first be validated against the
declared list (`aliasFromValue`), so a stale or foreign value never reaches PackageManager.
