#!/usr/bin/env python3
"""Real TLS transfers through the shipping Swift/OkHttp cores and agent handler.

python3 tests/test_native_upload.py --client /path/to/native-test-executable
All keys, tickets, files and listeners are synthetic and temporary. This is not
a phone UI/background-lifecycle test; signed device builds are a release gate.
"""
import argparse
import hashlib
import http.server
import importlib.util
import json
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("couchsided", ROOT / "agent/couchsided.py")
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client", required=True)
    args = parser.parse_args()
    client = str(Path(args.client).resolve())
    with tempfile.TemporaryDirectory(prefix="couchside-native-upload-") as tmp:
        root = Path(tmp).resolve()
        cert, key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "1",
                        "-subj", "/CN=paired-box.invalid"], check=True, capture_output=True)
        modulus = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-noout", "-modulus"], text=True).strip().split("=")[1].lower()
        drop = root / "drop"
        drop.mkdir()
        cs._drop_dir = lambda: str(drop)
        payload = bytes(range(256)) * 8192 + b"synthetic-file-end"
        source = root / "source.bin"
        source.write_bytes(payload)
        requests = []
        redirected = []

        class Trap(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                redirected.append(self.path)
                self.send_error(500)

            def log_message(self, *args):
                pass

        trap = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Trap)
        threading.Thread(target=trap.serve_forever, daemon=True).start()

        class Handler(cs.Handler):
            token = "fixture-bearer-must-not-be-sent"
            token_file = None
            mock = True

            def _log(self, *args, **kwargs):
                pass

            def do_POST(self):
                requests.append((self.path, dict(self.headers)))
                name = parse_qs(urlsplit(self.path).query).get("name", [""])[0]
                if name.startswith("fixture-"):
                    self.close_connection = True
                    if name == "fixture-cancel":
                        time.sleep(1)
                        return
                    self.rfile.read(int(self.headers["Content-Length"]))
                    if name == "fixture-timeout":
                        time.sleep(33)
                        return
                    if name == "fixture-disconnect":
                        return
                    if name in ("fixture-302", "fixture-307"):
                        self.send_response(int(name[-3:]))
                        self.send_header("Location", f"http://127.0.0.1:{trap.server_port}/leak")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    self.send_response(200)
                    if name == "fixture-truncated":
                        self.send_header("Content-Length", "100")
                        self.end_headers()
                        self.wfile.write(b"{}")
                        return
                    self.send_header("Content-Length", "65537")
                    self.end_headers()
                    try:
                        self.wfile.write(b"x" * 65537)
                    except (OSError, ssl.SSLError):
                        pass
                    return
                super().do_POST()

        server = cs.BoundedThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def run(name, *, pin=modulus, ticket=None, cancel=False, port=None):
            if ticket is None:
                ticket = cs._mint_ticket(True)
            result = subprocess.run([client, str(port or server.server_port), pin, ticket, str(source), name]
                                    + (["cancel"] if cancel else []), capture_output=True, text=True, timeout=45)
            assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
            status = next((int(line[7:]) for line in result.stdout.splitlines() if line.startswith("STATUS=")), None)
            assert status is not None, result.stdout
            return status, result.stdout

        try:
            name = "native + ü test.bin"
            ticket = cs._mint_ticket(True)
            status, text = run(name, ticket=ticket)
            assert status == 200, text
            assert hashlib.sha256((drop / name).read_bytes()).digest() == hashlib.sha256(payload).digest()
            assert (drop / name).stat().st_mode & 0o777 == 0o600
            assert all(not h.get("Authorization") for _, h in requests)
            print("PASS pinned HTTPS binary stream, UTF-8/+ filename, private file, no bearer", flush=True)

            assert run(name, ticket=ticket)[0] in (0, 401)  # early close may abort the native send
            assert (drop / name).read_bytes() == payload
            print("PASS one-use ticket replay refused", flush=True)

            before = len(requests)
            wrong = ("b" if modulus[0] != "b" else "a") + modulus[1:]
            assert run("must-not-arrive.bin", pin=wrong)[0] == 0
            assert len(requests) == before and not (drop / "must-not-arrive.bin").exists()
            print("PASS wrong certificate rejected before HTTP headers or file bytes", flush=True)

            assert run("must-not-be-plaintext.bin", port=trap.server_port)[0] == 0
            assert not redirected
            print("PASS plaintext endpoint cannot receive upload or trigger downgrade", flush=True)

            for code in (302, 307):
                assert run(f"fixture-{code}")[0] == code
                assert not redirected
            print("PASS redirects never reach plaintext listener", flush=True)

            for name in ("fixture-oversize", "fixture-truncated", "fixture-disconnect"):
                before = len(requests)
                assert run(name)[0] == 0, name
                assert len(requests) == before + 1, "failed POST must not be replayed"
                print("PASS " + name, flush=True)

            assert run("fixture-cancel", cancel=True)[0] == 0
            print("PASS cancellation completes as failure", flush=True)
            started = time.monotonic()
            assert run("fixture-timeout")[0] == 0
            assert time.monotonic() - started < 38
            print("PASS stalled response times out within the native read deadline", flush=True)
            assert run("after-errors.bin")[0] == 200
            assert (drop / "after-errors.bin").read_bytes() == payload
            assert not list(drop.glob("*.part"))
            print("PASS next transfer succeeds; no abandoned upload staging", flush=True)
        finally:
            server.shutdown()
            server.server_close()
            trap.shutdown()
            trap.server_close()


if __name__ == "__main__":
    main()
