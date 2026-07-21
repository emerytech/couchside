# Couchside — Claude Instructions

> **This file governs how you work, not what you build.**
> Read it fully at the start of every session before touching any code.

Couchside turns a phone into the dashboard, remote console, and game controller for a
living-room Linux box (SteamOS / Bazzite / Steam Deck / any systemd machine). A native
iOS + Android app talks to a dependency-free Python service on the box. LAN-only,
token-authed, no cloud, no accounts, no analytics.

---

## ⛔ CRITICAL CONSTRAINT — READ BEFORE ANYTHING ELSE

**The agent executes only what is on an explicit allowlist. Nothing a client sends ever
becomes a command, a path, or a shell string.**

The agent runs as the user's desktop account on their gaming machine. It can launch
programs, switch sessions, reboot, and power off. It sits on a home LAN behind one bearer
token. If a client can steer it to run something arbitrary, an attacker on that LAN owns
the box — and the blast radius is somebody's personal computer, not a sandbox. There is no
cloud tier to revoke, no account to lock: a shipped hole stays open until the user updates
the agent themselves.

**Treat every violation as a zero-tolerance bug.** If you are ever unsure whether code
respects this, STOP and ask before writing or executing it.

---

## 1. Startup Sequence (run at the start of EVERY session)

1. **Read all memory files** in `docs/memory/`. Create missing ones with sensible defaults.
2. **Read `docs/ROADMAP.md`** — planned, in progress, done.
3. **Read `docs/BUILD_LOG.md`** — what was last worked on, where things were left.
4. **Scan the source area** you're about to touch — read existing files before creating new ones.
5. **Identify the allowlist pattern** already used in that area (launcher ids, action ids,
   menu ids, TV ops — each has one).
6. **State your plan** in one short paragraph before writing code: what, which files, how it
   fits existing patterns, how the allowlist constraint is maintained. Wait for confirmation
   if anything is architecturally ambiguous.

Note: `app/CLAUDE.md` carries an app-specific instruction (read the versioned Expo SDK 57
docs before writing app code). It is not superseded by this file.

## 2. Memory Files

| Path | Contents |
|------|----------|
| `docs/memory/ARCHITECTURE.md` | Stack, directory layout, key patterns, integrations |
| `docs/memory/CONVENTIONS.md` | Coding conventions, naming, test + PR + release rules |
| `docs/memory/DEPENDENCIES.md` | Every meaningful dependency, version, why |
| `docs/memory/DECISIONS.md` | **LOCAL — gitignored.** Append-only log of significant decisions |
| `docs/memory/KNOWN_ISSUES.md` | **LOCAL — gitignored.** Numbered KI-### registry: bugs, limitations, debt |

**Three files are deliberately untracked** (`docs/memory/KNOWN_ISSUES.md`,
`docs/memory/DECISIONS.md`, `docs/BUILD_LOG.md`). This repo is public, and a numbered
registry of where a LAN-exposed daemon is soft is not something to publish — the agent runs
as the user's desktop account and can reboot their machine. They exist on the maintainer's
machine and are read at the start of every session. **If you are in a fresh clone they will
be absent: create them rather than assuming there is no history**, and do not "helpfully"
commit them.

Update the relevant file any time you add a dependency, establish a pattern, make a decision,
or find an issue. **Never let these go stale.**

## 3. Allowlist Rules — never violate

1. **A client-supplied identifier is looked up, never interpolated.** Ids index a frozen
   set or dict defined in the agent source (`_STEAM_MENU_IDS`, `ACTIONS`, `LAUNCHERS`,
   the TV op tables). An id that is not present is a 404 — never a pass-through.
2. **`subprocess` is called with an argv LIST. Never `shell=True`, never a formatted
   command string.** The binary and its arguments are chosen by the agent; user input
   only ever selects *which allowlisted entry* runs.
3. **Never widen an allowlist to a pattern.** No globs, no prefix matches, no "anything
   under this namespace". Adding a capability means adding an explicit entry.
4. **Every route that changes state requires the bearer token.** `/api/ping` is the only
   deliberate pre-auth endpoint. `/pair` is loopback-only AND checks the Host header
   (anti-DNS-rebinding) because it renders the token.
5. **Paths derived from client input are contained.** Resolve, then verify the result is
   still inside the intended root before opening it.
6. **Reject rather than sanitise.** If input is not exactly a known-good value, return an
   error. Do not attempt to clean it up.
7. **Degrade closed.** When a probe fails or `/proc` is unreadable, return "unavailable",
   never "allowed".
8. **If you find existing code violating these rules**, do not replicate it. Add a KI-###
   entry with `Impact: high` and flag it immediately.

## 4. Hard Constraints — Never Violate

- **The gamepad / trackpad input path is safety-critical.** It is the most stateful,
  most concurrent code in the project and the source of most escaped bugs: half-dead
  sockets, promote/demote races, leaked uinput devices. Changes here require tests for
  the lifecycle (create → hold → hand off → reap), not just the happy path.
  **The agent's own virtual pad must never be matched as a real device** — that filter is
  load-bearing; if it ever matched, connecting a phone would tear down the user's desktop.
- **Reachability is protected.** `/api/ping`, `/api/status` and the auth gate are smoke-tested
  in CI on every push. Do not weaken those gates. The product's promise is that it works when
  the TV is black — being unreachable is a total failure.
