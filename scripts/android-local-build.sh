#!/usr/bin/env bash
# Build a release APK on the Linux build box AND archive the Hermes source map
# that symbolicates it, side by side, named by versionCode.
#
#   scripts/android-local-build.sh [--direct] [--out DIR] [--archive-only] [--force]
#
#   --direct        the direct (off-store) edition: EXPO_PUBLIC_DIRECT=1 at
#                   prebuild. Run from a build/direct-apk checkout (its
#                   app.config.js gives it the .direct package id).
#   --out DIR       where the archive goes. Default: the directory that CONTAINS
#                   this checkout (app/build is not gitignored, so never inside).
#   --archive-only  skip npm ci / prebuild / gradle and archive what the last
#                   build left in app/android/app/build.
#   --force         replace an existing archive whose contents DIFFER. Without
#                   it that is refused: a map that stops matching its APK is
#                   worse than no map.
#   --app-dir DIR   the Expo app directory (default: <repo>/app). For tests.
#
# Output, e.g. for the store app at 2.9.61 / versionCode 109:
#   couchside-2.9.61-vc109.apk      the APK exactly as built
#   couchside-2.9.61-vc109.map      android/app/build/generated/sourcemaps/react/
#                                   release/index.android.bundle.map
#   couchside-2.9.61-vc109.sha256   apk + map + the Hermes bundle inside the APK
#   couchside-2.9.61-vc109.r8-mapping.txt   only if R8 minify is on (it is not
#                                   yet; ROADMAP "Android R8 obfuscation") — the
#                                   JVM-side twin, for obfuscated Java frames
#                                   in `adb logcat -b crash`
# The direct edition is couchside-direct-<version>-vc<N>.* (its versionCode line
# is separate from the store app's, so the prefix is what keeps them apart).
#
# WHY. A release crash on Android reports Hermes frames as
# `index.android.bundle:1:<bytecode offset>`. Only the source map from THAT
# exact build turns them back into file:line, and the build box's tree is
# re-cloned for every release, so a map not copied out at build time is gone
# for good. Every APK before this script shipped without one.
#
# WHAT IT CHECKS (CLAUDE.md §11.4, read the artifact, not the exit code):
#   * version, versionCode and package id are read from the BUILT APK
#     (aapt2 dump badging), falling back to AGP's output-metadata.json;
#   * the Hermes bundle inside the APK is byte-identical to the one the map was
#     composed from, so the map provably belongs to this APK;
#   * a missing map is a hard failure, and nothing is archived: an APK with no
#     map is exactly the gap this exists to close.
#
# Needs for a build: JAVA_HOME (JDK 21 on the Debian box; Expo SDK 57 / Gradle
# 9 build fine on it) and ANDROID_HOME. Signing is whatever the prebuilt
# project uses (Expo's debug keystore unless configured) — sideload/test only.
# See docs/memory/CONVENTIONS.md §5 "Android builds on the Linux build box".
set -euo pipefail

DIRECT=0
OUT=""
ARCHIVE_ONLY=0
FORCE=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --direct) DIRECT=1 ;;
    --out) OUT="${2:?--out needs a directory}"; shift ;;
    --archive-only) ARCHIVE_ONLY=1 ;;
    --force) FORCE=1 ;;
    --app-dir) APP="${2:?--app-dir needs a directory}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

APP="$(cd "$APP" && pwd)"
[ -n "$OUT" ] || OUT="$(dirname "$ROOT")"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ---------------------------------------------------------------- build
if [ "$ARCHIVE_ONLY" -eq 0 ]; then
  [ -n "${JAVA_HOME:-}" ] && [ -d "$JAVA_HOME" ] || die "JAVA_HOME is not a directory (JDK 21 on the build box)"
  [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ] || die "ANDROID_HOME is not a directory"
  echo "==> npm ci"
  (cd "$APP" && npm ci --no-audit --no-fund)
  echo "==> expo prebuild (android, clean)$([ "$DIRECT" -eq 1 ] && echo ' — DIRECT edition')"
  if [ "$DIRECT" -eq 1 ]; then
    (cd "$APP" && EXPO_PUBLIC_DIRECT=1 npx expo prebuild -p android --clean --no-install)
  else
    (cd "$APP" && npx expo prebuild -p android --clean --no-install)
  fi
  echo "==> gradle :app:assembleRelease"
  if [ "$DIRECT" -eq 1 ]; then
    (cd "$APP/android" && EXPO_PUBLIC_DIRECT=1 ./gradlew :app:assembleRelease --no-daemon)
  else
    (cd "$APP/android" && ./gradlew :app:assembleRelease --no-daemon)
  fi
fi

# ---------------------------------------------------------------- locate
BUILD="$APP/android/app/build"
APK="$BUILD/outputs/apk/release/app-release.apk"
META="$BUILD/outputs/apk/release/output-metadata.json"
MAP="$BUILD/generated/sourcemaps/react/release/index.android.bundle.map"
BUNDLE="$BUILD/generated/assets/react/release/index.android.bundle"
R8MAP="$BUILD/outputs/mapping/release/mapping.txt"

[ -f "$APK" ] || die "no APK at $APK"
[ -s "$MAP" ] || die "no source map at $MAP — nothing archived. Hermes writes it only while
       react { hermesFlags } keeps '-output-source-map' (the RN default); check
       android/app/build.gradle after prebuild."

