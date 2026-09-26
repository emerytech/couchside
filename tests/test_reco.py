#!/usr/bin/env python3
"""Tests for the "what to play next" recommendation engine (GET /api/recommend).

Run: python3 tests/test_reco.py

The engine is READ-ONLY and works from LOCAL Steam signals only — total hours and
days-since-last-played. Properties that matter:
  * It only recommends INSTALLED games (you can launch them now).
  * Every bucket is reachable and tagged (streak / unfinished / rediscover /
    comfort / fresh / backlog) — observe them all (§11).
  * Alternates are DIVERSIFIED across buckets, so the row shows varied angles.
  * Degrade closed: no Steam / nothing installed -> available False, primary None
    (never a fabricated pick).
  * It NEVER launches anything — it returns data; the app launches via the
    existing Steam path.

Pure stdlib, no pytest.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "couchsided.py")
spec = importlib.util.spec_from_file_location("couchsided", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
_fail = []


def check(cond, label):
    print((PASS if cond else FAIL) + "  " + label)
    if not cond:
        _fail.append(label)


NOW = 1_700_000_000
DAY = 86400


def test_score_buckets():
    print("_reco_score reaches every bucket with a sensible tag (observe all)")
    cases = {
        "streak": cs._reco_score(22.0, 1),
        "unfinished": cs._reco_score(11.0, 24),
        "rediscover": cs._reco_score(41.0, 140),
        "comfort": cs._reco_score(19.0, 80),   # 15h+ but outside the unfinished window
        "backlog": cs._reco_score(1.5, 200),
    }
    for want, (score, bucket, tag, reason) in cases.items():
        check(bucket == want and isinstance(score, float) and reason,
              "%.1fh maps to bucket %r (tag %r)" % (0, bucket, tag) if False else "bucket %r reached" % want)
    # a recent, high-hours game must outscore an old, low-hours one
    hi, _, _, _ = cs._reco_score(20.0, 1)
    lo, _, _, _ = cs._reco_score(1.0, 300)
    check(hi > lo, "a recent streak game outscores a stale backlog game")


def test_rank_only_installed():
    print("rank offers only INSTALLED games; excludes played-but-uninstalled")
    pt = {"1": {"playtime_min": 1200, "last_played": NOW - DAY},        # installed, streak
          "9": {"playtime_min": 5000, "last_played": NOW - DAY}}        # NOT installed
    r = cs._reco_rank(pt, {"1"}, NOW)
    ids = [r["primary"]["appid"]] + [a["appid"] for a in r["alternates"]]
    check("1" in ids and "9" not in ids, "the uninstalled game (9) is never offered")
    check(r["primary"]["appid"] == "1" and r["primary"]["bucket"] == "streak",
          "the installed streak game is the primary pick")


def test_rank_fresh_and_diversify():
    print("installed-but-never-played -> fresh; alternates diversify across buckets")
    pt = {
        "1": {"playtime_min": 1340, "last_played": NOW - DAY},         # streak
        "2": {"playtime_min": 670, "last_played": NOW - 24 * DAY},     # unfinished
        "3": {"playtime_min": 2460, "last_played": NOW - 140 * DAY},   # rediscover
    }
    installed = {"1", "2", "3", "5"}   # 5 = installed, never played
    r = cs._reco_rank(pt, installed, NOW)
    check(r["primary"]["bucket"] == "streak", "streak is the primary")
    buckets = [a["bucket"] for a in r["alternates"]]
    check("fresh" in buckets, "an installed-never-played game appears as fresh")
    check(len(set(buckets)) == len(buckets), "alternates are all DIFFERENT buckets (diversified)")
    fresh = next(a for a in r["alternates"] if a["bucket"] == "fresh")
    check(fresh["appid"] == "5" and fresh["hours"] == 0.0, "the fresh pick is the unplayed install")


def test_degrade_closed():
    print("degrade closed: nothing installed -> no pick (never fabricated)")
    r = cs._reco_rank({"1": {"playtime_min": 999, "last_played": NOW}}, set(), NOW)
    check(r["primary"] is None and r["alternates"] == [], "no installed game -> primary None, no alternates")
    # payload with no Steam root -> available False
    saved = cs._steam_root
    try:
        cs._steam_root = lambda: None
        p = cs._recommend_payload()
        check(p["available"] is False and p["primary"] is None, "no Steam root -> available False")
    finally:
        cs._steam_root = saved


def test_payload_attaches_names():
    print("payload attaches game NAMES from appinfo; reads only local data")
    import time
    saved = {k: getattr(cs, k) for k in ("_steam_root", "_steam_playtime", "_installed_appids", "_steam_appinfo_names")}
    try:
        cs._steam_root = lambda: "/fake/steam"
        # _recommend_payload ranks against the REAL wall clock, so anchor last_played to now.
        cs._steam_playtime = lambda root: {"1145360": {"playtime_min": 1344, "last_played": int(time.time()) - DAY}}
        cs._installed_appids = lambda root: {"1145360"}
        cs._steam_appinfo_names = lambda: {1145360: "Hades"}
        p = cs._recommend_payload()
        check(p["available"] is True and p["primary"]["name"] == "Hades",
              "primary carries the resolved name (Hades)")
        check(p["primary"]["bucket"] == "streak" and p["primary"]["hours"] == 22.4,
              "hours + bucket computed from the local playtime record")
    finally:
        for k, v in saved.items():
            setattr(cs, k, v)


def test_mock_observable():
    print("mock: /api/recommend body is well-formed and playable")
    m = cs.mock_recommend()
    check(m["available"] is True and m["primary"]["name"] == "Hades", "mock has a primary pick")
    check(len(m["alternates"]) >= 3 and all(a.get("name") and a.get("tag") for a in m["alternates"]),
          "mock alternates each carry a name + tag")
    check(all("bucket" in a for a in m["alternates"]), "mock alternates carry a bucket")


if __name__ == "__main__":
    test_score_buckets()
    test_rank_only_installed()
    test_rank_fresh_and_diversify()
    test_degrade_closed()
    test_payload_attaches_names()
    test_mock_observable()
    print()
    if _fail:
        print("FAILED: %d" % len(_fail))
        for f in _fail:
            print("  - " + f)
        raise SystemExit(1)
    print("all reco tests passed")
