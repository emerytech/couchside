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


def violations(source, local_modules=frozenset()):
    tree = ast.parse(source)
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
                found = violations((ROOT / filename).read_text(encoding="utf-8"), local_modules)
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


if __name__ == "__main__":
    unittest.main()
