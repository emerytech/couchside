#!/usr/bin/env python3
"""asc-submit.py — submit an already-uploaded iOS build for App Store review.

`eas submit -p ios` uploads the binary to App Store Connect (TestFlight), but it
does NOT create the App Store version or submit it for review. This does the rest
via the App Store Connect API, using the SAME ES256 key eas already uses
(app/asc-key.p8), so no fastlane, no manual clicking.

Flow (App Store Connect API v1):
  1. find the app (ascAppId) + the processed build for our version/buildNumber
  2. get-or-create the editable appStoreVersion (PREPARE_FOR_SUBMISSION) for the
     marketing version, set its releaseType
  3. attach the build to that version
  4. set the "What's New" (whatsNew) en-US localization
  5. create a reviewSubmission (IOS) + add the version, then submit it

Defaults to READ-ONLY (--dry-run): prints the app/build/version state and the
exact steps it WOULD take, mutating nothing. Pass --submit to actually do it.

Usage:
  scripts/asc-submit.py --version 2.9.8 --build 59                 # inspect only
  scripts/asc-submit.py --version 2.9.8 --build 59 --submit        # do it
    [--release-type AFTER_APPROVAL|MANUAL|SCHEDULED] (default AFTER_APPROVAL)
    [--notes app/changelogs/whatsnew-en-US.txt] [--lang en-US]

Auth/config are read from app/eas.json (submit.production.ios) so there is one
source of truth: ascAppId, ascApiKeyId, ascApiKeyIssuerId, ascApiKeyPath.
Requires `cryptography` (already used by the Play tooling).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from base64 import urlsafe_b64encode

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.serialization import load_pem_private_key

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EAS = os.path.join(REPO, "app", "eas.json")
DEFAULT_NOTES = os.path.join(REPO, "app", "changelogs", "whatsnew-en-US.txt")
API = "https://api.appstoreconnect.apple.com"


def _b64(b: bytes) -> bytes:
    return urlsafe_b64encode(b).rstrip(b"=")


def make_jwt(key_path: str, kid: str, iss: str) -> str:
    with open(key_path, "rb") as f:
        key = load_pem_private_key(f.read(), password=None)
    now = int(time.time())
    header = {"alg": "ES256", "kid": kid, "typ": "JWT"}
    payload = {"iss": iss, "iat": now, "exp": now + 1000, "aud": "appstoreconnect-v1"}
    si = _b64(json.dumps(header).encode()) + b"." + _b64(json.dumps(payload).encode())
    der = key.sign(si, ec.ECDSA(SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return (si + b"." + _b64(raw)).decode()


class ASC:
    def __init__(self, token: str):
        self.token = token

    def req(self, method: str, path: str, body=None):
        url = path if path.startswith("http") else API + path
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            sys.exit(f"error: ASC {method} {path} -> {e.code}\n{detail}")


def load_cfg():
    with open(EAS) as f:
        ios = json.load(f)["submit"]["production"]["ios"]
    key_path = ios["ascApiKeyPath"]
    if not os.path.isabs(key_path):
        key_path = os.path.normpath(os.path.join(REPO, "app", key_path))
    return {
        "appId": str(ios["ascAppId"]),
        "kid": ios["ascApiKeyId"],
        "iss": ios["ascApiKeyIssuerId"],
        "key_path": key_path,
    }


def main():
    p = argparse.ArgumentParser(description="Submit an uploaded iOS build for App Store review.")
    p.add_argument("--version", required=True, help="marketing version, e.g. 2.9.8")
    p.add_argument("--build", required=True, help="build number (CFBundleVersion), e.g. 59")
    p.add_argument("--submit", action="store_true", help="actually mutate + submit (default: dry-run)")
    p.add_argument("--release-type", default="AFTER_APPROVAL",
                   choices=["AFTER_APPROVAL", "MANUAL", "SCHEDULED"])
    p.add_argument("--notes", default=DEFAULT_NOTES)
    p.add_argument("--lang", default="en-US")
    a = p.parse_args()

    cfg = load_cfg()
    asc = ASC(make_jwt(cfg["key_path"], cfg["kid"], cfg["iss"]))
    dry = not a.submit
    tag = "DRY-RUN" if dry else "SUBMIT"

    # notes
    notes = ""
    if os.path.exists(a.notes):
        with open(a.notes) as f:
            notes = f.read().strip()
    if len(notes) > 4000:
        sys.exit("error: whatsNew exceeds 4000 chars")

    app = asc.req("GET", f"/v1/apps/{cfg['appId']}")["data"]
    print(f"[{tag}] app: {app['attributes']['name']} ({app['attributes']['bundleId']})  id={app['id']}")

    # find the processed build matching version + buildNumber
    builds = asc.req(
        "GET",
        f"/v1/builds?filter[app]={cfg['appId']}&filter[version]={a.build}"
        f"&filter[preReleaseVersion.version]={a.version}&limit=5"
        f"&fields[builds]=version,processingState,expired",
    ).get("data", [])
    if not builds:
        builds = asc.req(
            "GET",
            f"/v1/builds?filter[app]={cfg['appId']}&filter[version]={a.build}&limit=10"
            f"&fields[builds]=version,processingState,expired",
        ).get("data", [])
    if not builds:
        sys.exit(f"error: no build {a.build} found for app {cfg['appId']}")
    build = builds[0]
    st = build["attributes"]["processingState"]
    print(f"[{tag}] build {a.build}: processingState={st} expired={build['attributes'].get('expired')} id={build['id']}")
    if st != "VALID":
        sys.exit(f"error: build {a.build} not ready (processingState={st}); "
                 f"Apple is still processing it — wait and retry.")

    # editable app store version for this marketing version?
    vers = asc.req(
        "GET",
        f"/v1/apps/{cfg['appId']}/appStoreVersions?filter[platform]=IOS&limit=10"
        f"&fields[appStoreVersions]=versionString,appStoreState,releaseType",
    ).get("data", [])
    editable_states = {
        "PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
        "METADATA_REJECTED", "INVALID_BINARY",
    }
    ver = next((v for v in vers
                if v["attributes"]["versionString"] == a.version
                and v["attributes"]["appStoreState"] in editable_states), None)
    if ver:
        print(f"[{tag}] reuse version {a.version}: state={ver['attributes']['appStoreState']} id={ver['id']}")
    else:
        live = next((v for v in vers if v["attributes"]["versionString"] == a.version), None)
        if live:
            sys.exit(f"error: version {a.version} exists but is not editable "
                     f"(state={live['attributes']['appStoreState']}).")
        print(f"[{tag}] will CREATE appStoreVersion {a.version} (IOS, releaseType={a.release_type})")

    print(f"[{tag}] will attach build {a.build}, set whatsNew ({len(notes)} chars, {a.lang}), submit for review")
    if dry:
        print("\ndry-run: nothing sent. re-run with --submit to do it.")
        return

    # 1. create version if needed
    if not ver:
        ver = asc.req("POST", "/v1/appStoreVersions", {
            "data": {
                "type": "appStoreVersions",
                "attributes": {
                    "platform": "IOS",
                    "versionString": a.version,
                    "releaseType": a.release_type,
                },
                "relationships": {"app": {"data": {"type": "apps", "id": cfg["appId"]}}},
            }
        })["data"]
        print(f"  created appStoreVersion id={ver['id']}")
    ver_id = ver["id"]

    # 2. attach build
    asc.req("PATCH", f"/v1/appStoreVersions/{ver_id}/relationships/build",
            {"data": {"type": "builds", "id": build["id"]}})
    print(f"  attached build {a.build}")

    # 3. whatsNew localization (only for a non-first release; harmless if unused)
    if notes:
        locs = asc.req("GET", f"/v1/appStoreVersions/{ver_id}/appStoreVersionLocalizations"
                              f"?limit=50&fields[appStoreVersionLocalizations]=locale").get("data", [])
        loc = next((l for l in locs if l["attributes"]["locale"] == a.lang), None)
        if loc:
            asc.req("PATCH", f"/v1/appStoreVersionLocalizations/{loc['id']}",
                    {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"],
                              "attributes": {"whatsNew": notes}}})
            print(f"  set whatsNew on {a.lang}")
        else:
            print(f"  warn: no {a.lang} localization to set whatsNew on; skipping")

    # 4. create reviewSubmission (or reuse an open one) and add the version
    subs = asc.req("GET", f"/v1/reviewSubmissions?filter[app]={cfg['appId']}"
                          f"&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW"
                          f"&filter[platform]=IOS&limit=5").get("data", [])
    sub = next((s for s in subs if s["attributes"].get("state") == "READY_FOR_REVIEW"), None)
    if not sub:
        sub = asc.req("POST", "/v1/reviewSubmissions", {
            "data": {
                "type": "reviewSubmissions",
                "attributes": {"platform": "IOS"},
                "relationships": {"app": {"data": {"type": "apps", "id": cfg["appId"]}}},
            }
        })["data"]
        print(f"  created reviewSubmission id={sub['id']}")
    sub_id = sub["id"]

    asc.req("POST", "/v1/reviewSubmissionItems", {
        "data": {
            "type": "reviewSubmissionItems",
            "relationships": {
                "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub_id}},
                "appStoreVersion": {"data": {"type": "appStoreVersions", "id": ver_id}},
            },
        }
    })
    print("  added version to the review submission")

    asc.req("PATCH", f"/v1/reviewSubmissions/{sub_id}",
            {"data": {"type": "reviewSubmissions", "id": sub_id, "attributes": {"submitted": True}}})
    print(f"OK: submitted {a.version} (build {a.build}) for App Store review "
          f"[releaseType={a.release_type}].")


if __name__ == "__main__":
    main()
