# Next Couchside release plan — audit of November 2, 2026

This is a planning snapshot, not release authorization. No new app or agent
version/build number is reserved. Re-fetch branches and check exact-head CI before
integration. Preserve API compatibility, saved boxes, pairing, licenses and settings.

## Baseline: already shipped

| Component | Published baseline | Source/evidence |
| --- | --- | --- |
| Mobile app | 2.9.81; iOS 289, Play 129, Direct 64 | [release v2.9.81](https://github.com/emerytech/couchside/releases/tag/v2.9.81), source `3d149a0dd4c884e7a7be65472d445b02f1a96262` |
| Linux agent | 2.9.136 | Same release/tag |
| Windows agent | 0.4.15-win; existing unsigned distribution | [Windows release](https://github.com/emerytech/couchside-windows/releases/tag/v0.4.15-win), main `4f8e57a61673cce4e787838a930feff9401ca1a7` |
| Decky companion | 0.2.101, compatible with Loader 3.3.1 | [companion release](https://github.com/emerytech/couchside-decky/releases/tag/v0.2.101), master `f6f3c214381cb35f512e10d7c24071a1684b9e73` |

The companion version is independent of Decky Loader's version.
Store-delivered iOS and Play smoke evidence was recorded November 2. The Play
check was a fresh install, not an older-Play in-place upgrade. Current public
Android checker advertises Play 129 and Direct 64. The GitHub release description
still contains launch-day store-review wording; it is stale status copy, not a
reason to rebuild or resubmit those binaries. No published copy was changed here.

The themed preset gallery, one-handed Vampire Survivors, custom controller
button/trigger copies and labels, portrait PAD fit, Rotate/PREFS, Decky manager,
TV appearance packs, and Steam uninstall handoff are already in 2.9.81. Do not
repeat them as unshipped features. Keyboard bindings and timed macros are not part
of the shipped custom-controller implementation.

## Actual new source on main

`main` is `6bc40e29e63a923bf35a8f214ce6028b62b48c1d`, one squash commit after
v2.9.81: [Ports PR #659](https://github.com/emerytech/couchside/pull/659).
It adds catalog/allowlist, Linux install/remove jobs, opt-in CLI and mobile Ports UI.
It still declares app 2.9.81 / Linux 2.9.136: those versions describe the old release,
not a newly published Ports build. Never overwrite the old version's assets.

### First priority: make Ports ready or explicitly exclude it

- [ ] **Verify downloaded executable content before execution.**
  `ports/index.json` and `agent/couchsided.py` currently freeze a release URL/tag,
  but `ports_run` downloads a script and passes it to bash without a pinned digest
  or signature check. The tag `couchside-bbport` is not a content hash. Establish
  a reviewed immutable-content contract for install/remove scripts and downstream
  executable assets; reject changed bytes before spawn. Test digest/signature
  failure and HTTPS redirect behavior. TLS and the current ID allowlist are useful
  protections, but do not establish content immutability.
- [ ] **Make job ownership survive/reconcile agent restart.** `_PORTS_JOB` is
  memory-only while the installer is detached. Restart loses the child handle,
  current status and concurrency gate. Record/reconcile an active job safely;
  verify a restart cannot start a competing install or falsely report completion.
- [ ] **Exercise polling and host switching.** The Ports screen combines a slow
  poll with a fast poll enabled from the slow result, then prefers `fast.data`.
  Test completion while the fast poll disables, repeat jobs, failures, refresh,
  background/return and changing boxes; a stale completion must not mask a new job.
  This is a code-review concern, not a reproduced native defect in this audit.
- [ ] **Exercise the real UI.** Setup entry, old-agent hidden state, opt-in hint,
  confirmation Cancel, install/remove, busy state, progress, failure and recovery.
  Rendering and pure helper tests do not prove these interactions work.
- [ ] **Validate supported targets and data preservation.** Test SteamOS/Bazzite
  x86_64, unsuitable platforms/architectures, correct installed detection, Steam
  shortcut creation and remove/reinstall with synthetic fixtures. Inspect recipe
  provenance and distribution contents. Do not use personal game dumps/saves as
  disposable data. Verify removal preserves supplied files and settings.
- [ ] Run the complete exact-head CI after fixes, then native iPhone/Android
  acceptance against the same Linux candidate. Tests passing today do not close
  the above gaps.

Relevant source: [agent](../agent/couchsided.py), [catalog](../ports/index.json),
[screen](../app/app/ports.tsx), [card](../app/components/PortsCard.tsx),
[install tests](../tests/test_ports_install.py).

## Branch and PR reconciliation

The repository uses squash merges. Non-ancestor status does not mean a feature
is missing. Compare feature files and the combined release diff before cherry-pick.
No PR was closed, rebased, merged or retargeted as part of this audit.

| Open PR(s) / branch | Audit disposition | Next action |
| --- | --- | --- |
| #643, #644, #645, #647, #649, #650 | Earlier Windows/TLS/CEC/input, Android cleanup and Hermes stack; runtime scope carried by #655 and subsequent releases | Historical stack; verify residual differences before closing as superseded. Do not merge the old stack wholesale. |
| #652 | Earlier keyboard/upload implementation; an old Android lifecycle check is red | Superseded paths were replaced in #653/#655. Do not import the old upload approach or interpret its old red check as current-main failure. |
| #653 | Secure background-transfer branch | Its native upload module matches current main; changes to later version/UI files are expected. Historical cleanup candidate. |
| #656 | Decky manager refresh | Six of eight runtime files are byte-identical on main; remaining agent/API differences include later uninstall/Ports additions. Feature shipped via #658; avoid duplicate merge. |
| #657 | Custom controls + uninstall | Seventeen of twenty-three runtime files are byte-identical; remaining differences are later versions/Ports integration. Feature shipped via #658. |
| #622 | Old newsletter Account link | Superseded by the shipped newsletter card and persistent Account entry. |
| #651 `fix/account-version-label` | **Not integrated**: resolver, tests and appVersion change absent from main | Optional small defensive-hardening candidate. Rebase only its three-file delta and retest; do not merge its old combined base. Not a reproduced blank-label release blocker. |
| #575 `claude/reco-app-ui` | Separate older Reserve/recommendation prototype, not current shipped UI | Defer unless selected. Review entitlement, API, flags and overlap before porting its delta. |
| `codex/windows-signing-source-20261030` `dd19d25` | Unmerged monorepo signing/update preparation | Separate optional Windows workstream below; do not merge its outdated base/version wholesale. |
| `codex/backup-couchside-player-20261021` `6424426` | Unmerged Player/discovery/library + receiver backup | Separate feature train below; preserve receiver boundary and avoid importing obsolete source or documentation deletions. |

The old stack's feature disposition is based on release PRs plus source comparison;
it is not a claim every old branch's documentation/packaging delta is integrated.
All listed PR checks were read live. #652 had one failure; #575/#622/#643–#651,
#653/#656/#657 had no failing/pending required checks at audit time (CodeRabbit
was skipped on #656/#657). This does not certify rebased future heads.

Windows repository still has PR #5 (warning already in the released agent) and
PR #2 (old installer-brand-icon proposal). Review #2 against current build/sync
and installer files before taking any icon change. No companion PR is open;
its master equals the published 0.2.101 tag.

## Separate optional workstreams

### Windows signing and secure self-update

Canonical branch `dd19d25410054fd0a1390668445b8f8dce1e9162`; mirror branch
`codex/windows-signing-prep-20261030` at
`ed3d325ec4c832f7b96e5e20f158b7bfa0b2bbbb`. These are GitHub backups with green
exact-head CI and unsigned hosted install/upgrade/uninstall evidence. They are
not main, genuine SignPath-signed builds, or production acceptance.

- [ ] Rebase the reviewed changes on current source without losing Steam uninstall.
  Canonical source first, then mirror the exact reviewed files to Windows repo.
- [ ] Obtain eligibility/project approval and a reviewed project-specific trust
  binding, exact signer and timestamp contract. No approval is assumed here.
- [ ] Test genuinely signed N-to-N+1 upgrade, UAC denial/retry, staging cleanup,
  interrupted installer and recovery. Mock signature tests are insufficient.
- [ ] Finish consumer fresh-OS/no-driver, SmartScreen and controller acceptance;
  retained runner/VM tests have narrower coverage.
- [ ] Keep updater off by default and signing workflow dormant until approved.
  Review opt-in persistence and mobile disabled/error copy on actual candidates.

Signing is not a mandatory gate for an unrelated mobile/Ports release if the
existing Windows policy remains explicitly selected and Windows bytes do not change.
Do not change licenses, policy, repository settings or contact providers from this plan.

### Player discovery and personal library

The backup has provider-neutral interfaces, licensed samples, saved/watched state,
local persistence and receiver work. It is not integrated with the current release.
A production metadata provider, terms/attribution, provider selection and matching
agent progress identity need review. Prior phone builds did not deploy the matching
agent. Automatic resume, episode browsing and real service availability are not proven.
Check the provider inquiry outcome separately; do not assume approval or expose keys.
Keep this out of the small Ports release unless deliberately selected and revalidated.

### Further custom-control work

Keyboard keys/chords and timed combos require a separate design and input-lifecycle
review. Preserve the shared PAD touch handler; use validated action IDs and release
all held keys on rotation, background, disconnect, handoff and preset switch. Do not
accept arbitrary executable commands. Retain beta labels until real gameplay checks
support each preset. No new custom-binding implementation is authorized by this audit.

## Release checklist after scope is chosen

1. Review and resolve the selected feature's gates above; optionally include only
   the isolated #651 hardening. Keep unrelated prototypes out.
2. Freeze an exact integration commit and require green CI on that head. Reconcile
   public notes and checklist facts; do not use historical draft status as truth.
3. Explicitly choose new app/Linux versions. Query EAS/App Store Connect/Play before
   allocating separate iOS, Play and Direct build sequences. The baseline numbers
   are not reservations for a new build. Change Windows only if its source changes.
4. Build iOS through EAS cloud under current owner policy. Android Gandalf checkouts,
   dependencies, outputs, caches and logs must remain under `/tank/build-storage`;
   source the build environment and stop if storage preparation fails.
5. Verify actual package versions, bundle IDs, signatures, retained Android maps and
   checksums. In-place upgrade smoke must preserve pairing, unlock, settings and pads;
   include a real older-Play upgrade when available, since prior Play smoke was fresh.
6. Test Ports/native UI and Linux jobs on actual final candidates. Reuse unchanged
   2.9.81 acceptance evidence with its limits; do not relabel it as new-binary proof.
7. If Linux agent changes, bundle that exact agent into a newly versioned Decky
   companion; verify installer compatibility, ownership, offline signatures and
   device smoke. A workflow notification is not proof the companion was updated.
8. Prepare release notes, signed agent assets, rollback and website/checker changes
   for review. Execute publication only after fresh owner authorization.

Long memory soak, Tailscale transfer and Pass-while-holding remain owner-deferred;
do not silently reinstate them as blockers. Keyboard and prior encrypted-transfer
acceptance are retained unless relevant code changes. No production changes or
subscriber sends are part of this audit.

## Verification performed in this audit

- Fetched/pruned current monorepo, Windows and companion refs; inspected public
  releases, open PR exact heads/checks, main CI and relevant release handoffs.
- Inspected 55 existing worktrees read-only. Several older checkouts contain staged
  or unstaged work. It was neither reset nor swept into this branch. Private
  continuation records identify them for selective reconciliation; no claim is made
  that every uncommitted byte is backed up to GitHub.
- On main source `6bc40e2`: Ports catalog/install tests, six Ports app helper tests,
  six dependency tests, protocol parity, app TypeScript, `bash -n install.sh` passed.
- Main hosted CI and native upload-security workflows passed on `6bc40e2`.
- No fresh native-device, live install/remove, signed Windows, long-soak, store
  upload or production deployment test was run. This document identifies remaining
  work; it does not mark those gates complete.


## Ports implementation checkpoint — November 3, 2026

Download-content verification and durable independent job tracking are implemented
on `codex/ports-verification-recovery-20261103`; see [Ports job contract](PORTS_JOBS.md).
All catalogued executable bytes, including the runtime, passed the new downloader.
Local Ports agent tests and the app suite passed, with delayed-response and
process-interruption controls. The exported-app fixture passed install/completion,
remove and backend-disconnect/reconnect reconciliation without duplicate mutation.
The earlier checklist stays open until real systemd user-service, native-phone and
approved disposable-target acceptance. Nothing is released or deployed by this work.
