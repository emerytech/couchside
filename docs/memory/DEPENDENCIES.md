# DEPENDENCIES

Every meaningful dependency, its version, and why it is there. Two halves of the
product with two opposite dependency philosophies: the **app** leans on the Expo
ecosystem, the **agent** has none at all.

Source of truth: `app/package.json`, `app/app.json` (plugins),
`agent/couchsided.py`, `scripts/`. Update this file any time a dependency is
added or removed (see the checklist in `CLAUDE.md`).

---

## 1. The app — `app/package.json`

Expo SDK 57 / React Native 0.86 / React 19.2.3. Managed workflow with a
prebuilt `ios/` directory checked in.

### Core runtime

| Package | Version | Why |
|---|---|---|
| `expo` | `~57.0.1` | The SDK itself. Everything below pins to its 57.x train. |
| `react` / `react-dom` | `19.2.3` | React 19. `react-dom` is only reachable on the web target. |
| `react-native` | `0.86.0` | The runtime. New Architecture era. |

### File drop (Console tab, agent >= 2.9.54)

| Package | Version | Why |
|---|---|---|
| `expo-camera` | `~57.0.3` | `CameraView` + `useCameraPermissions` behind the in-app QR pairing scanner (`BoxScanQr`). QR-only (`barcodeTypes: ['qr']`). Registered as an `app.json` plugin with `recordAudioAndroid: false` + `microphonePermission: false` — the plugin's DEFAULTS add RECORD_AUDIO / an iOS mic string to a scanner that records nothing (verified stripped via `expo config --type introspect`). `require()`d lazily so a JS bundle on a binary without the native module hides the feature instead of crashing. Pulls `barcode-detector` (web-only transitive). |
| `expo-background-task` | `~57.0.6` (resolves 57.0.20) | OS-scheduled background wake (WorkManager on Android, BGTaskScheduler on iOS) for the opt-in **wishlist price-drop notification** (`lib/wishlistAlertTask.ts`, engagement Phase 1b). Registers a `TaskManager` task; `minimumInterval` is a FLOOR/hint, not a schedule (>=15 min Android; iOS at its own discretion), so alerts are explicitly BEST-EFFORT. iOS needs `UIBackgroundModes:[processing]` + `BGTaskSchedulerPermittedIdentifiers:[com.expo.modules.backgroundtask.processing]` (added to `app.json` infoPlist; also applied by its CNG plugin). No web runtime — a `wishlistAlertTask.web.ts` stub keeps it out of the harness bundle. |
| `expo-notifications` | `~57.0.7` (resolves 57.0.21) | LOCAL notification only (no push server, no account) when a wishlisted game drops. Permission requested on opt-in (`enableWishlistNotify`); Android channel `wishlist-drops`; immediate delivery via `trigger:{channelId}` on Android / `trigger:null` on iOS (channelId lives on the TRIGGER for immediate notifications, verified against the SDK 57 docs, NOT on content). Tap handled by `useLastNotificationResponse` → deep-links to the Play tab. Registered as an `app.json` plugin. |
| `expo-task-manager` | `~57.0.6` (resolves 57.0.20) | Defines the headless background task (`TaskManager.defineTask`, module scope, imported at the app root so it registers in both the foreground app and the headless JS context) that `expo-background-task` runs. No plugin needed. |
| `expo-document-picker` | `~57.0.1` | Native file picker behind the "Send a file to your box" card (`FileDropCard`). `copyToCacheDirectory` so the picked file is a real file:// uri the uploader can stream. |
| `expo-file-system` | `~57.0.1` | Streams the picked file to `POST /api/upload` via the SDK-57 `new File(uri).createUploadTask(..., { uploadType: UploadType.BINARY_CONTENT })` API — bytes never enter JS memory, so multi-GB games upload with live progress. **Lazy-imported** inside `lib/api.ts uploadFile()` so the web dev harness never has to load the native module. |

### Navigation / router