# ---------------------------------------------------------------- identity (from the artifact)
VC=""; VN=""; PKG=""
AAPT2=""
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/build-tools" ]; then
  for _a in "$ANDROID_HOME"/build-tools/*/aapt2; do [ -x "$_a" ] && AAPT2="$_a"; done  # newest (lexical) wins
fi
if [ -n "$AAPT2" ] && [ -x "$AAPT2" ]; then
  BADGING="$("$AAPT2" dump badging "$APK" 2>/dev/null | head -1 || true)"
  VC="$(printf '%s' "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")"
  VN="$(printf '%s' "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
  PKG="$(printf '%s' "$BADGING" | sed -n "s/.*package: name='\([^']*\)'.*/\1/p")"
  [ -n "$VC" ] && echo "==> identity from aapt2: $PKG $VN vc$VC"
fi
if [ -z "$VC" ] && [ -f "$META" ]; then
  READ_META='import json,sys
d=json.load(open(sys.argv[1])); e=(d.get("elements") or [{}])[0]
print(e.get("versionCode",""), e.get("versionName",""), d.get("applicationId",""), sep="\t")'
  if command -v python3 >/dev/null 2>&1; then
    FIELDS="$(python3 -c "$READ_META" "$META" 2>/dev/null || true)"
  else
    FIELDS="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(d.elements||[{}])[0]||{};console.log([e.versionCode??"",e.versionName??"",d.applicationId??""].join("\t"))' "$META" 2>/dev/null || true)"
  fi
  IFS=$'\t' read -r VC VN PKG <<<"$FIELDS" || true
  [ -n "$VC" ] && echo "==> identity from output-metadata.json: $PKG $VN vc$VC"
fi
case "$VC" in ''|*[!0-9]*) die "could not read a numeric versionCode from the APK or $META" ;; esac
[ -n "$VN" ] || die "could not read versionName"
case "$VN" in *[!A-Za-z0-9._-]*) die "unexpected versionName: $VN" ;; esac

if [ "$DIRECT" -eq 1 ] && [ "${PKG%.direct}" = "$PKG" ]; then
  die "--direct given but the APK's package is '$PKG' (expected ….direct) — wrong checkout?"
fi
PREFIX="couchside"
[ "${PKG%.direct}" != "$PKG" ] && PREFIX="couchside-direct"
BASE="$PREFIX-$VN-vc$VC"

# ---------------------------------------------------------------- the map belongs to this APK
APK_BUNDLE_SHA=""
TMPB="$(mktemp)"
trap 'rm -f "$TMPB"' EXIT
if command -v unzip >/dev/null 2>&1; then
  unzip -p "$APK" assets/index.android.bundle >"$TMPB" 2>/dev/null || : >"$TMPB"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c 'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("assets/index.android.bundle"))' "$APK" >"$TMPB" 2>/dev/null || : >"$TMPB"
fi
if [ -s "$TMPB" ]; then
  APK_BUNDLE_SHA="$(sha256 "$TMPB")"
  [ -f "$BUNDLE" ] || die "no generated bundle at $BUNDLE to match the map against"
  [ "$APK_BUNDLE_SHA" = "$(sha256 "$BUNDLE")" ] || die "the APK's index.android.bundle differs from $BUNDLE —
       the map is not from this APK's build. Nothing archived."
  echo "==> APK bundle matches the map's build (sha256 ${APK_BUNDLE_SHA:0:12}…)"
else
  echo "warn: could not read assets/index.android.bundle out of the APK (no unzip/python3?);" >&2
  echo "      archiving WITHOUT proving the map matches it." >&2
fi

# ---------------------------------------------------------------- archive (refuse to clobber)
place() { cp "$1" "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"; }  # src dest, atomic-ish
# Check every destination before writing any, so a refusal leaves nothing half-done.
EXTS="apk map"; [ -s "$R8MAP" ] && EXTS="apk map r8-mapping.txt"
srcof() { case "$1" in apk) echo "$APK" ;; map) echo "$MAP" ;; *) echo "$R8MAP" ;; esac; }
for ext in $EXTS; do
  src="$(srcof "$ext")"
  if [ -e "$OUT/$BASE.$ext" ] && ! cmp -s "$src" "$OUT/$BASE.$ext" && [ "$FORCE" -ne 1 ]; then
    die "$OUT/$BASE.$ext exists with DIFFERENT contents (another build at the same versionCode?).
       Bump versionCode, or pass --force to replace it."
  fi
done
for ext in $EXTS; do place "$(srcof "$ext")" "$OUT/$BASE.$ext"; done
{
  for ext in $EXTS; do echo "$(sha256 "$OUT/$BASE.$ext")  $BASE.$ext"; done
  if [ -n "$APK_BUNDLE_SHA" ]; then echo "$APK_BUNDLE_SHA  $BASE.apk!/assets/index.android.bundle"; fi
} >"$OUT/$BASE.sha256"

echo
echo "archived:"
for ext in $EXTS sha256; do echo "  $OUT/$BASE.$ext"; done
echo
echo "symbolicate a Hermes stack from this build (from app/, metro-symbolicate ships with metro):"
echo "  npx metro-symbolicate $OUT/$BASE.map < stack.txt"
