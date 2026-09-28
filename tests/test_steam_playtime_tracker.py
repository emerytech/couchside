#!/usr/bin/env python3
"""Tests for the Steam play-time tracker (agent 2.9.124).

Run: python3 tests/test_steam_playtime_tracker.py

Steam's API exposes only "last 2 weeks" + lifetime. To show real 7d / 30d trends
the agent snapshots the library's TOTAL lifetime minutes once a day, keyed by
steamid64, in the user's own config dir (0600), pruned to ~70 days, and diffs the
nearest snapshot at/older than the window edge. Proves:

  - a snapshot is recorded once per day; the latest read of the day wins;
  - unchanged totals do not rewrite the file; history is pruned to KEEP days;
  - the file is written 0600 and load/save/record never raise on bad input;
  - deltas pick the NEAREST snapshot <= (today - N days), clamp negatives to 0,
    and are None until an old-enough snapshot exists;
  - accounts never mix: records are keyed by sid;
  - the library payload carries played_7d / played_30d.

No real network. Pure stdlib, no pytest.
"""
import importlib.util
import json
import os
import stat
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []
SID_A = "76561197960287930"
SID_B = "76561198000000009"


def check(cond, label, detail=""):
    print((PASS if cond else FAIL) + "  " + label + ("" if cond else "  <- %s" % (detail,)))
    if not cond:
        _fail.append(label)


def _fresh_conf():
    d = tempfile.mkdtemp()
    return d, os.path.join(d, "steam_playtime.json")


# ---------------------------------------------------------------------------
print("\n_pt_day — ISO dates sort chronologically, older is 'less'")
# ---------------------------------------------------------------------------
today = cs._pt_day(0)
wk = cs._pt_day(7)
mo = cs._pt_day(30)
check(mo < wk < today, "older offsets produce lexically smaller dates", (mo, wk, today))
check(len(today) == 10 and today[4] == "-" and today[7] == "-", "YYYY-MM-DD shape", today)


# ---------------------------------------------------------------------------
print("\n_steam_playtime_record — once/day, keyed by sid, prune, skip-unchanged")
# ---------------------------------------------------------------------------
_saved_conf = cs._STEAM_PLAYTIME_CONF
_d, _f = _fresh_conf()
cs._STEAM_PLAYTIME_CONF = _f
try:
    acct = cs._steam_playtime_record(SID_A, 1000)
    check(acct == {today: 1000}, "first record stores today's total", acct)

    # latest read of the day wins, in place (still one entry for today)
    acct = cs._steam_playtime_record(SID_A, 1200)
    check(acct == {today: 1200}, "same-day re-record overwrites today", acct)

    # unchanged total => no disk write (mtime unchanged)
    mtime1 = os.stat(_f).st_mtime_ns
    cs._steam_playtime_record(SID_A, 1200)
    check(os.stat(_f).st_mtime_ns == mtime1, "unchanged total skips the write")

    # file is 0600
    mode = stat.S_IMODE(os.stat(_f).st_mode)
    check(mode == 0o600, "snapshot file is 0600", oct(mode))

    # a second account does not touch the first
    cs._steam_playtime_record(SID_B, 55)
    ondisk = json.load(open(_f))
    check(ondisk.get(SID_A, {}).get(today) == 1200 and ondisk.get(SID_B, {}).get(today) == 55,
          "two accounts coexist, keyed by sid", ondisk)

    # prune: an ancient entry is dropped on the next write
    raw = json.load(open(_f))
    raw[SID_A][cs._pt_day(cs._STEAM_PLAYTIME_KEEP + 5)] = 1
    json.dump(raw, open(_f, "w"))
    acct = cs._steam_playtime_record(SID_A, 1300)  # changed -> triggers prune+write
    check(all(k >= cs._pt_day(cs._STEAM_PLAYTIME_KEEP) for k in acct),
          "entries older than KEEP days are pruned", list(acct))

    # empty sid / bad total degrade to {} without raising or writing
    check(cs._steam_playtime_record("", 100) == {}, "empty sid -> {}")
    check(cs._steam_playtime_record(SID_A, "notanumber") == {}, "non-int total -> {}")
