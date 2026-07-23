#!/usr/bin/env python3
"""publish-app-version.py — keep couchside.tv/app-version.json in step with a Play release.

The app's "check for app update" reads this file ONLY on Android (iOS asks Apple
directly). So on every Play release the manifest's android.versionCode has to be
bumped, or Android users get a stale answer forever. This automates that: it
rewrites the manifest in the ets3d site repo, commits, and deploys.

    scripts/publish-app-version.py                 # versions from app/app.json
    scripts/publish-app-version.py --version-code 59 --version 2.9.22
    scripts/publish-app-version.py --no-deploy     # write + commit only

The ets3d checkout is found via --site-dir, then $COUCHSIDE_SITE_DIR, then
~/Developer/ets3d. iOS needs nothing here.

play-release-notes.py calls this automatically after setting the Play notes
(best-effort — a failure warns, it does not undo the notes).
"""
import argparse
import json
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JSON = os.path.join(REPO_ROOT, "app", "app.json")
MANIFEST_REL = os.path.join("couchside", "app-version.json")


def app_json_versions():
    """(marketing_version, android_version_code) from app/app.json."""
    d = json.load(open(APP_JSON, encoding="utf-8"))["expo"]
    return d["version"], int(d["android"]["versionCode"])


def find_site_dir(explicit):
    for cand in (explicit, os.environ.get("COUCHSIDE_SITE_DIR"),
                 os.path.expanduser("~/Developer/ets3d")):
        if cand and os.path.isdir(os.path.join(cand, "couchside")):
            return cand
    return None


def main():
    ver_default, vc_default = app_json_versions()
    p = argparse.ArgumentParser()
    p.add_argument("--version", default=ver_default,
                   help="marketing version shown to users (default: app/app.json)")
    p.add_argument("--version-code", type=int, default=vc_default,
                   help="Android versionCode that just went live (default: app/app.json)")
    p.add_argument("--site-dir", default=None,
                   help="ets3d site checkout (default: $COUCHSIDE_SITE_DIR or ~/Developer/ets3d)")
    p.add_argument("--no-deploy", action="store_true",
                   help="write + commit the manifest but do not push/deploy")
    a = p.parse_args()

    site = find_site_dir(a.site_dir)
    if not site:
        sys.exit("error: ets3d site checkout not found. Pass --site-dir or set "
                 "$COUCHSIDE_SITE_DIR (needs a couchside/ subdir).")
    manifest = os.path.join(site, MANIFEST_REL)
    if not os.path.isfile(manifest):
        sys.exit(f"error: manifest missing: {manifest}")

    d = json.load(open(manifest, encoding="utf-8"))
    android = d.setdefault("android", {})
    if android.get("versionCode") == a.version_code and android.get("version") == a.version:
        print(f"already current: android {a.version} / vc {a.version_code} — nothing to do.")
        return
    android["versionCode"] = a.version_code
    android["version"] = a.version
    android.setdefault(
        "url", "https://play.google.com/store/apps/details?id=com.ets3d.rescueremote")
    with open(manifest, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print(f"==> {MANIFEST_REL}: android -> {a.version} / vc {a.version_code}")

    def git(*args):
        subprocess.run(["git", "-C", site, *args], check=True)

    git("add", MANIFEST_REL)
    git("commit", "-m",
        f"couchside: app-version.json android {a.version} / vc {a.version_code} (Play release)")
    if a.no_deploy:
        print(f"--no-deploy: committed. To publish:  cd {site} && git push && npm run deploy")
        return
    git("push")
    print("==> npm run deploy (production)")
    subprocess.run(["npm", "run", "deploy"], cwd=site, check=True)
    print("OK: manifest bumped and couchside.tv deployed.")


if __name__ == "__main__":
    main()
