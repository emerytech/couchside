#!/usr/bin/env python3
"""The privileged helper must live where NO ancestor is user-writable.

The helper is the only root process in the product: its service unit runs
`ExecStart=/usr/bin/python3 <HELPER_DIR>/couchside-helper.py` as root. On Linux,
renaming an entry inside a directory needs only write on that PARENT directory
(no sticky bit here), regardless of who owns the entry. So if ANY ancestor of
the helper is owned by the desktop user, that user can rename our root-owned
dir aside, mkdir their own, and drop code root then runs -- user-to-root
(KI-092, reproduced in a container).

install.sh chowns $STATE_DIR (/var/lib/couchside) to the desktop user in (e0).
The SteamOS fallback therefore must NOT put the helper under $STATE_DIR; it goes
in its own root-owned tree (/var/lib/couchside-root/...). This test reads the
installer TEXT and fails if any HELPER_DIR the installer picks is $STATE_DIR or
a descendant of it, or if any ancestor the installer CREATES is not root:root.

Pure stdlib, no pytest. Optional argv[1] = installer path (default install.sh),
matching the other installer tests. Exit non-zero on the first failure.
"""
import os
import re
import sys

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print("FAIL: " + msg)
        sys.exit(1)


def components(path):
    """Absolute path -> list of components, so containment is compared by
    component and never by string prefix (/var/lib/couchside is a string prefix
    of /var/lib/couchside-root but NOT an ancestor of it)."""
    return [c for c in path.strip().split("/") if c]


def is_within(child, parent):
    """True if `child` == `parent` or is a descendant, by path component."""
    c, p = components(child), components(parent)
    return c[: len(p)] == p


def ancestors(path):
    """Every ancestor directory of `path`, deepest first, excluding '/'.
    /a/b/c -> ['/a/b/c', '/a/b', '/a']."""
    comps = components(path)
    return ["/" + "/".join(comps[:i]) for i in range(len(comps), 0, -1)]


def main():
    installer = sys.argv[1] if len(sys.argv) > 1 else "install.sh"
    src = open(installer, encoding="utf-8").read()

    # STATE_DIR — the user-owned dir (e0 chowns it to $USER_NAME).
    m = re.search(r'^STATE_DIR="([^"]+)"', src, re.M)
    check(m is not None, "could not find STATE_DIR assignment")
    state_dir = m.group(1)
    check(
        state_dir == "/var/lib/couchside",
        "STATE_DIR moved to %r — update this test's assumptions" % state_dir,
    )

    # (e0) really does hand $STATE_DIR to the user — the precondition that makes
    # a helper under it dangerous. If this ever stops, the invariant is moot,
    # but silently passing would hide a moved chown, so assert it is present.
    check(
        re.search(r'sudo\s+chown\s+"\$USER_NAME"\s+"\$STATE_DIR"', src) is not None,
        "expected (e0) to chown $STATE_DIR to $USER_NAME — precondition for KI-092",
    )

    # Single-valued literal var assignments, for resolving $VAR in paths below.
    # HELPER_DIR is multi-valued (default + fallback) so it is handled apart.
    varmap = {}
    for name, val in re.findall(r'^(\w+)="([^"$]+)"', src, re.M):
        if name != "HELPER_DIR":
            varmap.setdefault(name, val)

    def resolve(tok):
        m2 = re.fullmatch(r"\$\{?(\w+)\}?", tok)
        return varmap.get(m2.group(1), tok) if m2 else tok

    # Every directory install.sh CREATES with `install -d ... -o O -g G ... PATH`.
    # $HELPER_DIR is deferred to helper_dir_owners (it holds whichever value is
    # in scope); other $VARs are resolved through varmap; literals stored as-is.
    created = {}          # literal path -> (owner, group)
    helper_dir_owners = set()  # (owner, group) seen on every `install -d $HELPER_DIR`
    for line in src.splitlines():
        if "install -d" not in line:
            continue
        owner = re.search(r"-o\s+(\S+)", line)
        group = re.search(r"-g\s+(\S+)", line)
        if not (owner and group):
            continue
        og = (owner.group(1), group.group(1))
        path = None
        for t in reversed(line.split()):
            t = t.strip().strip('"')
            if t.startswith("/") or t.startswith("$"):
                path = t
                break
        if not path:
            continue
        if re.fullmatch(r"\$\{?HELPER_DIR\}?", path):
            helper_dir_owners.add(og)
        else:
            created[resolve(path)] = og

    def created_root(path):
        """Is `path` created root:root, whether literally or via $HELPER_DIR?"""
        if path in created:
            return created[path] == ("root", "root")
        return helper_dir_owners == {("root", "root")}

    # Every value assigned to HELPER_DIR (default + the SteamOS fallback).
    helper_dirs = re.findall(r'HELPER_DIR="([^"]+)"', src)
    check(len(helper_dirs) >= 2,
          "expected at least a default + fallback HELPER_DIR, found %r" % helper_dirs)
    literal_dirs = [d for d in helper_dirs if "$" not in d]
    check(literal_dirs, "no literal HELPER_DIR path found")
    check(helper_dir_owners == {("root", "root")},
          "some `install -d $HELPER_DIR` is not -o root -g root: %r" % (helper_dir_owners,))

    for d in literal_dirs:
        # CORE INVARIANT: the helper never lives under the user-owned state dir.
        check(
            not is_within(d, state_dir),
            "HELPER_DIR %r is inside the user-owned STATE_DIR %r — a user-"
            "writable ancestor makes the root helper swappable (KI-092)" % (d, state_dir),
        )
        # Every ancestor the installer CREATES must be root:root, so no ancestor
        # is ever handed to the user.
        for anc in ancestors(d):
            if anc in created:
                owner, group = created[anc]
                check(
                    owner == "root" and group == "root",
                    "ancestor %r of helper dir %r is created %s:%s, not root:root"
                    % (anc, d, owner, group),
                )
        # The helper dir itself must be created root:root.
        check(created_root(d),
              "helper dir %r is not created root:root" % d)

    # The SteamOS fallback specifically: an explicit root-owned tree, with a
    # root-owned parent that is NOT the user-owned state dir.
    fallback = [d for d in literal_dirs if d != "/usr/local/libexec"]
    check(fallback, "no SteamOS fallback HELPER_DIR (non-/usr/local) found")
    for d in fallback:
        check(created_root(d),
              "SteamOS fallback %r is not created root:root" % d)
        parent = "/" + "/".join(components(d)[:-1])
        check(
            created.get(parent) == ("root", "root"),
            "fallback parent %r is not created root:root (it must be its own "
            "root-owned tree, not $STATE_DIR)" % parent,
        )

    print("all helper-root-parent checks passed (%d checks, installer=%s)"
          % (CHECKS, os.path.basename(installer)))


if __name__ == "__main__":
    main()
