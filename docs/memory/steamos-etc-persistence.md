# SteamOS: which /etc files survive an OS update, and why

> Researched 2026-09-26 for the KI-088 follow-up (`feat/install-health`). Sources:
> Valve's source for the mechanism, confirmed by read-only reads of the maintainer's
> Deck OLED on SteamOS 3.9.2. Read this before adding ANY file under `/etc` to
> `install.sh` or the Decky plugin.

## TL;DR

A SteamOS atomic update **throws away every change in `/etc` except the paths on a
keep-list.** `/etc/systemd/system/*.service` is on Valve's list, which is why
`couchside.service` survived. `/etc/couchside/**`, `/etc/udev/rules.d/*`,
`/etc/modules-load.d/*`, `/etc/sudoers.d/*` and `/etc/systemd/network/*` are not on the
list, so they were dropped. `/var` is copied to the new slot almost whole, so
`/var/lib/couchside` (token mirror, config) survived.

The OS supports adding paths to the list with drop-in files in
`/etc/atomic-update.conf.d/*.conf`. The drop-in dir is itself on the list. Since this
branch, `install.sh` section **(f4)** writes `/etc/atomic-update.conf.d/couchside.conf`
naming only Couchside's own files. The agent's `install_health` (on `/api/status`) and
the installer's unconditional re-write of every piece are the safety net for boxes that
were already damaged, and for a SteamOS that ever changes this behaviour.

Bazzite (bootc/ostree) is different: it carries `/etc` through upgrades with a 3-way
merge. It kept all 11 Couchside `/etc` files hash-identical across 43.20260420 →
44.20260921 (verified 2026-09-26, see BUILD_LOG).

## Evidence

### What was observed (hardware)

| Box | Update | Lost | Kept |
|---|---|---|---|
| Deck OLED `taylor-steamdeck` (10.1.1.210) | SteamOS 3.8.x, from 2026-08-26 07:58 (first line of the oldest retained boot) | `/etc/couchside/` (token, `couchside-journal` wrapper), `/etc/udev/rules.d/*couchside*`, `/etc/modules-load.d/*couchside*` | `/etc/systemd/system/couchside.service`, `/etc/ssh` host keys, `/var/lib/couchside/` |
| A user's Deck | SteamOS 3.8.28 | `/etc/couchside/token` (journal: "cannot read token file") | the rendered unit (the log shows `--config /var/lib/couchside/config.json`, which only that unit passes) |
| Bazzite 10.1.1.60 | bootc 43.20260420 → 44.20260921 | nothing | all 11 files, hash-identical |

The task brief also listed "`/usr/local/bin/couchside-journal`" as lost. **No Couchside
code has ever installed that path.** `git log -S` finds nothing, and both installers write
the wrapper to `/etc/couchside/couchside-journal` (`install.sh` `JOURNAL_WRAPPER`, the
Decky plugin's `main.py:70`). The wrapper was lost because it lives inside
`/etc/couchside/`.

### Read on the Deck itself (read-only ssh, 2026-09-26, SteamOS 3.9.2 BUILD_ID 20260925.101)

- `findmnt /etc` → `overlay ... lowerdir=/new_root/etc,upperdir=/new_root/var/lib/overlays/etc/upper`.
  `/etc` is the read-only image plus an upper layer that lives in `/var`.
- `pacman -Qo` → `/usr/lib/rauc/atomic-update-keep.conf` and `/usr/lib/holo/holo-sync-var`
  are owned by **`steamos-customizations-jupiter 20260827.2-1`**. `/etc/rauc/system.conf:18`
  `post-install=/usr/lib/rauc/post-install.sh`.
- `/usr/lib/rauc/atomic-update-keep.conf` on the Deck: 69 lines, **identical** to the
  mirror's template below with the placeholders substituted (line 4 reads
  `files in "/etc/atomic-update.conf.d/"`, line 8 names `/var/lib/steamos-atomupd/etc_backup`,
  line 14 `/etc/atomic-update.conf.d/*.conf`). Lines 23, 26-27 and 37-40 are exactly as
  cited below.
