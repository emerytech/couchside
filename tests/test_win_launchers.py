#!/usr/bin/env python3
"""Tests for the Windows agent's non-Steam game launchers (Epic, GOG, Xbox).

Run: python3 tests/test_win_launchers.py

These launchers take a client-supplied id, so per CLAUDE.md §3/§6 the load-bearing
property is allowlist-by-lookup: an id is looked up in a fresh, read-only
discovery and the launch argv is REBUILT from the matched record — the client
string is never interpolated into a command or URI. The security assertions here
prove the reject path (unknown / malformed id -> None -> the route 404s and
NOTHING runs) and that the argv comes from the record, not the id.

The pure transforms (_epic_games_from_manifests / _gog_games_from_rows /
_xbox_games_from_json) are tested with fixtures shaped like the real files, so
they run cross-platform (the agent module imports fine on macOS; winreg + the
PowerShell bridge are guarded). Live GOG/Xbox enumeration is Windows-only and is
verified on a real box separately; here we test their pure transforms + resolver.

Also asserts the `launchers` capability is wired at five of the SIX edit sites
(CLAUDE.md §4): the two agent sites here, plus the three app sites by reading the
app source — a missing app site is the classic silent "cap never persists" bug.

The sixth site does not exist for this cap, and that is a real gap rather than an
exemption: protocol/protocol.json models `capabilities.keys` (every agent must
declare these) and `linuxOnlyCapabilities.keys`, with NO group for a
Windows-only cap. `launchers` is therefore absent from the canonical list and
test_protocol_parity.py does not gate it either way. Noted 2026-08-01; adding a
windowsOnlyCapabilities group is a protocol change and belongs in its own PR,
not smuggled in as a comment fix.

Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import json
import os
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "win", "couchsided-win.py")
spec = importlib.util.spec_from_file_location("couchsided_win", AGENT)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


# --------------------------------------------------------------------------
# Epic
# --------------------------------------------------------------------------
def test_epic_transform():
    print("epic: manifest -> records (games only, strict ids)")
    manifests = [
        {"AppName": "Fortnite", "DisplayName": "Fortnite",
         "CatalogNamespace": "fn", "CatalogItemId": "abc123",
         "AppCategories": ["public", "games"]},
        # engine: has categories but no "games" -> dropped
        {"AppName": "UnrealEngine", "DisplayName": "Unreal Engine",
         "CatalogNamespace": "ue", "CatalogItemId": "def",
         "AppCategories": ["public", "engines"]},
        # non-alphanumeric AppName -> dropped (would be unsafe in the URI)
        {"AppName": "bad name", "DisplayName": "Bad", "CatalogNamespace": "x",
         "CatalogItemId": "y", "AppCategories": ["games"]},
        # colon in the namespace -> dropped (URI-injection shape)
        {"AppName": "Hostile", "DisplayName": "Hostile",
         "CatalogNamespace": "a:b", "CatalogItemId": "z",
         "AppCategories": ["games"]},
        # no categories at all -> kept (don't guess a game out)
        {"AppName": "NoCat", "DisplayName": "No Category Game",
         "CatalogNamespace": "nc", "CatalogItemId": "z9"},
        # missing required field -> dropped
        {"AppName": "MissingNs", "DisplayName": "x", "CatalogItemId": "q"},
    ]
    got = [g["id"] for g in cw._epic_games_from_manifests(manifests)]
    check(got == ["epic:Fortnite", "epic:NoCat"], "keeps only real games: %r" % got)


def test_epic_discovery_reads_files():
    print("epic: discover_epic_games globs + parses *.item on disk")
    o_win, o_dir = cw.IS_WINDOWS, cw._epic_manifests_dir
    try:
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "a.item"), "w", encoding="utf-8") as f:
                json.dump({"AppName": "Alpha", "DisplayName": "Alpha Game",
                           "CatalogNamespace": "ns1", "CatalogItemId": "cid1",
                           "AppCategories": ["games"]}, f)
            # malformed JSON: skipped, not fatal (degrade closed)
            with open(os.path.join(d, "broken.item"), "w", encoding="utf-8") as f:
                f.write("{ not json")
            cw.IS_WINDOWS = True
            cw._epic_manifests_dir = lambda: d
            games = cw.discover_epic_games()
            check([g["id"] for g in games] == ["epic:Alpha"],
                  "found the good manifest, skipped the broken one")
    finally:
        cw.IS_WINDOWS, cw._epic_manifests_dir = o_win, o_dir


def test_epic_resolver_and_reject():
    print("epic: resolve rebuilds URI from the RECORD; unknown/malformed -> None")
    o_win, o_disc, o_exe = cw.IS_WINDOWS, cw.discover_epic_games, cw._explorer_exe
    try:
        cw.IS_WINDOWS = True
        cw._explorer_exe = lambda: r"C:\Windows\explorer.exe"
        # namespace/cid live ONLY in the record — the client id carries neither,
        # so a correct URI proves it was rebuilt from the record, not the id.
        cw.discover_epic_games = lambda: [
            {"id": "epic:Alpha", "label": "Alpha", "kind": "epic",
             "namespace": "REALNS", "catalog_item_id": "REALCID",
             "app_name": "Alpha"}]
        argv = cw._launcher_argv("epic:Alpha")
        want = [r"C:\Windows\explorer.exe",
                "com.epicgames.launcher://apps/REALNS:REALCID:Alpha?action=launch"]
        check(argv == want, "known id -> exact URI from record: %r" % argv)
        check("REALNS" in argv[1] and "REALCID" in argv[1],
              "URI components came from the record, not the client id")
        check(cw._launcher_argv("epic:NotInstalled") is None,
              "id absent from discovery -> None (nothing runs)")
        check(cw._launcher_argv("epic:Alpha:../../evil") is None,
              "malformed id (colons/dots) -> None, never sanitised")
        check(cw._launcher_argv("epic:") is None, "empty name -> None")
    finally:
        cw.IS_WINDOWS, cw.discover_epic_games, cw._explorer_exe = o_win, o_disc, o_exe


# --------------------------------------------------------------------------
# GOG
# --------------------------------------------------------------------------
def test_gog_transform():
    print("gog: registry rows -> records (numeric id + name required)")
    rows = [
        {"gameID": "1207658924", "gameName": "The Witcher 3",
         "path": r"D:\Games\Witcher3"},
        {"gameID": "notnumeric", "gameName": "Bad", "path": "x"},   # dropped
        {"gameID": "55", "gameName": "", "path": "y"},              # dropped
    ]
    got = [(g["id"], g["path"]) for g in cw._gog_games_from_rows(rows)]
    check(got == [("gog:1207658924", r"D:\Games\Witcher3")],
          "keeps only rows with a numeric id + name: %r" % got)


def test_gog_resolver_and_reject():
    print("gog: resolve rebuilds GalaxyClient argv; unknown/non-numeric -> None")
    o_win, o_disc, o_exe = cw.IS_WINDOWS, cw.discover_gog_games, cw._gog_client_exe
    try:
        cw.IS_WINDOWS = True
        cw._gog_client_exe = lambda: r"C:\GOG\GalaxyClient.exe"
        cw.discover_gog_games = lambda: [
            {"id": "gog:1207658924", "label": "W3", "kind": "gog",
             "game_id": "1207658924", "path": r"D:\Games\Witcher3"}]
        argv = cw._launcher_argv("gog:1207658924")
        want = [r"C:\GOG\GalaxyClient.exe", "/command=runGame",
                "/gameId=1207658924", r"/path=D:\Games\Witcher3"]
        check(argv == want, "known id -> exact Galaxy argv: %r" % argv)
        check(cw._launcher_argv("gog:999") is None, "unknown id -> None")
        check(cw._launcher_argv("gog:abc") is None, "non-numeric id -> None")
        # a game with no stored path drops the /path arg (never an empty one)
        cw.discover_gog_games = lambda: [
            {"id": "gog:1", "label": "P", "kind": "gog", "game_id": "1",
             "path": ""}]
        check(cw._launcher_argv("gog:1") ==
              [r"C:\GOG\GalaxyClient.exe", "/command=runGame", "/gameId=1"],
              "empty path -> no /path argument")
    finally:
        cw.IS_WINDOWS, cw.discover_gog_games, cw._gog_client_exe = o_win, o_disc, o_exe


# --------------------------------------------------------------------------
# Xbox
# --------------------------------------------------------------------------
def test_xbox_transform():
    print("xbox: Get-AppxPackage JSON -> records (well-formed AUMID only)")
    blob = json.dumps([
        {"aumid": "Microsoft.MinecraftUWP_8wekyb3d8bbwe!App", "name": "Minecraft"},
        {"aumid": "noseparator", "name": "Bad"},           # dropped: no '!'
        {"aumid": "a_b!App!Extra", "name": "BadToo"},      # dropped: two '!'
        {"aumid": "evil path!x", "name": "Spacey"},        # dropped: space
    ])
    got = [g["id"] for g in cw._xbox_games_from_json(blob)]
    check(got == ["xbox:Microsoft.MinecraftUWP_8wekyb3d8bbwe!App"],
          "keeps only the well-formed AUMID: %r" % got)
    # ConvertTo-Json collapses a single item to an object, not an array
    solo = cw._xbox_games_from_json(json.dumps({"aumid": "A_b!App", "name": "Solo"}))
    check([g["id"] for g in solo] == ["xbox:A_b!App"],
          "single-object JSON is accepted (not just arrays)")
    check(cw._xbox_games_from_json("not json") == [], "garbage JSON -> []")


def test_xbox_resolver_and_reject():
    print("xbox: resolve rebuilds shell:AppsFolder; unknown/malformed -> None")
    o_win, o_disc, o_exe = cw.IS_WINDOWS, cw.discover_xbox_games, cw._explorer_exe
    try:
        cw.IS_WINDOWS = True
        cw._explorer_exe = lambda: r"C:\Windows\explorer.exe"
        aumid = "Microsoft.MinecraftUWP_8wekyb3d8bbwe!App"
        cw.discover_xbox_games = lambda: [
            {"id": "xbox:" + aumid, "label": "Minecraft", "kind": "xbox",
             "aumid": aumid}]
        argv = cw._launcher_argv("xbox:" + aumid)
        check(argv == [r"C:\Windows\explorer.exe",
                       "shell:AppsFolder\\" + aumid],
              "known id -> exact shell:AppsFolder argv: %r" % argv)
        check(cw._launcher_argv("xbox:Not_Installed!App") is None,
              "unknown AUMID -> None")
        check(cw._launcher_argv("xbox:evil path!x") is None,
              "malformed AUMID (space) -> None")
    finally:
        cw.IS_WINDOWS, cw.discover_xbox_games, cw._explorer_exe = o_win, o_disc, o_exe


def test_validators_reject_injection():
    print("id validators reject anything but the strict charset")
    for bad in ("a:b", "a/b", "a b", "a?x", "..", "a\\b", ""):
        check(not cw._alnum_ok(bad), "_alnum_ok rejects %r" % bad)
    for bad in ("nobang", "a!b!c", "a b!x", "!x", "x!", "a/b!c"):
        check(not cw._aumid_ok(bad), "_aumid_ok rejects %r" % bad)
    check(cw._alnum_ok("Fortnite123"), "_alnum_ok accepts a clean id")
    check(cw._aumid_ok("Pkg.Name_hash13!App"), "_aumid_ok accepts a real AUMID")


# --------------------------------------------------------------------------
# Merge + delete guard + capability wiring
# --------------------------------------------------------------------------
def test_list_launchers_merges_all_stores():
    print("list_launchers merges customs + steam + epic + gog + xbox in order")
    saved = (cw.LAUNCHERS, cw.discover_steam_games, cw.discover_epic_games,
             cw.discover_gog_games, cw.discover_xbox_games)
    try:
        cw.LAUNCHERS = [{"id": "custom:c", "label": "C", "cmd": ["x"]}]
        cw.discover_steam_games = lambda: [{"id": "steam:1", "label": "S", "kind": "steam"}]
        cw.discover_epic_games = lambda: [{"id": "epic:E", "label": "E", "kind": "epic"}]
        cw.discover_gog_games = lambda: [{"id": "gog:2", "label": "G", "kind": "gog"}]
        cw.discover_xbox_games = lambda: [{"id": "xbox:X!A", "label": "X", "kind": "xbox"}]
        ids = [l["id"] for l in cw.list_launchers()]
        check(ids == ["custom:c", "steam:1", "epic:E", "gog:2", "xbox:X!A"],
              "merge order is custom, steam, epic, gog, xbox: %r" % ids)
    finally:
        (cw.LAUNCHERS, cw.discover_steam_games, cw.discover_epic_games,
         cw.discover_gog_games, cw.discover_xbox_games) = saved


def test_auto_ids_not_creatable_or_deletable():
    print("auto-discovered ids are never custom (can't be created/deleted)")
    check(cw._AUTO_LAUNCHER_KINDS == frozenset({"steam", "epic", "gog", "xbox"}),
          "the delete guard covers all four auto kinds")
    for lid in ("steam:1", "epic:E", "gog:2", "xbox:X!A"):
        check(not cw._valid_launcher_id(lid),
              "%s is not a valid custom id (POST create refuses it)" % lid)
        check(lid.split(":", 1)[0] in cw._AUTO_LAUNCHER_KINDS,
              "%s hits the 'not deletable' DELETE guard" % lid)


def test_launchers_cap_five_sites():
    print("`launchers` capability wired at five of six edit sites "
          "(no protocol.json group exists for a Windows-only cap)")
    # Agent site 1: mock CAPS
    cw.set_caps(mock=True)
    check(cw.CAPS.get("launchers") is True, "agent mock CAPS carries launchers")
    # Agent site 2: real CAPS predicate, both directions
    o = (cw.IS_WINDOWS, cw.LAUNCHERS, cw._steam_root, cw._gog_client_exe,
         cw._epic_manifests_dir)
    try:
        cw.IS_WINDOWS = True
        cw.LAUNCHERS = []
        cw._steam_root = lambda: None
        cw._gog_client_exe = lambda: None
        cw._epic_manifests_dir = lambda: os.path.join(tempfile.gettempdir(), "no-epic-here")
        check(cw._any_launcher_source() is False, "no launcher -> cap False")
        cw._steam_root = lambda: r"C:\Steam"
        check(cw._any_launcher_source() is True, "steam present -> cap True")
    finally:
        (cw.IS_WINDOWS, cw.LAUNCHERS, cw._steam_root, cw._gog_client_exe,
         cw._epic_manifests_dir) = o
    # App sites 3-5: read the app source and assert `launchers` is present in
    # each. A missing site is the silent "cap never persists / re-probes" bug.
    app = os.path.join(HERE, "..", "app")
    api = open(os.path.join(app, "lib", "api.ts"), encoding="utf-8").read()
    settings = open(os.path.join(app, "lib", "settings.ts"), encoding="utf-8").read()
    layout = open(os.path.join(app, "app", "(tabs)", "_layout.tsx"), encoding="utf-8").read()
    check("launchers?: boolean" in api, "app BoxCaps type declares launchers")
    check("a.launchers === b.launchers" in api, "app capsEqual compares launchers")
    check("bool('launchers')" in settings and "launchers," in settings,
          "app normalizeCaps parses + returns launchers")
    check("caps?.launchers" in layout, "app _layout gates the Launch tab on launchers")


if __name__ == "__main__":
    test_epic_transform()
    test_epic_discovery_reads_files()
    test_epic_resolver_and_reject()
    test_gog_transform()
    test_gog_resolver_and_reject()
    test_xbox_transform()
    test_xbox_resolver_and_reject()
    test_validators_reject_injection()
    test_list_launchers_merges_all_stores()
    test_auto_ids_not_creatable_or_deletable()
    test_launchers_cap_five_sites()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all Windows launcher tests passed")
