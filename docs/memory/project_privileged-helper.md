# Project: the privileged helper (retiring the sudoers surface)

**Status:** 📋 Scoped, not started. Depends on nothing; safe to start any time.
**Risk:** high — this is new root-side code on a LAN-reachable box. Every rule in
CLAUDE.md §3 applies to the helper with no exceptions.

---

## 1. Why

Three separate shipped bugs came out of the sudoers surface, not out of the
features themselves:

- the NOPASSWD lexical-ordering saga (`zz-couchside`, last-match-wins probing),
- **KI-049** — the greetd grants are *never written by install.sh*, so the agent's
  greetd path calls `sudo -n` against rules that do not exist and fails closed on
  every greetd box,
- **KI-050** — the Decky bootstrap may write stale `sddm`-shaped grants on a box
  whose display manager is not sddm.

The grants are also now *dynamic* (`$DM_NAME`), which means the installer has to
be re-run to fix a box whose DM changed — the agent alone cannot repair it.

Root-running the agent is rejected: see §6.

## 2. What exists today (shipped, agent 2.9.68)

Eleven NOPASSWD rules, from `install.sh`:

| # | rule | note |
|---|------|------|
| 1 | `systemctl restart $DM_NAME` | dynamic — `sddm` or `plasmalogin` |
| 2 | `tee /etc/$DM_NAME.conf.d/zzz-couchside-session.conf` | dynamic path |
| 3 | `tee /etc/sddm.conf.d/zz-couchside-session.conf` | legacy, blank-only |
| 4 | `systemctl reboot` | |
| 5 | `systemctl poweroff` | |
| 6 | `systemctl suspend` | |
| 7 | `systemctl restart plugin_loader` | Decky recovery |
| 8 | `systemctl restart --no-block couchside.service` | app-triggered update |
| 9 | `$JOURNAL_WRAPPER` | root-owned, validates unit + line count |
| 10 | `$WRAP` (flatpak update wrapper) | conditional on `-x` |
| 11 | `$OSWRAP` (OS update wrapper) | conditional on `-x` |

Plus two agent call sites with **no matching grant at all** (KI-049):
`sudo -n cp -n $GREETD_CONFIG $GREETD_BACKUP` and `sudo -n tee $GREETD_CONFIG`.

## 3. The helper

A separate root process, socket-activated, that the network-facing agent talks to
over a local unix socket. The agent keeps running as `User=__USER__` — it must,
because uinput, Wayland capture, PipeWire, KWin DBus and launching Steam all need
the user session bus.

```
/usr/libexec/couchside-helper          root:root 0755, pure stdlib
/run/couchside/helper.sock             SocketMode=0660, SocketUser=<install user>
couchside-helper.socket                systemd socket unit
couchside-helper.service               Type=simple, root, Accept=no
```

**Protocol.** One JSON object per line in, one out. No streaming, no shell.

```json
{"verb": "session.set-boot", "arg": "desktop"}
{"ok": true, "detail": "plasmalogin: zzz-couchside-session.conf written"}
```

**Authentication is two-layer and both layers fail closed:**
1. socket mode 0660 owned by the install user;
2. `SO_PEERCRED` on the accepted connection — the peer uid must equal the uid
   baked in at install time. If `SO_PEERCRED` is unavailable, **refuse**, do not
   fall through to "allow".

**The verb table is a frozen dict in the helper.** The verb selects a Python
function; the arg is validated against that verb's own closed set. An unknown
verb or an unknown arg is an error reply and nothing runs. No verb takes a path,
a unit name, or any string that reaches a shell. `subprocess` is argv-list only.

| verb | arg (closed set) | replaces |
|------|------------------|----------|
| `session.set-boot` | `game` \| `desktop` \| `last` | 2, 3, + greetd writes |
| `session.clear-boot` | — | 2 |
| `dm.restart` | — | 1 |
| `power` | `reboot` \| `poweroff` \| `suspend` | 4, 5, 6 |
| `unit.restart` | `plugin_loader` \| `couchside` | 7, 8 |
| `logs.journal` | `{unit, lines}`, unit from the units table | 9 |
| `update.flatpak` | — | 10 |
| `update.os` | — | 11 |

