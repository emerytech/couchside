#!/usr/bin/env python3
"""The Android build script archives the Hermes source map WITH its APK.

Run: python3 tests/test_android_build_archive.py

WHY THIS EXISTS: a release crash on Android reports Hermes frames as
`index.android.bundle:1:<offset>`, and only the source map from that exact
build symbolicates them. The build box re-clones for every release, so a map
not copied out at build time is gone — and until 2026-09-26 none ever was.
scripts/android-local-build.sh now archives `<artifact>-vc<versionCode>.map`
next to the APK. This pins what it must get right, using a fake build tree and
`--archive-only` (no Gradle, no Android SDK, no network):

    names       couchside-<ver>-vc<N>.{apk,map,sha256}; ….direct -> couchside-direct-…
    identity    read from the BUILT artifact's metadata, never from app.json
    fail closed no map -> non-zero and NOTHING archived (an APK without its
                map is the exact gap); a map from a different build (the APK's
                bundle differs) -> refused; an unreadable versionCode -> refused
    no clobber  a different file already at that name is refused unless --force;
                re-archiving identical bytes is a no-op success

CONTROL: the "missing map" case is the control for the happy path — same tree,
one file removed, and the exit code and output directory flip.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "android-local-build.sh")

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


HBC = b"\xc6\x1f\xbc\x03HERMES-BYTECODE-FIXTURE" + bytes(range(256))
MAP = json.dumps({"version": 3, "sources": ["app/(tabs)/pad.tsx"], "mappings": "AAAA"}).encode()


def make_tree(base, *, app_id="com.ets3d.rescueremote", vc=109, vn="2.9.61",
              map_bytes=MAP, apk_bundle=HBC, gen_bundle=HBC, meta=True, r8=None):
    """A minimal app/android/app/build as AGP + the RN gradle plugin leave it."""
    app = os.path.join(base, "app")
    build = os.path.join(app, "android", "app", "build")
    rel = os.path.join(build, "outputs", "apk", "release")
    os.makedirs(rel)
    with zipfile.ZipFile(os.path.join(rel, "app-release.apk"), "w") as z:
        z.writestr("AndroidManifest.xml", b"\x03\x00fake")
        z.writestr("assets/index.android.bundle", apk_bundle)
    if meta:
        with open(os.path.join(rel, "output-metadata.json"), "w") as f:
            json.dump({
                "version": 3, "artifactType": {"type": "APK", "kind": "Directory"},
                "applicationId": app_id, "variantName": "release",
                "elements": [{"type": "SINGLE", "filters": [], "attributes": [],
                              "versionCode": vc, "versionName": vn,
                              "outputFile": "app-release.apk"}],
                "elementType": "File",
            }, f)
    if map_bytes is not None:
        d = os.path.join(build, "generated", "sourcemaps", "react", "release")
        os.makedirs(d)
        with open(os.path.join(d, "index.android.bundle.map"), "wb") as f:
            f.write(map_bytes)
    d = os.path.join(build, "generated", "assets", "react", "release")
    os.makedirs(d)
    with open(os.path.join(d, "index.android.bundle"), "wb") as f:
        f.write(gen_bundle)
    if r8 is not None:
        d = os.path.join(build, "outputs", "mapping", "release")
        os.makedirs(d)
        with open(os.path.join(d, "mapping.txt"), "wb") as f:
            f.write(r8)
    return app


def run(app, out, *extra):
    env = dict(os.environ)
    # No Android SDK: identity must come from output-metadata.json, and a stray
    # aapt2 on the runner must not be picked up.
    env.pop("ANDROID_HOME", None)
    env.pop("JAVA_HOME", None)
    p = subprocess.run(["bash", SCRIPT, "--archive-only", "--app-dir", app, "--out", out, *extra],
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def listing(d):
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


def read(p):
    with open(p, "rb") as f:
        return f.read()


def test_happy_path_store():
    print("store build: APK + map + sha256, named by version and versionCode")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t)
        out = os.path.join(t, "out")
        rc, log = run(app, out)
        check("exit 0", rc, 0)
        check("files", listing(out), ["couchside-2.9.61-vc109.apk",
                                      "couchside-2.9.61-vc109.bundle-sha256",
                                      "couchside-2.9.61-vc109.map",
                                      "couchside-2.9.61-vc109.sha256"])
        if rc == 0:
            check("map copied byte-for-byte", read(os.path.join(out, "couchside-2.9.61-vc109.map")), MAP)
            src_apk = os.path.join(app, "android/app/build/outputs/apk/release/app-release.apk")
            check("apk copied byte-for-byte", read(os.path.join(out, "couchside-2.9.61-vc109.apk")), read(src_apk))
            sums = read(os.path.join(out, "couchside-2.9.61-vc109.sha256")).decode()
            check("sha256 names ONLY real sibling files (apk, map)",
                  [ln.split("  ", 1)[1] for ln in sums.strip().splitlines()],
                  ["couchside-2.9.61-vc109.apk", "couchside-2.9.61-vc109.map"])
            bsum = read(os.path.join(out, "couchside-2.9.61-vc109.bundle-sha256")).decode()
            check("the in-APK bundle hash is kept, in its own file",
                  bsum.strip().split("  ", 1)[1], "couchside-2.9.61-vc109.apk!/assets/index.android.bundle")
            # The archive must verify with the stock tools (review finding: a
            # non-file line made `-c` exit 1 every time).
            tool = (["sha256sum", "-c"] if shutil.which("sha256sum") else ["shasum", "-a", "256", "-c"])
            chk = subprocess.run(tool + ["couchside-2.9.61-vc109.sha256"], cwd=out,
                                 capture_output=True, text=True)
            check("%s passes on the archive" % " ".join(tool), chk.returncode, 0)
            check("says it proved the bundle match", "APK bundle matches" in log, True)
            check("prints the symbolicate recipe", "metro-symbolicate" in log, True)


def test_direct_edition_prefix():
    print("direct edition: the .direct package id picks the couchside-direct- prefix")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t, app_id="com.ets3d.rescueremote.direct", vc=3)
        out = os.path.join(t, "out")
        rc, _ = run(app, out)
        check("exit 0", rc, 0)
        check("files", listing(out), ["couchside-direct-2.9.61-vc3.apk",
                                      "couchside-direct-2.9.61-vc3.bundle-sha256",
                                      "couchside-direct-2.9.61-vc3.map",
                                      "couchside-direct-2.9.61-vc3.sha256"])
    print("--direct against a store APK is refused (wrong checkout)")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t)
        out = os.path.join(t, "out")
        rc, log = run(app, out, "--direct")
        check("non-zero", rc != 0, True)
        check("nothing archived", listing(out), [])


def test_r8_mapping_archived_when_present():
    print("R8 minify on: mapping.txt is archived too, and summed")
    with tempfile.TemporaryDirectory() as t:
        r8 = b"com.ets3d.X -> a.a:\n"
        app = make_tree(t, r8=r8)
        out = os.path.join(t, "out")
        rc, _ = run(app, out)
        check("exit 0", rc, 0)
        check("files", listing(out), ["couchside-2.9.61-vc109.apk",
                                      "couchside-2.9.61-vc109.bundle-sha256",
                                      "couchside-2.9.61-vc109.map",
                                      "couchside-2.9.61-vc109.r8-mapping.txt",
                                      "couchside-2.9.61-vc109.sha256"])
        if rc == 0:
            check("mapping copied", read(os.path.join(out, "couchside-2.9.61-vc109.r8-mapping.txt")), r8)
            sums = read(os.path.join(out, "couchside-2.9.61-vc109.sha256")).decode()
            check("mapping summed", "couchside-2.9.61-vc109.r8-mapping.txt" in sums, True)


def test_missing_map_fails_closed():
    print("CONTROL: same tree without the map -> non-zero and NOTHING archived")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t, map_bytes=None)
        out = os.path.join(t, "out")
        rc, log = run(app, out)
        check("non-zero", rc != 0, True)
        check("no APK archived without its map", listing(out), [])
        check("names the missing map", "no source map" in log, True)


def test_map_from_another_build_refused():
    print("a map whose bundle is not the APK's bundle is refused")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t, gen_bundle=HBC + b"-rebuilt")
        out = os.path.join(t, "out")
        rc, log = run(app, out)
        check("non-zero", rc != 0, True)
        check("nothing archived", listing(out), [])
        check("says why", "not from this APK's build" in log, True)


def test_unreadable_version_refused():
    print("no readable versionCode -> refused (never a guessed name)")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t, meta=False)
        out = os.path.join(t, "out")
        rc, _ = run(app, out)
        check("no metadata: non-zero", rc != 0, True)
        check("no metadata: nothing archived", listing(out), [])
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t, vc="10 9; rm -rf /")
        out = os.path.join(t, "out")
        rc, _ = run(app, out)
        check("non-numeric versionCode: non-zero", rc != 0, True)
        check("non-numeric versionCode: nothing archived", listing(out), [])


def test_no_clobber():
    print("an existing DIFFERENT archive at that name is refused; --force replaces; identical is a no-op")
    with tempfile.TemporaryDirectory() as t:
        app = make_tree(t)
        out = os.path.join(t, "out")
        os.makedirs(out)
        stale = os.path.join(out, "couchside-2.9.61-vc109.map")
        with open(stale, "wb") as f:
            f.write(b"a map from some other build")
        rc, log = run(app, out)
        check("refused", rc != 0, True)
        check("existing map untouched", read(stale), b"a map from some other build")
        check("APK not written either (checked before any write)",
              os.path.exists(os.path.join(out, "couchside-2.9.61-vc109.apk")), False)
        rc, _ = run(app, out, "--force")
        check("--force: exit 0", rc, 0)
        check("--force: replaced", read(stale), MAP)
        rc, _ = run(app, out)
        check("identical re-run: exit 0", rc, 0)


if __name__ == "__main__":
    if not shutil.which("bash"):
        print("bash not found")
        sys.exit(1)
    test_happy_path_store()
    test_direct_edition_prefix()
    test_r8_mapping_archived_when_present()
    test_missing_map_fails_closed()
    test_map_from_another_build_refused()
    test_unreadable_version_refused()
    test_no_clobber()
    print()
    if FAILURES:
        print("%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("all passed")
