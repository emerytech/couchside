# Remote-only mode — Couchside as just a TV remote (no box)

**Owner ask (2026-08-04):** "add a remote only feature for users that dont have a gaming
computer they can setup their smart tv only … basically a way to toggle remote only mode so
its just a tv remote app."

**Prior decision this builds on (2026-07-17, confirmed):** build the AGENTLESS architecture
(app → TV directly), ship it FIRST behind the CURRENT paywall (7-day trial + one-time
unlock, unchanged), and defer the "free tier" flip to a later, separate, reversible
decision. "Agentless" and "free" are independent axes; this project is the agentless axis
only. See the freemium-split analysis in the maintainer's session memory.

---

## 1. Why this is net-new architecture, not a re-mount

Today **all TV control is agent-mediated**: the app's eleven `api.ts` `tv*` calls go to the
box's agent, and every credential (webOS client_key, Samsung token, Roku host) persists in
`/etc/couchside/config.json` **on the box** (`SmartTvSetup.tsx:86-91` states the model).
`SmartTvSetup` is only mountable inside a paired box's edit panel. A user with no box has
no agent, no config store, no `api.tv` — so remote-only mode needs:

- an app-side **TV device store** (a TV cannot be a `Box`: `normalizeBox` drops hostless
  entries, and every Box consumer polls `/api/status`, opens `/ws/gamepad`, syncs caps —
  pointing all of that at a TV's IP would be a bug farm);
- an app-side **direct transport** per brand;
- a **mode shell**: the toggle, the tab set, the TV-only setup path.

## 2. Transport feasibility ladder (recon 2026-08-04, sourced)

| Brand | Transport | App-direct feasibility |
|---|---|---|
| **Roku** | plain HTTP ECP :8060, no auth, no pairing, reachable in standby | **TRIVIAL — plain `fetch`, zero native modules. Phase 1.** |
| LG webOS | SSAP JSON over **wss:3001, self-signed cert** | Needs `react-native-tcp-socket` (v6.4.2, maintained). **No `rejectUnauthorized:false` exists** — self-signed certs are accepted only by PINNING via `ca`. TOFU bootstrap problem: the peer cert is only readable AFTER a trusted handshake (`getPeerCertificate()`), so obtaining the cert to pin needs an out-of-band step. **Spike required before promising.** |
| Samsung Tizen | wss:8002 `samsung.remote.control`, token on first Allow | Same TLS wall as webOS. Older sets accept plaintext ws:8001 (token support there unverified). Pre-2016 sets unsupported regardless (KI-007). |
| Google TV / Android TV | protobuf over TLS **with client cert (mTLS)**, 6-digit PIN pairing | Hardest. `react-native-tcp-socket` DOES support client certs (key/cert PEM); prior art: `vricosti/react-native-androidtv-remote` (on that stack, low-maintenance), `kud/androidtv-remote` (Node, protocol reference). Own protobuf codec needed (the agent's `_atv_*` hand-rolled codec is the porting source). |
| VIDAA (Hisense) | MQTT 3.1.1 over TLS :36669, default broker creds | Same raw-TLS need; agent's hand-rolled MQTT is the porting source. Newer sets need a 4-digit authorize we never built. |

RN's built-in WebSocket **cannot** skip TLS validation on either platform (options accept
only `headers`; facebook/react-native #30341 closed stale) — so LG/Samsung can never ride
the stock WS client against wss with a self-signed cert.

**Native-module cost:** the app is CNG/prebuild (no committed ios/android dirs) and already
ships native modules incl. `react-native-udp` — adding `react-native-tcp-socket` is the
same class of change (autolinks, no config plugin, NOT runnable in Expo Go; metro
`assetExts` += pem/p12 only if certs ship as assets). `expo-dev-client` is NOT currently
installed; on-device iteration for Phase 2 needs it (or TestFlight builds).

## 3. Phases

### Phase 1 — mode shell + Roku direct (NO native work) ← built first
- `app/lib/tvdirect/model.ts` — `DirectTv {id,name,brand,host}`, normalize (LAN-IP-only
  hosts via `lanIp.ts` — the KI-033 corpus applies), `couchside.tvs.v1` store shape.
- `app/lib/tvdirect/roku.ts` — ECP client mirroring the agent tables VERBATIM
  (`_ROKU_KEYS` `couchsided.py:8759`, `_ROKU_OP_KEY` `:8752`): `POST /keypress/<Key>`
  empty body, 4s timeout, 403 → `roku_control_disabled` hint (same copy as
  `RemoteView.tsx:213`), per-char `Lit_<pct>` text, `GET /query/device-info` identify.
  Import-free → bare-Node testable (CI `app-input` glob).
- `app/lib/tvdirect/store.ts` — persisted TV list + active id, prefs.ts external-store
  pattern.
- `remoteOnlyMode` pref (prefs.ts, 3 edits) — the toggle.
- New `remote` tab (`app/app/(tabs)/remote.tsx`), visible only in remote-only mode;
  box tabs `href: null` in that mode; cold-start redirect → remote (or setup when no TV).
  Content wrapped in `<Gated>` — the 2026-07-17 "current paywall first" decision.
- `DirectRemoteView` composing the pieces EXPORTED from `RemoteView.tsx` (Dpad, Rocker,
  CornerBtn, MidBtn — export-only change, box path untouched).
- `DirectTvSetup` card in Setup: brand (Roku now; others listed as needs-a-box), IP,
  TEST (identify) → ADD; TV list; the mode switch. Auto-enables remote-only mode when a
  TV is added to an empty fleet.
- **Honesty constraint:** no Roku hardware is owned. Verified against a stub ECP server
  (same method as the agent's Roku backend) + the harness pressing every control. Store
  copy must not claim Roku until a real set confirms — same lockstep rule as the agent
  backends (marketing-expansion memory).

### Phase 2 — LG webOS + Samsung direct (the native step)
- Add `react-native-tcp-socket`; hand-rolled WS client over its TLS socket (the agent's
  `_WebOSWS` is the porting source; same SSAP register manifest byte-verbatim).
- **THE blocker to spike first: self-signed acceptance.** Options, in test order:
  (a) pin a leaf self-signed cert via `ca` — UNVERIFIED that iOS accepts a leaf (issue
  #190 history suggests platform quirks); (b) TOFU via a first plain-TCP fetch of the cert
  — needs a handshake path that yields the cert without trust (may not exist in the lib);
  (c) upstream PR/patch-package for an insecure-accept option; (d) Samsung-only fallback
  ws:8001 plaintext where it still works. Spike on the OWNED LG (home) + Samsung before
  committing to copy or store claims.
- WoL power-on from the phone: `wol.ts` already broadcasts magic packets via
  react-native-udp — **Android only; iOS blocks app UDP**, and there is no relay box in
  remote-only mode. So on iOS, webOS/Samsung power-ON stays honest-absent (button hidden,
  copy says why). Roku is unaffected (ECP PowerOn, reachable in standby).
- Pairing UX ports from `SmartTvSetup` (Allow-prompt / client_key, token persist —
  app-side SecureStore instead of agent config.json).

### Phase 3 — Google TV direct
- mTLS + protobuf port (`_atv_*` codec → TS), cert generation problem: the agent shells
  out to `openssl` — the app cannot; needs either the lib's KeyStore path or a bundled
  pure-JS keypair+self-sign (spike; `react-native-modpow` prior art for the pairing hash).
- KI-031 applies: no `source` key claim on Google TV.

### Phase 4 — discovery + polish
- SSDP (`roku:ecp`, webOS) needs UDP multicast: react-native-udp may serve on Android;
  **iOS blocks UDP and raw-multicast needs a restricted Apple entitlement** — mDNS via an
  NSNetServiceBrowser-backed module (react-native-zeroconf class) + `NSBonjourServices`
  additions is the iOS path. Until then: manual IP (works today, matches the agent-side
  "Add by IP" precedent).
- Hardware volume buttons → TV volume in remote-only mode (react-native-volume-manager is
  already a dep; the Pad tab has the pattern).
- The free-tier flip (entitlement re-gate + two-tier marketing) — SEPARATE decision,
  deliberately not here.

## 4. Interactions and traps
- **Paywall:** remote tab is `<Gated>` like every feature tab (trial → unlock). Flip-free
  later is a one-gate change by design.
- **Marketing lockstep:** "no box needed" / "universal remote" copy ONLY once a brand is
  live-verified app-direct. Currently that would be NOTHING (Roku is stub-verified).
- **iOS Local Network prompt:** first direct fetch to the TV triggers it;
  `NSLocalNetworkUsageDescription` already declared, wording currently box-specific —
  revisit when store copy changes.
- **Both-modes users:** a box owner can add TVs too, but in v1 the remote tab only shows
  in remote-only mode (box owners already have RemoteView via the agent, which is richer —
  CEC/RS-232/soft volume). Hybrid (app-direct fallback when the box is asleep) is Phase 4+.
- **Existing RemoteView Roku hint** dedupe: both surfaces alert once per session
  independently — acceptable, they cannot both be visible.

## 5. Verification ledger (update as it happens)
- 2026-08-04: recon (6-agent workflow) — transport tables read from agent source; TLS
  library research web-sourced; nothing executed against hardware yet.
- 2026-08-04: **Phase 1 BUILT and harness-verified by pressing every control** against a
  stub Roku on loopback (`127.0.0.1:8060` — loopback is a valid LAN host, so the real
  add-flow accepted it). Observed on the wire, not on screen: the ADD flow's
  `GET /query/device-info` (the TV was stored under the name the stub advertised, so the
  response was genuinely parsed), then 18 presses producing exactly
  `Up, Down, Left, Right, Select, Info, Home, Back, Info, Rev, Play, Fwd, VolumeUp,
  VolumeDown, VolumeMute, PowerOff, PowerOn` plus text as
  `Lit_a, Lit_%20, Lit_b, Lit_%26, Lit_c` — one request per press, no duplicates.
  BOTH directions of the toggle observed: on → tab bar collapses to Remote + Setup;
  off → Console/Actions/Pad/Launch return. Persistence + the bounce guard proven by
  loading `/pad` directly with the mode on and landing on the Remote. Empty state (no TV)
  and the host gate both observed — typing `8.8.8.8` left ADD TV disabled, and pressing it
  anyway sent NOTHING (stub hit count unchanged) and stored nothing.
- **HARNESS TRAP, banked:** the first ADD attempt reported "No Roku answered" while the
  stub's log showed the request had ARRIVED. Cause is browser CORS — RN's fetch has no CORS
  enforcement, the web harness's does. The stub grew an `Access-Control-Allow-Origin`
  header to get past it; **the app must never grow CORS handling for this**, and a web-only
  failure of a direct-TV call is not evidence of a product bug.
- **NOT verified, owed before any public claim:** a REAL Roku (none owned) — hint 403 path,
  standby PowerOn, and whether a real set's `device-info` matches the stub's field names;
  anything native (the paywall gate — `expo-iap` is a no-op on web so the expired state
  could not be observed; the iOS Local Network prompt on first direct fetch; row overflow
  on a device); and every non-Roku brand, which is Phase 2+.
