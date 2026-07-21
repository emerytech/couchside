#!/usr/bin/env python3
"""The shipping app must never gain camera capability. This blocks demo mode.

WHAT THIS IS FOR
----------------
Branch `feat/demo-mode` (commit 976d7a2, "wip: demo-mode build for promo recording --
NOT for merge") adds a developer-only recording aid: a tap-indicator overlay plus a
rear-camera picture-in-picture. It is built as an ad-hoc, bundle-id-forked
(`com.ets3d.rescueremote.demo`) build that never goes near TestFlight or the App Store.

That branch is DELIBERATELY UNMERGEABLE. This test is the mechanism.

WHY A TEST RATHER THAN A CONVENTION
-----------------------------------
The branch carries its own isolation test, and that is exactly the problem: a guard
that lives on the branch disappears at the moment it would matter, because merging the
branch merges the guard's own approval. The guard has to live HERE, on main, where a
merge makes CI go red instead of quietly shipping a camera-linked binary.

THE ACTUAL TRAP THIS CATCHES
----------------------------
On that branch the expo-camera CONFIG PLUGIN is conditional (added by app.config.js only
when EXPO_PUBLIC_DEMO_BUILD=1), but the `expo-camera` DEPENDENCY in app/package.json is
NOT. Expo autolinking keys off package.json, not off config plugins -- measured on this
repo: with expo-camera present in node_modules but absent from main's package.json,
`npx expo-modules-autolinking resolve -p ios --json` returns 24 modules and does not
include it. Declare it in package.json and it links.

So a merge would compile camera native code into the SHIPPING binary while
NSCameraUsageDescription stayed absent -- precisely the state Apple's purpose-string
checks exist to flag, and precisely what the owner said he does not want.

IF THIS TEST FAILS
------------------
You are probably mid-merge of demo mode. Do not "fix" it by adding a camera usage string.
Back the merge out. Demo mode is built from its own branch with
`eas build --profile demo -p ios --local`; see docs/DEMO_MODE.md on that branch.

Pure stdlib, like every other test here.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"

# The dependency that started this. Kept narrow ON PURPOSE: a guard that also blocks
# unrelated future work (expo-image-picker for an avatar, say) is a guard someone deletes
# in frustration. This blocks the camera-preview path specifically.
BANNED_DEPS = ("expo-camera", "react-native-vision-camera")

# Purpose strings that must never appear in the shipping Info.plist.
BANNED_PLIST_KEYS = ("NSCameraUsageDescription", "NSMicrophoneUsageDescription")

failures = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


# ------------------------------------------------------ package.json (the real trap)

pkg = json.loads((APP / "package.json").read_text())
# All three sections, not just `dependencies`. Measured: moving expo-camera to
# devDependencies does NOT stop the leak (autolinking still resolves 25 modules and
# still links it), and optionalDependencies links it too while silently disabling the
# demo camera. Every section that lands the package in node_modules is a leak path.
declared = (
    set(pkg.get("dependencies", {}))
    | set(pkg.get("devDependencies", {}))
    | set(pkg.get("optionalDependencies", {}))
)

for dep in BANNED_DEPS:
    check(
        dep not in declared,
        f"app/package.json declares `{dep}`. Expo autolinking keys off package.json, so "
        f"this links camera native code into the SHIPPING binary even if no config "
        f"plugin adds a usage string. This is the demo-mode merge trap -- back the merge "
        f"out rather than adding a purpose string.",
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

plugins = [p[0] if isinstance(p, list) else p for p in expo.get("plugins", [])]
for dep in BANNED_DEPS:
    check(
        dep not in plugins,
        f"app.json lists the `{dep}` config plugin, which writes a camera purpose string "
        f"into the shipping Info.plist.",
    )

info_plist = expo.get("ios", {}).get("infoPlist", {})
for key in BANNED_PLIST_KEYS:
    check(
        key not in info_plist,
        f"app.json's ios.infoPlist sets {key}. The shipping app does not use the camera "
        f"or the microphone and must not ask for them.",
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
    print("FAIL: the shipping app is gaining camera capability\n")
    for f in failures:
        print(f"  * {f}\n")
    print(
        "Demo mode is deliberately unmergeable. Build it from feat/demo-mode with\n"
        "`eas build --profile demo -p ios --local` instead of merging it to main."
    )
    sys.exit(1)

print("ok: shipping app declares no camera dependency, plugin, or purpose string")
