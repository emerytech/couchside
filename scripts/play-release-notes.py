#!/usr/bin/env python3
"""play-release-notes.py — set Google Play "What's new" for a released build.

`eas submit -p android` uploads the AAB and creates the track release, but it
CANNOT set release notes (its android config only takes track/releaseStatus/
rollout/changesNotSentForReview). So the Play listing shows an empty "What's
new" unless someone types it into the Play Console by hand. This closes that
gap using the SAME service account eas submit already uses.

Usage:
    scripts/play-release-notes.py <versionCode> [--track production]
                                  [--notes app/changelogs/whatsnew-en-US.txt]
                                  [--lang en-US] [--dry-run]

    # normal release flow:
    eas submit -p android --profile production --path build.aab
    scripts/play-release-notes.py 34

Reads the notes from a file so they live in git with the code. Play caps the
text at 500 chars per language; this refuses to upload something longer rather
than let Google silently truncate it.

Auth: service-account JWT -> OAuth2 access token -> Android Publisher v3.
Requires `cryptography` (already used by the ASC tooling) — no google SDK.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from base64 import urlsafe_b64encode

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_KEY = os.path.join(REPO_ROOT, "secrets", "play-service-account.json")
DEFAULT_NOTES = os.path.join(REPO_ROOT, "app", "changelogs", "whatsnew-en-US.txt")
PACKAGE = "com.ets3d.rescueremote"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
MAX_LEN = 500  # Play's per-language limit


def _b64(raw: bytes) -> bytes:
    return urlsafe_b64encode(raw).rstrip(b"=")


def access_token(sa: dict) -> str:
    """Service-account JWT -> OAuth2 bearer token."""
    now = int(time.time())
    header = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64(json.dumps({
        "iss": sa["client_email"], "scope": SCOPE,
        "aud": sa["token_uri"], "iat": now, "exp": now + 3600,
    }).encode())
    signing_input = header + b"." + claims
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    sig = _b64(key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256()))
    assertion = (signing_input + b"." + sig).decode()

    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode()
    req = urllib.request.Request(sa["token_uri"], data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


def api(token: str, method: str, path: str, payload=None):
    url = f"{API}/{PACKAGE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"error: {method} {path} -> {e.code}\n{e.read().decode(errors='ignore')[:600]}")


def main() -> None:
    p = argparse.ArgumentParser(description="Set Google Play release notes for a versionCode.")
    p.add_argument("version_code", type=int, help="versionCode of the release to annotate")
    p.add_argument("--track", default="production")
    p.add_argument("--notes", default=DEFAULT_NOTES)
    p.add_argument("--lang", default="en-US")
    p.add_argument("--key", default=DEFAULT_KEY)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    if not os.path.isfile(a.key):
        sys.exit(f"error: service account key not found: {a.key}")
    if not os.path.isfile(a.notes):
        sys.exit(f"error: notes file not found: {a.notes}")
    text = open(a.notes, encoding="utf-8").read().strip()
    if not text:
        sys.exit(f"error: notes file is empty: {a.notes}")
    if len(text) > MAX_LEN:
        sys.exit(f"error: notes are {len(text)} chars; Play's limit is {MAX_LEN}. Trim {a.notes}.")

    print(f"==> notes ({len(text)}/{MAX_LEN} chars, {a.lang}):\n{text}\n")
    if a.dry_run:
        print("dry-run: nothing sent")
        return

    sa = json.load(open(a.key, encoding="utf-8"))
    token = access_token(sa)
    print(f"==> authenticated as {sa['client_email']}")

    edit_id = api(token, "POST", "/edits")["id"]
    print(f"==> edit {edit_id}")

    track = api(token, "GET", f"/edits/{edit_id}/tracks/{a.track}")
    releases = track.get("releases") or []
    target = next(
        (r for r in releases if str(a.version_code) in [str(v) for v in (r.get("versionCodes") or [])]),
        None,
    )
    if target is None:
        seen = [vc for r in releases for vc in (r.get("versionCodes") or [])]
        sys.exit(f"error: versionCode {a.version_code} not found on track '{a.track}' "
                 f"(present: {seen or 'none'}). Submit the build first.")

    target["releaseNotes"] = [{"language": a.lang, "text": text}]
    api(token, "PUT", f"/edits/{edit_id}/tracks/{a.track}",
        {"track": a.track, "releases": releases})
    api(token, "POST", f"/edits/{edit_id}:commit")
    print(f"OK: release notes set for versionCode {a.version_code} on '{a.track}' and committed.")


if __name__ == "__main__":
    main()