finally:
    cs._STEAM_PLAYTIME_CONF = _saved_conf
    import shutil
    shutil.rmtree(_d, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n_steam_playtime_load/save — corrupt file degrades closed")
# ---------------------------------------------------------------------------
_d, _f = _fresh_conf()
cs._STEAM_PLAYTIME_CONF = _f
try:
    open(_f, "w").write("{ not json")
    check(cs._steam_playtime_load() == {}, "corrupt file loads as {}")
    open(_f, "w").write("[1,2,3]")  # valid json, wrong type
    check(cs._steam_playtime_load() == {}, "non-dict json loads as {}")
    cs._steam_playtime_save({"x": {today: 1}})
    check(cs._steam_playtime_load() == {"x": {today: 1}}, "round-trips a dict")
finally:
    cs._STEAM_PLAYTIME_CONF = _saved_conf
    import shutil
    shutil.rmtree(_d, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n_steam_playtime_deltas — nearest-snapshot diff, clamp, None-until-ready")
# ---------------------------------------------------------------------------
# 10 days ago: 1000 min; 3 days ago: 1180 min; today total = 1300 min.
acct = {cs._pt_day(10): 1000, cs._pt_day(3): 1180}
d = cs._steam_playtime_deltas(acct, 1300)
# 7d window edge = today-7: nearest snapshot <= that is the 10-day-ago one (1000).
check(d["played_7d"] == round((1300 - 1000) / 60.0, 1), "7d uses nearest snapshot <= edge (10d ago)", d)
# 30d window edge = today-30: no snapshot that old yet -> None.
check(d["played_30d"] is None, "30d None until a >=30d-old snapshot exists", d)

# a snapshot exactly at the edge counts; negative diffs clamp to 0.
acct2 = {cs._pt_day(7): 1400, cs._pt_day(30): 900}
d2 = cs._steam_playtime_deltas(acct2, 1300)
check(d2["played_7d"] == 0.0, "total below snapshot clamps 7d to 0 (not negative)", d2)
check(d2["played_30d"] == round((1300 - 900) / 60.0, 1), "30d edge snapshot counted", d2)

# empty history -> both None; bad total -> both None
check(cs._steam_playtime_deltas({}, 1300) == {"played_7d": None, "played_30d": None}, "no history -> None/None")
check(cs._steam_playtime_deltas(acct, "x") == {"played_7d": None, "played_30d": None}, "bad total -> None/None")

# over-count guard: a baseline far OLDER than the window edge (a history gap) must
# degrade to None, not report a >N-day diff as "this week".
gap = {cs._pt_day(12): 1000, cs._pt_day(3): 1180}
dg = cs._steam_playtime_deltas(gap, 1300)
check(dg["played_7d"] is None, "7d None when nearest baseline is >TOL days before the edge (12d gap)", dg)
# within tolerance (edge=today-7, baseline today-8) still reports, exactly.
near = {cs._pt_day(8): 1200}
dn = cs._steam_playtime_deltas(near, 1300)
check(dn["played_7d"] == round((1300 - 1200) / 60.0, 1), "7d reports when baseline within TOL of the edge (8d)", dn)


# ---------------------------------------------------------------------------
print("\n_steam_library_payload — carries played_7d / played_30d")
# ---------------------------------------------------------------------------
_saved = {k: getattr(cs, k) for k in ("_steam_owned_cached", "_steam_webapi_configured")}
_d, _f = _fresh_conf()
cs._STEAM_PLAYTIME_CONF = _f
try:
    cs._steam_webapi_configured = lambda: True
    cs._steam_owned_cached = lambda: [
        {"appid": 1, "name": "A", "playtime_forever": 600, "playtime_2weeks": 120},
        {"appid": 2, "name": "B", "playtime_forever": 300, "playtime_2weeks": 0}]
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = SID_A
    body = cs._steam_library_payload()
    check("played_7d" in body and "played_30d" in body, "payload has played_7d/played_30d keys", list(body))
    # first-ever fetch: only today's snapshot exists -> both windows None
    check(body["played_7d"] is None and body["played_30d"] is None, "first fetch -> None (no old snapshot yet)", body)
finally:
    for k, v in _saved.items():
        setattr(cs, k, v)
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
    cs._STEAM_PLAYTIME_CONF = _saved_conf
    import shutil
    shutil.rmtree(_d, ignore_errors=True)

# ---------------------------------------------------------------------------
print("\nTOCTOU: account switch mid-library-fetch is not recorded under the wrong sid")
# ---------------------------------------------------------------------------
_saved3 = {k: getattr(cs, k) for k in ("_steam_owned_cached", "_steam_webapi_configured")}
_d, _f = _fresh_conf()
cs._STEAM_PLAYTIME_CONF = _f
try:
    cs._steam_webapi_configured = lambda: True
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = SID_A

    def _switch_midfetch():
        # a concurrent POST switches the box to account B while the games are read
        with cs._STEAM_WEBAPI_LOCK:
            cs._STEAM_WEBAPI["steamid64"] = SID_B
        return [{"appid": 1, "name": "A", "playtime_forever": 999, "playtime_2weeks": 0}]
    cs._steam_owned_cached = _switch_midfetch
    body = cs._steam_library_payload()
    check(body["played_7d"] is None and body["played_30d"] is None,
          "account switched mid-fetch -> deltas None (not attributed)", body)
    ondisk = cs._steam_playtime_load()
    check(SID_A not in ondisk and SID_B not in ondisk,
          "no snapshot filed under EITHER account on a mid-fetch switch", ondisk)
finally:
    for k, v in _saved3.items():
        setattr(cs, k, v)
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI["steamid64"] = None
    cs._STEAM_PLAYTIME_CONF = _saved_conf
    import shutil
    shutil.rmtree(_d, ignore_errors=True)


check("played_7d" in cs.mock_steam_library_payload(), "mock library payload also carries played_7d")
check(cs.mock_steam_library_payload()["played_30d"] is None, "mock exercises the null (—) render branch")

print()
if _fail:
    print("FAILURES: %d" % len(_fail))
    for f in _fail:
        print("  - " + f)
    raise SystemExit(1)
print("all steam playtime tests passed")