| Package | Version | Why |
|---|---|---|
| `expo-router` | `~57.0.2` | File-based routing and the entry point (`"main": "expo-router/entry"`). Registered as a plugin in `app.json`. Provides `Stack`/`ThemeProvider` in `app/_layout.tsx`, the imperative `router` and `useFocusEffect` in `app/(tabs)/fleet.tsx`, `useLocalSearchParams`/`useRouter` in `setup.tsx`, and the re-exported `ErrorBoundary`. `experiments.typedRoutes` is on, so routes are typechecked. |
| `react-native-screens` | `4.25.2` | Never imported directly — required peer of `expo-router`'s native stack; backs each screen with a real native view controller. |
| `react-native-safe-area-context` | `~5.7.0` | `useSafeAreaInsets` throughout the UI (`pad.tsx`, `BoxSwitcher`, `RemotePowerBar`, `Paywall`, `UnlockToast`, `ReviewToast`, and more). Load-bearing for the trackpad tab, where the touch surface must avoid the home indicator. |

### UI / presentation

| Package | Version | Why |
|---|---|---|
| `@expo/vector-icons` | `^15.0.2` | Ionicons only. Tab-bar glyphs (`app/(tabs)/_layout.tsx`) and inline icons across `actions.tsx`, `pad.tsx`, `launch.tsx`, `BoxSwitcher`, `SmartTvSetup`. |
| `expo-status-bar` | `~57.0.0` | Root `_layout.tsx` syncs native status-bar chrome to the active theme (`lib/theme.ts` defers to it rather than styling the bar itself). |
| `expo-splash-screen` | `~57.0.1` | Config plugin only, no imports. Supplies the splash image and `#0b1220` background at build time. |
| `react-native-reanimated` | `4.5.0` | Imported for side effects only — a bare `import 'react-native-reanimated'` in `app/_layout.tsx` to install the runtime. No animations authored against its API yet. |
| `react-native-worklets` | `0.10.0` | Never imported directly — mandatory peer of Reanimated 4, which moved the worklet runtime into its own package. Removing it breaks Reanimated. |
| `react-native-gesture-handler` | `3.1.0` | Was transitive (react-navigation peer); now imported DIRECTLY by `components/TrackSlider.tsx` (the LED sliders) via `Gesture.Pan().activeOffsetX(...)` to win the horizontal drag over the iOS nav-swipe. Requires `GestureHandlerRootView` at the app root (`app/_layout.tsx`) — expo-router does NOT auto-wrap it. |

### Native capability

These are the reason the product exists — each one maps to a feature that
cannot be done in JS alone.