- `/usr/lib/holo/holo-sync-var` on the Deck (the older 20260827.2 build, so its line
  numbers differ from the mirror's): `:44` `ETC_OVERLAY_ABSDIR=/var/lib/overlays/etc`,
  `:46` `ATOMIC_UPDATE_CONF_D=/etc/atomic-update.conf.d`, `:233` sed of the keep-list,
  `:237-240` the drop-in loop, `:278-289` the rsync with `--include="*/"
  --include-from="${config}" --exclude="*"`, `:330-344` the `/var` copy with its excludes.
  **This build has NO "very important files" fallback.** That retry exists only in the
  newer mirror tag (see the table).
- `/usr/lib/rauc/post-install.sh:214` reformats the other `/var`, and `:224` runs
  `/usr/lib/holo/holo-sync-var all`.
- `/etc/atomic-update.conf.d/` holds only Valve's `example-additional-keep-list.conf`.
- `ls -A /var/lib/overlays/etc/upper` holds `.devkit-service-on-os-update .pwd.lock
  .updated NetworkManager brlapi.key cups group group- gshadow gshadow- hostname
  ld.so.cache localtime machine-id pacman.d previous printcap resolv.conf sddm.conf.d
  shadow ssh steamos-atomupd systemd vconsole.conf xdg`. There is **no `couchside/`,
  `udev/`, `modules-load.d/` or `sudoers.d/`**. The only Couchside entries are
  `systemd/system/couchside.service` and its `multi-user.target.wants` symlink, both on
  the keep-list. `previous/` holds a copy of `couchside.service` only; the loss predates
  the last update.
- Footprint: `/etc/couchside`, all four `99-couchside-*.rules`, `couchside-uinput.conf`
  and `50-couchside-wol.link` are MISSING; `couchside.service` is present;
  `/var/lib/couchside/{config.json,token}` are present (deck-owned, 0600; not read). The
  agent answers `/api/ping` as 2.9.114, and `couchside.service` is active.
- `sudo -n -l` → rc **0**. SteamOS ships NOPASSWD rules of its own for `deck`, so sudo
  still lists, but the list no longer names our wrapper: the grant is gone. The verbatim
  listing is the `LISTING_DECK` fixture in `tests/test_install_health.py`.
- **This branch's `install_health_compute()` run ON the Deck** (source piped over stdin,
  executed as a module, nothing written) returned
  `{"ok": false, "missing": ["token_canonical", "sudoers_grant", "journal_wrapper",
  "udev_uinput", "modules_uinput", "udev_rtc"], "unknown": []}`. Control: the same code
  on the same box, with the expected set narrowed to the one piece that survived
  (`systemd_unit`), returned `{"ok": true, ...}`.

### The mechanism (source)

Source: Valve's `steamos-customizations`, read from the public mirror
`github.com/evlaV/steamos-customizations` at tag **`jupiter-20260916.1`**, 2026-09-26.
This is newer than the Deck's `20260827.2` build. Where the two differ (the `/var`
fallback), the difference is noted. Everything the product relies on was confirmed on
the Deck, as listed above.

