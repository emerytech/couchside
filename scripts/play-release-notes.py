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
import subprocess
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


def api_soft(token: str, method: str, path: str, payload=None):
    """Like api(), but returns (ok, data_or_reason) instead of exiting.

    Exists for the POST-COMMIT readback. api()'s sys.exit is right on the write
    path — a failed write means the notes are not set, so stop. It is WRONG
    afterwards: by then the notes are already published, and a transient 500 or
    a dropped connection would make this script report a failed release that
    actually succeeded. Getting that backwards is how a "safety check" costs
    more than it saves.
    """
    url = f"{API}/{PACKAGE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return True, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return False, f"{method} {path} -> {e.code} {e.read().decode(errors='ignore')[:200]}"
    except Exception as e:  # noqa: BLE001 - transport, DNS, timeout
        return False, f"{method} {path} -> {e}"


def notes_match(sent: str, got: str) -> bool:
    """Is what Play stored the same notes we sent?

    Compared after normalising line endings and trailing whitespace, because
    those are round-trip artifacts and not a difference anyone shipped. Anything
    else — truncation, the wrong version's text, an empty field — is a real
    mismatch and must fail loudly.
    """
    def norm(s: str) -> str:
        return "\n".join(line.rstrip() for line in (s or "").replace("\r\n", "\n").split("\n")).strip()
    return norm(sent) == norm(got)


def read_back_notes(token: str, track: str, version_code: int, lang: str):
    """What Play ACTUALLY has for this versionCode now. (text, None) or (None, reason).

    Opens its own throwaway edit — an edit is a snapshot, so re-reading the one
    we just committed would hand back our own local changes rather than server
    state, which would make this check pass by construction. The edit is deleted
    afterwards so a verification run never leaves a dangling one behind.
    """
    ok, edit = api_soft(token, "POST", "/edits")
    if not ok:
        return None, str(edit)
    eid = (edit or {}).get("id")
    if not eid:
        return None, "no edit id in response"
    try:
        ok, t = api_soft(token, "GET", f"/edits/{eid}/tracks/{track}")
        if not ok:
            return None, str(t)
        for r in (t or {}).get("releases") or []:
            if str(version_code) in [str(v) for v in (r.get("versionCodes") or [])]:
                for n in r.get("releaseNotes") or []:
                    if n.get("language") == lang:
                        return n.get("text") or "", None
                # Release is there but carries no notes for this language. That
                # is a genuine failure, not an unmeasurable one: it is exactly
                # the empty "What's new" this script exists to prevent.
                return "", None
        return None, f"versionCode {version_code} not on track '{track}' after commit"
    finally:
        api_soft(token, "DELETE", f"/edits/{eid}")


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
    print(f"==> committed edit {edit_id}; reading the notes back from Play")

    # READ THE ARTIFACT, NOT THE EXIT CODE (CLAUDE.md §11.4). This script used
    # to print OK on the strength of the :commit call returning 200 — which is
    # exactly the shape that once published a stale changelog and exited 0. A
    # 200 means Play accepted the edit, not that the listing now says what we
    # sent.
    #
    # Three outcomes, deliberately different:
    #   match      -> success
    #   mismatch   -> HARD FAIL. Wrong text on the live listing is the bug.
    #   unreadable -> WARN ONLY. The notes are already committed by this point,
    #                 so a transient error here must never be reported as a
    #                 failed release (see api_soft).
    got, why = read_back_notes(token, a.track, a.version_code, a.lang)
    if why is not None:
        print(f"WARNING: could not verify the notes ({why}).\n"
              f"         The commit succeeded; check the Play Console listing by hand.",
              file=sys.stderr)
    elif not notes_match(text, got):
        sys.exit(
            "error: Play does not show the notes that were just sent.\n"
            f"  sent ({len(text)} chars): {text[:160]!r}\n"
            f"  play ({len(got)} chars): {got[:160]!r}\n"
            "The edit WAS committed, so fix the listing in the Play Console — "
            "re-running this script will not help if the input file is wrong.")
    else:
        print(f"==> verified: Play shows the {len(got)}-char notes we sent")
    print(f"OK: release notes set for versionCode {a.version_code} on '{a.track}' and committed.")

    # Keep couchside.tv/app-version.json (the Android update-check source) in step
    # with this release. Best-effort and non-fatal: the notes are already
    # committed, so a missing ets3d checkout or a deploy hiccup must WARN, never
    # unwind the release. Skipped for non-production tracks (only the live
    # listing feeds the in-app check).
    if a.track == "production":
        pub = os.path.join(REPO_ROOT, "scripts", "publish-app-version.py")
        try:
            print("==> updating couchside.tv/app-version.json for the Android update check")
            subprocess.run([sys.executable, pub, "--version-code", str(a.version_code)],
                           check=True)
        except Exception as e:  # noqa: BLE001 - best-effort, must not fail the release
            print(f"WARNING: could not update app-version.json ({e}). Run manually:\n"
                  f"         scripts/publish-app-version.py --version-code {a.version_code}",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
