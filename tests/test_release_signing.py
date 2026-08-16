#!/usr/bin/env python3
"""The release self-verification checks the keys a BOX trusts, not its own.

Run: python3 tests/test_release_signing.py

WHY THIS EXISTS. scripts/release-agent.sh and scripts/sign-release.sh both did:

    openssl pkey -in "$key" -pubout -out pub.pem     # from the SIGNING key
    openssl pkeyutl -verify -pubin -inkey pub.pem ...

That derives the public half from the very key that just produced the signature,
so it succeeds BY CONSTRUCTION for any key. It could never detect the single
failure it claimed to prevent -- "never publish a signature install.sh would
reject" -- because it never consulted install.sh's keys at all. Sign with a
wrong or rotated key and it passed, uploaded cleanly, and was then refused by
verify_release_sig() on EVERY user's box, after the release was public.

The control below is the point of this suite: it runs the PRE-FIX sequence and
asserts it PASSES against a key no box trusts. A guard is only proven once you
have watched the thing it replaced fail to notice.

Pure stdlib, no pytest. Needs an openssl with Ed25519 `-rawin` (CI has OpenSSL 3).
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INSTALLER = os.path.join(ROOT, "install.sh")
HELPER = os.path.join(ROOT, "scripts", "release-keys.sh")

FAILURES = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def _openssl():
    """An openssl that can do Ed25519 one-shot signing, or None."""
    for cand in ("openssl", "/opt/homebrew/opt/openssl@3/bin/openssl",
                 "/usr/local/opt/openssl@3/bin/openssl"):
        exe = shutil.which(cand) if os.sep not in cand else (
            cand if os.access(cand, os.X_OK) else None)
        if not exe:
            continue
        r = subprocess.run([exe, "pkeyutl", "-help"], capture_output=True, text=True)
        if "-rawin" in (r.stdout + r.stderr):
            return exe
    return None


OSSL = _openssl()


def _run_helper(installer, sums, sig):
    """Call verify_against_installer and return its numeric verdict."""
    script = (
        '. "%s"\n'
        'verify_against_installer "%s" "%s" "%s" "%s"\n'
        'echo "rc=$?"\n' % (HELPER, installer, sums, sig, OSSL)
    )
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.startswith("rc="):
            return int(line[3:])
    return -1


def main():
    if OSSL is None:
        # Never silently skip: a "green" run that tested nothing is the exact
        # failure mode this repo has been bitten by.
        print("FAILED: no openssl with Ed25519 -rawin available")
        sys.exit(1)

    tmp = tempfile.mkdtemp(prefix="couchside-signing-")
    try:
        key = os.path.join(tmp, "throwaway.key")
        sums = os.path.join(tmp, "SHA256SUMS")
        sig = os.path.join(tmp, "SHA256SUMS.sig")
        subprocess.run([OSSL, "genpkey", "-algorithm", "ED25519", "-out", key],
                       check=True, capture_output=True)
        with open(sums, "w") as f:
            f.write("deadbeef  couchsided.py\n")
        subprocess.run([OSSL, "pkeyutl", "-sign", "-inkey", key, "-rawin",
                        "-in", sums, "-out", sig], check=True, capture_output=True)

        pub = os.path.join(tmp, "throwaway.pub")
        subprocess.run([OSSL, "pkey", "-in", key, "-pubout", "-out", pub],
                       check=True, capture_output=True)
        pub_pem = open(pub).read().strip()

        print("the real install.sh REJECTS a key no box trusts")
        check("throwaway-signed sums vs the shipped keys -> 1 (reject)",
              _run_helper(INSTALLER, sums, sig), 1)

        print("an installer embedding that key ACCEPTS it")
        fake = os.path.join(tmp, "fake-install.sh")
        with open(fake, "w") as f:
            f.write("RELEASE_PUBKEY_PEM='%s'\n" % pub_pem)
        check("matching embedded key -> 0 (accept)",
              _run_helper(fake, sums, sig), 0)

        print("either key satisfies it (install.sh's own rule)")
        fake2 = os.path.join(tmp, "fake-backup.sh")
        other = os.path.join(tmp, "other.key")
        otherpub = os.path.join(tmp, "other.pub")
        subprocess.run([OSSL, "genpkey", "-algorithm", "ED25519", "-out", other],
                       check=True, capture_output=True)
        subprocess.run([OSSL, "pkey", "-in", other, "-pubout", "-out", otherpub],
                       check=True, capture_output=True)
        with open(fake2, "w") as f:
            f.write("RELEASE_PUBKEY_PEM='%s'\n" % open(otherpub).read().strip())
            f.write("RELEASE_PUBKEY_PEM_BACKUP='%s'\n" % pub_pem)
        check("signature matching only the BACKUP key -> 0 (accept)",
              _run_helper(fake2, sums, sig), 0)

        print("fail closed")
        nokeys = os.path.join(tmp, "nokeys.sh")
        with open(nokeys, "w") as f:
            f.write("# an installer with no embedded keys at all\n")
        check("no embedded keys -> 2 (hard abort, never 'nothing to check')",
              _run_helper(nokeys, sums, sig), 2)
        check("unreadable installer -> 2",
              _run_helper(os.path.join(tmp, "does-not-exist.sh"), sums, sig), 2)

        # ---- THE CONTROL -------------------------------------------------
        # Reproduce the pre-fix self-check and watch it accept a key that every
        # box would refuse. Without this, the assertions above only show the new
        # code working; they do not show that the old code was broken.
        print("control: the PRE-FIX self-check accepts a key no box trusts")
        r = subprocess.run(
            [OSSL, "pkeyutl", "-verify", "-pubin", "-inkey", pub, "-rawin",
             "-in", sums, "-sigfile", sig],
            capture_output=True, text=True)
        prefix_ok = "Verified Successfully" in (r.stdout + r.stderr)
        check("pre-fix check PASSES the throwaway key (the bug)", prefix_ok, True)
        check("...while a real box REJECTS the same signature",
              _run_helper(INSTALLER, sums, sig), 1)

        # ---- wiring pins (weaker evidence; labelled as such) --------------
        print("wiring (textual pins, not behaviour)")
        for name in ("release-agent.sh", "sign-release.sh"):
            src = open(os.path.join(ROOT, "scripts", name)).read()
            check("%s sources release-keys.sh" % name,
                  "release-keys.sh" in src, True)
            check("%s calls verify_against_installer" % name,
                  "verify_against_installer" in src, True)
            check("%s no longer derives a pubkey from the signing key" % name,
                  'pkey -in "$key" -pubout' in src, False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))
        sys.exit(1)
    print("all release-signing tests passed")


if __name__ == "__main__":
    main()
