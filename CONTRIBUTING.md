# Contributing to Couchside

Start with the [code map](docs/CODE_MAP.md) to find the component you need. The Linux
service is MIT-licensed; the phone app has its own [license](app/LICENSE). Keep
changes focused enough that another contributor can understand and revert them.

## Local development

CI uses Python 3.11 and Node.js 22. Agent tests use the Python standard library;
they do not need an installed service or a paired phone. Run commands below from
the repository root. Installing the production agent is not a prerequisite.

For app work:

```sh
npm ci --prefix app --no-audit --no-fund
npx --prefix app tsc --noEmit -p app
```

For a browser preview, see [scripts/web-dev.sh](scripts/web-dev.sh). It serves a
local mock/proxy alongside the exported app. A browser preview does not verify
native permissions, pairing, purchases, wake packets, or physical input devices.
Mock mode also is not a filesystem sandbox: use temporary paths for file tests.

## Choose checks for the boundary you change

| Change | Useful starting checks |
| --- | --- |
| File uploads | `python3 tests/test_upload.py` and `python3 tests/test_tls_ticket.py` |
| Authentication, pairing or TLS | `python3 tests/test_tls_ticket.py`, `python3 tests/test_pair_page.py`, `python3 tests/test_tls_smoke.py` |
| Action/configuration dispatch | `python3 tests/test_actions_inject.py` and `python3 tests/test_config_write.py` |
| Shared API contract | `python3 tests/test_protocol_parity.py` plus affected platform tests |
| App code | Typecheck above, then affected tests under `app/lib/__tests__` or `app/hooks/__tests__` |
| Adding an agent test | `python3 tests/test_ci_wiring.py`; add the new suite to CI |

These are starting points, not the whole release gate. The executable inventory
is [.github/workflows/ci.yml](.github/workflows/ci.yml). Read the relevant job for
its working directory, runtime and exact command rather than inventing an
`npm test` target. Most agent suites are standalone scripts, not pytest tests.

App unit tests run from `app/`, for example:

```sh
node --experimental-strip-types --test --test-timeout=60000 lib/__tests__/*.test.ts hooks/__tests__/*.test.ts
```

TV drivers and crypto have separate CI suites. Run those when touching their
boundaries. Passing unit tests is not evidence of compatibility with every TV,
SteamOS/Bazzite version, phone permission flow or signed store build.

## Make a change easy to review

1. Describe the observed problem, affected component and behavior to preserve.
2. For a bug, add a regression that fails for the actual failure condition. Use
   temporary directories, loopback servers and fixtures instead of personal data.
3. Keep behavior changes separate from broad formatting, renames, dependency
   upgrades and module moves. Prefer small named helpers over another long branch.
4. Preserve response shapes, capabilities, configuration defaults and compatibility
   with older apps/agents. Explain any intentional change or migration.
5. Run the relevant checks and `git diff --check`. Record what was tested, what
   was not, and how to roll back. Update the code map when a boundary moves.

Security-sensitive changes need explicit checks for authorization, rejected input,
resource limits, interrupted work and concurrent requests where applicable. Keep
commands as fixed argument lists and paths constrained by the operation's policy.
Do not widen sudo permissions or add network destinations as incidental cleanup.

The Linux agent is distributed as a **signed single file**. Splitting it into
imports changes the installer and update contract. First design signed packaging,
installation, upgrade and rollback together; until then, improve internal
boundaries and tests without breaking the deployed artifact.

## Before sharing or releasing

Review the exact staged diff and file list. Do not include pairing tokens, TV
credentials, signing keys, `.env` files, device logs, personal screenshots or local
assistant notes. An ignored file is not protected if it was already tracked.
Use synthetic credentials in tests. Report suspected vulnerabilities privately
to [support@couchside.tv](mailto:support@couchside.tv), without posting live keys.

For device-affecting work, arrange a focused check on the affected hardware before
release. Record the exact app and agent builds used. Keep publication, signed
artifacts and release notes as an explicit release step; a local test pass does
not mean that customers have received the change.
