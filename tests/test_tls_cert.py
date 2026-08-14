#!/usr/bin/env python3
"""Tests for the box-side TLS cert lifecycle (P1): parse, mint, re-sign, pin.

Run: python3 tests/test_tls_cert.py

TLS is a DARK, additive transport (see docs/memory/project_tls-encryption.md):
the agent keeps its plaintext listener and, when tls.enabled, serves HTTPS on a
second port with a self-signed cert it mints via openssl. These are the unit
checks for the cert plumbing that does NOT need a live socket (the live handshake
+ auth gate over TLS is test_tls_smoke.py).

Load-bearing property proven here: an IP-drift RE-SIGN reuses the private key, so
the SPKI hash (the recommended app pin) is STABLE while the full-cert fingerprint
changes. If that ever regressed, every phone's pin would break on a subnet move —
so it is asserted in BOTH directions (spki same, fp different), not just one.

Degrade-closed is proven too: a malformed tls block yields a disabled/None config
rather than raising, so a bad field can neither crash the agent nor silently flip
encryption on.

Pure stdlib, no pytest -- same style as the other agent tests.
"""
import hashlib
import importlib.util
import os
import ssl
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label +
          ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _spki(cert_pem):
    d = tempfile.mkdtemp(prefix="tlst_")
    p = os.path.join(d, "c.pem")
    with open(p, "w") as f:
        f.write(cert_pem)
    return cs._tls_spki_fp(p)


def _san(cert_pem):
    """SubjectAltName strings from a PEM, via the same openssl the agent assumes."""
    import subprocess
    d = tempfile.mkdtemp(prefix="tlss_")
    p = os.path.join(d, "c.pem")
    with open(p, "w") as f:
        f.write(cert_pem)
    r = subprocess.run(["openssl", "x509", "-in", p, "-noout", "-ext",
                        "subjectAltName"], capture_output=True, text=True)
    return r.stdout


def test_parse_tls():
    # DEFAULT-ON (2.9.88): an absent tls block enables TLS on the default port.
    check(cs._parse_tls({}) == {"enabled": True, "port": cs.DEFAULT_TLS_PORT},
          "no tls block -> default ON", cs._parse_tls({}))
    # enabled + explicit port
    got = cs._parse_tls({"tls": {"enabled": True, "port": 9443}})
    check(got == {"enabled": True, "port": 9443}, "enabled+port parsed", got)
    # default port when omitted
    got = cs._parse_tls({"tls": {"enabled": True}})
    check(got and got["port"] == cs.DEFAULT_TLS_PORT,
          "default port applied", got)
    # enabled defaults TRUE within a block too (an empty block means on)
    got = cs._parse_tls({"tls": {}})
    check(got == {"enabled": True, "port": cs.DEFAULT_TLS_PORT},
          "enabled defaults True", got)
    # OPT-OUT: explicit enabled:false is respected
    got = cs._parse_tls({"tls": {"enabled": False}})
    check(got == {"enabled": False, "port": cs.DEFAULT_TLS_PORT},
          "enabled:false respected (opt-out)", got)
    # DEGRADE CLOSED for TYPES: a non-dict tls block never raises; it falls back to
    # the default-on config (TLS is additive — a garbled block should not silently
    # DISABLE the encryption a plain box now gets).
    check(cs._parse_tls({"tls": 5}) == {"enabled": True, "port": cs.DEFAULT_TLS_PORT},
          "non-dict tls -> default ON (no raise)", cs._parse_tls({"tls": 5}))
    got = cs._parse_tls({"tls": {"enabled": True, "port": "nope"}})
    check(got and got["port"] == cs.DEFAULT_TLS_PORT,
          "bad port falls back to default (no raise)", got)
    got = cs._parse_tls({"tls": {"enabled": True, "port": True}})
    check(got and got["port"] == cs.DEFAULT_TLS_PORT,
          "bool port rejected (bool is not a valid port)", got)
    # cert/key/sans round-trip
    got = cs._parse_tls({"tls": {"enabled": True, "cert": "C", "key": "K",
                                 "sans": ["IP:1.2.3.4"], "fp": "ff"}})
    check(got.get("cert") == "C" and got.get("key") == "K"
          and got.get("sans") == ["IP:1.2.3.4"] and got.get("fp") == "ff",
          "cert/key/sans/fp round-trip", got)
    # a non-string sans list is dropped, not crashed
    got = cs._parse_tls({"tls": {"enabled": True, "sans": [1, 2]}})
    check("sans" not in got, "invalid sans dropped", got)


