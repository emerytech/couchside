#!/usr/bin/env python3
"""asc-screenshots.py — upload App Store screenshots to the editable iOS version.

App Store screenshots are LOCKED on a live version; they can only be changed on an
editable appStoreVersion (PREPARE_FOR_SUBMISSION / *_REJECTED). So this runs as part
of the NEXT release chain: after `asc-submit.py` has created/attached the next version
(while it is still editable, BEFORE it is submitted for review), point this at that
version to (re)build the iPhone + iPad screenshot sets, then submit.

Reuses the SAME ES256 key as asc-submit.py (app/asc-key.p8 via app/eas.json), so no
fastlane, no clicking.

Upload flow per screenshot (App Store Connect API v1):
  1. reserve:  POST /v1/appScreenshots {fileName,fileSize, rel->appScreenshotSet}
               -> response carries `uploadOperations` (method,url,length,offset,headers)
  2. upload:   for each operation, PUT the byte slice [offset,offset+length] to url
               with the EXACT headers Apple returned (NO Authorization on these URLs)
  3. commit:   PATCH /v1/appScreenshots/{id} {uploaded:true, sourceFileChecksum:<md5>}
  4. poll:     GET the screenshot until assetDeliveryState.state == COMPLETE
Then PATCH the set's appScreenshots relationship to fix display order.

Display types (screenshotDisplayType) — Apple shares one slot across the sibling sizes:
  * iPhone 1320x2868 (6.9") AND 1290x2796 (6.7") -> APP_IPHONE_67
  * iPad  2064x2752 (13")   AND 2048x2732 (12.9") -> APP_IPAD_PRO_3GEN_129
These are the CURRENT defaults but Apple renames enums; --dry-run first PRINTS the real
screenshotDisplayType values already on the version so you upload into the right slot.

Defaults to READ-ONLY (--dry-run): authenticates, finds the editable version + en-US
localization, lists the existing screenshot sets (real display types + counts), and lists
what it WOULD upload. Mutates nothing. Pass --submit to actually upload.

UNVERIFIED as of 2026-07-23: written against the ASC API docs but not yet exercised end to
end (2.9.22 is live, no editable version to test on). Dry-run the discovery first; upload
one set; confirm in App Store Connect before trusting the rest.

Usage:
  scripts/asc-screenshots.py --version 2.9.23                          # inspect only
  scripts/asc-screenshots.py --version 2.9.23 --submit --replace       # do it
    [--iphone-dir DIR] [--ipad-dir DIR]   (default: the persisted 2.9.x sets, see below)
    [--iphone-type APP_IPHONE_67] [--ipad-type APP_IPAD_PRO_3GEN_129]
    [--lang en-US]
"""
import argparse
import hashlib
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
API = "https://api.appstoreconnect.apple.com"

# where the captioned finals live (persisted out of the ephemeral scratchpad)
ASSETS = os.path.expanduser("~/Developer/couchside-store-assets/appstore-screenshots-2.9.x")
DEFAULT_IPHONE_DIR = os.path.join(ASSETS, "iphone-6.9")
DEFAULT_IPAD_DIR = os.path.join(ASSETS, "ipad-13")

EDITABLE_STATES = {
    "PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
    "METADATA_REJECTED", "INVALID_BINARY",
}


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

    def upload_part(self, op, blob: bytes):
        """PUT one part to Apple's pre-signed upload URL — NO ASC auth header."""
        chunk = blob[op["offset"]:op["offset"] + op["length"]]
        r = urllib.request.Request(op["url"], data=chunk, method=op["method"])
        for h in op.get("requestHeaders", []):
            r.add_header(h["name"], h["value"])
        try:
            with urllib.request.urlopen(r) as resp:
                resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            sys.exit(f"error: upload PUT -> {e.code}\n{detail}")


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


def pngs(d):
    if not os.path.isdir(d):
        return []
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.lower().endswith(".png")]


def get_localization(asc, ver_id, lang):
    locs = asc.req(
        "GET",
        f"/v1/appStoreVersions/{ver_id}/appStoreVersionLocalizations"
        f"?limit=50&fields[appStoreVersionLocalizations]=locale",
    ).get("data", [])
    loc = next((l for l in locs if l["attributes"]["locale"] == lang), None)
    if not loc:
        sys.exit(f"error: no {lang} localization on this version "
                 f"(have: {[l['attributes']['locale'] for l in locs]})")
    return loc["id"]


def list_sets(asc, loc_id):
    sets = asc.req(
        "GET",
        f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets"
        f"?limit=50&include=appScreenshots"
        f"&fields[appScreenshotSets]=screenshotDisplayType,appScreenshots",
    )
    out = {}
    for s in sets.get("data", []):
        dt = s["attributes"]["screenshotDisplayType"]
        n = len((s.get("relationships", {}).get("appScreenshots", {}) or {}).get("data", []) or [])
        out[dt] = {"id": s["id"], "count": n}
    return out


def get_or_create_set(asc, loc_id, display_type, existing):
    if display_type in existing:
        return existing[display_type]["id"]
    created = asc.req("POST", "/v1/appScreenshotSets", {
        "data": {
            "type": "appScreenshotSets",
            "attributes": {"screenshotDisplayType": display_type},
            "relationships": {
                "appStoreVersionLocalization": {
                    "data": {"type": "appStoreVersionLocalizations", "id": loc_id}
                }
            },
        }
    })["data"]
    print(f"    created screenshot set for {display_type} id={created['id']}")
    return created["id"]


def clear_set(asc, set_id):
    shots = asc.req("GET", f"/v1/appScreenshotSets/{set_id}/appScreenshots"
                           f"?limit=50&fields[appScreenshots]=fileName").get("data", [])
    for sh in shots:
        asc.req("DELETE", f"/v1/appScreenshots/{sh['id']}")
    if shots:
        print(f"    cleared {len(shots)} existing screenshot(s)")