| Package | Version | Why |
|---|---|---|
| `expo-secure-store` | `~57.0.0` | The persistence layer for everything sensitive and not: box tokens and box list (`lib/settings.ts`), user prefs (`lib/prefs.ts`), haptics toggle (`lib/haptics.ts`), theme choice (`lib/theme.ts`), keep-awake toggle (`lib/keepAwake.ts`), and the app's local error log (`lib/crashLog.ts`, 2026-09-26) — the ONE module that uses the synchronous `getItem`/`setItem` rather than the async pair, so a JS fatal is on disk before RN ends the process (Android `commit()`, iOS SecItemAdd/Update; read in the 57.0.1 module source). `settings.ts` wraps it with a `localStorage` fallback so the web target still runs. Registered as an `app.json` plugin. |
| `expo-network` | `~57.0.1` | Reads the phone's own IPv4 address in `lib/boxDiscovery.ts` so the LAN sweep knows which `/24` to scan. |
| `react-native-udp` | `^4.1.7` | UDP datagrams for Wake-on-LAN magic packets (`lib/wol.ts`) and the fast broadcast discovery probe (`lib/boxDiscovery.ts`). **Deliberately optional**: both call sites `require()` it inside a `try/catch` so a build predating the dependency degrades instead of crashing. Discovery's reliable path is the HTTP `/api/ping` sweep — iOS blocks UDP on the local network even after the permission is granted, so the UDP probe is an Android fast-path only. `boxDiscovery.ts` also has to accept either `udp.default` or the module itself, because the package does both `module.exports` and `export default`. |
| `buffer` | `^6.0.3` | Node's `Buffer` shim, not present in the RN runtime. Needed to build the raw WoL magic packet byte-for-byte (`lib/wol.ts`) and to frame discovery datagrams (`lib/boxDiscovery.ts`). |
| `expo-clipboard` | `~57.0.1` | The PASTE button on the Pad tab's keyboard bar (`app/(tabs)/pad.tsx`). iOS only offers its own paste menu on a long-press of a focused field, which is a poor fit for a remote where you are usually pasting a password or URL you have no intention of retyping. Read-only use (`getStringAsync`); the pasted text is routed through the compose field's normal change path so it diffs and sends exactly like typing. Since 2026-09-26 also WRITES (`setStringAsync`): the install command in onboarding, and the crash/diagnostics exports — Copy details on the crash screen, the next-launch crash banner, Setup › Account › App error log, and the Pad diagnostics sheet. On web it resolves `false` when the browser refuses, so callers check the boolean. |
| `expo-haptics` | `~57.0.0` | Tactile feedback on trackpad taps and button presses, wrapped in `lib/haptics.ts` behind a user-toggleable pref. |
| `react-native-volume-manager` | `^2.0.8` | `hooks/useVolumeButtons.ts` — binds the phone's physical volume rocker to the box's volume, so the phone behaves like a real remote. |
| `expo-screen-orientation` | `~57.0.0` | `hooks/useLockOrientation.ts` — pins orientation per screen (the gamepad/trackpad surfaces need a fixed frame). |
| `expo-linking` | `~57.0.1` | Deep links for pairing (`lib/DeepLink.tsx`) and outbound URL opening in `setup.tsx`. Note: `DeepLink.tsx` deliberately avoids `Linking.parse` and hand-parses instead — a documented behavior problem in expo-linking 57. |
| `expo-constants` | `~57.0.2` | App metadata in `setup.tsx`. Used *alongside* `expo-application`, not instead of it (see the warning below). |
| `expo-application` | `~57.0.2` | The correct source of the native build number, now in `lib/appVersion.ts` (moved out of `setup.tsx`; also gives `applicationId`, which tells the store app from the `.direct` edition in a crash report). There is an explicit comment there: `Constants.nativeBuildVersion` does **not** exist in SDK 57 but still typechecks via an index signature — this package is the fix. |
| `qrcode` | `^1.5.4` | Pairing QR generation. Only `QRCode.create()` is used, for its raw bit matrix — `components/QrView.tsx` draws that matrix as merged rows of `View`s, because `toDataURL`/`toString` need a browser canvas or Node `zlib`, neither of which exists in RN (this previously rendered a blank modal on-device). |
| `node-forge` | `^1.3.1` | Pure-JS crypto that runs in Hermes. Original use: TV certificate minting for app-direct Google TV / smart-TV pairing (`lib/tvdirect/*`). Added 2026-09-22: `lib/license.ts` uses `forge.pki.ed25519.verify` for offline **license-key** verification (direct off-store edition — see `docs/DIRECT_EDITION_LICENSING.md`). Keys are signed out-of-band by `scripts/make-license.mjs` using node's own `crypto` Ed25519; the two interoperate (both RFC 8032), proven by `lib/__tests__/license.test.ts` rather than assumed. |

### In-app purchase

| Package | Version | Why |
|---|---|---|
| `expo-iap` | `^4.3.6` | Direct StoreKit / Google Play Billing for the `couchpilot_unlock` entitlement. Registered as an `app.json` plugin. `lib/purchase.ts` is a deliberately no-throw wrapper that `require()`s it lazily and types only a minimal structural view of the v4 Open IAP surface — so web and any build without the native module return null instead of crashing. Given the prior App Review 2.1(b) rejection, the fail-closed behavior here is intentional. |
| `expo-store-review` | `~57.0.0` | Native rating prompt in `components/ReviewPrompt.tsx`. Lazily `require()`d, never a top-level import, for the same native-module-absent reason. |

### Web target

| Package | Version | Why |
|---|---|---|
| `react-native-web` | `~0.21.0` | `app.json` sets `web.bundler: metro`, `web.output: static`. Not imported by hand; Metro aliases `react-native` to it. There is a committed `dist/` web build and a `scripts/web-dev.sh` harness, so this path is live. |
| `@expo/metro-runtime` | `~57.0.6` | Metro's web runtime (Fast Refresh, error overlay). Required by the web target, never imported directly. |

### Dev / build

| Package | Version | Why |
|---|---|---|
| `typescript` | `~6.0.3` | Typechecking. Note the caveat below about what `tsc` does and does not prove. |
| `@types/react` | `~19.2.2` | React 19 types. |
| `@types/qrcode` | `^1.5.6` | Types for `qrcode`, which ships none. |
| `expo-build-properties` | `~57.0.2` | Config plugin, no imports. Its single job here is `android.usesCleartextTraffic: true` — the agent is plain HTTP on the LAN by design, and Android would otherwise block it. |

---

## 2. The agent — zero third-party dependencies