| Fact | File:line |
|---|---|
| "When an atomic update is applied, all changes made in /etc will be lost. The only exceptions are the files and directories listed below." | `atomic-update/rauc/atomic-update-keep.conf.in:1-2` |
| Drop-ins: "you can create drop-in '*.conf' files in `@atomic_update_conf_d@/`" | same file `:3-4` |
| The drop-ins themselves are kept: `@atomic_update_conf_d@/*.conf` | `:14` |
| A backup is made before the removal | `:8` |
| `*` does not match `/`; `**` does | `:10-11` |
| `/etc/sddm.conf.d/*` is kept (our `zzz-couchside-session.conf` survives) | `:23` |
| `/etc/ssh/*_key`, `*_key.pub` are kept (why the host keys survived) | `:26-27` |
| `/etc/systemd/system/*.wants/**`, `*.service`, `*.service.d/**`, `*.socket` are kept (why `couchside.service`, its enable symlink, and the helper/Decky-manager units survive) | `:37-40` |
| `@atomic_update_conf_d@` = `/etc/atomic-update.conf.d` | `common.mk:134` |
| The /etc overlay upper lives at `/var/lib/overlays/etc` (+ `/upper`) | `common.mk:73` |
| Backups go to `/var/lib/steamos-atomupd/etc_backup` | `common.mk:140,144` |
| The keep-list is installed to `/usr/lib/rauc/atomic-update-keep.conf`; the drop-in dir is created | `atomic-update/Makefile:32-34` |
| The RAUC post-install hook reformats the other slot's `/var`, then runs `/usr/lib/holo/holo-sync-var all` | `atomic-update/rauc/post-install.sh.in:214, 220, 224` |
| The include list = the keep-list plus every drop-in, each with the leading `/etc` stripped | `misc/libexec/holo-sync-var.in:332, 337-340` |
| The filter: `rsync ... --delete --prune-empty-dirs --include="*/" --include-from=<list> --exclude="*" <old upper>/ <new upper>/`. **Anything not listed is dropped.** | `holo-sync-var.in:381-391` |
| `/var` is copied whole with `rsync --archive --delete`, except `/boot/`, `/lib/{dkms,modules,pacman,NetworkManager}/`, `/lost+found/` and the /etc overlay (handled separately) | `holo-sync-var.in:400, 445-451` |
| NEWER than the Deck's build: if the full `/var` copy fails, it retries with only a short "very important" list (bluetooth, iwd, sddm, NetworkManager, steamos-atomupd, systemd bits). **`/var/lib/couchside` is not on that list**, so in that failure mode the token mirror and config.json would be lost too | `holo-sync-var.in:466, 475-492` (absent from the Deck's 20260827.2) |
| If the drop-ins make the /etc sync fail, it retries with the built-in list only | `holo-sync-var.in:529` |
| The whole old upper is copied to `/etc/previous/` in the new slot (only the LAST update's), and a `tar.xz` backup goes to `etc_backup` (root 0700, latest 5 kept) | `holo-sync-var.in:146, 225, 277-283, 685, 688` |
| There is a read-only report: `holo-sync-var --dry-run` lists the `/etc` files that would NOT be preserved | `holo-sync-var.in:24-29, 643-644` |

Tailscale's official Deck script (`tailscale-dev/deck-tailscale` `tailscale.sh`) and the
Determinate/Nix installer (`src/planner/steam_deck.rs`, guarded by
`Path::new("/etc/atomic-update.conf.d").exists()`) both use this drop-in directory.
Valve's example drop-in warns against keeping files that `pacman -Syu` might touch,
because a kept copy would shadow upstream edits forever
(`example-additional-keep-list.conf.in:3-4, 17-21`). That is why ours lists **only
Couchside-owned paths**.

## Decision, per file

| Piece (`install_health` id) | Path | Kept by SteamOS by default? | Decision |
|---|---|---|---|
| `token_canonical` | `/etc/couchside/token` | no | keep-list `/etc/couchside/**`. The agent mirror `/var/lib/couchside/token` stays as the fallback (2.9.114). |
| `journal_wrapper` | `/etc/couchside/couchside-journal` | no | keep-list (under `/etc/couchside/**`) |
| `sudoers_grant` | `/etc/sudoers.d/zz-couchside` (+ `-updates`, `-decky` opt-ins) | no | keep-list, exact names. This does not widen anything: it stops an update from silently revoking grants the owner already installed. |
| `udev_uinput` / `udev_rtc` / `udev_cec` / `udev_openpuck` | `/etc/udev/rules.d/99-couchside-*.rules` | no | keep-list, exact names |
| `modules_uinput` | `/etc/modules-load.d/couchside-uinput.conf` | no | keep-list |
| (not health-checked: hardware-conditional) | `/etc/systemd/network/50-couchside-wol.link` | no | keep-list |
| `systemd_unit` | `/etc/systemd/system/couchside.service` | **yes** (`:38`) | nothing to do |
| (helper / Decky manager units) | `/etc/systemd/system/couchside-*.{service,socket}` | **yes** (`:38, :40`) | nothing to do |
| (boot-session drop-in) | `/etc/sddm.conf.d/zzz-couchside-session.conf` | **yes** (`:23`) | nothing to do |
| (state) | `/var/lib/couchside/**` | yes (the `/var` copy, `:445-451`) | nothing to do (see the failure-mode caveat above) |

**Why not relocate instead.** Relocation fails for each kind of file:

- `sudo` reads only `/etc/sudoers` and `/etc/sudoers.d/`. `udev` reads
  `/etc/udev/rules.d`, `/run/udev/rules.d` (tmpfs, gone at every boot) and
  `/usr/lib/udev/rules.d` (read-only image on SteamOS). `modules-load.d` has the same
  three roots. No persistent, writable location exists outside `/etc`.
- The sudo-granted wrappers must sit in a **root-owned directory chain**.
  `/var/lib/couchside` is chowned to the desktop user every install run (so the agent
  can write config.json). A root-run file under it can be swapped by renaming its
  parent, which is user→root escalation. The same flaw exists today for the SteamOS
  helper fallback `/var/lib/couchside/libexec`. That is flagged separately as a task
  chip: "Move SteamOS helper out of user-owned /var/lib/couchside".
- A boot-time root unit that re-creates the files under `/run` would add new root code
  that runs every boot, only to recreate what the keep-list keeps by declaration.

**Why the installer does not restore opt-in grants from a record.** A record the
installer could restore from would have to live in writable state, e.g.
`/var/lib/couchside`, which the desktop user owns. Restoring sudo grants from
user-writable state would let the user, or anything running as the user, grant
themselves the opt-ins. Instead the keep-list prevents the loss, and a box that
already lost them re-opts-in with `couchside allow-… on`.

## What the product does about it (this branch)

1. **Prevent**: `install.sh` (f4) writes `/etc/atomic-update.conf.d/couchside.conf`,
   and only when that dir exists. Test: `tests/test_installer_steamos_keep.sh` runs
   Valve's include/exclude rules with real rsync over a fake upper, with and without
   the drop-in. Without it, the Deck's damage reproduces; with it, every piece
   survives.
2. **Detect**: agent `install_health` on `/api/status`:
   `{ok, missing: [ids], unknown: [ids]}`, from the frozen `_INSTALL_PIECE_IDS`
   table. A piece that could not be checked is reported as unknown, never as ok. The
   `/var/lib/couchside/install-manifest` written by `install.sh` (g1) tells "lost"
   apart from "never installed". The app's Console shows "Box installation is damaged
   (missing: …) — re-run the installer on the box" with the one-liner.
3. **Repair**: every `/etc` piece is rewritten **unconditionally** on a full installer
   run. (d) restores the token from the mirror, and the mirror now beats leftover
   pre-rename tokens. `couchside update` no longer says "Nothing to update" on a
   damaged box. The passwordless quick path cannot write `/etc`, so it prints the
   damage and tells the owner to run the installer from a terminal.

## Not verified (as of 2026-09-26)

- **The (f4) drop-in has not ridden through a real SteamOS update.** Its effect is
  shown only by reproducing Valve's rsync filter (`tests/test_installer_steamos_keep.sh`)
  against the keep-list the Deck actually has. To test on hardware: re-run the
  installer on the Deck (this restores everything and writes the drop-in), apply the
  next SteamOS update, then check the footprint again. The same read-only commands
  work:
  ```sh
  ssh -o HostKeyAlias=taylor-steamdeck.local -o BatchMode=yes deck@10.1.1.210 '
    ls -la /etc/atomic-update.conf.d/;
    for p in /etc/couchside /etc/udev/rules.d/99-couchside-uinput.rules \
             /etc/modules-load.d/couchside-uinput.conf; do [ -e "$p" ] && echo "ok $p" || echo "MISSING $p"; done;
    ls -A /var/lib/overlays/etc/upper'
  ```
- `holo-sync-var --dry-run` (the OS's own "what would be lost" report) was not run. It
  reads the whole upper and may need root.
- The newer `/var` fallback (`holo-sync-var.in:466`, mirror tag only), in which even
  `/var/lib/couchside` would be lost, has never been observed. The Deck's build does
  not have it.
- Which SteamOS release first applied the keep-list filter is not established here. The
  filter runs on **every** update (`post-install.sh` → `holo-sync-var all`). That explains
  both the maintainer's Deck (2026-08-26) and the user's (3.8.28): an update after
  install is enough, not one bad release. Treat any Couchside `/etc` file on SteamOS
  as lost at the next update unless the keep-list names it.
