# Repo-wide audit — 2026-08-16

Full read of ~110k lines: `agent/couchsided.py` (22.4k, single file), the Windows
agent (6.4k), the Expo/RN app (58k), `tests/` (18.7k), `install.sh` (~2.7k),
`scripts/`, CI. Goal was simplification/optimization; it also turned up four
correctness bugs.

**Status:** bugs + free wins EXECUTED (PRs #474–#478). Everything under
"Deferred" is analysed but NOT done — this file is the resume point.

---

## 0. The two methodology lessons (read these first)

**A grep over one directory is not a reference check.** The exploration pass
measured "dead code" over agent source alone and reported five confidently-dead
symbols. Three were live **test entrypoints**:

| Claimed dead | Reality |
|---|---|
| `_gpu_sensors` | 17 refs in `tests/`+`docs/`; `CONVENTIONS.md` cites it twice as the canonical docstring example |
| `_seq_frame_circle` | 3 refs; the line above it reads *"circle keeps its old name for callers/tests"* |
| `_steam_cover_path` | 2 refs; `test_steam_cover_art.py` pins it as "the NARROW lookup" |
| `lgcom_input` | genuinely orphaned ✔ deleted |
| `DL_ACTIVE_OP` | dead in `couchsided.py`, **LIVE in the Windows agent** — kept |

Yield went from ~950 claimed lines to 750 real. **Rule: re-verify every deletion
across `agent/ app/ tests/ scripts/ install.sh .github/ docs/` before removing it.**

**Reproduce the bug, don't just assert the fix.** Every fix below ships with a
control that shows the *old* code failing to notice. Two of the four bugs were
found only because the first control was built and came back green.

---

## 1. Correctness bugs — FIXED

### 1.1 `couchside allow-launchers` was a dead switch — PR #476
`install.sh` wrote `/etc/couchside/config.json`; the unit runs the agent with
`--config /var/lib/couchside/config.json` and `load_config()` opens only that.
Write and status grep agreed with each other and nothing else: turning it **on
did nothing, and status then said "on"**. Gates `POST /api/launchers`, which runs
a client-supplied argv.

Fix needed **two** changes: the path, *and* dropping the `sudo` — a sudo write
`os.replace()`s the file into root ownership, after which the agent (running as
the user) can no longer rewrite it and every TV pairing / launcher edit 500s.
Path-only would have traded a dead switch for a worse bug.

One hoisted `$CFG` now serves all three verbs; `status` prints the file it read.
New `tests/test_allow_launchers_switch.py` drives the real CLI against a live
Handler and carries the §6 coverage `ALLOW_APP_LAUNCHERS` never had.

**Open question, filed not solved:** `couchside-decky/main.py:47` pins `/etc` and
its unit has no `--config`, so a Decky agent may genuinely read `/etc`. That
checkout is stale (agent 2.8.3). The change makes the verb *consistently* wrong
there rather than accidentally right — same state as `allow-updates` and `tls`.

### 1.2 Pre-auth `/api/pair/finish` 500 — PR #475 (agent 2.9.92)
`req.get("pin")` sat inside a `try` catching only parse errors, so `[]`, `"x"`,
`5`, `null`, `true` raised `AttributeError` into the `do_POST` catch-all → **500**
on one of three unauthenticated routes. `{"pin": 5}` / `{"pin": 3.4}` escaped one
frame deeper at `pair_pin_check`'s `(pin or "").strip()` — so an
`isinstance(req, dict)` guard **alone would not have fixed it**. Two edit sites.

Falsy non-strings (`None`, `[]`, `0`) survived via the `or`, which is why it was
never noticed. Windows agent carried both sites verbatim; fixed in lockstep.
**Closes KI-020.**

### 1.3 `test_steam_menus.py` asserted nothing — PR #474
`check("steammenus" in cs.CAPS or True, ...)` — unconditionally true. Measured:
with `set_caps()` stubbed to return before building `CAPS` (the exact condition
the label claims), the old suite **exited 0 with zero failures**.

The other two checks in that function grepped source text (§11.1 violation).
They *do* catch a source-level removal — a control confirmed that — but are blind
to behavioural breaks leaving the strings intact. All three now runtime
assertions, both directions.

Class fix in `test_ci_wiring.py`: reject `check(<expr> or True, …)` repo-wide,
via **AST, not regex** — the regex version flagged its own comment, its own
`check()` call, and a docstring quoting the old line. Prose ≠ code.

### 1.4 Release self-verification was tautological — PR #477
`release-agent.sh` and `sign-release.sh` derived a pubkey from **the key they had
just signed with** and verified against that — true by construction for any key.
It could never catch the one failure it claimed ("never publish a signature
install.sh would reject"): a wrong or rotated key passed, uploaded, and was
refused on **every box** after the release went public.

New `scripts/release-keys.sh` verifies against `install.sh`'s embedded
`RELEASE_PUBKEY_PEM`/`_BACKUP`, reproducing install.sh's own accept rule (either
key; verdict from openssl's *output string*, not exit code). "Cannot verify" and
"zero keys found" both **abort** — a box degrading to checksums is right, a
release doing so is the bug.

`|| _rc=$?` is load-bearing: under `set -e` the bare call aborted **silently**
before the case could print why.

**Not verified:** the ACCEPT path needs the offline maintainer key. First
observation is the next real release; expect
`signature verifies against the key embedded in install.sh (key #1)`.

---

## 2. Deletions — DONE (PR #478, −750)

`scripts/cdp-probe.py` (388), `gamescope-tile-probe.py` (220),
`web-dev-skins.html` (135, route table checked by hand — the proxy serves `DIST`,
not `scripts/`), `app/lib/settings.ts` `activeSettings`+`loadSettings` (~35, a
duplicate `Box→Settings` projection that had already drifted and silently
disabled the pinned TLS transport), agent `lgcom_input` (~6, protocol knowledge
preserved on the ops table).

---

## 3. Deferred — analysed, NOT executed

Ordered by value. Line deltas measured, not estimated.

### 3.1 Test harness (~−970) — the highest-value remaining item
`check()` has **four mutually incompatible signatures** across 77 files:
`(name, got, want)` ×43, `(cond, label, detail)` ×29, `(name, cond, detail)` ×3,
plus one other. AST-verified: no live misuse *today*, but a copy-paste between
families **silently always passes**. Fix is a `tests/_harness.py` exporting
differently-*named* `eq()` / `ok()` so a mis-paste is a `TypeError`.

Also collapses ~1,175 lines of boilerplate (agent-loader shims in 4 spellings,
ANSI constants, failure epilogues in 3 variants) and the live-server harness 8
suites hand-roll. Standalone execution still works (`tests/` is `sys.path[0]`);
`_harness.py` doesn't match `test_ci_wiring.py`'s globs.

*Do this before any large mechanical refactor* — those lean on "77 suites still
pass" as their only proof.

### 3.2 CI restructure (~−450)
`ci.yml` is 916 lines / 90 steps, 77 of which are one `python3 tests/test_x.py`.
Shard into a 4-way matrix with filenames still literal in the YAML (so the
substring guard survives). Split `npm ci` + `tsc` off the tail of the 85-step
serial job; drop `smoke: needs: compile`; add the existing npm cache block to
`app-input`, which installs `node-forge` over the network every run.

**Prerequisite:** `test_ci_wiring.py` builds its blob from whole workflow files
*including comments*, so a suite named only in a comment reads as wired. Latent
today; becomes live under a matrix. Strip `^\s*#` lines first.

**Don't** purge the comments — that's the institutional memory.

### 3.3 App mechanical dedupe (~−490)
- **caps (−90):** `normalizeCaps` (108 lines) + `capsEqual` hand-list 27 keys
  each; comments show the same "forgot to add it here" bug shipped 12+ times.
  `REQUIRED_CAPS`/`OPTIONAL_CAPS` arrays drop the six-edit-site rule to four.
  **Must** update `test_protocol_parity.py:264-269` in the same PR — it scrapes
  the source text and would silently match zero.
- **api.ts (−120):** 16 probe methods take a `caps` param **no caller passes**
  (verified 0 call sites) → one `capProbe` factory. And the fail-closed TLS guard
  `secure && pinModulus && tlsPort` is written 5× while a proper type guard
  `canPin` already exists at `lib/ticket.ts:25`.
- **storage (−280):** 17 byte-identical `storageGet`/`storageSet` pairs, **none**
  with try/catch on the native path — and three sites do
  `void storageSet(KEY, JSON.stringify(bigMap))` on unbounded library-sized
  objects, so a SecureStore rejection is an unhandled rejection *and* the cache
  silently never persists, re-triggering a full re-index against a rate limit.
  Fix the three call sites even if the dedupe waits.

### 3.4 Agent mechanical dedupe (~−350)
- **appinfo double-parser (~−150, correctness):** `_APPINFO_CACHE` is defined at
  `:8790` **and redefined at `:8955`**, with incompatible cache-key shapes, so
  `/api/steamlink` and `/api/steam/installable` evict each other and every miss
  re-parses a multi-MB file (~80ms, per the code's own comment). Parser A is a
  strict superset. **Behaviour delta:** installable would start resolving names
  it previously returned blank for — additive, but a measured 1101/1101 baseline
  could move, so diff against a **real** `appinfo.vdf`, not the synthetic fixture.
- **JSON-body idiom ×27 in `do_POST` (−135).** Helper must stay *after* the auth
  gate. ~11 variants are non-canonical — enumerate before writing it.
- **WS handshake preamble ×4 verbatim (−85).** One is `_handle_gamepad_ws`; land
  the three non-gamepad handlers first.
- Smaller: `_webos_save` inlines `_config_set_field`'s body; `_webos_result` is
  the universal TV result builder used by 29 mostly-not-webOS sites (rename
  `_tv_result`); 8 `mock_*` TV ops with hand-synced `sleep`/`duration_ms`.

### 3.5 `/api/status` hot path (+60 lines, real CPU win)
Polled 1–2 Hz. Forks `pgrep` **per poll** via `_couchmode_session()`; re-parses
`/proc/self/mountinfo` **once per mount** inside `read_disks`'s loop; re-globs and
re-selects the hwmon sensor every poll. TTL precedent exists in-file
(`_DISPLAY_TTL`) — including its degrade-closed invariant: never paper over a
failed probe with the previous answer. Keep the session TTL at 1–2s.

**Do 3.6 first** — it cuts the poll rate 5× with zero staleness.

### 3.6 Five concurrent `/api/status` pollers
`RemotePowerBar` (5s), `index.tsx`, `pad.tsx` (8s), `RemoteView` (8s),
`useCapsSync` (30s) — ~5 requests/10s to a single-threaded stdlib agent, and the
first two both read `statusIntervalMs`, so the user's chosen cadence is doubled
on the home tab. `RemotePowerBar.tsx:229-260` is a 30-line post-mortem
(KI-053/054) about two components holding different snapshots of *this exact
resource* causing an 8-minute JS-thread hang on hardware.

Ref-counted shared source **wrapping** `usePoll` (not a rewrite) — must preserve
focus-pause, AppState refetch, `ERROR_RETRY_MS`, and per-consumer `resetKey`/
`dataKey`. Touches the CI-protected reachability path: do it alone, late, needs
hardware.

### 3.7 Structure (mostly moves, ~−80 net)
- Circular import `setup.tsx` ⇄ `GuideHoldSetup.tsx` — works today only because
  the shared helpers are hoisted `function` declarations; `PrefFilterCtx` is a
  module-scope `const` that lands in TDZ if evaluation order flips.
- `DesktopKeyboard.tsx` imports `textDelta` from the 2,976-line pad route. It's
  pure, its docblock claims it's "exported so the risky half is testable", and
  **no test exists**. Move to `lib/`, write the test.
- Clean extractions: `KeyboardBar` (446, zero coupling), the prefs tab
  (~630, shares nothing with the boxes tab), the handoff prompt duplicated
  **verbatim** at `pad.tsx:1905-1932` and `:2011-2038` — a control-handoff path.
- `install.sh` embeds the same 35-line binary-VDF parser **three times**
  (byte-identical). It mutates the user's `shortcuts.vdf`, so a fix landing in
  one copy corrupts config. All three are *quoted* heredocs — concatenate, don't
  unquote.

---

## 4. Explicitly NOT worth doing

- **`do_GET`/`do_POST` handler extraction.** 92 routes, net-zero lines, touches
  the ordering CLAUDE.md calls load-bearing: pre-auth zones, `/api/upload`
  appearing **twice** (pre-auth via ticket, post-auth), and the cover route's
  *different* authorizer `_authorized_image`. A dict dispatch flattens all three.
  The file extracted 4 of 92 over its lifetime — evidence it was never needed.
  Opportunistic only.
- **Blanket `React.memo`.** Zero usage is a fact, not a defect; blanket
  memoization buys a stale-closure bug class and the harness can't measure native
  render cost. Two targeted exceptions are real: `installable.tsx`'s
  one-setState-per-game indexing (1,101 renders, each re-running an unmemoized
  sort/filter over 1,101 items) and `launch.tsx`'s per-tile `coverSource`/closure
  churn.
- **`useTheme` identity fix.** High blast radius, only observable on a device.
- **Splitting `PadScreen`** (1,501 lines). `web-dev.sh` structurally cannot drive
  pad/trackpad/gamepad — no WS proxying, mouse ≠ touch. A split you cannot press
  is a change with no available proof.
- **Purging `ci.yml` comments.** See 3.2.

---

## 5. Loose ends

Three findings from this audit are **not written here**: they describe latent
soft spots in shipped, LAN-exposed code rather than fixed bugs, and this file is
tracked in a public repo. They are in the gitignored `docs/memory/KNOWN_ISSUES.md`
under the 2026-08-16 audit entries — a cross-agent logging guard, a caps-vocabulary
divergence between the Linux and Windows agents, and the Decky config-path
question from §1.1. Read them there before touching the mac agent or the
Windows caps table.