`agent/couchsided.py` is ~11,100 lines in **one file** with **no imports outside
the Python 3 standard library**. Same for `agent/qr.py`, `agent/win/couchsided-win.py`,
`couchside-decky/main.py`, `cec-bridge/couchside-cec-bridge.py`, and every file
in `tests/`.

`CLAUDE.md` states the rule directly: *"The agent stays pure Python 3 stdlib,
single file. No third-party imports, ever."* Treat a violation as a bug, not a
tradeoff.

### Why the constraint exists

The agent installs onto **immutable-rootfs distros** — SteamOS and Bazzite —
where the root filesystem is read-only and there is no usable `pip` story. There
is no virtualenv to activate in a systemd unit, no package manager to invoke, no
build toolchain to compile a native wheel against. What *is* guaranteed is that
`python3` is preinstalled on both. So the install path reduces to: copy one file
into `~/.local/opt`, write a systemd unit, start it. `install.sh` verifies the
download with nothing more than `python3 -m py_compile`.

The agent confines its writes to `~/.local/opt`, `/etc`, and
`/etc/systemd/system` — the three places writable on both distros.

### What the constraint forces

Every convenience library the agent cannot use has a hand-rolled replacement:

- **No `psutil`.** System metrics are read by parsing kernel interfaces
  directly: `/proc/uptime`, `/proc/meminfo`, `/proc/net/route` (to find the
  default-route interface), `/proc/net/tcp{,6}` and `/proc/net/udp{,6}`,
  `/proc/bus/input/devices` (gamepad enumeration), and `/proc/*/cmdline`
  (scanning for the Steam reaper wrapper to identify the running AppId).
  Hardware state comes from sysfs by hand: `/sys/class/hwmon/hwmon*/name` and
  `/sys/class/thermal/thermal_zone*/temp` for temperature, `/sys/class/net/<if>/`
  for MAC and wireless detection, `/sys/class/drm/` for display and connector
  status, `/sys/class/power_supply/` for battery.
- **No `websockets` / `websocket-client`.** RFC 6455 is implemented twice, by
  hand. A **server** side (`ws_try_parse` / `ws_recv_frame` / `ws_send`, no
  fragmentation support) for the phone's control socket, and a separate
  **client** side over TLS for LG WebOS TV control, which speaks the same
  framing with a different message schema — explicitly reused rather than
  pulling in a library.
- **No `vdf` parser.** Steam's VDF format has no stdlib parser, so
  `_parse_vdf_paths` extracts library paths from `libraryfolders.vdf` by string
  scanning. The same applies to `shortcuts.vdf` (screensaver registration),
  `remoteclients.vdf` (Steam Link hosts), and the multi-megabyte `appinfo.vdf`
  name cache, which is read incrementally rather than parsed whole.
- **No `evdev` / `pynput`.** Virtual input devices are created against the
  legacy uinput API using `fcntl.ioctl` plus `struct` packing. This is fragile
  enough that the code does a runtime size check rather than an `assert`
  (`struct.calcsize(_UINPUT_USER_DEV) != 1116`), specifically because `python3 -O`
  strips asserts.
- **No `pyserial`.** RS-232 control of the Newline panel opens the line raw at
  8N1 through `termios`.
- **No `requests`.** Outbound HTTP is `urllib.request` / `urllib.error`.
- **No `paho-mqtt`, no CEC bindings, no cloud SDKs.** Anything else is
  `subprocess` against a system binary that is already present.
- **No `pytest`.** `tests/*.py` are plain scripts run as `python3 tests/foo.py`,
  one CI step per file. They load the agent via `importlib.util.spec_from_file_location`
  and drive the *real* functions against temp-directory fixtures, repointing
  module constants like `_DRM_DIR`, `_POWER_SUPPLY_DIR`, and `_PROC_INPUT_DEVICES`
  rather than reimplementing logic.

### Stdlib modules it leans on hardest

Top-level imports in `couchsided.py`:

`argparse`, `base64`, `calendar`, `glob`, `hashlib`, `hmac`, `json`, `os`,
`random`, `re`, `select`, `shutil`, `socket`, `ssl`, `struct`, `subprocess`,
`sys`, `tempfile`, `termios`, `threading`, `time`, `urllib.error`,
`urllib.request`, `zlib`, plus `http.server` (`BaseHTTPRequestHandler`,
`ThreadingHTTPServer`) and `urllib.parse`.

Conditional / local imports: `fcntl` (POSIX only — uinput needs it, absent on
Windows), `math`, and a deferred `urllib.request`.

