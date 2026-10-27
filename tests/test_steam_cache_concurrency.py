#!/usr/bin/env python3
"""Bounded Steam refreshes and account isolation; no real network or user files."""
import importlib.util
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cs', os.path.join(os.path.dirname(__file__), '..', 'agent', 'couchsided.py'))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)
SID = '76561197960287930'
OTHER = '76561197960287931'
KEY = 'A' * 32
fails = []


def check(ok, label):
    print(('PASS ' if ok else 'FAIL ') + label)
    if not ok:
        fails.append(label)


def configure(sid=SID, key=KEY):
    with cs._STEAM_WEBAPI_LOCK:
        cs._STEAM_WEBAPI.update(steamid64=sid, apikey=key)
        cs._steam_reset_caches_locked()


def test_single_flight_and_latency():
    configure()
    release = threading.Event()
    started = threading.Event()
    calls = []
    def fetch(sid, key):
        calls.append(sid)
        started.set()
        release.wait(3)
        return {'personaname': 'one fetch'}
    with patch.object(cs, '_steam_get_summary', fetch):
        start = time.monotonic()
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: cs._steam_summary_cached(), range(12)))
        elapsed = time.monotonic() - start
        with cs._STEAM_WEBAPI_LOCK:
            done = cs._STEAM_SUMMARY_CACHE.get('loading')
        check(started.is_set() and len(calls) == 1, '12 simultaneous cold readers share one upstream fetch')
        check(elapsed < 1 and results == [None] * 12, 'cold readers return promptly while upstream is blocked')
        release.set()
        check(done.wait(2), 'refresh completes in background')
        check(cs._steam_summary_cached()['personaname'] == 'one fetch' and len(calls) == 1, 'completed result is cached')


def test_generation_rejects_aba_and_credentials():
    configure()
    release = threading.Event()
    started = threading.Event()
    def fetch(sid, key):
        started.set(); release.wait(3)
        return {'personaname': 'old'}
    with patch.object(cs, '_steam_get_summary', fetch):
        cs._steam_summary_cached()
        done = cs._STEAM_SUMMARY_CACHE['loading']
        configure(OTHER)
        configure(SID, 'B' * 32)
        release.set(); check(done.wait(2), 'old-account refresh completes')
        check(cs._STEAM_SUMMARY_CACHE['val'] is None, 'A -> B -> A with new credentials rejects old completion')
    with patch.object(cs, '_steam_get_summary', lambda *a: {'personaname': 'new'}):
        check(cs._steam_summary_cached()['personaname'] == 'new', 'current credentials can populate the cache')


def test_stale_failure_and_backoff():
    configure()
    cache = cs._STEAM_SUMMARY_CACHE
    cache.update(ts=0, val={'personaname': 'last good'})
    count = []
    def fail(*args):
        count.append(1)
        return None
    with patch.object(cs, '_steam_get_summary', fail):
        start = time.monotonic()
        value = cs._steam_summary_cached()
        check(time.monotonic() - start < .1 and value['personaname'] == 'last good', 'stale value returns without waiting')
        for _ in range(100):
            with cs._STEAM_WEBAPI_LOCK:
                done = cache.get('loading')
            if done is None: break
            done.wait(.1)
        for _ in range(10): cs._steam_summary_cached()
        check(len(count) == 1 and cache['val'] == value, 'upstream failure preserves last good result and backs off')


def test_detached_slot_account_isolation():
    configure()
    slot = {'ts': 0, 'val': None}
    check(cs._steam_cached_fetch(slot, 60, lambda *a: 'old') == 'old', 'detached-slot control populates old account')
    configure(OTHER)
    check(cs._steam_cached_fetch(slot, 60, lambda *a: 'new') == 'new', 'slot retained across account change cannot return old data')


def test_price_failure_not_empty_sale():
    configure()
    with patch.object(cs, '_steam_get_wishlist', lambda *a: ['570']), patch.object(cs, '_steam_store_get', lambda *a, **k: None):
        body = cs._steam_wishlist_payload()
        check(body.get('connected') is False, 'failed price lookup reports unavailable')
        check(cs._STEAM_WISHLIST_CACHE['val'] is None, 'price failure is never cached as no sales')
    configure()
    with patch.object(cs, '_steam_get_wishlist', lambda *a: []):
        body = cs._steam_wishlist_payload()
        check(body.get('connected') is True and body['on_sale'] == [], 'valid empty wishlist remains a successful cacheable result')


def test_global_worker_bound():
    configure()
    release = threading.Event()
    calls = []
    slots = [{'ts': 0, 'val': None} for _ in range(9)]
    def fetch(*args):
        calls.append(1); release.wait(3); return []
    with patch.object(cs, '_STEAM_CACHE_WAIT', 0):
        for slot in slots: cs._steam_cached_fetch(slot, 10, fetch)
    events = [slot['loading'] for slot in slots if slot.get('loading')]
    check(len(events) == 4, 'at most four upstream workers even across nine distinct slots')
    release.set()
    check(all(done.wait(2) for done in events), 'all worker permits are released')
    check(cs._steam_cached_fetch(slots[-1], 10, lambda *a: [1]) == [1], 'a later reader can refresh when a worker is available')


def test_upstream_budget():
    configure()
    def fetch(*args):
        cs._STEAM_REFRESH_CONTEXT.deadline = time.monotonic() - 1
        with patch.object(cs.urllib.request, 'urlopen', side_effect=AssertionError('expired request reached network')):
            a = cs._steam_store_get('appdetails', {'appids': '570'})
            b = cs._steam_api_get('ISteamUser', 'GetPlayerSummaries', '0002', {})
        return a is None and b is None
    check(cs._steam_cached_fetch({'ts': 0, 'val': None}, 1, fetch) is True, 'expired shared budget skips all further upstream calls')


def test_save_clear_and_composed_response():
    with tempfile.TemporaryDirectory() as d, patch.object(cs, '_STEAM_WEBAPI_CONF', os.path.join(d, 'steam.json')):
        configure()
        cs._STEAM_SUMMARY_CACHE.update(ts=time.monotonic(), val={'personaname': 'old'})
        check(cs._steam_webapi_save(OTHER, KEY), 'save succeeds')
        check(cs._STEAM_SUMMARY_CACHE['val'] is None and cs._STEAM_WEBAPI['steamid64'] == OTHER, 'save changes account and clears cache together')
        cs._steam_webapi_clear()
        check(not cs._steam_webapi_configured() and not os.path.exists(cs._STEAM_WEBAPI_CONF), 'disconnect clears memory and file')
    configure()
    def change_account():
        configure(OTHER)
        return {'personaname': 'wrong owner'}
    with patch.object(cs, '_steam_summary_cached', change_account), patch.object(cs, '_steam_level_cached', lambda: 1):
        check(cs._steam_profile_payload().get('connected') is False, 'composed profile rejects account changes during the fetch')


if __name__ == '__main__':
    for fn in (test_single_flight_and_latency, test_generation_rejects_aba_and_credentials,
               test_stale_failure_and_backoff, test_detached_slot_account_isolation, test_price_failure_not_empty_sale,
               test_global_worker_bound, test_upstream_budget, test_save_clear_and_composed_response):
        fn()
    raise SystemExit(1 if fails else 0)
