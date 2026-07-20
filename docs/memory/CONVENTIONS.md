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

CI is two jobs: `compile` (`py_compile` on all three entrypoints, then the unit tests) and `smoke`
(boots the agent `--mock` on a spare port and proves auth: `/api/ping` 200, `/api/status` 401
without a token, 200 with one) — `.github/workflows/ci.yml:103-186`.

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

### Hooks

`usePoll(fn, intervalMs, enabled, resetKey)` (`app/hooks/usePoll.ts`) is the standard data path:
fires immediately, ~2s retry while a box is unreachable, refetch on AppState `active`, paused while
unfocused, never setState after unmount. Pass `hostKey(settings)` as `resetKey` for any per-box poll
so a box switch clears stale data in the same render instead of painting the previous box's data
(`app/lib/api.ts:694-697`). Render-time consumers that mutate refs from `data` must check `dataKey`
first — the reason is documented at `app/hooks/usePoll.ts:15-23`.

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
