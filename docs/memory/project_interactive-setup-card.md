# Project — Interactive setup card

Status: **SPEC / not built.** Written 2026-07-21.
Motivation: measured funnel — ~9-15 distinct strangers downloaded the phone app in the first
six days, and ~0 of them got an agent running on a box. Everything upstream of the install
works; the drop-off is at "now go install a daemon on your gaming PC."
See the maintainer-side metrics note for the baseline this is measured against.

---

## 1. What it is

The no-box empty state stops being a paragraph of instructions and becomes a **live card that
advances itself**. The user reads four short steps, walks to their PC, runs the installer —
and the card on their phone changes on its own the moment the agent starts answering on the
LAN, before they have typed anything. It ends by putting a PIN on the box's own TV, so the
last mile needs no terminal, no token, and no typing on the box.

The point is not decoration. It is **proof of progress**: the single hardest moment in the
funnel is the user standing at their PC with no idea whether anything worked.

---

## 2. Why this is possible (mechanisms, all read from source)

| Fact | Where | Consequence |
|---|---|---|
| `GET /api/ping` is pre-auth, returns `{ok, app, version, ip, host}` | `agent/couchsided.py:10375-10393` (gate at `:10399`) | The app can see a box and read its **hostname + version** with no token. |
| `POST /api/pair/start` and `/api/pair/finish` are the only unauthenticated POSTs, **not** loopback-gated | `agent/couchsided.py:10686-10714` | Any phone on the LAN can start a pairing. This is the zero-terminal path. |
| `/api/pair/start` pops the PIN **full-screen on the box's own TV** and returns only `{ok, ttl}` — never the PIN | `agent/couchsided.py:10022-10041`, `:10691-10700` | Physical-presence proof, Android-TV style. The secret never crosses the network. |
| `GET /pair` and `/api/pair/status` are **loopback-only** (`/pair` also Host-header checked) | `agent/couchsided.py:10348-10373` | The phone can never read these. The asymmetry is the design — do not "fix" it. |
| `PAIR_PIN_TTL = 120`, `MAX_ATTEMPTS = 5`, `START_DEBOUNCE = 3` | `agent/couchsided.py:9968-9973` | The card can and should show a real countdown. |
| The agent **binds at the midpoint of `install.sh`** — ~850 more lines run afterwards | `install.sh:880-889`, QR at `:1708-1728` | **The box answers `/api/ping` well before the terminal finishes.** The card can say "found it" while the installer is still scrolling. |
| The agent has **no** first-run / unpaired / paired flag anywhere | verified live vs 10.1.1.60 | Cannot ask the box "are you new?" — but see §3. |

**The one that matters most:** the agent binds long before the installer prints its QR, so the
card reaches "found your box" *while the user is still watching the terminal*. That is the
moment worth engineering for.

### The "is it new?" problem, solved phone-side

The agent cannot say "I was just installed." It does not need to. **The card only ever runs
when the local fleet is empty**, so any agent discovered in that state is new *to this phone* —
which is the only sense that matters. No agent change, no new `/api/ping` field, no protocol
bump. (Adding a field would be additive-only per CLAUDE.md §4 anyway, but it is not needed.)

---

## 3. Required code changes

### 3a. `app/lib/boxDiscovery.ts` — incremental results (the only non-trivial change)

Today `scanForBoxes()` awaits `Promise.all` over 64 workers and returns **only when the entire
sweep drains** (`:227-235`). A box at `.5` is not reported until the last worker finishes —
up to ~6 s of dead air with the answer already in hand. For a card whose whole value is
immediacy, that is the bug.

Add an **optional** callback, fired from the worker the instant `pingHost` returns non-null:

```ts
export type ScanOpts = {
  timeoutMs?: number;
  onFound?: (box: FoundBox) => void;   // NEW — called per hit, mid-sweep
};
```

Additive. The existing return contract is unchanged, so `BoxScanPair.tsx:36` keeps working
untouched. Constants that stay as they are: range `.1`-`.254`, `CONC = 64`, per-host timeout
1500 ms (note: currently hardcoded at the call site and **not** reachable from `opts.timeoutMs`
— leave that alone, it is out of scope).

### 3b. `app/components/SetupProgress.tsx` — new component

Follows the **discriminated-union phase machine** already used by `BoxScanPair.tsx:21-26` —
that is the house pattern for a wizard, and the new card should be indistinguishable in style:

```ts
type Phase =
  | { k: 'idle' }                                         // never scanned yet
  | { k: 'looking'; since: number }                       // sweep in flight
  | { k: 'found'; box: FoundBox }                         // /api/ping answered, fleet empty
  | { k: 'pin'; box: FoundBox; ttl: number; expiresAt: number }
  | { k: 'pairing'; box: FoundBox }
  | { k: 'failed'; box: FoundBox; msg: string }           // agent's own error string
  | { k: 'unsupported'; box: FoundBox }                   // Windows agent, no PIN flow
  | { k: 'blocked' };                                     // iOS Local Network denied
```

Rules carried over from `BoxScanPair`: every async handler sets a terminal phase in **both**
the ok and catch branches (never leave a spinner stuck), and there is always an explicit path
back to `idle`.

Styling: `useTheme()` + `useThemedStyles(makeStyles)` with a module-scope
`const makeStyles = (t: Palette) => StyleSheet.create({...})` factory — the current pattern per
CONVENTIONS.md:215-227. **Do not** write against the legacy static `theme` export. Reuse
`setup.tsx`'s existing `card` / `emptyText` / `emptyLink` / `sectionLabel` styles
(`:1539-1545`, `:1616-1631`, `:1802`) so the card sits in the screen rather than on it.