The heavy hitters, by role:

- `http.server` + `threading` — the entire API surface. `ThreadingHTTPServer`
  is the web framework.
- `socket` + `select` + `struct` — WebSocket framing, discovery datagrams,
  RS-232 and TV control.
- `subprocess` — the universal escape hatch, standing in for every library
  that would otherwise be a pip install.
- `glob` + `os` + `re` — the `/proc` and sysfs parsing layer.
- `hmac` + `hashlib` + `base64` — token auth and the WebSocket handshake accept key.
- `fcntl` + `struct` — uinput ioctls.

### Windows agent

`agent/win/couchsided-win.py` holds the same line. Instead of `pywin32` or
`pynput` it uses **`ctypes`** to call Win32 directly (`SendInput`, WTS session
queries), plus `winreg` for registry access. Its only non-stdlib-shaped import
is `qr` — the sibling `agent/qr.py`, in-repo.

### External runtime endpoints the agent talks to — Decky manager (agent 2.9.105+)

Nothing is vendored: no Decky source, no store client, no zip handling ships in
the repo. The agent is a *client* of four things that exist on or reach the box,
all pinned to what was verified against **Decky Loader v3.2.8** (stable tag,
published 2026-09-02) and **decky-installer v1.9.0** on 2026-09-06
(`docs/memory/project_decky-manager.md`; evidence in the research capture).
Every one of them is reached from the box, never from the phone (README promises
the app "never talks to anything except your service").

| Endpoint | Who | Used for | Bound / pin |
|---|---|---|---|
| `ws://127.0.0.1:1337/ws?auth=<token>` + `GET http://127.0.0.1:1337/auth/token` | Decky Loader v3.2.8, running as root on the box | the loader's own WebSocket RPC. Only these routes, a `frozenset` the client refuses to leave: `utilities/ping`, `loader/get_plugins`, `loader/reload_plugin`, `utilities/install_plugin`, `utilities/confirm_plugin_install`, `utilities/cancel_plugin_install`, `utilities/uninstall_plugin`, `updater/get_version_info`. Wire: `{"type":0,"route","args","id"}` → type 1/-1/2 reply, `{"type":3,"id"}` ack, type-5 events. **Not used, deliberately:** `updater/do_update` (unpins the unit, `chmod 777`s the binary, follows the box's prerelease branch), `execute_in_tab`/`get_tab_id` (hang without Steam) | token fetched only after `/proc/net/tcp` shows the listener is uid 0; own bounded RFC6455 client (1 MiB frame cap, one deadline per call, ≤64 events, 3 s per session, per-job watchdog 150/40/20 s). The loader holds ONE socket — a connect displaces Steam's frontend ~5 s (KI-068) |
| `https://plugins.deckbrew.xyz/plugins` | the official Decky plugin store (decky-plugin-store, AGPL-3.0 server — we use the public JSON API only, no server code) | the plugin catalogue: ~200 KB JSON list of `{id, name, author, description, tags, downloads, created, updated, image_url, versions[{name, hash, created}]}` | fetched in a background thread, 8 s timeout, 4 MiB cap, **no redirects followed** (`_DeckyNoRedirect`), 900 s TTL, normalised by rejection, UA `couchside-agent/<VERSION>`. No API key, no ToS published; third-party clients (EmuDeck) already consume it the same way |
| `https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/versions/<sha256>.zip` and the store's `image_url` on the same host | the store's CDN (Backblaze B2 behind Cloudflare) | plugin zips — **downloaded by Decky Loader itself, never by the agent** (the agent only hands Decky the agent-built URL + the store hash, and Decky sha256-checks the bytes); plugin icons — proxied by the agent for the phone | icon fetch: host pinned to exactly `cdn.tzatzikiweeb.moe`, https only, no redirects, ≤1 MiB, image-sniffed (jpeg/png/webp/gif/avif), cached at `~/.cache/couchside/decky-icons/<int id>` |
| `https://github.com/SteamDeckHomebrew/decky-loader/releases/download/<tag>/PluginLoader` (tag resolved via the `releases/latest` redirect hop, API fallback) | GitHub releases, GPL-2.0 project | the loader binary, ~27 MB PyInstaller executable — fetched by the **root wrapper** `/etc/couchside/couchside-decky-loader` (a heredoc in `install.sh`, not a release asset), never by the agent | `curl --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --retry 2`, unit `TimeoutStartSec=900`; ELF + ≥5 MB sanity check; **no upstream checksum or signature exists** (KI-070) — TLS + host pin only |

