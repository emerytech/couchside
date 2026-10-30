#!/usr/bin/env python3
"""Check core daemon imports without importing or starting either daemon.

Run with Python 3.11 (the CI baseline) or newer. Inspect every AST branch,
including lazy and platform-specific imports. Optional standalone helpers such
as couchside-portal.py have separate dependency policies and are not core files.
This is an architecture guard, not a sandbox or a general Python security scan.
"""
import ast
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
# Exact local-module exceptions; scan the allowed sibling too, so its imports
# cannot silently introduce a transitive dependency into the Windows daemon.
CORE_FILES = {
    "agent/couchsided.py": frozenset(),
    "agent/win/couchsided-win.py": frozenset({"qr"}),
    "agent/qr.py": frozenset(),
}

# Windows certificate creation only. Never permit the whole cryptography
# namespace, top-level imports, or a similarly named method/nested function.
WINDOWS_CERT_IMPORTS = frozenset({
    ("_tls_identity", "cryptography", "x509"),
    ("_tls_identity", "cryptography.x509.oid", "NameOID"),
    ("_tls_identity", "cryptography.x509.oid", "ExtendedKeyUsageOID"),
    ("_tls_identity", "cryptography.hazmat.primitives", "hashes"),
    ("_tls_identity", "cryptography.hazmat.primitives", "serialization"),
    ("_tls_identity", "cryptography.hazmat.primitives.asymmetric", "rsa"),
})
SCOPED_IMPORTS = {"agent/win/couchsided-win.py": WINDOWS_CERT_IMPORTS}


def violations(source, local_modules=frozenset(), scoped_imports=frozenset()):
    tree = ast.parse(source)
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    def scope(node):
        names = []
        while node in parents:
            node = parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(node.name)
        return ".".join(reversed(names))

    failures = []
    dynamic_names = {"__import__"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "importlib":
            dynamic_names.update(alias.asname or alias.name for alias in node.names
                                 if alias.name == "import_module")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                failures.append((node.lineno, "relative import requires an explicit policy"))
                continue
            modules = [node.module or ""]
            if all((scope(node), node.module, alias.name) in scoped_imports
                   for alias in node.names):
                modules = []
        else:
            modules = []
        for module in modules:
            if module.split(".")[0] not in sys.stdlib_module_names and module not in local_modules:
                failures.append((node.lineno, "unapproved import: " + module))
        if isinstance(node, ast.Call):
            func = node.func
            if ((isinstance(func, ast.Name) and func.id in dynamic_names)
                    or (isinstance(func, ast.Attribute)
                        and func.attr in {"import_module", "__import__"})):
                failures.append((node.lineno, "dynamic import requires an explicit policy"))
    return failures


class DependencyPolicyTests(unittest.TestCase):
    def test_shipping_core_imports(self):
        for filename, local_modules in CORE_FILES.items():
            with self.subTest(filename=filename):
                found = violations((ROOT / filename).read_text(encoding="utf-8"), local_modules,
                                   SCOPED_IMPORTS.get(filename, frozenset()))
                self.assertEqual(found, [], "%s: %s" % (filename, found))

    def test_stdlib_including_platform_specific_imports(self):
        self.assertEqual(violations("import ssl, ctypes\nfrom urllib.parse import quote\n"
                                    "if False:\n import winreg\n import fcntl\n"), [])

    def test_nested_optional_and_multiple_imports_are_checked(self):
        source = ("import os, requests\ntry:\n import gi\nexcept ImportError:\n pass\n"
                  "def lazy():\n from cryptography import x509\n")
        self.assertEqual([message for _, message in violations(source)], [
            "unapproved import: requests", "unapproved import: gi",
            "unapproved import: cryptography"])

    def test_sibling_exception_is_exact_and_platform_scoped(self):
        windows = CORE_FILES["agent/win/couchsided-win.py"]
        self.assertEqual(violations("import qr as qrmod", windows), [])
        self.assertTrue(violations("import qr"))
        self.assertTrue(violations("import qr.unapproved", windows))
        self.assertTrue(violations("from . import qr", windows))
        self.assertIn("agent/qr.py", CORE_FILES)
        self.assertTrue(violations("import requests", CORE_FILES["agent/qr.py"]))

    def test_common_dynamic_imports_cannot_bypass_policy(self):
        for source in ("__import__('requests')", "import importlib as il\nil.import_module('requests')",
                       "from importlib import import_module as load\nload('requests')"):
            with self.subTest(source=source):
                self.assertTrue(violations(source))

    def test_windows_crypto_exception_is_function_and_symbol_scoped(self):
        allowed = "def _tls_identity(root):\n from cryptography import x509\n"
        self.assertEqual(violations(allowed, scoped_imports=WINDOWS_CERT_IMPORTS), [])
        self.assertTrue(violations(allowed))  # Linux and QR receive no exception.
        for source in (
            "from cryptography import x509",
            "def unrelated():\n from cryptography import x509\n",
            "def _tls_identity(root):\n import cryptography\n",
            "def _tls_identity(root):\n from cryptography import x509, fernet\n",
            "def _tls_identity(root):\n from cryptography.hazmat.primitives import *\n",
            "class Other:\n def _tls_identity(self):\n  from cryptography import x509\n",
            "def outer():\n def _tls_identity(root):\n  from cryptography import x509\n",
            "def _tls_identity(root):\n __import__('cryptography')\n",
        ):
            with self.subTest(source=source):
                self.assertTrue(violations(source, scoped_imports=WINDOWS_CERT_IMPORTS))


if __name__ == "__main__":
    unittest.main()
