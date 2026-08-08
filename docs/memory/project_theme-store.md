# Theme store — download controller themes from couchside.tv (owner ask 2026-08-08)

> **Status: SPEC ONLY, future work.** Owner: *"ideally long term building a theme
> store that users can download themes from couchside.tv to their app would be
> great."* The 17 bundled themes (2.9.42) are the seed catalogue; this is the
> delivery mechanism to add more without an app update.

## Why this is a real project, not a config change

Today a theme is a frozen app-internal registry entry + bundled PNG art (see
[project_game-themes] / lib/gameTheme.ts). That is deliberately **contrast-safe
by construction and content-injection-proof**: a theme can only move the accent
family + a bundled backdrop, and nothing from the wire becomes a theme — the
running appid is a lookup key, never data. A download-from-couchside.tv store
**inverts that**: theme *data* (colours, and image bytes) now comes from a
remote source into the app. That crosses the same line the agent's allowlist
draws, and it has to be designed with the same seriousness.

## The threats a remote theme introduces

1. **Malicious/oversized image** — a downloaded backdrop could be enormous
   (OOM), a decompression bomb, or crafted to exploit the image decoder.
2. **Contrast attack** — a hostile palette could set the accent to the card
   colour and make the controls invisible, in a surface the user isn't looking
   at. The bundled themes are safe because a TEST asserts it; a downloaded one
   has never run that test.
3. **Tampering in transit** — a MITM (or a compromised couchside.tv) could swap
   a theme's bytes.
4. **Bricking** — a malformed theme JSON that crashes `applyGameTheme` or the
   renderer would break the controller, the app's core function.

## Design that keeps the guarantees (proposed, not built)

- **Signed theme bundles.** A theme = a small JSON manifest (key, label, accent
  {dark,light}, glow, backdrop dimensions) + two images, packaged and
  **Ed25519-signed with the same offline release key** the agent assets use
  (release-signing-keys). The app ships the public key; an unsigned or
  tampered bundle is refused. This is the existing, proven pattern —
  couchside.tv already serves signed agent assets (sync-installer / release-agent.sh).
- **Validate on the CLIENT before applying**, not just trusting the manifest:
  - Run the SAME contrast check the test runs (extract it to a shared pure
    function `assertThemeContrast()` used by both `gameTheme.test.ts` and the
    download path) — reject a theme whose accent fails 3:1 on card.
  - Clamp image dimensions + byte size before decode; reject over a ceiling.
  - Parse the manifest through the same `isControllerThemePref`-style allowlist:
    only accent/glow/backdrop fields are read; anything else is ignored, so a
    manifest can never reach a Palette/status token.
- **The registry becomes: bundled (frozen) + downloaded (validated, cached).**
  `THEMES` stays the compile-time set; a second `downloadedThemes` map is filled
  from disk cache at boot (already-validated) and by the download flow.
  `resolveTheme` / `THEME_PICKER` / the switcher read the UNION — so the picker
  and the in-controller switcher list downloaded themes automatically, exactly
  as they already list bundled ones.
- **couchside.tv side:** a `/themes/index.json` (signed) listing available
  themes + their bundle URLs; the app fetches the index, shows a "get more
  themes" grid, downloads + verifies + caches on tap. Reuses the site's
  existing signed-asset serving.

## Phases

1. **Extract `assertThemeContrast()`** as a shared pure function (test + future
   download path both call it). No behaviour change; pure refactor. Cheap, do
   it whenever.
2. **Theme bundle format + signer** (a `scripts/sign-theme.sh` mirroring
   sign-release.sh) and the couchside.tv `/themes/` endpoint + signed index.
3. **App download flow:** fetch index → grid UI (a new Setup screen or a "＋
   Get themes" row in the picker) → download → verify sig → validate contrast +
   size → cache → appears in picker/switcher.
4. **Management:** delete a downloaded theme, storage accounting, update when a
   theme's bundle changes.

## What NOT to do

- **No unsigned remote themes**, ever — that is the whole risk.
- **No remote CODE** — a theme is data (colours + images), never logic. The
  renderer stays in the app binary.
- **No skipping the client-side contrast + size validation** on the theory that
  "we control couchside.tv" — a compromised CDN or MITM is exactly the case the
  validation exists for. Degrade closed: an invalid theme is refused, the
  controller keeps its current look.

## Reuses that already exist

- Signed-asset delivery from couchside.tv (release-agent.sh, sync-installer).
- The offline Ed25519 release key + embedded public half.
- The picker/switcher already read a registry by key — they need no change
  beyond reading the bundled∪downloaded union.
- The contrast test's math — extract and share it.
