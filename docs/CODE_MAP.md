# Couchside code map

This is the starting map for contributors, checked against the 2.9.75 app /
2.9.131 Linux agent baseline and the 2.9.132 release candidate identified below. Search by
symbol rather than relying on line numbers.
Update this page when ownership or a security boundary changes. Older design
notes in `docs/memory/` contain historical examples, not a current route inventory.

## Repository boundaries

| Area | Start here | Responsibility |
| --- | --- | --- |
| Phone screens | [app/app](../app/app) | Expo Router screens and navigation |
| Reusable UI | [app/components](../app/components) | Components used by screens |
| Phone services | [app/lib](../app/lib), [app/hooks](../app/hooks) | API, persisted state, drivers and lifecycle |
| Native integration | [app/modules](../app/modules), [app/plugins](../app/plugins) | Platform modules and build configuration |
| Linux service | [agent/couchsided.py](../agent/couchsided.py) | API, hardware/input, discovery and box-side integrations |
| Privileged helper | [agent/couchside-helper.py](../agent/couchside-helper.py) | Allowlisted operations over a local Unix socket |
| Other platforms | [agent/win](../agent/win), [agent/mac](../agent/mac) | Platform-specific service implementations |
| Decky | Separate `emerytech/couchside-decky` repository; [release notification](../.github/workflows/notify-decky.yml) | Steam Game Mode plugin; not a directory in this checkout |
| Protocol | [protocol/protocol.json](../protocol/protocol.json) | Shared contract; check parity when changing it |
| Delivery | [install.sh](../install.sh), [workflows](../.github/workflows) | Installation, tests and signed release artifacts |
| Regression tests | [tests](../tests), [app/lib/__tests__](../app/lib/__tests__) | Agent and phone behavior checks |

## Follow a request

For phone-to-box calls, start with `app/lib/api.ts`, then `boxTransport.ts`.
Pinned native TLS uses `boxTls.ts` and `boxTlsConn.ts`; WebSocket transport uses
`boxWs.ts` and `boxWsConn.ts`. Pairing trust lives in `boxTlsPair.ts`. Input has a
separate lifecycle in `gamepad.ts`; a successful status request does not establish
that the input connection is healthy.

On Linux, `Handler.do_GET` and `Handler.do_POST` route requests. Check the route's
authorization **before** following it to a handler. `_authorized` handles bearer
credentials; `_authorized_image`, `_mint_ticket` and `_ticket_ok` cover scoped
native-loader tickets. WebSocket handlers check credentials before upgrading.
Discovery and pairing deliberately have separate gates and rate limits.

The user service may call `_helper_call` for a privileged operation. In the helper,
read `serve_one`, `peer_uid` and `dispatch` together: peer identity and verb/argument
validation are separate checks. Also inspect installer permissions when changing
this boundary; the helper is not the only historical privilege path.

## Find a Linux subsystem

All symbols below are in `agent/couchsided.py` unless indicated otherwise.

| Question | Entry points |
| --- | --- |
| How are config and actions selected? | `load_config`, `ACTIONS`, `LAUNCHERS`, `real_action` |
| How does pairing work? | `build_pair_url`, `pair_pin_start`, `pair_pin_check`, `Handler._is_loopback`, `Handler._host_header_is_local` |
| Where are streamed uploads written? | `Handler._handle_upload`, `_drop_dir`; tests in `test_upload.py` and `test_tls_ticket.py` |
| Who owns the virtual controller? | `UInputGamepad`, `_make_holder`, `_release_devices`, `_gamepad_keepalive_tick` |
| How do LED sequences advance? | `_validate_sequence_body`, `_seq_compute_frame`, `_seq_render`, `_seq_loop` |
| Where does the Steam library response come from? | `_steam_library_payload` |
| How does the service start and serve TLS? | `main`, `BoundedThreadingHTTPServer`, `_tls_ensure`, `_tls_start`, `_tls_supervisor` |

The unreleased 2.9.132 TLS fix defers listener negotiation to `BoundedThreadingHTTPServer` workers.
The worker cap includes incomplete handshakes; their five-second deadline is
separate from established HTTP and WebSocket read timeouts. Do not move a blocking
handshake into `accept()` or `get_request()` when changing this path. See
`tests/test_tls_handshake.py` for the responsiveness and cleanup checks.

For example, from the repo root:

```sh
rg -n 'def _handle_upload|def _drop_dir' agent/couchsided.py
rg -n '/api/upload|_handle_upload' agent/couchsided.py tests app/lib
```

## Security boundaries to preserve

- Remote control is intended for the LAN; do not expose the service through a
  public port forward. The paired token represents substantial control of the
  desktop session, not just access to harmless metrics.
- Pinned API/WebSocket TLS normally uses port 8788; legacy HTTP on 8787 remains.
  Do not describe all traffic as encrypted. Existing native image/file loaders
  use short-lived tickets over HTTP: scoped authorization does **not** encrypt
  the image or uploaded file. Inspect the caller's actual transport.
- Box control has no required cloud relay. Optional integrations, app stores,
  purchases and update checks do use internet services. LAN control does not
  imply that the app never makes an internet request.
- Token-bearing local pages require both a loopback peer and a local Host header.
  Discovery, PIN pairing, image tickets and bearer API routes are different trust
  surfaces; do not copy one gate to another without checking its purpose.
- Upload names are bare filenames beneath the configured drop directory. That
  directory is trusted configuration, not a sandbox against other code running
  as the same OS user. Uploads should stage privately and commit atomically.
  The unreleased 2.9.132 private-staging fix also makes completed uploads owner-readable/writable (0600);
  another OS user needs an explicit permission change to read them.
- Keep privileged commands allowlisted and validate their arguments. Linux,
  Windows and macOS share contracts but do not have identical implementations.

## Make the structure better in small steps

First characterize a subsystem's inputs, outputs, mutable state and failure cases
with tests. Extract small helpers within the existing agent file when useful;
keep pure validation/computation separate from hardware and process effects.
For phone changes, keep network and persistence logic out of screen components.

Do not split the Linux daemon into modules as a cosmetic refactor: installers and
updates fetch a signed single-file artifact. A module split needs a signed package
format, migration, interrupted-update behavior and rollback tests first. Keep that
delivery change separate from security fixes and UI work.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, test commands and review steps.