Step rendering: reuse the existing `StepState` / `StepRow` idiom already in `setup.tsx` (the
`· … ✓ ✗` mark + label + colored detail line used by the CONNECTION TEST card). It already
exists, it already matches, and it needs no new dependency.

**No Reanimated.** It is a dependency (`app/package.json:30`) but is imported in exactly three
files, none of them under `app/components/`. Introducing it here buys a pulse animation and
costs the entire animation-verification trap surface (§5). **State changes are the feedback.**

### 3c. `app/app/(tabs)/setup.tsx` — swap the empty state

Replace the `boxes.length === 0` branch at `:882-902` with `<SetupProgress />`. Keep the
"Haven't installed the Couchside service? Setup guide" link **inside** the new card — it is the
escape hatch for anyone who wants the full page, and its deep link is verified working.

### 3d. Polling policy

Poll only when **all** of: `boxes.length === 0`, the Setup tab is focused, and
`AppState === 'active'`. Sweep, wait ~6 s, sweep again. Stop after 5 minutes of nothing and
show a "Keep looking" button rather than burning battery forever. Cancel in flight on unmount.

---

## 4. The states, and what each one says

1. **`idle` / `looking`** — the four steps, with step 1 marked running:
   *1. On your PC, switch to Desktop Mode and open a terminal. 2. Open couchside.tv and run
   the install command. 3. Watch this screen — it updates by itself. 4. A PIN appears on your
   TV; type it here.* Plus a live "Looking for your box on the network…" line.
2. **`found`** — *"Found **bazzite** at 10.1.1.60 · service v2.9.36"* and a single **Pair now**
   button. This is the payoff moment and it can fire while the installer is still running.
3. **`pin`** — fires `POST /api/pair/start`, which pops the PIN on the TV. Shows the 6-digit
   input **and a countdown from the returned `ttl`**. Today the app requests `ttl` and throws
   it away (`BoxScanPair.tsx:66-73` only checks `r.ok`), so an expired PIN is discovered only
   on submit. The card should fix that: show the countdown, and offer "Show a new PIN" at zero.
4. **`failed`** — surface the **agent's own** error string verbatim (`wrong PIN`,
   `no active pairing — start it again from the app`, `too many wrong PINs — start again`),
   exactly as `BoxScanPair.tsx:84-110` already does. Return to `pin` so retry needs no re-scan.
5. **`unsupported`** — the Windows agent has **no PIN pairing at all** (Linux-only; grep of
   `agent/win/couchsided-win.py` finds no `pair_pin`). Discriminate on the `version` string
   from `/api/ping` (Windows builds carry a `-win` suffix) and route those users to the QR /
   token path instead of a PIN input that would 404.
6. **`blocked`** — **iOS Local Network permission denied.** The sweep then finds nothing,
   forever, silently, and a card that says "still looking…" is actively lying. Needs its own
   state with a "Open Settings" affordance. This is the highest-risk state to omit.

---

## 5. Verification plan (and the three ways the harness will lie)

From CONVENTIONS.md §"Verifying app UI" — all three apply directly here:

1. **`AppState` is mapped to document visibility in RN Web**, and the browser pane is
   permanently `visibilityState: hidden`. A card gated on `AppState === 'active'` **will never
   poll in the harness.** Required shim, harness-side only:
   `Object.defineProperty(document,'visibilityState',{get:()=>'visible'})` then dispatch
   `visibilitychange`. Without this the card looks dead and the bug is in the test rig.
2. **`requestAnimationFrame` runs at 0 fps** there. Irrelevant if §3b's no-animation rule
   holds — which is a second reason to hold it.
3. **`localStorage` is per-origin AND per-browser.** Reseed after any port change.

Also: RN Web `Pressable`s expose no a11y role, so `read_page`/`find` cannot reach them — drive
taps by coordinate or by dispatching pointer events on the ancestor.

**Observe both states.** A detector is unverified until it has been seen to fire *and* not
fire. Concretely: the card must be watched finding a box **and** correctly staying in `looking`
when none exists. One half is how a card shipped advertising a dead session for 27 minutes.

**Harness gap, stated plainly:** the web harness's own IP is loopback, so an HTTP `/24` sweep
has nothing real to find. Discovery timing and the `found` transition **cannot be proven in the
harness** and must be exercised on a device against a real box (10.1.1.60 answers pre-auth
today). Do not mark this feature complete on harness evidence alone.

---

## 6. What must not change

- `/pair` and `/api/pair/status` stay **loopback-only**. The LAN-reachable route never reveals
  a secret; the secret-revealing route is loopback-only. That asymmetry is the security model.
- No new agent endpoint is required. No `/api/ping` field is required.
- No client-supplied string may reach `subprocess`. `pair_show_on_box` builds its URL from
  `self.port`, a server-side attribute — it must stay that way.
- Response shapes are additive-only (CLAUDE.md §4).

---

## 7. Open questions

- **Sweep cost.** 254 connection attempts every ~6 s, repeatedly. Battery impact unmeasured;
  may also look like port-scanning to a router/IDS. Consider backing off after the first
  minute, or sweeping a narrower range first (`.1-.60` covers most DHCP pools).
- **Time-to-listening is inferred, not measured** — ~10-25 s from pressing enter, dominated by
  human prompts (sudo password, plus an interactive screensaver y/N that blocks *before* any
  download, `install.sh:456-459`) and ~630 KB of downloads, not by compute. Worth timing once
  for real before promising "watch this screen" in copy.
- Whether the four steps should also appear on couchside.tv, so the phone and the web page
  tell the same story.