Eight verbs for eleven grants plus the two ungranted greetd calls. The DM name
stops being part of the *grant* and becomes an internal detail of the helper,
which detects it the same way the agent does today — so a box whose DM changes
repairs itself on the next call instead of needing install.sh re-run.

## 4. Rollout — the constraint that shapes everything

**The agent updates independently of the installer.** The quick-update path
prints, verbatim:

> Quick update: agent binary only. If the service file or sudo grants also
> changed, re-run this installer from a terminal to apply those.

So a 2.9.7x agent will run on boxes that have no helper, possibly for months.
The helper is therefore **optional and detected**, never assumed:

```
_privileged(verb, arg):
    if helper socket present and answers  -> use it
    else                                  -> existing sudo argv path
```

Phase order:
1. Ship the helper + the agent shim, with sudoers **unchanged**. Both paths live.
   Any box that runs the installer gains the helper; every other box is untouched.
2. Once telemetry-free confidence is there (both test boxes on the helper path,
   one full release cycle), stop writing the migrated sudoers lines in a new
   installer run and remove the stale file.
3. Delete the sudo fallback only after the minimum supported agent has the shim.

## 5. Traps to design against

- **Shutdown ordering.** `couchside.service` has
  `ExecStop=… --arm-boot-session`, which will now want the helper. If
  `couchside-helper.socket` is torn down first, arming silently fails and the
  KI-051 fix regresses on every shutdown. The units need explicit ordering, and
  the arming test must be run against a *real* reboot, not a mocked one — that is
  how the original bug was caught.
- **Socket activation at boot.** The agent can start before the socket is up; the
  detection must treat "not yet there" as "use fallback", not as a hard error.
- **The helper is root code reading a socket.** It gets the same review bar as the
  HTTP allowlist: a reviewer should be able to read the whole verb table on one
  screen.
- **`Accept=no`,** so one long-lived process handles connections; a per-connection
  fork would multiply the root surface for no gain.

## 6. Rejected: run the agent as root

It would delete the sudoers file outright, and it is still the wrong trade.

- The agent is a hand-rolled HTTP/WebSocket server reachable on the LAN behind one
  bearer token. Today a token compromise yields the desktop account plus a fixed
  argv allowlist; as root it yields the whole box, and any bug in that parser
  becomes a root RCE.
- It does not simplify as much as it looks. `User=__USER__` and
  `XDG_RUNTIME_DIR=/run/user/__UID__` are load-bearing for uinput, Wayland
  capture, PipeWire, KWin DBus and Steam. A root daemon would immediately need to
  re-enter the user session, trading sudoers complexity for privilege-dropping
  complexity — the harder of the two to get right.
- Root would not have prevented any of the recent display-manager work. It does
  not tell you which DM is installed, does not change that `/etc/sddm.conf`
  overrides `conf.d`, and would not have prevented KI-051. Those are platform
  semantics, identical at every privilege level.

## 7. Tests required (CLAUDE.md §6)

- unknown verb refused **and nothing runs** (the standard non-allowlisted-id test);
- unknown arg for a known verb refused;
- `SO_PEERCRED` mismatch refused; missing `SO_PEERCRED` refused (fail closed);
- agent shim: helper present -> helper used; helper absent -> sudo fallback;
  helper present but erroring -> reported, **not** silently retried as sudo;
- shutdown arming through the helper, proven on a real reboot of a real box, both
  directions (game and desktop), the way KI-051 was proven;
- greetd: the path that has never worked now works — this is the KI-049 close.

## 8. Size

Helper ~200 lines. Agent shim ~60 plus deleting the sudo argv builders. install.sh
~40 (install units, stop writing migrated rules in phase 2). Four test files.
