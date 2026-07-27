#!/usr/bin/env python3
"""The shipping app's camera is QR-pairing only and MIC-LESS. Demo mode stays unmergeable.

HISTORY — the invariant this file guards CHANGED, on purpose, once
------------------------------------------------------------------
Until 2026-07-27 this test enforced "the shipping app must never gain camera
capability", written when branch `feat/demo-mode` (rear-camera PiP for promo
recording, deliberately unmergeable) was the only thing that could bring a
camera in. On 2026-07-27 the owner explicitly asked for an in-app QR pairing
scanner (couchside PR #292), so `expo-camera` is now a LEGITIMATE shipping
dependency and this test failing on that PR was the system working: the
capability arrived by decision, not by accident, and the decision is recorded
here.

WHAT IS STILL BANNED, AND WHY
-----------------------------
1. THE MICROPHONE. The scanner reads frames; it records nothing. expo-camera's
   config plugin DEFAULTS to adding android.permission.RECORD_AUDIO and offers
   an iOS mic string — a QR scanner that asks for the mic is both a store-review
   smell and a lie against couchside.tv/privacy ("no image or video is
   recorded"). So the plugin entry must pin `recordAudioAndroid: false` and
   `microphonePermission: false`, and no mic purpose string may appear.
   (Verified 2026-07-27 via `expo config --type introspect`: with those options
   the manifest carries CAMERA but not RECORD_AUDIO, and the plist has no
   NSMicrophoneUsageDescription.)
2. THE DEMO-MODE FORK MACHINERY. `feat/demo-mode` is still deliberately
   unmergeable, and the guard against it still has to live HERE on main —
   a guard that lives on the branch merges its own approval. Its tells:
   app.config.* (the bundle-id fork mechanism), the `.demo` bundle id, a
   `demo` EAS profile, EXPO_PUBLIC_DEMO_BUILD, DemoCameraPip.tsx, and
   react-native-vision-camera.

THE AUTOLINKING TRAP, still true and still the reason this checks package.json
------------------------------------------------------------------------------
Expo autolinking keys off package.json, not off config plugins — measured on
this repo. So a camera dependency in ANY dependency section links native code
into the shipping binary regardless of plugins. That is why expo-camera's
package.json entry must be paired with its properly-pinned plugin entry: the
dependency without the plugin ships camera code with no purpose string
(Apple flags exactly this), and the plugin without the pins re-grows the mic.

IF THIS TEST FAILS
------------------
Mic findings: do not "fix" by adding a mic string — the scanner records
nothing; restore the plugin pins. Demo findings: you are probably mid-merge of
demo mode; back it out (it builds from its own branch, see docs/DEMO_MODE.md
there). Pure stdlib, like every other test here.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"

# The one camera dependency the shipping app may declare, and the plugin option
# pins that keep it mic-less. vision-camera remains banned outright (it is the
# demo branch's tell, and nothing in the product needs it).
ALLOWED_CAMERA_DEP = "expo-camera"
BANNED_DEPS = ("react-native-vision-camera",)

failures = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


# ------------------------------------------------------ package.json (autolinking)

pkg = json.loads((APP / "package.json").read_text())
# All three sections: measured, devDependencies and optionalDependencies both
# still land the package in node_modules and autolinking still links it.
declared = (
    set(pkg.get("dependencies", {}))
    | set(pkg.get("devDependencies", {}))
    | set(pkg.get("optionalDependencies", {}))
)

for dep in BANNED_DEPS:
    check(
        dep not in declared,
        f"app/package.json declares `{dep}`. That package is the demo branch's camera; "
        f"the shipping scanner uses expo-camera. Back the merge out.",
    )

# --------------------------------------------------- app.config.js (the fork mechanism)

for name in ("app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"):
    check(
        not (APP / name).exists(),
        f"app/{name} exists. On main, app.json is the single source of truth for the "
        f"shipping config; a dynamic config here is the demo branch's bundle-id fork "
        f"(com.ets3d.rescueremote.demo) arriving by merge.",
    )

# ------------------------------------------------------------------------ app.json

app_json = json.loads((APP / "app.json").read_text())
expo = app_json["expo"]

raw_plugins = expo.get("plugins", [])
plugin_names = [p[0] if isinstance(p, list) else p for p in raw_plugins]

for dep in BANNED_DEPS:
    check(
        dep not in plugin_names,
        f"app.json lists the `{dep}` config plugin — the demo branch's camera path.",
    )

# expo-camera: dependency and plugin must arrive TOGETHER, with the mic pinned off.
has_dep = ALLOWED_CAMERA_DEP in declared
has_plugin = ALLOWED_CAMERA_DEP in plugin_names
check(
    has_dep == has_plugin,
    "expo-camera dependency and its config plugin must be added/removed together: the "
    "dependency alone links camera code with no purpose string (autolinking keys off "
    "package.json), and the plugin alone is a purpose string for code that isn't there.",
)
if has_plugin:
    entry = next(p for p in raw_plugins if isinstance(p, list) and p[0] == ALLOWED_CAMERA_DEP)
    opts = entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {}
    check(
        opts.get("recordAudioAndroid") is False,
        "expo-camera plugin must pin `recordAudioAndroid: false` — the plugin DEFAULT "
        "adds android.permission.RECORD_AUDIO to a scanner that records nothing.",
    )
    check(
        opts.get("microphonePermission") is False,
        "expo-camera plugin must pin `microphonePermission: false` — no mic purpose "
        "string may ship; the scanner reads frames and records nothing.",
    )
    check(
        bool(opts.get("cameraPermission")),
        "expo-camera plugin must set an explicit cameraPermission string — the default "
        "boilerplate ('Allow $(PRODUCT_NAME) to access your camera') explains nothing "
        "and App Review flags vague purpose strings.",
    )

info_plist = expo.get("ios", {}).get("infoPlist", {})
check(
    "NSMicrophoneUsageDescription" not in info_plist,
    "app.json's ios.infoPlist sets NSMicrophoneUsageDescription. The shipping app must "
    "never ask for the microphone.",
)

bundle_id = expo["ios"]["bundleIdentifier"]
check(
    not bundle_id.endswith(".demo"),
    f"app.json ships the demo bundle id ({bundle_id}). main must always build the real "
    f"app; the .demo fork exists only on the demo branch.",
)

# ------------------------------------------------------------------------- eas.json

eas = json.loads((APP / "eas.json").read_text())
check(
    "demo" not in eas.get("build", {}),
    "app/eas.json has a `demo` build profile. That profile exists only on the demo "
    "branch; its presence on main means the branch was merged.",
)

for name, profile in eas.get("build", {}).items():
    check(
        "EXPO_PUBLIC_DEMO_BUILD" not in profile.get("env", {}),
        f"build profile `{name}` sets EXPO_PUBLIC_DEMO_BUILD. Nothing on main may enable "
        f"demo mode.",
    )

# ------------------------------------------------------------ the component itself

check(
    not (APP / "components" / "DemoCameraPip.tsx").exists(),
    "app/components/DemoCameraPip.tsx exists on main. The camera picture-in-picture is "
    "demo-branch-only.",
)

# ------------------------------------------------------------------------- verdict

if failures:
    print("FAIL: shipping-app camera/mic policy violated\n")
    for f in failures:
        print(f"  * {f}\n")
    print(
        "The shipping camera is QR-pairing only and mic-less; demo mode builds from\n"
        "feat/demo-mode with `eas build --profile demo -p ios --local`, never a merge."
    )
    sys.exit(1)

print("ok: camera is pairing-only and mic-less; no demo-mode machinery on main")