- **The agent stays pure Python 3 stdlib, single file.** No third-party imports, ever.
  It installs onto machines we do not control.
- **Never change existing API response shapes.** Add fields; never rename or remove. Old
  app versions in the wild must keep working against new agents (verify with the harness).
- **A capability key requires all five edit sites** (agent CAPS dict + mock tuple; app
  BoxCaps + normalizeCaps + capsEqual). Missing the app two is a silent bug: the cap never
  persists and the app re-probes forever.
- **No credentials in source.** The release signing key lives offline and never touches CI.
- **Do not add CORS to the agent.** It is LAN-only and token-authed by design; dev browsers
  go through `scripts/web-dev-proxy.py` instead.

## 5. Stack and Key File Locations

| Layer | Choice |
|---|---|
| App | Expo SDK 57, React Native 0.86, TypeScript, expo-router |
| Agent | Python 3, standard library only, single file, systemd user service |
| Transport | HTTP + RFC6455 WebSocket (hand-rolled), bearer token, LAN only |
| Tests | Pure-stdlib Python, no pytest; one CI step per file |
| CI/Release | GitHub Actions; EAS builds; Ed25519-signed agent assets |

```
agent/couchsided.py      the whole Linux agent (~11k lines)
agent/win/               Windows agent variant
app/                     Expo app (app/(tabs)/ screens, components/, lib/)
tests/test_*.py          agent tests, each its own CI step
scripts/                 release, signing, store submission, web-dev harness
docs/memory/             the files listed in §2
```

See `docs/memory/ARCHITECTURE.md` for the canonical patterns (probe-and-appear, caps,
injected actions) with real snippets. New code matches those exactly.

## 6. Testing Requirements

| Area | Required |
|------|----------|
| New agent endpoint | Happy path + auth failure + unknown-input rejection |
| Anything taking a client id | A test proving a non-allowlisted id is refused and nothing runs |
| Gamepad / input path change | Device lifecycle test (create → hold → hand off → reap) |
| New capability key | A test asserting all five edit sites are wired |
| Parsing `/proc` or sysfs | Fixtures copied VERBATIM from real hardware |
| App UI change | Driven in the web harness — **press the control, don't just render it** |
| Anything only observable on the TV | Screen-capture proof via `/api/screen/frame` |

**A render is not a test.** A tap shipped broken to TestFlight because the harness was used
to look at a screen and never to press anything.

## 7. Living Build Documents

`docs/ROADMAP.md`: sections ✅ Completed / 🔨 In Progress / 📋 Planned / 💡 Backlog.
Entries carry priority, risk, affects, depends_on, description, notes. Move items; never
delete. Only mark Complete after the constraint checklist passed.

`docs/BUILD_LOG.md`: append-only. After every session:

    ## YYYY-MM-DD — Session title
    **What was done:** bullets
    **Files created/modified:** path — why
    **Allowlist verification:** endpoints/ids added + how each is constrained
    **Verified how:** what was actually exercised, and what was NOT
    **Left off at:** one sentence
    **Known issues / follow-ups:** bullets

## 8. Before Writing Any Code — Checklist

- [ ] Read memory files, BUILD_LOG, ROADMAP
- [ ] Scanned existing files in the area
- [ ] Identified the allowlist pattern for this area
- [ ] Every new route/handler follows the §3 rules
- [ ] Not introducing a pattern without noting it in CONVENTIONS.md
- [ ] Not adding a dependency without DEPENDENCIES.md
- [ ] Not creating a new file where extending an existing one is cleaner

## 9. After Completing Work

1. Append to BUILD_LOG including the verification sections.
2. Update ROADMAP.
3. Update memory files (dependency → DEPENDENCIES, pattern → CONVENTIONS, decision →
   DECISIONS, issue → KNOWN_ISSUES).
4. State what was completed, what's next, and any open edge cases.

## 10. Roadmap Intake

When the user says "add X to the roadmap" / "capture this feature": dedupe against ROADMAP +
KNOWN_ISSUES first; add a structured 📋 Planned entry; specs with 3+ phases go to
`docs/memory/project_<slug>.md`, never into this file.

## 11. Evidence Rules — how claims get made here

This project's expensive bugs have almost all been *confident wrong claims*, not bad code.
These are not style preferences; they are the house standard for what counts as knowing.

1. **Test the thing; don't grep for it.** Absence of a string is not absence of a feature.
   Grepping Steam's bundle "proved" a working deep link did not exist. Firing the URL took
   ten seconds.
2. **Observe both states.** A detector is unverified until you have seen it fire AND not
   fire. Shipping on one half produced a card that advertised a dead session for 27 minutes.
3. **Put a control in every measurement** — an input whose answer you already know. Two
   automated sweeps produced confident, entirely wrong tables before one had controls.
4. **Verify the tool did what it claims.** `autoIncrement` silently rewrites `app.json`
   mid-build; the release-notes script published a stale changelog and exited 0. Read the
   artifact, not the exit code.
5. **Don't generalise from one observation — in either direction.** One install dialog was
   read as "streaming is broken"; streaming was fine, the host was asleep.
6. **Write down what you did NOT verify.** PR bodies say so explicitly. If you catch
   yourself writing "should work", stop and go verify it instead.