The pinned Decky service file the wrapper writes is Decky's own
`dist/plugin_loader-release.service` text with `${HOMEBREW_FOLDER}` substituted
(identical at v3.2.8 and main); `unit_pinned` on `/api/decky/loader` reports
whether the live unit still byte-matches it.

### Python version floor

**Python 3.8+.** The binding constraint is a single walrus operator at
`couchsided.py:6003`; f-strings appear ~39 times (3.6+). There is no `match`
statement, no PEP 585 builtin generics (`list[...]`/`dict[...]`), no
`dataclasses`, and no `str | None` unions — the code is written in a
conservative dialect and formats mostly with `%`. Nothing declares the floor
explicitly (no `python_requires`, no `sys.version` guard); it is inferred from
syntax. Both target distros ship well past 3.8, so this has not been tested at
the boundary.

---

## 3. Build and release tooling

Not runtime dependencies, but required to ship.

| Tool | Where | Why |
|---|---|---|
| `eas-cli` (`>= 12.0.0`) | `app/eas.json` | Builds and submits both platforms. Profiles: `development`, `preview`, `beta` (sets `EXPO_PUBLIC_BETA_UNLOCK=1`), `production`. `appVersionSource: local` — versions come from `app.json`, not EAS. Cloud builds are the default; the self-hosted Mac (`eas build --local`) is a quota fallback only. |
| `openssl` (Ed25519) | `scripts/sign-release.sh`, `scripts/release-agent.sh` | Signs `SHA256SUMS` for every release so `install.sh` can verify what it downloads. Needs one-shot Ed25519 signing (`-rawin`) — macOS system LibreSSL 3.3+ works, otherwise Homebrew `openssl@3`; both scripts probe `PATH` first and fall back to `brew --prefix openssl@3`. |
| `gh` (GitHub CLI) | `scripts/release-agent.sh` | Creates the release and uploads assets (`--clobber`). Fails fast if unauthenticated. Note: `main` is branch-protected, so releases go through PRs. |
| `scripts/asc-submit.py` | — | App Store Connect API. Mints an ES256 JWT from the `.p8` key and drives submission. |
| `scripts/play-release-notes.py` | — | Google Play Developer API. Service-account RS256 JWT, pushes release notes. |
| `python3` | `install.sh`, `scripts/*` | The installer shells into `python3` heredocs for config generation, VDF parsing, LAN-IP detection, and version comparison. |

**One documented exception to the stdlib rule:** `scripts/asc-submit.py` and
`scripts/play-release-notes.py` both import the third-party **`cryptography`**
package (for ES256 / RS256 JWT signing). This is fine and deliberate — these run
on a developer's Mac or a CI runner, never on a user's box. The stdlib
constraint applies to shipped agent code, not to release tooling. Worth keeping
the boundary explicit so it does not erode.

---

## 4. Flags

### Unused — safe to remove

Three packages appear **only** in `app/package.json`, with zero references
anywhere in `app/`, `components/`, `hooks/`, `lib/`, or `app.json`:

- **`expo-font` `~57.0.0`** — no `useFonts`, no custom font assets loaded.
- **`expo-symbols` `~57.0.0`** — no `SymbolView`. Icon work goes through
  `@expo/vector-icons` instead.
- **`expo-web-browser` `~57.0.0`** — no `WebBrowser.openBrowserAsync`.
  Outbound links go through `expo-linking` in `setup.tsx`.

All three are Expo defaults from `create-expo-app` that were never wired up.
Dropping them trims the native build. Verify against the pending "set up a box"
deep-link work first — if that ends up wanting an in-app browser tab,
`expo-web-browser` is the package it would use.

Not unused, despite having no direct imports — **do not remove**:
`react-native-screens` (expo-router peer), `react-native-worklets` (Reanimated 4
peer), `@expo/metro-runtime` and `react-native-web` (web target),
`expo-splash-screen` and `expo-build-properties` (config plugins).

### Worth a look

- **`react-native-reanimated` `4.5.0` earns its keep only by side effect.** The
  sole reference is a bare `import 'react-native-reanimated'` in `_layout.tsx`.
  Together with its `react-native-worklets` peer that is two native packages
  carrying no authored animation. If nothing downstream (a navigator, a gesture
  surface) actually requires it, both could go; if something does, a comment at
  the import site would prevent a future removal attempt.
