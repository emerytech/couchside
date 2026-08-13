# Project spec — TLS / on-wire encryption for Couchside

> Status: **🔨 P1 + P2 BUILT + DARK (2026-08-13), rest planned.** Box-side HTTPS
> listener + cert lifecycle + `/api/tls/cert` (P1, merged `ea43155`/#454), plus the
> additive availability advertisement (P2, branch `feat/agent-tls-p2`): `/api/ping`
> + the UDP discovery reply + `build_pair_url` gain `tls_*` fields **only when TLS is
> enabled** — dark payloads stay byte-identical. Dark by default, tested
> (`tests/test_tls_cert.py`, `tests/test_tls_smoke.py`, `tests/test_tls_advertise.py`).
> README port-forward warning shipped. **App-track device spike DONE (2026-08-13, iOS+
> Android): `{ca}` pinning is unreliable (dead on iOS); the cross-platform path is a
> MANUAL modulus pin via `getPeerCertificate` — see §2. P3/P5 unblocked, NOT yet built.**
> Grounded 2026-08-13 by a 5-agent investigation (app transport inventory, agent
> server surface, protocol/caps/tests impact, trust-model panel, cert-lifecycle
> panel). Every file:line below was read, not guessed.
>
> **P1 as-built notes:** cert shape = RSA-2048, `CA:FALSE` + `serverAuth` (the
> `CA:TRUE`-vs-`CA:FALSE` question is now MOOT — the spike proved the app pins by
> modulus, which ignores `basicConstraints`; keep `CA:FALSE`). `--tls` flag force-enables with an ephemeral (non-persisted)
> cert for CI; real enablement is config-driven and persists. `/api/tls/cert` is
> PRE-AUTH (cert is public). No cap added (Decision A held).
>
> Origin: a public critique ("everything unencrypted, anyone on your home network
> can hijack it") — a fair hit. Today the bearer token rides cleartext HTTP headers
> and `ws://…?token=` query strings on the LAN. This spec closes that.

---

## 0. The two load-bearing decisions (settled)

**Decision A — TLS is a transport concern, NOT a capability.**
Do **not** add a `tls`/`secure`/`https` key to `protocol.json`, the CAPS dict, or
`BoxCaps`. Caps are read *over* the transport (auth-gated `GET /api/status`,
`app/lib/api.ts:578`), so a cap can never decide whether the *first* connection is
`http` vs `https` — chicken-and-egg. Scheme selection must be signalled on the one
**pre-auth** surface (`/api/ping` + UDP discovery + pair link). A `capabilities.tls`
flag would add the six-edit-site drift + harness churn + CI parity surface and solve
nothing the transport layer doesn't already own. Skip it. (If a *post-connect
informational* cap is ever wanted, the six sites are catalogued in §7 and
`tests/test_protocol_parity.py` keeps them honest — but it's drift, not need.)

**Decision B — dual-listen, never flip.**
Keep the plaintext listener on **8787 forever**. Every app already in the wild
hardcodes `http://`/`ws://` (§2). Add HTTPS/WSS on a **second listener, second port**,
as its own daemon thread sharing the same `Handler`, token, and CAPS. Additive,
opt-in, negotiated. A TLS-only flip of 8787 bricks every installed app — non-negotiable
per CLAUDE.md §4 "never change existing API response shapes / old apps must keep working."

---

## 1. Current state (grounded)

### Box agent (`agent/couchsided.py`, pure stdlib, single file)
- `import ssl` already present (`:29`); `from http.server import … ThreadingHTTPServer` (`:40`).
- **Plaintext server**: `BoundedThreadingHTTPServer((args.host, port), Handler)` (`:20365`)
  → `serve_forever()` (`:20388`). Class at `:20255` overrides only the connection-cap
  hooks, not `get_request`/`server_bind` — so `get_request()` is the inherited
  `self.socket.accept()`.
- **Hand-rolled WebSocket** rides the SAME socket: upgrade writes `101` via
  `self.connection.sendall` (gamepad `:19466`, screen `:19505`, +2 more `:19650/:19758`);
  the entire frame loop uses `self.connection` (`_gamepad_session` `:19885`).
  → **Wrapping the listener socket in TLS gives HTTP + WS-upgrade + frame-loop WSS for
  free**, because `self.connection` becomes the accepted `SSLSocket`. No per-handler change.
- **Existing self-signed cert precedent**: `_atv_generate_cert` (`:10587`) shells
  `openssl req -x509 -newkey rsa:2048 -nodes …` (argv `:10593`); `_atv_write_cert`
  (`:10607`) materializes PEM → temp files (`load_cert_chain` needs paths), key `chmod 0600`.
  **This is a CLIENT cert today** (talks TO smart TVs); it proves the mint/store/wrap
  pattern, not the server intent.
- **Cert-in-config precedent**: the ATV block persists `{host,cert,key}` PEM *inside*
  config.json, round-tripped at `:509`. Storing a server cert+key the same way is
  established, not new.
- **Ownership**: agent runs as `User=__USER__` (`agent/couchside.service:36`), NOT root.
  It **cannot write into root-owned `/etc/couchside/`**. Agent-mutated config lives at
  **`/var/lib/couchside/config.json`** (user-owned dir `chmod 700`, file `chmod 600`,
  `install.sh:134,983-985,1088-1089`). Token at `/etc/couchside/token` (root dir,
  chowned to user).
- **Discovery advertises no scheme, no TLS port**: UDP reply
  `{couchside,name,host,port,version}` (`:17152`); `GET /api/ping` (pre-auth, `:17611`)
  → `{ok,app,version,ip,host}` (`:17626`). Both carry `version` (so new apps can gate).
- **Pair link**: `build_pair_url` (`:16879`) →
  `https://couchside.tv/pair#host=&port=&token=&ip=` — box params ride the URL **fragment**;
  that `port` is the plaintext port.
- **openssl**: assumed present on the cert path (no fallback there); installer treats it
  as preferred-but-optional (token gen falls back to `secrets`). Degrade-closed: no openssl
  → leave HTTPS listener down, plaintext unaffected.

### App (Expo SDK 57 / RN 0.86, managed workflow — no `ios/`/`android/` dirs)
- **Scheme hardcoded at ~11 box call sites**: `baseUrl()` `http://` (`api.ts:1216`);
  explicit `http://` at `api.ts:1362` (media art), `:1393` (screen frame), `:1638`
  (unauth PIN pairing); `SettingsContext.tsx:313` + `boxDiscovery.ts:94` (ping/sweep);
  `<Image>` steam cover `api.ts:2045`; `ws://` gamepad `gamepad.ts:980`, screen
  `screenstream.ts:96`, and **in-WebView** H.264 `H264DecoderView.tsx:139`.
- **iOS ATS** (`app.json:11-24`): only `NSAllowsLocalNetworking:true` — permits
  *cleartext* to LAN IPs; does **nothing** to trust a self-signed HTTPS cert.
- **Android** (`app.json:53-60`, via `expo-build-properties`):
  `usesCleartextTraffic:true`; **no `network_security_config.xml`, no trust anchor.**
- **Native modules present**: `react-native-tcp-socket ^6.4.2` (the ONLY self-signed-TLS-
  capable transport, used today only for TV control in `app/lib/tvdirect/`),
  `react-native-webview 13.16.1`, `node-forge ^1.3.1`, `expo-build-properties`.
  Absent: `react-native-ssl-pinning`, `react-native-webrtc` (stripped on RN 0.86).
- **Stored box identity** (`Box`, `settings.ts:26-66`): `{id,name,host,port,token,
  padMode,lastIp?,mac?,volumeTarget?,caps?,lastSeen?}` — **no `secure`/`scheme`/cert-pin
  field.** Room to add cleanly (the `mac`/`caps` additions are the reference; a plain
  `Box` field does NOT trigger the six-edit-site rule — that's `BoxCaps`-only).
- **`PairLink`** (`pairLink.ts:115-121`): `{host,port,token,ip?}` — no scheme/fingerprint.

### THE WALL (why this is hard)
RN's `fetch()`, WHATWG `WebSocket`, `<Image src>`, and `WebView` all delegate TLS trust
to the platform and expose **no per-request `rejectUnauthorized`, no CA pin, no
cert-challenge callback.** A self-signed cert on a bare LAN IP fails the platform trust
evaluation with **no seam to override it** — this is the absence of an API, not a config
gap. `NSAllowsArbitraryLoads` only relaxes cleartext + TLS-quality floor; it does **not**
disable X.509 server-trust (self-signed `https://` still fails). Android needs a
build-time `network-security-config` trust anchor — but the cert is **per-box, minted at
install**, so there's nothing to bake. The app's ONE self-signed-capable transport
(`react-native-tcp-socket.connectTLS`) cannot back `fetch`/`WebSocket`/`<Image>`/`WebView`.

---

## 2. Trust model — the crux (RESOLVED by device spike 2026-08-13)

> **✅ SPIKE RESULT — iOS + Android, RN 0.86, real hardware (iPhone iOS 27 + Razr).**
> The original plan (pin with `{ca}` and let the TLS stack enforce it) is **WRONG on
> iOS.** react-native-tcp-socket's iOS side flips to manual-accept-all the moment a `ca`
> is present, so `{ca}` — *even with `rejectUnauthorized:true`* — accepts **any** cert,
> including an unrelated DECOY. Android is the OPPOSITE: `{ca, rejectUnauthorized:true}`
> DOES enforce (decoy rejected, `CertPathValidatorException: Trust anchor not found`).
> The one mechanism that works on **BOTH** is a **MANUAL modulus pin**: connect accept-
> all, then read the live cert via `getPeerCertificate()` and compare its RSA **modulus**
> to the pinned box modulus. Proven to accept the right cert and reject the decoy on both
> platforms. **⇒ ADOPT the manual modulus pin as the single cross-platform path.**
> (Spike branch `spike/tls-app-device`, screen `app/app/tls-spike.tsx`, throwaway.)

**Route all RN-side box traffic through `react-native-tcp-socket` over TLS. Connect
accept-all (encrypt), then AUTHENTICATE by reading the live peer cert's RSA modulus via
`getPeerCertificate()` and comparing it to the modulus of the cert pinned at pairing** —
whose integrity is anchored to the SHA-256 fingerprint shown in the pairing QR. Mismatch =
destroy the socket. Over the verified socket, hand-roll an HTTP/1.1 client (replaces
`fetch`) and an RFC6455 client (replaces `new WebSocket`), mirroring the agent's own
hand-rolled HTTP server + WS upgrade over one socket.

**Pin the modulus (RSA public key), NOT the whole-cert DER:** the agent reuses its key
across IP-drift re-signs, so the modulus is STABLE while the cert fp changes — the same
property `tls_spki` advertises. Belt-and-suspenders: ALSO pass `{ca, rejectUnauthorized:
true}` so Android enforces natively for free (iOS ignores it); the manual modulus compare
is the load-bearing check on both.

Why this and not the alternatives:

| Option | iOS | Android | Trust | Verdict |
|---|---|---|---|---|
| **A. rn-tcp-socket, accept-all + MANUAL modulus pin (getPeerCertificate)** | ✅ proven | ✅ proven | pinning (physical-access anchor) | **ADOPT** |
| A′. rn-tcp-socket `{ca}`, trust the TLS stack to enforce | ❌ accepts any cert | ✅ enforces | — | **REJECTED on iOS by spike** |
| B. `NSAllowsArbitraryLoads` / cleartext flags | ❌ | ❌ | none — does NOT trust bad certs | reject |
| C. Local CA / user installs a profile (mkcert) | ⚠️ brutal | ❌ (Android 7+ ignores user CAs) | CA install | reject (friction) |
| D. `react-native-ssl-pinning` for fetch | ⚠️ | ⚠️ | pinning, **fetch only** (no WS) | reject (redundant, no WS) |
| E. app-layer crypto (Noise/WireGuard) / token-only wrap | — | — | mixed | reject the crypto (stdlib has no X25519/ChaCha). **Keep the stream ticket idea (§4).** |

### The pairing sequence (the trust anchor)
```
1. Install:  box mints self-signed cert (SAN=IP + .local), stores PEM,
             computes fp = SHA-256(DER) and spki = SHA-256(SPKI).
2. Pair QR:  https://couchside.tv/pair#host=&port=8787&token=&ip=&tlsport=N&fp=<hex>
             (fp is shown ON THE BOX'S OWN SCREEN — the physical-access anchor)
3. App:      read fp from QR (trusted channel)
             GET http://box:8787/api/tls/cert  -> PEM         (plaintext, convenient)
             assert SHA-256(PEM) == fp                        (detects a swapped PEM)
             store { secure:true, tlsPort:N, certPin:PEM, pinModulus:<hex> } on the Box
4. Connect:  TcpSocket.connectTLS({ host, port:tlsPort, ...acceptAll })  (encrypt only)
             getPeerCertificate() -> live modulus (retry ~150ms; fires before TLS finish)
             assert normalize(liveModulus) == pinModulus  else DESTROY socket   <-- THE PIN
             hand-rolled HTTP/1.1 + RFC6455 ride this VERIFIED socket
```
The trust root is **physical possession of the box at pairing** (you read the fingerprint
off its screen), not trust-on-first-use over a hostile wire. The plaintext PEM fetch is
*not* trusted — its integrity is proven by the QR fingerprint; the modulus is then derived
from that verified PEM. After pairing, the modulus compare means an active MITM presenting
any other cert is rejected in JS before a byte of app data is sent. Confidentiality **and**
authenticity against a hostile LAN — the property `{ca}` quietly FAILS to deliver on iOS.

### react-native-tcp-socket TLS truths (spike-verified — supersedes [[rn-tcp-socket-tls-truth]])
- `rejectUnauthorized`/`ca` are **missing from the TS types** but read by native code. Pass
  via a loosely-typed options object (as `app/lib/tvdirect/atvnative.ts:72` does).
- **`{ca}` is NOT reliable pinning.** iOS: `ios/TcpSocketClient.m startTLS:` sets manual-
  trust and `completionHandler(YES)` unconditionally when a ca is supplied → accepts every
  cert (spike case 3). Android DOES enforce ca (spike case 3 → CertPathValidatorException).
  `{rejectUnauthorized:true}` with **no** ca rejects self-signed on both (iOS −9807 SSL,
  Android CertPath) — so the platform trust layer is active, just not steerable by `{ca}` on
  iOS.
- **`getPeerCertificate()` is the PRIMARY pin mechanism (not a fallback).** It reliably
  returns `{modulus,pubkey}` on BOTH platforms after a short retry (`secureConnect` fires
  before native TLS finishes — poll ~150ms). Compare the RSA **modulus** (normalize: strip
  `0x`/colons, lowercase, drop a leading DER sign byte) — a public-key pin, stable across
  cert re-signs.

---

## 3. Box-side design (cert lifecycle + dual-listen)

### Cert mint (SERVER variant of `_atv_generate_cert`)
Lazy at startup, only when `config.tls.enabled`. Shell to `openssl`; if absent, log +
leave HTTPS down (degrade closed). Three deliberate changes vs the ATV client cert:
real SANs (IP + `.local` + hostname), leaf shape, `serverAuth` EKU.

```python
argv = ["openssl","req","-x509","-newkey","rsa:2048","-keyout",kp,"-out",cp,
        "-days","3650","-nodes","-subj","/CN=couchside",
        "-addext","subjectAltName=IP:<lan-ip>,DNS:<host>.local,DNS:<host>,"
                  "DNS:couchside,DNS:localhost,IP:127.0.0.1",
        "-addext","basicConstraints=CA:FALSE",            # ⚠ SPIKE — see below
        "-addext","keyUsage=digitalSignature,keyEncipherment",
        "-addext","extendedKeyUsage=serverAuth"]
# re-sign path: argv[3:6] = ["-key", existing_key_path]  # reuse key → SPKI stable
```
> **✅ RESOLVED by the device spike (2026-08-13): `basicConstraints` is MOOT — keep the
> current `CA:FALSE`+`serverAuth` leaf.** The debate assumed `{ca}` validation, but the
> spike proved we do NOT rely on it (iOS accepts any cert with a `ca` present). The app
> pins by comparing the live cert's RSA **modulus** (`getPeerCertificate`), which never
> consults `basicConstraints` — so `CA:FALSE` vs `CA:TRUE` makes no difference. No agent
> cert change needed.

Fingerprints are **pure stdlib** (no openssl needed to compute):
`hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert_pem)).hexdigest()`. **SPKI hash** (stable
across IP-drift re-signs when the key is reused) is the **recommended app pin**; full-cert
`fp` is exposed too for display/debug.

### Storage — user-owned state, never `/etc`
New top-level section in `/var/lib/couchside/config.json`, written by the existing atomic
writer `_write_config_atomic` (`:655`), parsed alongside the ATV block in `load_config`
(`:588`). Key `chmod 0600`. Never git, never `/etc`, never world-readable.
```json
"tls": { "enabled": false, "port": 8788,
         "cert": "-----BEGIN CERTIFICATE-----…", "key": "-----BEGIN PRIVATE KEY-----…",
         "sans": ["IP:10.1.1.235","DNS:box.local","DNS:localhost","IP:127.0.0.1"],
         "fp": "…sha256(DER)…", "spki": "…sha256(SPKI)…" }
```

### IP-drift rotation (subnet moves — home 10.1 ↔ work 10.7 per box inventory)
At startup compute desired SANs from live IP+hostname. If a new IP appeared,
**re-sign REUSING the stored key** → new cert covers the new IP, `spki` unchanged, `fp`
changes. Keep old IPs in the SAN set (avoid thrash on ping-pong). **Pin on SPKI** so the
app's pin survives every subnet move silently; only a lost/reset key rotates SPKI, which
surfaces as an SSH-style "box identity changed — re-confirm" prompt.

### Dual-listen seam (main(), between `:20365` and `:20388`)
```python
server = BoundedThreadingHTTPServer((args.host, port), Handler)   # plaintext, unchanged
if TLS_ENABLED and _tls_ready():
    cp, kp = _tls_materialize()                        # PEM -> temp files, key 0600
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cp, kp)
    tls_srv = BoundedThreadingHTTPServer((args.host, CONFIG_TLS_PORT or port+1), Handler)
    tls_srv.socket = ctx.wrap_socket(tls_srv.socket, server_side=True)
    threading.Thread(target=tls_srv.serve_forever, daemon=True).start()
server.serve_forever()                                 # plaintext stays primary
```
Same `Handler`/token/CAPS — no state duplication. **Landmine (bounded):** default
`wrap_socket` does the handshake inside `accept()` on the TLS listener's own thread; a
stalled/malicious handshake blocks only the TLS accept loop, not plaintext. Deferred-
handshake hardening (`do_handshake_on_connect=False` via `get_request`/`finish_request`
override) is a later ticket, noted-not-done.

### Advertisement — additive only (never repurpose `port`)
Present **only when TLS enabled**:
- `GET /api/ping` (`:17626`) → add `tls_port`, `tls_fp`, `tls_spki`. Existing keys untouched.
- UDP reply (`:17152`) → same three. Existing keys untouched.
- `/pair` page + `build_pair_url` fragment (`:16879`) → add `&tlsport=<n>&fp=<hex>`.
Old apps ignore unknown keys; new apps gate on presence of `tls_port`.

**BUILT (P2, `feat/agent-tls-p2`).** `TLS_ADVERT` module global (`{port,fp,spki}` or None)
is set by `main()` right after `_tls_start`; `_discovery_reply()` and `build_pair_url()`
read it, `/api/ping` reads the equivalent `Handler.tls_info`. The QR carries `fp` = the
**DER cert fingerprint** (`_tls_fp`, the same value `/api/tls/cert` returns and the P1
smoke test pins), NOT the SPKI — resolves the earlier `fp=<spki>` line here: the QR fp is a
pairing-time integrity check on the fetched PEM (`SHA-256(PEM)==fp`), and the box re-fetches
the PEM on any re-sign, so the *stable* SPKI pin is not needed in the one-shot QR. `spki` is
still advertised on `/api/ping` + UDP for an app that wants the stable pin. Additive control
proven in `test_tls_advertise.py` (dark == legacy bytes; enabled adds only `tls_*`) AND live
(agent `--tls` vs not: ping + UDP round-trip, both states).

### New endpoint
`GET /api/tls/cert` → PEM text (cert is public by nature; can be pre-auth). Needs the
standard happy-path / auth / unknown-input tests (CLAUDE.md §6).

---

## 4. The four transport planes

| Plane | Today | Under TLS |
|---|---|---|
| JSON API + upload (`fetch`) | `http://` | Pinned TLS via rn-tcp-socket + hand-rolled HTTP/1.1. Token only on TLS. |
| Gamepad WS | `ws://` | Pinned TLS + RFC6455 client. **Latency-sensitive → spike (safety-critical input path).** |
| Screen MJPEG WS | `ws://` | Pinned TLS + RFC6455 client (RN-side, so it can move). |
| `<Image>` steam cover | `http://…?token=` | Fetch bytes over the pinned socket → hand `<Image>` a `data:` URI (art frames already do this). Token off the wire. |
| **H.264 WebView WS** | `ws://` in WebView, `baseUrl:'http://localhost/'` | **EXCEPTION — no cert-override hook inside a WebView.** See below. |

**The H.264 WebView is the sharpest blocker.** `H264DecoderView.tsx:159` deliberately
sets `baseUrl:'http://localhost/'` because `http://localhost` is a secure context (so
`VideoDecoder` exists) AND, unlike `https://localhost`, lets an http-origin page open a
plain `ws://` with no mixed-content block. Moving the in-page `new WebSocket` to
`wss://<self-signed>` fails cert validation with **no bypass** (WKWebView has no WebSocket
cert override; `react-native-webview` wires no `onReceivedSslError` accept path).
- **Phase 1 (ship):** keep plaintext `ws://` but swap the URL's long-lived `token` for a
  **single-use stream ticket** minted over the pinned control channel. The durable secret
  never rides cleartext; pixels stay cleartext on the LAN as a **disclosed residual.**
- **Phase 2 (optional):** bridge decoded frames from an RN-side pinned socket into the
  WebView via `postMessage` (page opens no socket; localhost secure-context trick still
  holds) — **only if a throughput spike proves it keeps the "verified smooth" framerate.**

> Token also rides the WS query string on gamepad/screen/h264 today — so token exposure
> isn't fully closed until those endpoints move to TLS (or the token moves out of the
> query into a WS subprotocol). Tracked as a P5+ follow-up.

---

## 5. Phased plan

P1–P4 are **box-side, backward-compatible, shippable today.** P1–P3 ship **DARK**
(`tls.enabled=false`; app persists fields but still connects `http`). P4 is user opt-in.
The single **flip (P5)** is app-side and **GATED** on the RN self-signed-trust app-track.

| Phase | Ships | Default | Lands | Tests (CLAUDE.md §6) |
|---|---|---|---|---|
| **P1** cert lifecycle + dual-listen | agent | dark | `_tls_generate_server_cert`, config `tls` section, SPKI/fp compute, IP-drift re-sign (key reused), 2nd SSL-wrapped listener gated by flag | cert-gen unit (SANs/fp/spki/key-0600); **re-sign-on-IP-change unit** (spki stable, fp changes); **https smoke** (`curl -k` ping-200 / no-token-401 / token-200 on the encrypted listener); **plaintext smoke stays green** |
| **P2** additive advertisement ✅ BUILT | agent | dark | `/api/ping` + UDP + `build_pair_url` gain `tls_*` (only when enabled); `TLS_ADVERT` global + `_discovery_reply()` helper | ✅ `test_tls_advertise.py`: additive-shape control (TLS-off == legacy bytes; TLS-on adds only `tls_*`) on all 3 surfaces + degrade-closed (advert without port → nothing); parity unchanged (no cap) |
| **P3** app reads/persists (dark) | app | dark (`http`) | `Box`/`Settings`/`PairLink` gain `secure`/`tlsPort`/`fp`/**`pinModulus`** (derived from the verified PEM at pairing); `normalizeBox` round-trips; pair parser reads `tlsport`/`fp` fragment keys | **harness: press Connect/pair**, assert fields persist AND app still reaches `--mock` over http (render ≠ test) |
| **P4** installer/opt-in enable | agent/installer | user opt-in | `couchside tls on` sets `enabled=true`, mints, starts HTTPS listener | boot `enabled:true` mock: both listeners serve; both triads pass in one run |
| **P5** app flip (GATED) | app | flip-on when pinned | app prefers the pinned TLS transport (connect accept-all → **modulus compare** → hand-rolled HTTP/1.1 + RFC6455) when box advertises `tls_port`; **http fallback never removed** | harness vs TLS mock; **modulus-mismatch surfaced + socket destroyed**, not silently trusted; on-device pin accept+reject proof (§2 spike) |

**P5 hard dependency (stated, not hand-waved):** the RN trust wall (§1). P5 needs a
separate app-track deliverable — the hand-rolled HTTP/1.1 + RFC6455 clients over
`react-native-tcp-socket`, `{ca}` pinning. The box side (P1–P4) is fully valuable without
it: the day the app-track lands, P5 is a scheme flip with pin data already persisted.

---

## 6. Threat model — honest

**TLS fixes:** passive token theft on the LAN (today the Bearer token is cleartext in
headers and `ws://…?token=` — a promiscuous roommate device / compromised switch/AP /
Wireshark reads it and owns the box); replay of a sniffed token; passive capture of screen
frames + gamepad/trackpad input + media metadata; active tampering after the handshake.

**TLS does NOT fix:** (a) an active MITM on the **very first pairing**, before any
fingerprint is pinned — the intrinsic TOFU gap; mitigated because the fingerprint travels
the same channel as the token (the `/pair` QR/PIN on the box's own screen), and an attacker
who can subvert *that* already has physical/screen access, at which point TLS is moot;
after first pin, SPKI pinning detects any later substitution (SSH host-key model).
(b) **Authorization** — TLS is confidentiality/integrity, not a second factor; the single
bearer token is still the gate. (c) **Identity beyond TOFU** — no CA, no revocation.

**Why self-signed-without-CA is correct (not a compromise):** no public CA will issue for
RFC1918 IPs or `.local` names — there is no authority for private addresses. A private CA
on a consumer box is heavier, adds a root-key liability, and is **no more trustworthy**
than TOFU here, because the real trust root is physical possession of the box at pairing.
This is exactly the SSH model, the accepted norm for this problem.

**README port-forward warning (drop-in):**
> ⚠️ **Do not port-forward Couchside to the internet.** Couchside is built for a trusted
> home LAN. Its TLS (agent X.Y+) encrypts traffic so nobody on your local network can read
> your access token — but the certificate is **self-signed and trusted on first use** (like
> SSH), not backed by a public certificate authority. That is safe on a LAN you control,
> where you confirm the box's fingerprint by reading it off the box's own screen while
> pairing. It is **not** safe to expose publicly: a single bearer token is the only gate,
> there is no account to lock and no cloud tier to revoke, and anyone who can reach the port
> can attempt to pair. For remote access use a VPN or Tailscale/WireGuard back to your home
> network — **never** a router port-forward.

(Independently: add this warning to the agent README NOW, decoupled from TLS — the critic
was right that it's a gap, and it's a one-paragraph doc fix.)

---

## 7. If a `tls` cap is ever wanted anyway (six sites, for reference)
Decision A says don't. But if a post-connect informational cap is later desired, the sites
are: agent CAPS dict (`couchsided.py:~1635`) + mock tuple (`~1580`); app `BoxCaps`
(`api.ts:81`) + `normalizeCaps` (`settings.ts:~311`, both the `const` AND the return
object — the classic silent miss) + `capsEqual` (`api.ts:~1276`); `protocol.json` `keys[]`
cross-platform group (`:164-174`). `tests/test_protocol_parity.py` auto-enforces all six.

## 8. Spikes-before-trust (nothing here is settled by reading code)
1. **`{ca: <self-signed cert>}` actually validates the box peer** on iOS + Android, RN 0.86
   — and resolves the `CA:TRUE` vs `CA:FALSE` question (§3). Fallback: `getPeerCertificate`
   key-pin.
2. **Hand-rolled RFC6455 client latency on the gamepad path** matches native `WebSocket`
   (safety-critical, most-concurrent code → create→hold→hand-off→reap lifecycle test, not
   a happy-path demo).
3. **`getPeerCertificate` fallback** reliably returns the cert on both platforms after the
   polling fix (prove before depending on it).
4. **H.264 frame-bridge throughput** (Phase 2 only) — `postMessage` bitstream into the
   WebView at the marquee framerate without regressing "verified smooth."
5. **QR density** — pair link + `fp` (or inline PEM ~500B) scans reliably full-screen off the box.
6. **Agent handshake-on-accept serialization** under concurrent-connect load; defer-to-worker if it stalls.

Per CLAUDE.md §11: the PR body states each of these as NOT-yet-verified. No "should work."

## 9. Effort (rough)
Agent P1–P2: ~1–2 days (mostly precedent). App track (P3 + the hand-rolled HTTP/1.1 +
RFC6455 clients for P5): ~1–2 weeks incl. spikes. The README port-forward warning: minutes,
ship it independently now.

## Related memory
[[rn-tcp-socket-tls-truth]] · [[native-serverTrust-tv-unlock]] · [[h264-tier-webcodecs-not-webrtc]]
· [[remote-desktop-and-screen-capture]] · [[security-audit-status]] · [[androidtv-app-direct-proven]]