def test_desired_sans():
    sans = cs._tls_desired_sans()
    check("DNS:localhost" in sans and "IP:127.0.0.1" in sans,
          "desired SANs cover loopback", sans)
    check("DNS:couchside" in sans, "desired SANs include couchside", sans)
    # the .local hostname is present (mDNS reachability)
    check(any(s.startswith("DNS:") and s.endswith(".local") for s in sans),
          "desired SANs include a .local hostname", sans)


def test_mint_and_fingerprints():
    sans = ["IP:10.0.0.5", "DNS:box.local", "DNS:localhost", "IP:127.0.0.1"]
    cert_pem, key_pem = cs._tls_generate_server_cert(sans)
    check(cert_pem.startswith("-----BEGIN CERTIFICATE-----"), "cert is PEM")
    check("PRIVATE KEY" in key_pem, "key is PEM")
    # the cert actually carries the SANs we asked for (the DNS:couchside-only bug
    # the ATV precedent would have shipped is what this guards against)
    san_txt = _san(cert_pem)
    check("10.0.0.5" in san_txt and "box.local" in san_txt
          and "127.0.0.1" in san_txt, "cert SAN carries IP + .local + loopback",
          san_txt.strip())
    # fingerprints are real 64-hex
    fp = cs._tls_fp(cert_pem)
    spki = _spki(cert_pem)
    check(isinstance(fp, str) and len(fp) == 64, "fp is 64-hex sha256", fp)
    check(isinstance(spki, str) and len(spki) == 64, "spki is 64-hex sha256", spki)
    # fp is the DER-cert sha256 (independent recompute)
    der = ssl.PEM_cert_to_DER_cert(cert_pem)
    check(fp == hashlib.sha256(der).hexdigest(), "fp == sha256(DER cert)")
    # the cert loads as a servable chain (would raise if malformed)
    d = tempfile.mkdtemp(prefix="tlsl_")
    cp, kp = os.path.join(d, "c"), os.path.join(d, "k")
    open(cp, "w").write(cert_pem)
    open(kp, "w").write(key_pem)
    ok = True
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cp, kp)
    except Exception as e:
        ok = False
        detail = e
    check(ok, "cert+key load as a TLS_SERVER chain",
          "" if ok else detail)


def test_resign_reuses_key_spki_stable():
    """IP drift: re-sign with a new SAN reusing the key. SPKI (the pin) must be
    stable; the full-cert fp must change; the key bytes must be identical."""
    c1, k1 = cs._tls_generate_server_cert(["DNS:localhost", "IP:127.0.0.1"])
    c2, k2 = cs._tls_generate_server_cert(
        ["DNS:localhost", "IP:127.0.0.1", "IP:10.9.9.9"], existing_key_pem=k1)
    check(k1 == k2, "re-sign reused the private key verbatim")
    check(_spki(c1) == _spki(c2), "SPKI STABLE across re-sign (pin survives)")
    check(cs._tls_fp(c1) != cs._tls_fp(c2), "full-cert fp CHANGED across re-sign")
    check("10.9.9.9" in _san(c2), "re-signed cert carries the new IP SAN")


def test_materialize_key_perms():
    cp, kp = cs._tls_materialize("CERTPEM", "KEYPEM")
    mode = oct(os.stat(kp).st_mode & 0o777)
    check(mode == "0o600", "materialized key is chmod 0600", mode)
    check(open(cp).read() == "CERTPEM" and open(kp).read() == "KEYPEM",
          "materialized files hold the PEM")


def test_ensure_disabled_returns_none():
    check(cs._tls_ensure(None) is None, "ensure(None) -> None")
    check(cs._tls_ensure({"enabled": False}) is None, "ensure(disabled) -> None")


if __name__ == "__main__":
    test_parse_tls()
    test_desired_sans()
    test_mint_and_fingerprints()
    test_resign_reuses_key_spki_stable()
    test_materialize_key_perms()
    test_ensure_disabled_returns_none()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all TLS cert-lifecycle tests passed")