- **`usesCleartextTraffic: true` on Android is a real, accepted exposure.** It
  disables TLS enforcement app-wide, not just for the agent. It is correct under
  the LAN-only threat model documented in the security audit, and TLS pinning
  was deferred for needing a native module. Worth revisiting if the app ever
  talks to anything off-LAN.
- **`expo-iap` is a `^` range on a fast-moving v4 package.** `lib/purchase.ts`
  types only a minimal structural view of the API surface, which limits the
  blast radius, but a minor bump could still shift runtime behavior on a revenue
  path. Consider pinning exactly, given the App Review history.
- **`qrcode` is a Node-oriented package used against the grain.** Only
  `QRCode.create()` works in RN; the render helpers need canvas or `zlib`. This
  already caused a blank-QR bug on-device. It works and is well commented, but
  it is one upstream refactor away from breaking again.
- **TypeScript does not protect you here.** `setup.tsx` documents a live case:
  `Constants.nativeBuildVersion` does not exist in SDK 57 but typechecks anyway
  because of an index signature on the module type. `tsc` passing is not
  evidence that an Expo API exists — grep the installed `.d.ts`.

### Checked and clean

`app/asc-key.p8` (App Store Connect private key) and
`secrets/play-service-account.json` (Play service account) are both present on
disk, both correctly gitignored (`app/.gitignore:44`, `.gitignore:13`), and
neither is tracked by git. Confirmed via `git ls-files`. The Ed25519 release
signing keys live outside the repo entirely (`~/couchside-release.key` and the
rollover backup) — losing both means losing the ability to ship updates, so the
offline backup is not optional.

### expo-alternate-app-icons 8.0.0 (app, pinned exact) — added 2026-09-26
- **What:** config plugin + native module for alternate launcher icons. Android: one `<activity-alias>`
  `.MainActivity<Name>` per declared icon (disabled by default, own adaptive-icon mipmaps generated at prebuild),
  switched with `PackageManager.setComponentEnabledSetting` — enable new THEN disable old, `DONT_KILL_APP`.
  iOS: `setAlternateIconName`. Web shim: `supportsAlternateIcons = false`.
- **Why:** a direct-edition user wanted the Play Store icon instead of the gold Pro one. Writing our own Kotlin
  module + manifest plugin was the alternative; this is small, maintained, peer `expo >= 53`, and its generated
  APK is what we verify (aapt: aliases present, one enabled) rather than trusting the claim.
- **Where configured:** ONLY in `build/direct-apk`'s `app.config.js` (plugin entry + `expo.extra.appIcons`
  declaring `[Pro (default), Standard]`). `main` installs the package but declares nothing, so the store APK only
  links the module; `lib/appIcon.ts` parses `extra.appIcons` defensively (malformed → no row).
- **Used ONLY as the prebuild plugin.** Its runtime switch is NOT used: it derives the "current" icon from the
  launching Activity's component (fixed for the process), so a second switch in one session silently no-ops
  while MainActivity stays disabled (review 2026-09-26). Switching is done by OUR local module
  `app/modules/app-icon-switch` (Android, Kotlin, ~100 lines): PackageManager truth, enable target first, then
  disable every other launcher component, refuse undeclared names, DONT_KILL_APP.
- **Deep links:** MainActivity alone carries the `couchside://` VIEW filter unless `android.intentFilters` is
  declared — the direct app.config.js declares it so the plugin copies the filter onto every alias.
- **PERMANENCE RULE (latent launcher brick):** for `com.ets3d.rescueremote.direct` the plugin entry and every
  alias NAME ever shipped are append-only — never rename or remove one. A user who picked an alias has
  MainActivity DISABLED (persisted across updates); a later build without that alias leaves them with no
  launcher icon and no way back in except adb/uninstall. Release recipe: `aapt dump xmltree` the new APK and
  check its `.MainActivity<Alias>` set is a superset of the previously shipped one.
- **Risk:** launcher quirks (pinned shortcuts reset; brief disappearance on some OEMs). Every icon is fixed at
  build time (new icon = new APK). Device protocol: Pro→Standard→Pro WITHOUT a restart, `dumpsys package …`
  enabled/disabled components must match the picker after each tap; then cold start and re-check; then
  `am start -a android.intent.action.VIEW -d 'couchside://…'` with Standard selected (and Pro as control).