def upload_one(asc, set_id, path):
    blob = open(path, "rb").read()
    reserved = asc.req("POST", "/v1/appScreenshots", {
        "data": {
            "type": "appScreenshots",
            "attributes": {"fileName": os.path.basename(path), "fileSize": len(blob)},
            "relationships": {
                "appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}
            },
        }
    })["data"]
    sid = reserved["id"]
    for op in reserved["attributes"]["uploadOperations"]:
        asc.upload_part(op, blob)
    md5 = hashlib.md5(blob).hexdigest()
    asc.req("PATCH", f"/v1/appScreenshots/{sid}", {
        "data": {
            "type": "appScreenshots", "id": sid,
            "attributes": {"uploaded": True, "sourceFileChecksum": md5},
        }
    })
    # poll delivery
    for _ in range(30):
        st = asc.req("GET", f"/v1/appScreenshots/{sid}"
                            f"?fields[appScreenshots]=assetDeliveryState")["data"]
        state = (st["attributes"].get("assetDeliveryState") or {}).get("state")
        if state == "COMPLETE":
            break
        if state == "FAILED":
            errs = (st["attributes"]["assetDeliveryState"] or {}).get("errors")
            sys.exit(f"error: {os.path.basename(path)} delivery FAILED: {errs}")
        time.sleep(2)
    print(f"    uploaded {os.path.basename(path)} ({len(blob)} bytes) id={sid}")
    return sid


def set_order(asc, set_id, ids):
    asc.req("PATCH", f"/v1/appScreenshotSets/{set_id}/relationships/appScreenshots",
            {"data": [{"type": "appScreenshots", "id": i} for i in ids]})
    print(f"    set display order ({len(ids)} shots)")


def main():
    p = argparse.ArgumentParser(description="Upload App Store screenshots to the editable iOS version.")
    p.add_argument("--version", required=True, help="marketing version of the EDITABLE target, e.g. 2.9.23")
    p.add_argument("--submit", action="store_true", help="actually upload (default: dry-run discovery)")
    p.add_argument("--replace", action="store_true", help="delete existing screenshots in each set first")
    p.add_argument("--iphone-dir", default=DEFAULT_IPHONE_DIR)
    p.add_argument("--ipad-dir", default=DEFAULT_IPAD_DIR)
    p.add_argument("--iphone-type", default="APP_IPHONE_67")
    p.add_argument("--ipad-type", default="APP_IPAD_PRO_3GEN_129")
    p.add_argument("--lang", default="en-US")
    a = p.parse_args()

    cfg = load_cfg()
    asc = ASC(make_jwt(cfg["key_path"], cfg["kid"], cfg["iss"]))
    dry = not a.submit
    tag = "DRY-RUN" if dry else "UPLOAD"

    iphone = pngs(a.iphone_dir)
    ipad = pngs(a.ipad_dir)
    print(f"[{tag}] iPhone dir {a.iphone_dir}: {len(iphone)} png -> {a.iphone_type}")
    print(f"[{tag}] iPad   dir {a.ipad_dir}: {len(ipad)} png -> {a.ipad_type}")
    if not iphone and not ipad:
        sys.exit("error: no PNGs found in either dir")

    vers = asc.req(
        "GET",
        f"/v1/apps/{cfg['appId']}/appStoreVersions?filter[platform]=IOS&limit=10"
        f"&fields[appStoreVersions]=versionString,appStoreState",
    ).get("data", [])
    ver = next((v for v in vers
                if v["attributes"]["versionString"] == a.version
                and v["attributes"]["appStoreState"] in EDITABLE_STATES), None)
    if not ver:
        live = next((v for v in vers if v["attributes"]["versionString"] == a.version), None)
        if live:
            sys.exit(f"error: version {a.version} is not editable "
                     f"(state={live['attributes']['appStoreState']}). Screenshots can only be "
                     f"changed on an editable version — create/attach the next version first "
                     f"(asc-submit.py) and run this BEFORE submitting it for review.")
        sys.exit(f"error: no appStoreVersion {a.version} found. Create it first (asc-submit.py).")
    ver_id = ver["id"]
    print(f"[{tag}] version {a.version}: state={ver['attributes']['appStoreState']} id={ver_id}")

    loc_id = get_localization(asc, ver_id, a.lang)
    existing = list_sets(asc, loc_id)
    print(f"[{tag}] existing screenshot sets on {a.lang}:")
    for dt, info in (existing or {"(none)": {"count": 0}}).items():
        print(f"    {dt}: {info.get('count', 0)} shot(s)")

    plan = [(a.iphone_type, iphone), (a.ipad_type, ipad)]
    if dry:
        print("\n[DRY-RUN] would, for each set: "
              + ("clear then " if a.replace else "")
              + "upload in filename order, then fix display order:")
        for dt, files in plan:
            if files:
                print(f"    {dt}: {[os.path.basename(f) for f in files]}")
        print("\ndry-run: nothing sent. Confirm the display-type enums above match Apple's real "
              "slots, then re-run with --submit (+ --replace to overwrite).")
        return

    for dt, files in plan:
        if not files:
            continue
        print(f"[{tag}] {dt}:")
        set_id = get_or_create_set(asc, loc_id, dt, existing)
        if a.replace:
            clear_set(asc, set_id)
        ids = [upload_one(asc, set_id, f) for f in files]
        set_order(asc, set_id, ids)
    print(f"OK: uploaded screenshots to {a.version}. Review in App Store Connect, then submit "
          f"(asc-submit.py ... --submit) — the shots ride that submission.")


if __name__ == "__main__":
    main()
