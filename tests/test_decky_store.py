#!/usr/bin/env python3
"""The Decky store slice of the Decky manager: what the box tells the phone
about plugins it could install, and the icon bytes it proxies for them.

Run: python3 tests/test_decky_store.py

WHY THIS FILE EXISTS (spec: docs/memory/project_decky-manager.md §3, §9, §14).
The store catalogue is the one piece of INTERNET data that ends up naming
something the box will trust: `versions[0].hash` is what the agent hands
Decky Loader as the SHA-256 it must verify before extracting a zip as root.
Everything between plugins.deckbrew.xyz and that hand-off is therefore
tested here as a REFUSAL surface, not a parser:

  1. Normalisation is BY REJECTION. A store entry that violates any shape
     rule is dropped whole, never repaired — a 3 MiB `tags` array or a
     nested object where a string belongs cannot reach the phone. The one
     trim is `description` (display-only) and the one null-not-reject field
     is `image_url` (a bad picture must not hide a good plugin).
  2. No redirect is EVER followed. The catalogue and the icon bytes come
     through `_DeckyNoRedirect`, so a CDN or store 302 to `http://…` on the
     LAN is a failure (`unavailable` / `stale` / 404), not the box's data.
     Both fakes here answer a real 302 to `http://127.0.0.1:<port>/` and the
     target's hit counter proves it was never requested.
  3. Icons are host-pinned (`https` on exactly `_DECKY_ICON_HOST`), capped at
     1 MiB, image-sniffed (incl. AVIF), and served from a cache keyed by the
     INT id — the path segment must be `[0-9]{1,9}` exactly (never
     `str.isdigit()`: `'²'.isdigit()` is True and `int('²')` raises).
  4. `has_icon` is never advertised-then-404: every kept image type is one
     the sniff accepts, and this file walks every served entry to prove it.
  5. Update detection is STRICT semver on both sides, so `-pre`, `-1` and
     `-dddf365` suffixes (all present in the live store) never produce the
     phantom updates `_ver_tuple` would.

FIXTURE: `STORE_CAPTURE_2026_09_06` is VERBATIM — ten entries cut from the
`GET https://plugins.deckbrew.xyz/plugins` capture of 2026-09-06 (research
scratchpad `decky/store.json`, 110 entries), one JSON object per line, byte
for byte including every version. The eight ids the spec's mock uses (36, 7,
14, 23, 21, 10, 137, 13) plus two that make the rules bite: id 63 "Free
Loader" carries ELEVEN tags (the spec's cap is ten — the normaliser drops a
real plugin, recorded as an open issue), and id 107 "Decky Sunshine" has the
hash-suffixed version `2025.10.27-dddf365` as its newest.

The fake CDN is a real TLS server on 127.0.0.1 (cert minted with the
`openssl` CLI, exactly how the agent mints its own; the client context
VERIFIES it) because the icon pin is https-only by code and a plain-http
fake could never reach the fetch path. When `openssl` cannot mint a cert the
TLS-dependent checks are printed as SKIP and counted, never silently passed.
"""
import ast
import copy
import http.client
import http.server
import importlib.util
import inspect
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "couchsided", os.path.join(ROOT, "agent", "couchsided.py"))
cs = importlib.util.module_from_spec(_spec)
sys.modules["couchsided"] = cs
_spec.loader.exec_module(cs)

FAILURES = []
SKIPPED = []
TOKEN = "test-secret-token"


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s (got %r, want %r)" % (name, got, want))
        FAILURES.append(name)


def skip(name, why):
    print("  SKIP  %s (%s)" % (name, why))
    SKIPPED.append(name)


class Patch:
    """Swap module attributes for the duration of a `with`, restore after."""

    def __init__(self, **kw):
        self._kw = kw
        self._old = {}

    def __enter__(self):
        for k, v in self._kw.items():
            self._old[k] = getattr(cs, k)
            setattr(cs, k, v)
        return self

    def __exit__(self, *a):
        for k, v in self._old.items():
            setattr(cs, k, v)


# ---------------------------------------------------------------------------
# The VERBATIM store capture (2026-09-06). One entry per line, untouched.
# ---------------------------------------------------------------------------
STORE_CAPTURE_2026_09_06 = r'''
{"id":36,"name":"SteamGridDB","author":"SteamGridDB","description":"Customize your library with user-submitted images or local files, and other style tweaks like square capsules, uniform sizing, and more!","tags":["artwork","sgdb"],"versions":[{"name":"1.7.1","hash":"6d6eca184677dc9ff7736439ee7a575ca8ab386c5ffb1627d446bc43dbd1ecf3","created":"2026-03-27T16:53:16Z","downloads":206912,"updates":275005},{"name":"1.7.0","hash":"f18279dc95b6ee003a7f53a84e8f7eee3a8fdd042ef67e5160c91c31ad12659f","created":"2025-10-28T02:35:51Z","downloads":252110,"updates":263749},{"name":"1.6.0","hash":"6bc09af6ce16bf3437dc100129940310481338bbf2b198ed702854ed193d2e46","created":"2025-07-07T14:18:55Z","downloads":144007,"updates":250715},{"name":"1.5.1-loaderv2","hash":"b84f0a3f83b6e5d7cbc0ba9360bde33cfb400cf5f2a5d5c38f44a488e2c91a57","created":"2024-09-05T14:49:49Z","downloads":491700,"updates":135392},{"name":"1.5.0-loaderv2","hash":"9fac0bdd698c68d3584ef9cc70db891e644566faf4a0bf26ffc452e5c207358a","created":"2024-08-24T12:11:19Z","downloads":82858,"updates":1567},{"name":"1.4.0","hash":"c9243a2e95098899a08e2b2dab4a881fc029527b055a2a7741f8f3772bf7946b","created":"2024-03-17T18:03:57Z","downloads":346649,"updates":3427},{"name":"1.3.3-1","hash":"0b78bac79bb4aac8279c31dedc96e245d0aed176e9a45e0b359b75ac47135939","created":"2024-01-20T03:59:08Z","downloads":78437,"updates":113106},{"name":"1.3.3","hash":"441ecf2738e60129537e617ad3f4e3ccfd1d51d71cc2aa2ca2aab394f2063d86","created":"2023-11-16T12:44:02Z","downloads":45338,"updates":21689},{"name":"1.3.2","hash":"3efefffc47964e2088649f98e53287a3938526424ee71a4a7b7cabf96909b496","created":"2023-11-14T20:46:32Z","downloads":157,"updates":101},{"name":"1.3.1","hash":"30e29dfc52b1a353a50ce020ebf7d1f400b6d27273584678dacac36e488e4ac5","created":"2023-09-18T13:17:55Z","downloads":74,"updates":39},{"name":"1.3.0","hash":"3726585bcc5ab07036a18ac890b0b2642afb0aa3c142d75873399251994772a8","created":"2023-08-22T23:34:03Z","downloads":143,"updates":71},{"name":"1.2.5","hash":"599beab94ce4f6a06d4f7008bcf05a54389508d6258221c209a4e3b92419825e","created":"2023-05-12T20:46:23Z","downloads":68,"updates":25},{"name":"1.2.4","hash":"32e22e0252fe8b16847fa48993b3f22ee42ac2b53202a8740ca71141b4654535","created":"2023-04-20T14:02:58Z","downloads":27,"updates":27},{"name":"1.2.3","hash":"4484b1887b884b3f30eb3bfbe16b4d2f6f01b8f8d52c5c1ca3c26f6b67b5bd08","created":"2023-04-05T10:22:09Z","downloads":11,"updates":6},{"name":"1.2.2","hash":"352c99bf545ef0ddccd17326ff7f0e5c07d3bd5b55356873239f1140614e330d","created":"2023-03-28T00:06:30Z","downloads":7,"updates":6},{"name":"1.2.1","hash":"c3aebdc5fc73fd820e8dfcec7a1b8994b425ebd43c1385e0d5c7a7b2d5665479","created":"2023-03-19T21:40:37Z","downloads":7,"updates":5},{"name":"1.2.0","hash":"9c819693e4c67196ef232f14f7406fa9b7ac7897f425d6660b2382f005fa11bb","created":"2023-03-07T23:08:57Z","downloads":50,"updates":30},{"name":"1.1.1","hash":"6940b8672fce60926216e675cc101466bb55083efaa91010ba33d681c01db288","created":"2023-02-24T22:58:52Z","downloads":220,"updates":122},{"name":"1.1.0","hash":"848b2fff2bdf98d92ebe3450a8679f9bbd5855cf81475e94e3ea575ecef955ef","created":"2023-02-19T02:23:56Z","downloads":15,"updates":11},{"name":"1.0.1","hash":"eebf2093c109ca14fc960b212d101e6ac89102c7a8a8c86dc9d6c653cc179ff2","created":"2023-01-20T23:28:47Z","downloads":8,"updates":7},{"name":"1.0.0","hash":"0567f8a3468b32072692682f10f7d12534a43f0956e648a8f4a0d2b3e59407ab","created":"2022-12-18T21:21:19Z","downloads":89,"updates":59}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/SteamGridDB-1a938447c46d3d7816c87181c20b96ca438840cbdbb556c13c37cf1f923b3512.png","downloads":1648887,"updates":1065159,"created":"2022-12-18T21:21:19Z","updated":"2026-03-27T16:53:16Z"}
{"id":7,"name":"CSS Loader","author":"DeckThemes","description":"Dynamically loads themes developed with CSS into the Steam UI. For more information, visit deckthemes.com.","tags":["style"],"versions":[{"name":"2.1.2","hash":"1a1e8f4dded8494febe56df16429ef5bba1e5b8feb3fd989d5808fbef0d71350","created":"2024-07-06T11:37:37Z","downloads":1109573,"updates":197795},{"name":"2.1.1","hash":"9f83a4c8a95c1e71a56dd375d4ab137d1e2ed9f0e037dbf39a81fa31b65070a4","created":"2024-04-19T09:21:43Z","downloads":216695,"updates":1918},{"name":"2.1.0","hash":"188d67cdb5d4f407d6ed000c50592be2377af927f67925bc5e41b20b22c001dd","created":"2024-03-17T01:02:51Z","downloads":111083,"updates":1465},{"name":"2.0.6","hash":"929368a371a8e659940be114f55a7add327383f3c332eeedb4b1dd6a9a9295af","created":"2024-02-27T10:29:40Z","downloads":82034,"updates":3950},{"name":"2.0.5","hash":"d960eec8f6154718d7df160bff145a9e529f438ef53038825d0c231f70816ceb","created":"2024-01-20T22:06:06Z","downloads":36349,"updates":88350},{"name":"2.0.3-1","hash":"7148aa61cf169556ce956296cd7bef6a8c740ca9c8b05b63349381f5bcd4da6a","created":"2024-01-20T03:58:28Z","downloads":934,"updates":13409},{"name":"2.0.3","hash":"9c2a95295283c4c3f6131c62653a6dedf8ebf48087aaf2de8d2f50732a9388f2","created":"2024-01-19T03:37:12Z","downloads":1121,"updates":11585},{"name":"2.0.2","hash":"1565104318aeb15dce9605a8f42a7242afdac48bfd2b363ba6b8614ad777be34","created":"2023-12-01T13:14:59Z","downloads":37038,"updates":28301},{"name":"2.0.1","hash":"4f7a60b977ddf3fce2e5f506171629655b1c7babbf115a9e36f507fdc3971d8a","created":"2023-09-30T18:41:10Z","downloads":500,"updates":573},{"name":"2.0.0","hash":"074316ea7040149b8965c86a389dfe6c8519544dc69834776144dd407a14aa95","created":"2023-09-23T14:07:06Z","downloads":79,"updates":94},{"name":"1.8.0","hash":"4a6c8b0eaafa47568d40c4ade8cc4853e94d75302c25ce09434f38ea02797f5b","created":"2023-07-30T20:44:47Z","downloads":45,"updates":27},{"name":"1.7.1","hash":"902c72d2ae46171f71f2f123ee524f639709c82cf53b85a49b4d2fcccd2d733e","created":"2023-06-27T18:51:48Z","downloads":5,"updates":15},{"name":"1.6.1","hash":"0408b61432061293e08f57f8fb537ea1c6f0d5b2c08fa64aecc79bb4f5db6d23","created":"2023-05-11T23:34:04Z","downloads":13,"updates":12},{"name":"1.6.0","hash":"0543c6419babc52f6f3492c7df5beb2e00ee954c836421fd52b41d3384647249","created":"2023-05-07T14:57:05Z","downloads":9,"updates":9},{"name":"1.5.3","hash":"ce4783e5f5354031eaea098b70a70587b8f7e648dc91c7e6932ea740f36f5ecb","created":"2023-04-09T23:07:36Z","downloads":4,"updates":3},{"name":"1.5.2","hash":"2298978287d6da17ac58a8d532a3c0fbdcea7c5a78cba696f2fec1ec301355a6","created":"2023-04-06T02:44:54Z","downloads":7,"updates":7},{"name":"1.5.0","hash":"1c2fb6d6db6059c79d3b5874278657a3265067b8fa7271ae47b6eae169b758d5","created":"2023-04-06T02:44:54Z","downloads":4,"updates":10},{"name":"1.4.1","hash":"b2e63bef7454d2e2caa91644a975aaf8f7a0708cb326ce9c7e0bd508ea7d4757","created":"2023-04-06T02:44:54Z","downloads":4,"updates":5},{"name":"1.4.0","hash":"26bfb4896e093690fdf70de1eb2f2f1c4fb51218ed1761a53a7af4a34d5ad648","created":"2023-04-06T02:44:54Z","downloads":17,"updates":27},{"name":"1.3.2","hash":"8c37a0ab9852e2beba62473b0dcae6d54be802dff2b25a495613be295c25e491","created":"2023-04-06T02:44:54Z","downloads":7,"updates":4},{"name":"1.3.1","hash":"8e350218aecc407cbe20a93abef7198db7ad004b1af3e4a333f37be48205dabe","created":"2023-04-06T02:44:54Z","downloads":6,"updates":5},{"name":"1.3.0","hash":"535f3c719ca1169f42a991189a944bc47649e7363883e9688f3c28ddbe2e565f","created":"2023-04-06T02:44:54Z","downloads":5,"updates":7},{"name":"1.2.1","hash":"92c7f5381a8ba96f8101d435166882ada8fbba74e2780de96c82159084cb94dc","created":"2023-04-06T02:44:54Z","downloads":2,"updates":6},{"name":"1.2.0","hash":"8c92297a19a041ebdd4ab0390297c36e4e1231c89942046509824e9d217bd149","created":"2023-04-06T02:44:54Z","downloads":3,"updates":2},{"name":"1.1.1","hash":"30c36d41eb5874533b438dbfed514998a6f7a01f08930995cae8c356895848bf","created":"2023-04-06T02:44:54Z","downloads":6,"updates":3},{"name":"1.1.0","hash":"266498f4bf15506cbd9535631ee063e6cdb88b96ac455262da9370729a5a5a1f","created":"2023-04-06T02:44:54Z","downloads":0,"updates":4},{"name":"1.0.0","hash":"10a4ee4accb0a667379efdb5890a3eefd92167368dd8829e5efb7c9e90662c41","created":"2023-04-06T02:44:54Z","downloads":14,"updates":15},{"name":"0.2.0","hash":"ba70e00657372901b7f38781dc1dece4d66b5659c9a405c983c3df6c04ab2912","created":"2023-04-06T02:44:54Z","downloads":32,"updates":72}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/CSS%20Loader-521e6e0b59bd89ba3632f15b7a1463cb96127a8a43449d487a4e49b1f1cbafe2.png","downloads":1595589,"updates":347673,"created":"2023-04-06T02:44:54Z","updated":"2024-07-06T11:37:37Z"}
{"id":14,"name":"ProtonDB Badges","author":"Schelstraete Bart","description":"Display tappable ProtonDB badges on your game pages","tags":["protondb"],"versions":[{"name":"1.2.0","hash":"54fadb8faec26bb8667a6fd7c61167bc4e5584414f142ae455c74a381ee23891","created":"2026-01-07T23:08:55Z","downloads":220095,"updates":222142},{"name":"1.1.0","hash":"3894048d0d9b35342c85d9f50e9e5e4edc00b65e9dfe61d47ec5cf97bfd28da7","created":"2024-09-12T07:11:13Z","downloads":541024,"updates":103069},{"name":"1.0.12-1","hash":"0beced3bfc4b75d621b2766052012ed494e42d0c850e04c7f028f378d5acfb8b","created":"2024-01-20T03:58:20Z","downloads":217923,"updates":84975},{"name":"1.0.12","hash":"f862ee45dae15aa48154724a17cbcd65181fd003e1408caaad90d2b377f45c13","created":"2024-01-18T03:18:30Z","downloads":1717,"updates":18161},{"name":"1.0.11","hash":"b4d2ee391cb031f72025594ad9071e4f9a742428952dbc21ea88d4a9fa3079f3","created":"2023-05-14T17:51:37Z","downloads":26583,"updates":3699},{"name":"1.0.10","hash":"d7ac342b3bde4098b55929d4f94f80669a65bef237ac583cacc5f51593379f74","created":"2023-04-01T16:53:51Z","downloads":49,"updates":41},{"name":"1.0.9","hash":"2fef9780c7f63df39bbe38aeb16cc6225230be25d7810feaa8ad060c43974904","created":"2023-04-01T16:53:51Z","downloads":16,"updates":13},{"name":"1.0.8","hash":"0521b517ace91ca9f5599e33e3af966c23c1b76d4ad982568f5c428fbda8f3c1","created":"2023-04-01T16:53:50Z","downloads":11,"updates":4},{"name":"1.0.7","hash":"dfd3a2797ab084513638d95377c34ce30f491eeb3022c8c275e5cc4db7bf1c6d","created":"2023-04-01T16:53:50Z","downloads":5,"updates":4},{"name":"1.0.6","hash":"1405ede25dd2a76110fd1d23619eece6d3445c879783401b32b0bd55c1b90e57","created":"2023-04-01T16:53:50Z","downloads":12,"updates":8},{"name":"1.0.4","hash":"68f04e4c6b7300c5210e095d803d9fe18c44f62a709c270593fc23efef7e2f79","created":"2023-04-01T16:53:50Z","downloads":1,"updates":2},{"name":"1.0.3","hash":"a72dae80e7726d1b181edef00ef6e11cfb6493432b5180aad5db10bc3b65c618","created":"2023-04-01T16:53:50Z","downloads":1,"updates":1},{"name":"1.0.1","hash":"461fa528b5ea8229072c7a1e4051a3106dea68731a6594b819d0f90cf84c1120","created":"2023-04-01T16:53:50Z","downloads":19,"updates":11}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/ProtonDB%20Badges-aa57ab7fbf2d1fcbd51e8d671c7e702405df674aeac6de039f77a135c8c7586a.png","downloads":1007456,"updates":432130,"created":"2023-04-01T16:53:50Z","updated":"2026-01-07T23:08:55Z"}
{"id":23,"name":"Animation Changer","author":"Justin Marentette","description":"A boot/suspend animation management plugin.","tags":["boot-animation","utility"],"versions":[{"name":"1.3.2","hash":"f2c62b90ca60d8a80b6d0f75d8027552b1509c7a05842c6f4a24a9072846d133","created":"2025-02-10T21:25:10Z","downloads":444287,"updates":239418},{"name":"1.3.1","hash":"dfb5a6c6d7ddd5847f247596b3d19bbe937dbf4385c09ab8377526c87de31045","created":"2024-05-07T17:56:13Z","downloads":317140,"updates":29843},{"name":"1.3.0-1","hash":"63ede8fa94441e7917abd6edab4d8ac8317dbe1a49ad48f50a48085ff2039b0e","created":"2023-05-15T18:53:14Z","downloads":100721,"updates":10213},{"name":"1.3.0","hash":"f118f485dbd9a12878b054b2d39ae7a66bfa3b1388b88222f46f6fcaf584a952","created":"2023-04-19T14:04:24Z","downloads":555,"updates":314},{"name":"1.2.4","hash":"f73426674248701d718625c7cc996f4abc25daa5fd2be7625fc7163b1c6548b0","created":"2023-03-11T03:33:38Z","downloads":86,"updates":37},{"name":"1.2.3","hash":"5faeab2338c383e9325fa677f9b3895129d97de2e9804f1dcef870320bd3116d","created":"2023-02-20T22:42:28Z","downloads":12,"updates":14},{"name":"1.2.2","hash":"b36b3090f38913b8561da3bd8f03377879961b6ae53e237023c79d41778f77c1","created":"2022-12-19T01:04:26Z","downloads":30,"updates":16},{"name":"1.2.1","hash":"542bfb5b9ce7d192a238f32aa42a9ad89e7c98c9800cc0e5545d9b95e9fb783f","created":"2022-11-12T19:03:19Z","downloads":15,"updates":10},{"name":"1.2.0","hash":"79903d97be18da341bacc5724fb757d81b2e4429e9a47b1737d619354e0698ad","created":"2022-10-31T00:24:51Z","downloads":49,"updates":38},{"name":"1.1.0","hash":"d3a48d764db85aa7b58e1497942446f2ae6476a7d804d6b078bf9e3bc48f00e0","created":"2022-10-16T16:11:01Z","downloads":8,"updates":9},{"name":"1.0.0","hash":"13f2ecea0591f7928dfa93002ee0b32d664cd5cfd441413aff3c33f3959d8f17","created":"2022-10-14T03:11:46Z","downloads":27,"updates":30},{"name":"0.0.1","hash":"63a2e96ee6fe872b92530fed61a291470bccbd0a21d72af88a6a80c06cb98761","created":"2022-10-09T22:46:29Z","downloads":19,"updates":15}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/Animation%20Changer-2f01eb07e607c3ebd99b7e76648bc2486910d33081fa8571a8f18f718727d8bd.png","downloads":862949,"updates":279957,"created":"2022-10-09T22:46:29Z","updated":"2025-02-10T21:25:10Z"}
{"id":21,"name":"PowerTools","author":"NGnius","description":"Power tweaks for power users","tags":["power-management","root","utility"],"versions":[{"name":"2.0.3","hash":"47614f53b8c538c4caa15f89a01e4ab106fa328e89f78545bacb3166d104d964","created":"2024-06-18T14:02:00Z","downloads":411509,"updates":63981},{"name":"2.0.2","hash":"0532bb4701f45797726d7a852acc80580463720e2b160cae03906141b521dab0","created":"2024-05-03T03:45:34Z","downloads":95535,"updates":495},{"name":"1.4.0-1","hash":"3d712c7fbf3897ed2a6535a87492b15fb8f053ea71bcb2475691b356188863db","created":"2024-01-20T04:00:58Z","downloads":63965,"updates":67976},{"name":"1.4.0","hash":"122506f0984df9e04ffc2a3770d0b7607393c5d87f1f6f2475f8949c5e33b447","created":"2023-08-30T23:22:34Z","downloads":19122,"updates":7083},{"name":"1.3.2","hash":"55947c5299e5ce3612fc0459bd6e67e55edf427ba9a0c09333eb23e5e1b463d5","created":"2023-05-14T10:51:44Z","downloads":159,"updates":40},{"name":"1.3.1-1","hash":"4bc3155b47b4a3dbdcade741b86952652c083974a7a4548c8b2da1317a12127f","created":"2023-04-15T03:10:04Z","downloads":32,"updates":17},{"name":"1.3.1","hash":"147ad8b47d4fbb1744530b5c9e5593ab49cb9e7695e5eb3b0c5dbff4ecd278db","created":"2023-04-10T23:54:50Z","downloads":36,"updates":12},{"name":"1.3.0","hash":"d422076a0d7b54af01761066236126bd99e968b85fa83411d182e83bf615eee2","created":"2023-04-02T08:35:15Z","downloads":48,"updates":15},{"name":"1.2.0","hash":"cee24d3b4327ab8915f606f9c238b3596893a6a787e169c56841edd637811273","created":"2023-03-05T14:26:07Z","downloads":16,"updates":8},{"name":"1.1.1","hash":"62b9e1eb8701e15649cdab96f3d0b86a2602c24c55028001a578ca7036189cd4","created":"2023-02-19T02:28:43Z","downloads":9,"updates":5},{"name":"1.1.0","hash":"f9278bc4faf18e00473f592fca4c01461531ff6e14035d6fe51753dcd8795c4a","created":"2023-02-09T19:19:12Z","downloads":34,"updates":9},{"name":"1.0.6","hash":"e99f22a99e5b1ce8ec43cb673067221f1dc4e5f173b425134a01097cc5ef3e2d","created":"2023-01-25T07:52:31Z","downloads":2,"updates":1},{"name":"1.0.5","hash":"243c3641a07762254094c83dbc7641b1d72033f1a989755cb0b1cb1918dab1cb","created":"2022-10-12T22:16:29Z","downloads":12,"updates":7},{"name":"1.0.4","hash":"e7ccc9363a8b2231bb690fd5536995fa17de1c3f4f1becf29be24ecc5226cd43","created":"2022-09-25T18:35:40Z","downloads":38,"updates":30}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/PowerTools-5390b97fa41a45fcfb6529406527059b33c9d982872a286b9dbbbd06c74ca28d.png","downloads":590517,"updates":139679,"created":"2022-09-25T18:35:40Z","updated":"2024-06-18T14:02:00Z"}
{"id":10,"name":"vibrantDeck","author":"Scrumplex","description":"Adjust color settings of your Deck","tags":["saturation","vibrant"],"versions":[{"name":"2.0.1","hash":"272f6f3cd66c5d5c9b50ff46463ad509c8afc014633febd22046ff1aee52ee0f","created":"2024-05-19T18:25:52Z","downloads":412820,"updates":62999},{"name":"2.0.0-1","hash":"1dcd5ca7b64e04ab393dd5986bc1b4cc9a98f40dc7079a518596bfc93bb9e1b1","created":"2024-01-20T03:58:15Z","downloads":94070,"updates":38030},{"name":"2.0.0","hash":"5be5d4dbc3ec45f5cd4aa4cbd137fb114f793b81106eb6d0b6800e3c1e24dd8d","created":"2024-01-10T15:47:00Z","downloads":1300,"updates":608},{"name":"1.4.1","hash":"857bbc45ab7af76b10f50181103b2648e5468650519a6bbbc03882e550f83b84","created":"2023-08-22T23:40:22Z","downloads":571,"updates":310},{"name":"1.4.0","hash":"4efffdb1d0ceb6473fbd2839a00f2275f622bda8d9dacb0064651a1461dc5c97","created":"2023-06-10T13:54:57Z","downloads":157,"updates":105},{"name":"1.3.5","hash":"61906722edf49d9de6afa73d798e5e5b6b0a444b9cd4bde0142f0f30adff08cd","created":"2023-05-11T16:53:30Z","downloads":96,"updates":53},{"name":"1.3.4","hash":"81cdcd25c55194e9afc13a9bcbc2dbfa3c89085d15cea71deea76bdc3787e988","created":"2023-04-13T21:54:03Z","downloads":54,"updates":29},{"name":"1.3.3","hash":"73affc7b8425c49793443880accd205327529854f389490f2d9505ec2f709965","created":"2023-02-23T14:26:30Z","downloads":41,"updates":23},{"name":"1.3.2","hash":"2cbe56e69d94e6798a4c2d0374c71b87d0913d9f04e074b2ce4696f3181ea801","created":"2023-02-20T21:48:21Z","downloads":16,"updates":25},{"name":"1.3.1","hash":"507105137f0474f2fd7d1b0a1254c3d4492ed86f9478e3ba63c775c56345dc7f","created":"2023-01-10T00:30:29Z","downloads":130,"updates":140},{"name":"1.3.0","hash":"d08273335271fe5339b734a0f0a78a5b707d66082d64a072f1ef8f07f9810cb8","created":"2022-12-22T14:07:22Z","downloads":81,"updates":66},{"name":"1.2.1","hash":"c124699609bd7935389a52fbeb45556fefcbd24d983c96c9483f8c41fa9fe6c7","created":"2022-11-19T22:42:09Z","downloads":29,"updates":24},{"name":"1.2.0","hash":"a7b3f256533160d08bc9662826a516ca3169856bf31fad83040658de74c09463","created":"2022-11-19T22:42:09Z","downloads":57,"updates":46},{"name":"1.1.2","hash":"31063b435df61ecbf0793606d29abe8147c4eb987daf37fc2451e3c03cf5f24c","created":"2022-11-19T22:42:09Z","downloads":9,"updates":8},{"name":"1.1.1","hash":"564aea6c0bd3b273b2d1daffadc163866b2fb46799e8e4ecc8a93a8504c84cd8","created":"2022-11-19T22:42:09Z","downloads":9,"updates":11},{"name":"1.1.0","hash":"0bbee21190e9665b6bf6e41596dbb9cc07fa1ff203e66dead4af7c11d464a3b2","created":"2022-11-19T22:42:09Z","downloads":15,"updates":13},{"name":"1.0.1","hash":"b3d0f26f9494755632ec13daaad7bc24ac583707bf4201de22a3a9f32c677174","created":"2022-11-19T22:42:09Z","downloads":14,"updates":11},{"name":"1.0.0","hash":"c72e25f281f9ac67dbfdbfddb9b6ffdc47e8a0be167de8d0e9738ea5bc6f4157","created":"2022-11-19T22:42:09Z","downloads":172,"updates":161}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/vibrantDeck-cf0a9fb5eaed94bf5ab0d94a3440ad97b1f555dfafaa21eb65e0ab2a683046b1.jpg","downloads":509641,"updates":102662,"created":"2022-11-19T22:42:09Z","updated":"2024-05-19T18:25:52Z"}
{"id":137,"name":"Decky Proton Launch","author":"moi952","description":"Manage Steam game launch options from Gaming Mode. Set Proton environment variables like PROTON_FSR4_UPGRADE=1 or PROTON_DLSS4_UPGRADE=1 and add wrappers such as MangoHud or GameScope.","tags":["command","launch","proton"],"versions":[{"name":"0.9.0","hash":"e7b98a7ca8817ef08584ed0828eee8702631af33daccc229075a012eca91f731","created":"2026-05-13T22:21:52Z","downloads":17580,"updates":1445}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/Decky%20Proton%20Launch-d33f0e4efdd3e5bac366ddacb82fe61283c47386f91ac61ad0d48a00c867465b.jpg","downloads":17580,"updates":1445,"created":"2026-05-13T22:21:52Z","updated":"2026-05-13T22:21:52Z"}
{"id":13,"name":"Pause Games","author":"popsUlfr & wynn1212 & AkazaRenn","description":"Pause/Resume games to redirect resources and even play/stop apps that don't natively have an immediate option to do so.","tags":["pause","play","quick-resume","resume","sigcont","sigstop","sleep","stop","suspend"],"versions":[{"name":"1.0.2","hash":"68aa705107ceec43a50882e53d6dedc86cf4d9889c87a83279089c73b9de3c4f","created":"2026-09-02T05:19:14Z","downloads":0,"updates":0},{"name":"1.0.1","hash":"4816c0fd33e71fcea82dbdcf2d300f949f4f3a6ba6a179ce8c7aefff64115715","created":"2025-10-13T23:23:53Z","downloads":44482,"updates":31602},{"name":"1.0.0","hash":"b704ef5eb477415eeaab90c7e1d4cda524b061be211e8ec4885a60b995fd5503","created":"2025-01-13T22:44:43Z","downloads":39887,"updates":36205},{"name":"0.4.3","hash":"1158256926dcd00191225ba005f363d071b750607294e26b4faecba4da6dedd5","created":"2024-05-15T16:46:42Z","downloads":58737,"updates":2861},{"name":"0.4.2-1","hash":"f353d8494d7f571fa99bc35a9aa05d2799c55cc391f8e060d69bc0fca7372fd9","created":"2023-05-15T18:58:45Z","downloads":32218,"updates":1350},{"name":"0.4.2","hash":"f7bd98986e04c3a437d3e0912cc5df5b9d1134ab33a65fc1b85cb44f34e0011c","created":"2023-03-06T21:59:06Z","downloads":208,"updates":10},{"name":"0.4.1","hash":"0f46bd81d6466e8abaf529c0403bb4945585299cd39b112a4bcfac38c4a60a8a","created":"2023-01-23T20:13:53Z","downloads":34,"updates":6},{"name":"0.3.1","hash":"d23bb5281608971264e526da62c221002ad8070b53ccd5952017f712fb81d7a9","created":"2022-12-20T18:55:10Z","downloads":18,"updates":2},{"name":"0.2.0","hash":"4410cbc502f999d4bcf66c2480036f13e278289632aa51624a9e9b4b7ed55ec6","created":"2022-09-13T21:56:47Z","downloads":13,"updates":1},{"name":"0.1.2","hash":"2d9c8afa2857bc4ad1c69840c0c51216a60d85f5d15e86cfd010faf5dee8e37d","created":"2022-08-18T17:39:05Z","downloads":5,"updates":1},{"name":"0.1.0","hash":"685e9649363f27f555379402392e3544879f1a29c48454118015513f08071960","created":"2022-08-17T20:32:47Z","downloads":20,"updates":5}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/Pause%20Games-14da87b69a6682d5cee6644f03daa6e4b13655ef96061f097d963ac84a5ef9af.jpg","downloads":175622,"updates":72043,"created":"2022-08-17T20:32:47Z","updated":"2026-09-02T05:19:14Z"}
{"id":63,"name":"Free Loader","author":"jwhitlow45","description":"Notifications for free games on Steam, GOG, and Epic Games!","tags":["epic","epic games store","free","game","games","gog","library","loader","notifications","steam","store"],"versions":[{"name":"1.5.2","hash":"3b1b5a58f30c04c881d8745d3e6f6c5b6dee52fa3550789aab2ae2874fbd3db9","created":"2026-02-11T23:57:21Z","downloads":25841,"updates":29707},{"name":"1.5.1","hash":"2c960746e8827b542a500eeb7f12e851335deabd0d3825ae5b71e7009b5ac5a9","created":"2025-11-28T15:14:57Z","downloads":13283,"updates":22547},{"name":"1.4.1","hash":"6383f97cefa5b7de07a6512688a4001ab835944248a3247da307515e4709ba94","created":"2025-06-25T04:13:51Z","downloads":22774,"updates":31775},{"name":"1.4.0","hash":"52b5e0f35e83bd4758c2ba47790f95bfafb9ab7598100bdce13a445e610f04d1","created":"2025-06-11T15:51:42Z","downloads":2138,"updates":13135},{"name":"1.3.0","hash":"ce030b03c9638f990cf53657f1fd0ac95d1e1ad70060ac76752f26789d65f639","created":"2025-01-14T19:43:14Z","downloads":24057,"updates":26951},{"name":"1.2.1","hash":"7363155c458de4b0f24eb29a2824ff6331c7fa495f7feaaaf06626f2077dffad","created":"2024-05-07T18:06:56Z","downloads":63130,"updates":2883},{"name":"1.2.0","hash":"992e7a7be45e199d141071cd087c8e241d9d1a91b8b85a58e264458de4ef3423","created":"2024-03-17T18:07:34Z","downloads":18847,"updates":105},{"name":"1.1.0-1","hash":"d7430557e2638febb1d0d20d184b6cad6c86fff17206e5faddfc199635fe55f2","created":"2024-01-20T04:20:46Z","downloads":9781,"updates":10558},{"name":"1.1.0","hash":"d3ab825faa98e873586ffa3e711befa41a1cc48deef3731482d97098ea916de6","created":"2023-10-02T08:09:20Z","downloads":6070,"updates":684},{"name":"1.0.1","hash":"504ebd519177b1718c0448efd94ffa11ea99fb1dd6d61410d19c7e378d72f4f3","created":"2023-09-18T13:19:41Z","downloads":0,"updates":2},{"name":"1.0.0","hash":"f6888a95f72490f590fd62ff66483076fd8f04166e7eac9a025e91f918658cc1","created":"2023-08-05T07:29:51Z","downloads":5,"updates":7}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/Free%20Loader-532ae8cf47ec0b98f004bb879879db5b13f6767d9e047157c976490362372027.png","downloads":185926,"updates":138354,"created":"2023-08-05T07:29:51Z","updated":"2026-02-11T23:57:21Z"}
{"id":107,"name":"Decky Sunshine","author":"s0t7x","description":"Stream your Steam Deck screen to another device with minimal effort.","tags":["moonlight","root","server","streaming","sunshine"],"versions":[{"name":"2025.10.27-dddf365","hash":"335285d75df623492a04bb1955f6f802075623de985f426d9baaaf0b100ed437","created":"2025-11-27T16:56:04Z","downloads":24305,"updates":6486},{"name":"0.5.0","hash":"6d02497a15096bb879877730921f117742ff789516d98060edef624d6eb23ee5","created":"2025-06-10T22:40:25Z","downloads":7950,"updates":2761}],"visible":true,"image_url":"https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/artifact_images/Decky%20Sunshine-7c08989f90cb8734350b364929e4dca9cd195f66fa10e2ed19cac081f6541590.png","downloads":32255,"updates":9247,"created":"2025-06-10T22:40:25Z","updated":"2025-11-27T16:56:04Z"}
'''
CAPTURE = [json.loads(l) for l in STORE_CAPTURE_2026_09_06.strip().splitlines()]
CAPTURE_BY_ID = {e["id"]: e for e in CAPTURE}
SPEC_IDS = (36, 7, 14, 23, 21, 10, 137, 13)      # the mock's eight, all survive
ELEVEN_TAG_ID = 63                                 # "Free Loader": dropped by the <=10 cap
HASH_SUFFIX_ID = 107                               # "Decky Sunshine": newest is 2025.10.27-dddf365
# How many of the ten survive the normaliser: everything but Free Loader.
# If the tag cap is ever raised (open issue), this becomes 10 — one edit here.
KEPT_COUNT = 9
assert len(CAPTURE) == 10 and len(CAPTURE_BY_ID[ELEVEN_TAG_ID]["tags"]) == 11
assert CAPTURE_BY_ID[HASH_SUFFIX_ID]["versions"][0]["name"] == "2025.10.27-dddf365"

# Image fixtures. The PNG is the agent's own generator (real signature, real
# zlib stream). JPEG/WEBP/AVIF/HEIC are SYNTHETIC headers: the sniff reads
# magic bytes only, and the point under test is which magic is accepted.
PNG_BYTES = cs._png(8, 8, (10, 20, 30))
JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 60
WEBP_BYTES = b"RIFF" + b"\x24\x00\x00\x00" + b"WEBP" + b"VP8 " + b"\x00" * 24
# ISO-BMFF: 4-byte box size, 'ftyp', major brand 'avif' -> data[4:12] == b"ftypavif".
AVIF_BYTES = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf" + b"\x00" * 48
HEIC_BYTES = b"\x00\x00\x00\x1cftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 48
HTML_BYTES = b"<!doctype html><html><body>Cloudflare says no</body></html>"
BIG_BYTES = PNG_BYTES + b"\x00" * (cs._DECKY_ICON_MAX_BYTES + 1 - len(PNG_BYTES))
ATCAP_BYTES = PNG_BYTES + b"\x00" * (cs._DECKY_ICON_MAX_BYTES - len(PNG_BYTES))
assert len(BIG_BYTES) == cs._DECKY_ICON_MAX_BYTES + 1
assert len(ATCAP_BYTES) == cs._DECKY_ICON_MAX_BYTES


# ---------------------------------------------------------------------------
# Fake store / CDN server (plain http, and the same handler behind TLS)
# ---------------------------------------------------------------------------
class _FakeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_GET(self):
        srv = self.server
        with srv.lock:
            srv.hits[self.path] = srv.hits.get(self.path, 0) + 1
            route = srv.routes.get(self.path)
        if route is None:
            code, body, ctype, extra = 404, b"nope", "text/plain", {}
        else:
            code, body, ctype, extra = route
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)


class _FakeServer:
    """A fake plugins.deckbrew.xyz / cdn.tzatzikiweeb.moe on 127.0.0.1.
    `hits` counts every path requested — the counters are how "the 302 was
    NOT followed" is proven (the redirect target's counter stays at 0)."""

    def __init__(self, tls=None):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), _FakeHandler)
        self.srv.lock = threading.Lock()
        self.srv.hits = {}
        self.srv.routes = {}
        self.scheme = "http"
        if tls:
            cert, key = tls
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            self.srv.socket = ctx.wrap_socket(self.srv.socket, server_side=True)
            self.scheme = "https"
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def url(self, path):
        return "%s://127.0.0.1:%d%s" % (self.scheme, self.port, path)

    def route(self, path, body, ctype="application/octet-stream", code=200, **headers):
        with self.srv.lock:
            self.srv.routes[path] = (code, body, ctype, headers)

    def redirect(self, path, location):
        self.route(path, b"", "text/plain", code=302, Location=location)

    def hits(self, path):
        with self.srv.lock:
            return self.srv.hits.get(path, 0)

    def reset_hits(self):
        with self.srv.lock:
            self.srv.hits.clear()

    def stop(self):
        self.srv.shutdown()


def _mint_cert(d):
    """A self-signed cert for 127.0.0.1 via the openssl CLI (the agent mints
    its own the same way, `_tls_ensure`). None when openssl is unavailable."""
    cert, key = os.path.join(d, "cert.pem"), os.path.join(d, "key.pem")
    try:
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1",
             "-addext", "subjectAltName=IP:127.0.0.1"],
            check=True, capture_output=True, timeout=120)
    except Exception as e:                       # noqa: BLE001 - any failure = no TLS here
        print("  note: openssl could not mint a cert (%s); TLS cases will SKIP" % e)
        return None
    return cert, key


WORK = tempfile.mkdtemp(prefix="decky-store-test-")
HTTP = _FakeServer()
_TLS_PAIR = _mint_cert(WORK)
TLS = _FakeServer(tls=_TLS_PAIR) if _TLS_PAIR else None
if TLS:
    # The agent's opener, rebuilt with a VERIFYING client context that trusts
    # only our minted cert. `_DeckyNoRedirect` is the real class — the thing
    # under test — and HTTPSHandler(context=) only swaps the trust store.
    _client_ctx = ssl.create_default_context(cafile=_TLS_PAIR[0])
    cs._DECKY_NO_REDIRECT_OPENER = urllib.request.build_opener(
        cs._DeckyNoRedirect(), urllib.request.HTTPSHandler(context=_client_ctx))
    for p, body, ctype in (("/icon/png", PNG_BYTES, "image/png"),
                           ("/icon/jpg", JPEG_BYTES, "image/jpeg"),
                           ("/icon/avif", AVIF_BYTES, "image/avif"),
                           ("/icon/html", HTML_BYTES, "text/html"),
                           ("/icon/big", BIG_BYTES, "image/png"),
                           ("/icon/atcap", ATCAP_BYTES, "image/png")):
        TLS.route(p, body, ctype)
    TLS.redirect("/icon/302", TLS.url("/icon/png"))
    TLS.redirect("/icon/302-http", "http://127.0.0.1:%d/icon/png" % HTTP.port)

CAPTURE_JSON = json.dumps(CAPTURE).encode("utf-8")
HTTP.route("/plugins", CAPTURE_JSON, "application/json")
HTTP.route("/plugins-html", HTML_BYTES, "text/html")
HTTP.route("/plugins-notlist", json.dumps({"plugins": CAPTURE}).encode(), "application/json")
HTTP.redirect("/plugins-302", "http://127.0.0.1:%d/plugins" % HTTP.port)
HTTP.route("/icon/png", PNG_BYTES, "image/png")


def _closed_port_url():
    """A URL on a port nothing listens on (connection refused, never a hang)."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return "http://127.0.0.1:%d/plugins" % port


# ---------------------------------------------------------------------------
# Agent-state helpers
# ---------------------------------------------------------------------------
def _reset_store():
    """Cold cache, no backoff, no refresh gate — a clean slate per case."""
    cs._decky_store_install([], None)
    with cs._DECKY_STORE_LOCK:
        cs._DECKY_STORE["fetching"] = False
        cs._DECKY_STORE["last_attempt"] = 0.0
        cs._DECKY_STORE["refresh_at"] = 0.0
        cs._DECKY_STORE["stale"] = False
        cs._DECKY_STORE["error"] = None


def _store():
    with cs._DECKY_STORE_LOCK:
        return dict(cs._DECKY_STORE)


def _wait_fetch(timeout=20.0):
    """Block until no background store fetch is in flight."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with cs._DECKY_STORE_LOCK:
            if not cs._DECKY_STORE["fetching"]:
                return True
        time.sleep(0.02)
    return False


def _install_capture(entries=None):
    """Put a normalised copy of `entries` (default: the capture) in the cache
    as a fresh fetch, the way _decky_store_fetch would."""
    kept = cs._decky_store_normalise(copy.deepcopy(entries or CAPTURE))
    cs._decky_store_install(kept, int(time.time()))
    return kept


def _rewired_capture(icon_paths):
    """A deep copy of the capture with image_url pointed at the TLS fake:
    {id: '/icon/png' | full URL | None}. Entries not named keep their real
    (cdn.tzatzikiweeb.moe) URL, which under the repointed host pin is
    OFF-HOST and must normalise to null. Synthetic by construction — the
    real URLs are what the host-pin cases use."""
    out = copy.deepcopy(CAPTURE)
    for e in out:
        if e["id"] in icon_paths:
            p = icon_paths[e["id"]]
            e["image_url"] = TLS.url(p) if (p and p.startswith("/")) else p
    return out


class Box:
    """A fake box: temp roots for every Decky path constant, a Steam root,
    the opt-in marker on/off, the loader installed or not, and a plugins tree
    {name: (folder, version, flags)}. The store URL points at the http fake
    and the icon host pin at 127.0.0.1 (the TLS fake)."""

    def __init__(self, installed=True, marker=True, plugins=None, steam=True):
        self.installed, self.marker_on, self.plugins, self.steam = installed, marker, plugins, steam

    def __enter__(self):
        self.d = tempfile.mkdtemp(prefix="decky-box-", dir=WORK)
        self.marker = os.path.join(self.d, "allow-decky")
        self.icons = os.path.join(self.d, "decky-icons")
        self.plugdir = os.path.join(self.d, "homebrew", "plugins")
        self.unit = os.path.join(self.d, "plugin_loader.service")
        self.loader_bin = os.path.join(self.d, "homebrew", "services", "PluginLoader")
        self.settings = os.path.join(self.d, "homebrew", "settings", "loader.json")
        os.makedirs(self.plugdir)
        if self.installed:
            with open(self.unit, "w") as f:
                f.write("[Unit]\nDescription=SteamDeck Plugin Loader\n")
        self.set_marker(self.marker_on)
        for name, (folder, version, flags) in (self.plugins or {}).items():
            pd = os.path.join(self.plugdir, folder)
            os.makedirs(pd)
            with open(os.path.join(pd, "plugin.json"), "w") as f:
                json.dump({"name": name, "author": "t", "flags": flags}, f)
            if version is not None:
                with open(os.path.join(pd, "package.json"), "w") as f:
                    json.dump({"name": folder.lower(), "version": version}, f)
        steam_root = os.path.join(self.d, "steam")
        os.makedirs(os.path.join(steam_root, "steamapps"))
        sr = steam_root if self.steam else None
        self.patch = Patch(
            _DECKY_MARKER=self.marker, _DECKY_ICON_DIR=self.icons,
            _DECKY_PLUGINS_DIR=self.plugdir, _DECKY_UNIT=self.unit,
            _DECKY_LOADER_BIN=self.loader_bin, _DECKY_SETTINGS=self.settings,
            _DECKY_STORE_URL=HTTP.url("/plugins"), _DECKY_ICON_HOST="127.0.0.1",
            _steam_root=lambda: sr)
        self.patch.__enter__()
        _reset_store()
        return self

    def set_marker(self, on):
        if on:
            with open(self.marker, "w") as f:
                f.write("ok\n")
        elif os.path.exists(self.marker):
            os.unlink(self.marker)

    def icon_cached(self, sid):
        return os.path.isfile(os.path.join(self.icons, str(sid)))

    def __exit__(self, *a):
        _wait_fetch()
        self.patch.__exit__(*a)
        _reset_store()
        shutil.rmtree(self.d, ignore_errors=True)


def _server(mock=False):
    cs.Handler.token = TOKEN
    cs.Handler.token_file = None
    cs.Handler.mock = mock
    cs.Handler.port = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cs.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, token=TOKEN):
    """(status, headers, raw body). `token=None` sends no Authorization."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    headers = {"Authorization": "Bearer " + token} if token is not None else {}
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    hdrs = {k.lower(): v for k, v in resp.getheaders()}
    conn.close()
    return resp.status, hdrs, data


def _json(port, method, path, token=TOKEN):
    st, _h, data = _req(port, method, path, token)
    try:
        return st, json.loads(data or b"{}")
    except ValueError:
        return st, {}


def _flags(frozen=()):
    return {"disabled": set(), "hidden": set(), "frozen": set(frozen), "order": []}


# ---------------------------------------------------------------------------
print("\nnormaliser: the verbatim capture, by rejection")
# ---------------------------------------------------------------------------

def test_capture_survives_normaliser():
    """CONTROL for every rejection case below: the eight real entries the
    spec's mock is cut from survive the normaliser byte-for-byte on every
    field it keeps, so a rejection later is the rule firing, not the fixture
    failing to parse."""
    print("test_capture_survives_normaliser")
    kept = cs._decky_store_normalise(copy.deepcopy(CAPTURE))
    by = {e["id"]: e for e in kept}
    check("every spec id survives", all(i in by for i in SPEC_IDS), True)
    check("Decky Sunshine (hash-suffixed newest version) survives — the normaliser "
          "does not judge version SHAPES, only strings", HASH_SUFFIX_ID in by, True)
    e, raw = by[137], CAPTURE_BY_ID[137]
    check("kept field set is exactly the spec's",
          sorted(e), sorted(["id", "name", "author", "description", "tags", "downloads",
                             "created", "updated", "image_url", "versions"]))
    for k in ("id", "name", "author", "description", "tags", "downloads", "created", "updated"):
        check("137.%s is verbatim" % k, e[k], raw[k])
    check("real CDN image_url kept (https on cdn.tzatzikiweeb.moe)",
          e["image_url"], raw["image_url"])
    check("version keeps only name/hash/created",
          sorted(e["versions"][0]), ["created", "hash", "name"])
    check("version values verbatim",
          (e["versions"][0]["name"], e["versions"][0]["hash"], e["versions"][0]["created"]),
          (raw["versions"][0]["name"], raw["versions"][0]["hash"], raw["versions"][0]["created"]))
    sg = by[36]
    check("SteamGridDB's 21 versions capped to 5, newest first, in order",
          [v["name"] for v in sg["versions"]],
          [v["name"] for v in CAPTURE_BY_ID[36]["versions"][:5]])
    check("versions[0] is the one the store lists first (1.7.1)", sg["versions"][0]["name"], "1.7.1")
    # The spec's cap bites a REAL plugin. Asserted as the spec says (drop),
    # and recorded as an open issue: "Free Loader" (id 63, 11 tags) never
    # reaches the phone until the cap is raised.
    check("Free Loader (id 63, ELEVEN tags in the live store) is dropped by the "
          "<=10 tag cap [spec §3; open issue]", ELEVEN_TAG_ID in by, False)
    check("so %d of the ten captured entries are kept" % KEPT_COUNT, len(kept), KEPT_COUNT)
    # Live-capture sanity, so a future re-cut cannot silently weaken the cases.
    check("no captured description reaches the 400 cut (so nothing here is trimmed; the "
          "longest of the 110 live entries is 302 chars)",
          max(len(x["description"]) for x in CAPTURE) < 400, True)


def test_normaliser_rejects_bad_shapes_with_control():
    """Every shape rule fires on a copy of a REAL entry (id 137, the smallest)
    mutated in exactly one field; the unmutated entry is the control."""
    print("test_normaliser_rejects_bad_shapes_with_control")
    base = CAPTURE_BY_ID[137]
    ctrl = cs._decky_store_normalise_entry(copy.deepcopy(base))
    check("CONTROL: the unmutated entry is kept", ctrl and ctrl["id"], 137)

    def mut(**fields):
        e = copy.deepcopy(base)
        for k, v in fields.items():
            if v is _DEL:
                e.pop(k, None)
            else:
                e[k] = v
        return e

    def mutv(**fields):
        e = copy.deepcopy(base)
        for k, v in fields.items():
            if v is _DEL:
                e["versions"][0].pop(k, None)
            else:
                e["versions"][0][k] = v
        return e

    good_hash = base["versions"][0]["hash"]
    cases = [
        ("id True (bool is not an int here)", mut(id=True)),
        ("id '137' (string)", mut(id="137")),
        ("id 137.0 (float)", mut(id=137.0)),
        ("id 0", mut(id=0)),
        ("id -137", mut(id=-137)),
        ("id 10**9 (upper bound exclusive)", mut(id=10 ** 9)),
        ("id missing", mut(id=_DEL)),
        ("name empty", mut(name="")),
        ("name 65 chars", mut(name="x" * 65)),
        ("name with a newline (not printable)", mut(name="Decky\nProton")),
        ("name is a list", mut(name=["Decky"])),
        ("name is a nested object", mut(name={"en": "Decky"})),
        ("author 65 chars", mut(author="a" * 65)),
        ("author with a tab (not printable)", mut(author="moi\t952")),
        ("author is an int", mut(author=952)),
        ("description null", mut(description=None)),
        ("description nested object", mut(description={"text": "x"})),
        ("tags is a string", mut(tags="proton")),
        ("tags 11 entries", mut(tags=["t%d" % i for i in range(11)])),
        ("tag empty string", mut(tags=["", "proton"])),
        ("tag 25 chars", mut(tags=["x" * 25])),
        ("tag is an int", mut(tags=[1])),
        ("tag is a nested object", mut(tags=[{"t": "x"}])),
        ("downloads True", mut(downloads=True)),
        ("downloads -1", mut(downloads=-1)),
        ("downloads '17580' (string)", mut(downloads="17580")),
        ("downloads 1.5", mut(downloads=1.5)),
        ("created 33 chars", mut(created="2026-05-13T22:21:52Z" + "x" * 13)),
        ("created missing", mut(created=_DEL)),
        ("updated is an int", mut(updated=1780000000)),
        ("versions empty", mut(versions=[])),
        ("versions is an object", mut(versions={})),
        ("version entry is a string", mut(versions=["0.9.0"])),
        ("version name 33 chars", mutv(name="1" * 33)),
        ("version name empty", mutv(name="")),
        ("version name is an int", mutv(name=9)),
        ("version hash 63 chars", mutv(hash=good_hash[:63])),
        ("version hash 65 chars", mutv(hash=good_hash + "0")),
        ("version hash uppercase", mutv(hash=good_hash.upper())),
        ("version hash missing", mutv(hash=_DEL)),
        ("version hash is an int", mutv(hash=12345)),
        ("version created 33 chars", mutv(created="x" * 33)),
        ("version created missing", mutv(created=_DEL)),
        ("entry is a list, not an object", ["id", 137]),
        ("entry is a string", "137"),
        ("entry is null", None),
    ]
    for label, raw in cases:
        got = cs._decky_store_normalise_entry(raw)
        if got is not None:
            check("rejected: %s" % label, got, None)
    print("  PASS  %d one-field mutations of a real entry all rejected" % len(cases))
    # Boundary controls: exactly-at-the-limit values are KEPT.
    check("tags exactly 10 kept", cs._decky_store_normalise_entry(
        mut(tags=["t%d" % i for i in range(10)])) is not None, True)
    check("tag exactly 24 chars kept", cs._decky_store_normalise_entry(
        mut(tags=["x" * 24])) is not None, True)
    check("name exactly 64 chars kept", cs._decky_store_normalise_entry(
        mut(name="n" * 64)) is not None, True)
    check("author exactly 64 chars kept", cs._decky_store_normalise_entry(
        mut(author="a" * 64)) is not None, True)
    check("downloads 0 kept", cs._decky_store_normalise_entry(
        mut(downloads=0)) is not None, True)
    check("id 1 kept", cs._decky_store_normalise_entry(mut(id=1))["id"], 1)
    check("id 999999999 kept", cs._decky_store_normalise_entry(mut(id=10 ** 9 - 1))["id"], 10 ** 9 - 1)
    check("version created exactly 32 chars kept", cs._decky_store_normalise_entry(
        mutv(created="c" * 32)) is not None, True)
    # A real store extra the normaliser ignores rather than rejects: the live
    # payload carries `visible`, `updates` and per-version download counts.
    check("unknown extra keys (visible/updates) do not reject a real entry",
          cs._decky_store_normalise_entry(mut(visible=True, updates=1445, bogus="x")) is not None, True)
    check("the normaliser never raises on garbage", cs._decky_store_normalise_entry(object()), None)


_DEL = object()


def test_normaliser_list_level():
    print("test_normaliser_list_level")
    check("a non-list body keeps nothing", cs._decky_store_normalise({"plugins": CAPTURE}), [])
    check("a string body keeps nothing", cs._decky_store_normalise("[]"), [])
    check("None keeps nothing", cs._decky_store_normalise(None), [])
    # Three SEPARATE copies: deepcopy of [a, a, b] keeps the two a's shared
    # (memo), which made the first version of this case rename both.
    dup = [copy.deepcopy(CAPTURE_BY_ID[137]), copy.deepcopy(CAPTURE_BY_ID[137]),
           copy.deepcopy(CAPTURE_BY_ID[10])]
    dup[1]["name"] = "Impostor"
    kept = cs._decky_store_normalise(dup)
    check("duplicate id keeps the FIRST entry, drops the impostor",
          [(e["id"], e["name"]) for e in kept], [(137, "Decky Proton Launch"), (10, "vibrantDeck")])
    mixed = [None, "x", 5, copy.deepcopy(CAPTURE_BY_ID[13]), []]
    check("bad entries are skipped, the good one survives (control)",
          [e["id"] for e in cs._decky_store_normalise(mixed)], [13])


def test_image_url_host_scheme_rule():
    """`image_url` is the ONE field normalised to null instead of rejecting:
    a bad picture never hides a good plugin. Kept only for https on exactly
    the CDN host — checked on the parsed hostname, so userinfo tricks and
    look-alike hosts fail."""
    print("test_image_url_host_scheme_rule")
    ok = CAPTURE_BY_ID[36]["image_url"]
    check("real CDN url kept", cs._decky_image_url_ok(ok), ok)
    bad = [
        ("http:// on the real host (plaintext)", ok.replace("https://", "http://")),
        ("https on evil.example", "https://evil.example/x.png"),
        ("host suffix look-alike", "https://cdn.tzatzikiweeb.moe.evil.example/x.png"),
        ("host prefix look-alike", "https://evil-cdn.tzatzikiweeb.moe/x.png"),
        ("userinfo trick (real host before @)", "https://cdn.tzatzikiweeb.moe@evil.example/x.png"),
        ("ftp scheme", "ftp://cdn.tzatzikiweeb.moe/x.png"),
        ("scheme-relative", "//cdn.tzatzikiweeb.moe/x.png"),
        ("data: URI", "data:image/png;base64,iVBORw0KGgo="),
        ("empty string", ""),
        ("null", None),
        ("an int", 7),
        ("a list", [ok]),
        ("over 1024 chars", ok + "?" + "x" * 1024),
    ]
    for label, u in bad:
        check("nulled: %s" % label, cs._decky_image_url_ok(u), None)
    check("uppercase host spelling still pins to the host (hostname is lowercased)",
          cs._decky_image_url_ok(ok.replace("cdn.tzatzikiweeb.moe", "CDN.TZATZIKIWEEB.MOE")) is not None, True)
    # Through the entry normaliser: the entry SURVIVES with image_url null.
    e = copy.deepcopy(CAPTURE_BY_ID[14])
    e["image_url"] = "https://evil.example/x.png"
    got = cs._decky_store_normalise_entry(e)
    check("off-host image: entry kept", got and got["id"], 14)
    check("...with image_url null", got and got["image_url"], None)
    e["image_url"] = "http://cdn.tzatzikiweeb.moe/x.png"
    check("plaintext image: entry kept, image_url null",
          cs._decky_store_normalise_entry(e)["image_url"], None)
    e["image_url"] = {"src": ok}
    check("nested-object image: entry kept, image_url null",
          cs._decky_store_normalise_entry(e)["image_url"], None)
    # has_icon on the served row is exactly image_url-non-null.
    _install_capture([copy.deepcopy(CAPTURE_BY_ID[36]), e])
    try:
        rows = {r["id"]: r for r in cs.decky_store_payload()["plugins"]}
        check("has_icon true for the real CDN url", rows[36]["has_icon"], True)
        check("has_icon false when image_url was nulled", rows[14]["has_icon"], False)
    finally:
        _reset_store()


def test_description_and_versions_caps():
    print("test_description_and_versions_caps")
    e = copy.deepcopy(CAPTURE_BY_ID[137])
    e["description"] = "d" * 500
    got = cs._decky_store_normalise_entry(e)
    check("description cut at 400 (the one trim)", len(got["description"]), 400)
    e["description"] = "d" * 400
    check("description of exactly 400 untouched",
          len(cs._decky_store_normalise_entry(e)["description"]), 400)
    e = copy.deepcopy(CAPTURE_BY_ID[7])                  # 28 real versions
    got = cs._decky_store_normalise_entry(e)
    check("28 versions capped to 5", len(got["versions"]), 5)
    check("...the first five, in the store's order",
          [v["name"] for v in got["versions"]], [v["name"] for v in e["versions"][:5]])
    e["versions"][4]["hash"] = "not-a-hash"
    check("a bad version INSIDE the first five rejects the entry",
          cs._decky_store_normalise_entry(e), None)
    e = copy.deepcopy(CAPTURE_BY_ID[137])
    e["versions"] = e["versions"] * 5
    check("exactly 5 versions kept whole", len(cs._decky_store_normalise_entry(e)["versions"]), 5)


# ---------------------------------------------------------------------------
print("\nupdate detection: strict semver on both sides")
# ---------------------------------------------------------------------------

def test_update_detection_shapes():
    """The live store carries `-1`, `-loaderv2`, `-pre` and `-<sha>` suffixes.
    Decky's own UI (compare-versions, strict) shows no update for any of
    those; the agent must match it, never the lenient `_ver_tuple`."""
    print("test_update_detection_shapes")
    st = cs._semver_tuple
    check("1.7.1 parses", st("1.7.1"), (1, 7, 1))
    check("surrounding whitespace stripped", st(" 1.7.1 "), (1, 7, 1))
    check("single component parses", st("7"), (7,))
    check("four components parse", st("1.7.1.0"), (1, 7, 1, 0))
    for label, v in (("five components", "1.7.1.0.1"), ("v prefix", "v1.2"),
                     ("-pre suffix", "1.7.1-pre"), ("-1 suffix (real store shape)", "1.7.1-1"),
                     ("-loaderv2 suffix (real store shape)", "1.5.1-loaderv2"),
                     ("-<sha> suffix (real store shape)", "2025.10.27-dddf365"),
                     ("2.0.17-f57f127 (testing store shape)", "2.0.17-f57f127"),
                     ("empty", ""), ("double dot", "1..2"), ("trailing dot", "1.2."),
                     ("dev", "dev"), ("None", None), ("an int", 5), ("a list", ["1", "2"])):
        check("unparsable -> None: %s" % label, st(v), None)
    if hasattr(cs, "_ver_tuple"):
        # THE TRAP, demonstrated: the lenient helper turns a sha suffix into
        # a huge fourth component and would advertise a phantom update.
        check("CONTROL: the lenient _ver_tuple reads 2.0.17-f57f127 as newer than 2.0.17",
              cs._ver_tuple("2.0.17-f57f127") > cs._ver_tuple("2.0.17"), True)

    kept = _install_capture()
    try:
        store = cs._decky_store_snapshot()
        sg = CAPTURE_BY_ID[36]["versions"][0]           # 1.7.1 / 6d6eca...
        upd = cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0"}, _flags(), store)
        check("installed 1.7.0, store 1.7.1 -> update {version, hash}",
              upd, {"version": sg["name"], "hash": sg["hash"]})
        check("equal -> no update",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.1"}, _flags(), store), None)
        check("box ahead of the store (1.8.0) -> no update, never a downgrade prompt here",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.8.0"}, _flags(), store), None)
        check("installed 1.7.0-pre -> unparsable -> None (not a phantom)",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0-pre"}, _flags(), store), None)
        check("installed 1.7.0-1 (real store shape) -> None",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0-1"}, _flags(), store), None)
        check("installed version null -> None",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": None}, _flags(), store), None)
        check("Decky Sunshine 0.5.0 vs remote 2025.10.27-dddf365 -> None (remote unparsable)",
              cs._decky_plugin_update({"name": "Decky Sunshine", "version": "0.5.0"}, _flags(), store), None)
        check("frozen plugin never updates",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0"},
                                      _flags(frozen=("SteamGridDB",)), store), None)
        check("flags unknown (torn loader.json) -> None",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0"}, None, store), None)
        check("name not in the store -> None",
              cs._decky_plugin_update({"name": "Nope", "version": "0.0.1"}, _flags(), store), None)
        check("four-part installed (1.7.0.9) is still older than 1.7.1",
              cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0.9"}, _flags(), store)
              is not None, True)
    finally:
        _reset_store()
    check("cold store -> None (a poll never guesses)",
          cs._decky_plugin_update({"name": "SteamGridDB", "version": "1.7.0"}, _flags(),
                                  cs._decky_store_snapshot()), None)

    it = cs._decky_install_type
    check("not installed -> install", it(None, "1.0.0"), "install")
    check("older installed -> update", it("1.0.0", "1.1.0"), "update")
    check("newer installed -> downgrade (presented, never silent)", it("1.1.0", "1.0.0"), "downgrade")
    check("equal -> reinstall", it("1.0.0", "1.0.0"), "reinstall")
    check("unparsable installed (dev) -> reinstall, never INSTALL", it("dev", "1.0.0"), "reinstall")
    check("unparsable installed (-1 suffix) -> reinstall", it("1.0.0-1", "1.0.1"), "reinstall")
    check("unparsable remote -> reinstall", it("0.5.0", "2025.10.27-dddf365"), "reinstall")
    check("no fs listing -> None", it("1.0.0", "1.1.0", have_listing=False), None)


def test_store_overlay_install_type_from_disk():
    """`decky_store_payload` overlays the fs listing: installed_version,
    update_available and install_type per row, computed by the agent from
    disk + strict semver — the phone never sends a version."""
    print("test_store_overlay_install_type_from_disk")
    top = {i: CAPTURE_BY_ID[i]["versions"][0]["name"] for i in (36, 7, 21, 10, 107)}
    plugins = {"SteamGridDB": ("SteamGridDB", "1.7.0", []),
               "CSS Loader": ("SDH-CssLoader", top[7], []),
               "PowerTools": ("PowerTools", "9.9.9", ["root"]),
               "vibrantDeck": ("vibrantDeck", top[10] + "-1", []),
               "Decky Sunshine": ("decky-sunshine", "0.5.0", []),
               "Couchside": ("Couchside", None, ["root"])}
    with Box(installed=True, marker=False, plugins=plugins):
        _install_capture()
        rows = {r["id"]: r for r in cs.decky_store_payload()["plugins"]}
        check("SteamGridDB 1.7.0 on disk -> install_type update",
              (rows[36]["installed_version"], rows[36]["install_type"], rows[36]["update_available"]),
              ("1.7.0", "update", True))
        check("CSS Loader at the store version -> reinstall",
              (rows[7]["install_type"], rows[7]["update_available"]), ("reinstall", False))
        check("PowerTools 9.9.9 (box ahead) -> downgrade, presented honestly",
              rows[21]["install_type"], "downgrade")
        check("vibrantDeck with a -1 suffix on disk -> reinstall (unparsable installed)",
              rows[10]["install_type"], "reinstall")
        check("Decky Sunshine 0.5.0 vs sha-suffixed remote -> reinstall, not update",
              (rows[107]["install_type"], rows[107]["update_available"]), ("reinstall", False))
        check("not installed -> install, installed_version null",
              (rows[137]["install_type"], rows[137]["installed_version"]), ("install", None))
        check("row field set is exactly the spec's",
              sorted(rows[36]), sorted(["id", "name", "author", "description", "tags", "downloads",
                                        "updated", "has_icon", "installed_version",
                                        "update_available", "install_type", "versions"]))
    with Box(installed=False, marker=False, plugins=plugins):
        _install_capture()
        rows = {r["id"]: r for r in cs.decky_store_payload()["plugins"]}
        check("loader NOT installed: install_type null (listing unavailable), never 'install'",
              [rows[i]["install_type"] for i in (36, 137)], [None, None])
        check("...and installed_version null even though a folder is on disk",
              rows[36]["installed_version"], None)
        check("...and update_available false", rows[36]["update_available"], False)


# ---------------------------------------------------------------------------
print("\nfetch: no redirect is ever followed; stale is served, never guessed")
# ---------------------------------------------------------------------------

def test_no_redirect_handler_and_bounded_fetch():
    print("test_no_redirect_handler_and_bounded_fetch")
    h = cs._DeckyNoRedirect()
    # A REAL Request, so a handler that regressed to the stdlib behaviour
    # answers a new Request (a clean FAIL here) rather than crashing on None.
    req = urllib.request.Request("http://127.0.0.1/plugins")
    check("redirect_request answers None for every 3xx",
          [h.redirect_request(req, None, c, "", {}, "http://127.0.0.1/") for c in (301, 302, 303, 307, 308)],
          [None] * 5)
    fb = cs._decky_fetch_bounded
    HTTP.reset_hits()
    check("direct GET -> the bytes", fb(HTTP.url("/icon/png"), 1 << 20, 5), PNG_BYTES)
    check("302 -> None", fb(HTTP.url("/plugins-302"), 1 << 20, 5), None)
    check("...and the redirect target was never requested", HTTP.hits("/plugins"), 0)
    check("404 -> None", fb(HTTP.url("/nope"), 1 << 20, 5), None)
    check("over the cap -> None (cap+1 read, not a truncated body)",
          fb(HTTP.url("/icon/png"), len(PNG_BYTES) - 1, 5), None)
    check("exactly at the cap -> the bytes", fb(HTTP.url("/icon/png"), len(PNG_BYTES), 5), PNG_BYTES)
    check("connection refused -> None, no exception", fb(_closed_port_url(), 1 << 20, 5), None)
    check("garbage URL -> None, no exception", fb("not a url", 1 << 20, 5), None)


def test_store_302_not_followed_control_direct():
    print("test_store_302_not_followed_control_direct")
    with Box(marker=True):
        HTTP.reset_hits()
        with Patch(_DECKY_STORE_URL=HTTP.url("/plugins-302")):
            cs._decky_store_fetch()
        s = _store()
        check("302 to http://127.0.0.1:<port>/plugins -> no catalogue", s["fetched_at"], None)
        check("...reported as unreachable", s["error"], "store unreachable")
        check("...not stale (there was never a copy)", s["stale"], False)
        check("...the 302 itself was requested once", HTTP.hits("/plugins-302"), 1)
        check("...and its target NEVER (the redirect was not followed)", HTTP.hits("/plugins"), 0)
        check("payload says available:false", cs.decky_store_payload()["available"], False)
        # CONTROL: the same body, fetched directly, is a fresh catalogue.
        cs._decky_store_fetch()
        s = _store()
        check("CONTROL direct -> fresh (fetched_at set)", isinstance(s["fetched_at"], int), True)
        check("CONTROL kept entries (63 dropped by the tag cap)", len(s["plugins"]), KEPT_COUNT)
        check("CONTROL by_id carries 137", 137 in s["by_id"], True)
        check("CONTROL error cleared", s["error"], None)
        check("payload says available:true, the kept count, stale:false",
              (lambda p: (p["available"], p["count"], p["stale"]))(cs.decky_store_payload()),
              (True, KEPT_COUNT, False))


def test_store_stale_served_after_failed_refresh():
    print("test_store_stale_served_after_failed_refresh")
    with Box(marker=True):
        cs._decky_store_fetch()
        first = _store()
        check("precondition: a good copy", len(first["plugins"]), KEPT_COUNT)
        with Patch(_DECKY_STORE_URL=HTTP.url("/plugins-html")):
            cs._decky_store_fetch()
        s = _store()
        check("HTML body -> 'answered nothing usable'", s["error"], "store answered nothing usable")
        check("...the previous copy is still served (all kept entries)", len(s["plugins"]), KEPT_COUNT)
        check("...flagged stale", s["stale"], True)
        check("...fetched_at unchanged (the old copy's time)", s["fetched_at"], first["fetched_at"])
        with Patch(_DECKY_STORE_URL=HTTP.url("/plugins-notlist")):
            cs._decky_store_fetch()
        check("a JSON object (not a list) -> nothing usable, copy kept",
              (_store()["error"], len(_store()["plugins"])), ("store answered nothing usable", KEPT_COUNT))
        with Patch(_DECKY_STORE_URL=_closed_port_url()):
            cs._decky_store_fetch()
        s = _store()
        check("connection refused -> 'store unreachable', copy kept, stale",
              (s["error"], len(s["plugins"]), s["stale"]), ("store unreachable", KEPT_COUNT, True))
        p = cs.decky_store_payload()
        check("payload: available:true with stale:true and the old rows",
              (p["available"], p["stale"], p["count"]), (True, True, KEPT_COUNT))
        check("payload never invents 'no updates': install_type on the stale rows still computed",
              p["plugins"][0]["install_type"] in ("install", None), True)
        cs._decky_store_fetch()
        check("CONTROL: a good fetch clears stale", _store()["stale"], False)


def test_store_size_cap():
    print("test_store_size_cap")
    with Box(marker=True):
        with Patch(_DECKY_STORE_MAX_BYTES=len(CAPTURE_JSON) - 1):
            cs._decky_store_fetch()
        check("body over the cap -> unavailable", (_store()["fetched_at"], _store()["error"]),
              (None, "store unreachable"))
        with Patch(_DECKY_STORE_MAX_BYTES=len(CAPTURE_JSON)):
            cs._decky_store_fetch()
        check("CONTROL: body exactly at the cap -> fresh", len(_store()["plugins"]), KEPT_COUNT)


# ---------------------------------------------------------------------------
print("\ncache: marker-gated fetch, TTL, refresh rate limit")
# ---------------------------------------------------------------------------

def test_store_payload_marker_gates_cold_fetch():
    """A fetch LEAVES the LAN, so even a token-only GET may only start one
    when the opt-in marker is present. Observed in both states."""
    print("test_store_payload_marker_gates_cold_fetch")
    with Box(marker=False):
        HTTP.reset_hits()
        p = cs.decky_store_payload()
        _wait_fetch()
        check("cold + no marker -> available:false, fetching:false",
              (p["available"], p["fetching"], p["count"], p["plugins"]), (False, False, 0, []))
        check("...and the store was NOT contacted", HTTP.hits("/plugins"), 0)
        check("...payload field set is the spec's",
              sorted(p), sorted(["available", "fetching", "count", "fetched_at", "stale", "plugins", "error"]))
    with Box(marker=True) as box:
        HTTP.reset_hits()
        p = cs.decky_store_payload()
        check("cold + marker -> available:false, fetching:true immediately (never fetches inline)",
              (p["available"], p["fetching"]), (False, True))
        check("background fetch finishes", _wait_fetch(), True)
        check("...one store hit", HTTP.hits("/plugins"), 1)
        p = cs.decky_store_payload()
        check("then available:true with the catalogue", (p["available"], p["count"], p["fetching"]),
              (True, KEPT_COUNT, False))
        # Marker removed AFTER a copy exists: the copy is still served
        # (token-only cache read) — only the fetch is gated.
        box.set_marker(False)
        check("copy still served without the marker", cs.decky_store_payload()["count"], KEPT_COUNT)


def test_store_ttl_honoured():
    print("test_store_ttl_honoured")
    with Box(marker=True):
        cs._decky_store_fetch()
        HTTP.reset_hits()
        # Fresh copy (10 s old): a GET must not refetch.
        with cs._DECKY_STORE_LOCK:
            cs._DECKY_STORE["fetched_at"] = int(time.time()) - 10
            cs._DECKY_STORE["last_attempt"] = 0.0
        p = cs.decky_store_payload()
        _wait_fetch()
        check("CONTROL: 10 s old -> served, no refetch", (p["count"], p["fetching"], HTTP.hits("/plugins")),
              (KEPT_COUNT, False, 0))
        # Expired copy (TTL + 1 s): served at once, refetched in the background.
        old = int(time.time()) - int(cs._DECKY_STORE_TTL_S) - 1
        with cs._DECKY_STORE_LOCK:
            cs._DECKY_STORE["fetched_at"] = old
            cs._DECKY_STORE["last_attempt"] = 0.0      # the 30 s demand backoff is a separate rule
        p = cs.decky_store_payload()
        check("expired -> the OLD copy is served immediately (available, the kept rows)",
              (p["available"], p["count"], p["fetched_at"]), (True, KEPT_COUNT, old))
        check("...while a background refetch runs", p["fetching"], True)
        check("refetch finishes", _wait_fetch(), True)
        check("...one store hit", HTTP.hits("/plugins"), 1)
        check("...fetched_at advanced past the expired stamp", _store()["fetched_at"] > old, True)
        check("TTL constant is the spec's 900 s", cs._DECKY_STORE_TTL_S, 900.0)


def test_store_refresh_rate_limited():
    print("test_store_refresh_rate_limited")
    with Box(marker=True) as box:
        HTTP.reset_hits()
        r = cs.decky_store_refresh()
        check("first refresh starts a fetch", (r["refreshed"], r["fetching"]), (True, True))
        check("fetch finishes", _wait_fetch(), True)
        r2 = cs.decky_store_refresh()
        check("second refresh inside 60 s is refused (refreshed:false), nothing fetched",
              (r2["refreshed"], r2["fetching"], HTTP.hits("/plugins")), (False, False, 1))
        check("...but reports the copy's fetched_at", isinstance(r2["fetched_at"], int), True)
        check("refresh gate constant is the spec's 60 s", cs._DECKY_STORE_REFRESH_MIN_S, 60.0)
        with cs._DECKY_STORE_LOCK:
            cs._DECKY_STORE["refresh_at"] = 0.0
        box.set_marker(False)
        r3 = cs.decky_store_refresh()
        _wait_fetch()
        check("refresh without the marker starts nothing (the route 403s first; this is the second gate)",
              (r3["refreshed"], HTTP.hits("/plugins")), (False, 1))


# ---------------------------------------------------------------------------
print("\nHTTP: store + refresh routes, then the icon proxy")
# ---------------------------------------------------------------------------

def test_http_store_routes_auth_and_steam_root():
    print("test_http_store_routes_auth_and_steam_root")
    srv, port = _server(mock=False)
    try:
        with Box(marker=False):
            _install_capture()
            check("GET /api/decky/store no bearer -> 401", _json(port, "GET", "/api/decky/store", None)[0], 401)
            check("GET /api/decky/store wrong bearer -> 401", _json(port, "GET", "/api/decky/store", "nope")[0], 401)
            st, bd = _json(port, "GET", "/api/decky/store")
            check("GET /api/decky/store -> 200 with the cache", (st, bd.get("count")), (200, KEPT_COUNT))
            check("POST refresh no bearer -> 401", _json(port, "POST", "/api/decky/store/refresh", None)[0], 401)
            st, bd = _json(port, "POST", "/api/decky/store/refresh")
            check("POST refresh without the marker -> 403 needs_optin",
                  (st, bd.get("error"), bd.get("needs_optin")), (403, "needs_optin", True))
            check("icon no bearer -> 401", _req(port, "GET", "/api/decky/store/icon/36", None)[0], 401)
            check("icon wrong bearer -> 401", _req(port, "GET", "/api/decky/store/icon/36", "nope")[0], 401)
            check("icon wrong ?token= -> 401",
                  _req(port, "GET", "/api/decky/store/icon/36?token=nope", None)[0], 401)
        with Box(marker=True):
            _install_capture()
            HTTP.reset_hits()
            st, bd = _json(port, "POST", "/api/decky/store/refresh")
            check("POST refresh with the marker -> 200 refreshed:true", (st, bd.get("refreshed")), (200, True))
            check("...the fetch ran in a thread and hit the store once", (_wait_fetch(), HTTP.hits("/plugins")),
                  (True, 1))
            st, bd = _json(port, "POST", "/api/decky/store/refresh")
            check("...a second POST inside 60 s -> 200 refreshed:false", (st, bd.get("refreshed")), (200, False))
        # No Steam root: the whole surface 404s, before shape or auth details.
        with Box(marker=True, steam=False):
            _install_capture()
            check("no Steam root: GET store -> 404", _json(port, "GET", "/api/decky/store")[0], 404)
            check("no Steam root: POST refresh -> 404", _json(port, "POST", "/api/decky/store/refresh")[0], 404)
            check("no Steam root: icon of a real id -> 404", _req(port, "GET", "/api/decky/store/icon/36")[0], 404)
            check("no Steam root: even a bad-shape id is 404, not 400 (degrade closed first)",
                  _req(port, "GET", "/api/decky/store/icon/1e3")[0], 404)
    finally:
        srv.shutdown()


def test_icon_route_id_shapes():
    """The path segment is `[0-9]{1,9}` EXACTLY. Unicode digits are sent
    percent-encoded (an HTTP request line is ASCII) and the agent does not
    unquote, so they arrive as `%C2%B2` — refused by shape either way; the
    source guard proves `str.isdigit()` is not what does the refusing."""
    print("test_icon_route_id_shapes")
    # An AST walk, not a substring: the handler's own docstring NAMES
    # str.isdigit() as the trap it avoids, so a text grep reads the warning
    # as a violation. Only a real attribute access counts.
    srcs = [inspect.getsource(cs.Handler._handle_decky_icon), inspect.getsource(cs._decky_icon_bytes)]
    attrs = set()
    for one in srcs:                                  # dedented separately: one is a method
        attrs |= {n.attr for n in ast.walk(ast.parse(textwrap.dedent(one)))
                  if isinstance(n, ast.Attribute)}
    src = "\n".join(srcs)
    check("the icon path never CALLS str.isdigit()/isnumeric()/isdecimal()",
          sorted(attrs & {"isdigit", "isnumeric", "isdecimal"}), [])
    check("...it fullmatches the spec's [0-9]{1,9}", "[0-9]{1,9}" in src, True)
    srv, port = _server(mock=False)
    try:
        with Box(marker=True) as box:
            rewired = _rewired_capture({137: "/icon/jpg", 36: "/icon/png"}) if TLS else CAPTURE
            _install_capture(rewired)
            for seg, why in (("%C2%B2", "superscript two (isdigit() is True)"),
                             ("%D9%A3", "Arabic-Indic three (isdigit() is True)"),
                             ("1e3", "exponent"), ("-1", "negative"), ("+1", "plus sign"),
                             ("1234567890", "ten digits"), ("36%20", "trailing space"),
                             ("0x24", "hex"), ("137/../36", "traversal"), ("36.0", "float"),
                             ("36%3Bid", "encoded semicolon"), ("137%00", "NUL")):
                check("icon/%s -> 400 (%s)" % (seg, why), _req(port, "GET", "/api/decky/store/icon/" + seg)[0], 400)
            check("icon/ (empty segment) -> 404, not a route", _req(port, "GET", "/api/decky/store/icon/")[0], 404)
            check("icon/0 -> 404 (shape ok, ids start at 1)", _req(port, "GET", "/api/decky/store/icon/0")[0], 404)
            check("icon/999999999 -> 404 (shape ok, not in the cache)",
                  _req(port, "GET", "/api/decky/store/icon/999999999")[0], 404)
            check("icon/14 -> 404 (kept entry whose image_url was nulled off-host)",
                  _req(port, "GET", "/api/decky/store/icon/14")[0], 404)
            check("...nothing was written to the icon cache for it", box.icon_cached(14), False)
            if not TLS:
                skip("icon/137 -> 200 from the fake CDN", "no TLS cert")
                return
            TLS.reset_hits()
            st, h, body = _req(port, "GET", "/api/decky/store/icon/137")
            check("icon/137 -> 200 from the fake CDN", st, 200)
            check("...content-type from the SNIFF (image/jpeg), not the CDN's header",
                  h.get("content-type"), "image/jpeg")
            check("...the exact bytes", body, JPEG_BYTES)
            check("...Cache-Control max-age=86400", "max-age=86400" in h.get("cache-control", ""), True)
            check("...fetched from the CDN once", TLS.hits("/icon/jpg"), 1)
            check("...and cached under the INT id", box.icon_cached(137), True)
            st, h, body = _req(port, "GET", "/api/decky/store/icon/137")
            check("second GET served from cache (no second CDN hit)", (st, TLS.hits("/icon/jpg")), (200, 1))
            check("?token= form (Android <Image> drops headers) -> 200",
                  _req(port, "GET", "/api/decky/store/icon/36?token=" + TOKEN, None)[0], 200)
            check("icon/137/ (trailing slash) is the same id", _req(port, "GET", "/api/decky/store/icon/137/")[0], 200)
            # A raw ';' is RFC 2396 path-params: urlparse strips it BEFORE the
            # agent sees the segment, so this is id 36 (its own bytes) and
            # never a different lookup — the shape gate still ran on "36".
            st, _h, body = _req(port, "GET", "/api/decky/store/icon/36;id")
            check("icon/36;id: urlparse drops ';params', the agent sees exactly 36 (its bytes, no new lookup)",
                  (st, body == PNG_BYTES), (200, True))
    finally:
        srv.shutdown()


def test_icon_302_not_followed_and_cache_gate():
    print("test_icon_302_not_followed_and_cache_gate")
    if not TLS:
        skip("icon 302 / cache-gate cases", "no TLS cert")
        return
    srv, port = _server(mock=False)
    try:
        with Box(marker=True) as box:
            _install_capture(_rewired_capture({21: "/icon/302", 36: "/icon/png", 10: "/icon/png",
                                               23: "/icon/302-http"}))
            TLS.reset_hits()
            HTTP.reset_hits()
            check("CDN 302 (to its own https png) -> 404, never followed",
                  _req(port, "GET", "/api/decky/store/icon/21")[0], 404)
            check("...the 302 was requested once", TLS.hits("/icon/302"), 1)
            check("...its target NEVER", TLS.hits("/icon/png"), 0)
            check("...nothing cached for 21", box.icon_cached(21), False)
            check("CDN 302 to a PLAINTEXT http://127.0.0.1 target -> 404",
                  _req(port, "GET", "/api/decky/store/icon/23")[0], 404)
            check("...the plaintext target was never requested", HTTP.hits("/icon/png"), 0)
            st, _h, body = _req(port, "GET", "/api/decky/store/icon/36")
            check("CONTROL: direct -> 200 with the PNG bytes", (st, body == PNG_BYTES), (200, True))
            check("...one CDN hit", TLS.hits("/icon/png"), 1)
            # The marker gates FETCHING only: a cached icon is served without
            # it (token-only read), an uncached one is a 404 with no egress.
            box.set_marker(False)
            check("marker off: cached 36 still served", _req(port, "GET", "/api/decky/store/icon/36")[0], 200)
            check("marker off: uncached 10 -> 404", _req(port, "GET", "/api/decky/store/icon/10")[0], 404)
            check("...and the CDN was not contacted for it", TLS.hits("/icon/png"), 1)
            box.set_marker(True)
            check("marker on again: 10 fetched and served",
                  (_req(port, "GET", "/api/decky/store/icon/10")[0], TLS.hits("/icon/png")), (200, 2))
            # Unit-level: the same function, a URL that passes the pin at
            # normalise time but is re-checked at FETCH time (host repointed
            # underneath it) -> None, no request.
            TLS.reset_hits()
            with Patch(_DECKY_ICON_HOST="cdn.tzatzikiweeb.moe"):
                check("host pin re-checked on the URL actually fetched -> None",
                      cs._decky_icon_bytes(13), None)
            check("...no CDN request", sum(TLS.srv.hits.values()), 0)
    finally:
        srv.shutdown()


def test_icon_avif_served_and_sniff():
    print("test_icon_avif_served_and_sniff")
    sn = cs._decky_sniff_image
    check("PNG sniffs", sn(PNG_BYTES), "image/png")
    check("JPEG sniffs", sn(JPEG_BYTES), "image/jpeg")
    check("WEBP sniffs", sn(WEBP_BYTES), "image/webp")
    check("GIF sniffs", sn(b"GIF89a" + b"\x00" * 10), "image/gif")
    check("AVIF sniffs (ftypavif at offset 4)", sn(AVIF_BYTES), "image/avif")
    check("HEIC (ftypheic) does NOT sniff — only the brands the app can render", sn(HEIC_BYTES), None)
    check("HTML does not sniff", sn(HTML_BYTES), None)
    check("SVG (text) does not sniff", sn(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None)
    check("11 bytes starting like AVIF (too short) does not sniff", sn(AVIF_BYTES[:11]), None)
    check("empty does not sniff", sn(b""), None)
    if not TLS:
        skip("AVIF served over the icon route", "no TLS cert")
        return
    srv, port = _server(mock=False)
    try:
        with Box(marker=True) as box:
            _install_capture(_rewired_capture({7: "/icon/avif"}))
            st, h, body = _req(port, "GET", "/api/decky/store/icon/7")
            check("AVIF icon -> 200 image/avif", (st, h.get("content-type")), (200, "image/avif"))
            check("...exact bytes", body, AVIF_BYTES)
            check("...cached", box.icon_cached(7), True)
            st, h, _b = _req(port, "GET", "/api/decky/store/icon/7")
            check("...served from cache with the same sniffed type", (st, h.get("content-type")), (200, "image/avif"))
    finally:
        srv.shutdown()


def test_icon_size_cap_and_html_refused():
    print("test_icon_size_cap_and_html_refused")
    if not TLS:
        skip("icon size cap / HTML refusal", "no TLS cert")
        return
    srv, port = _server(mock=False)
    try:
        with Box(marker=True) as box:
            _install_capture(_rewired_capture({13: "/icon/big", 23: "/icon/atcap", 14: "/icon/html",
                                               10: "/icon/png"}))
            TLS.reset_hits()
            check("1 MiB + 1 byte -> 404", _req(port, "GET", "/api/decky/store/icon/13")[0], 404)
            check("...requested once, nothing cached", (TLS.hits("/icon/big"), box.icon_cached(13)), (1, False))
            st, _h, body = _req(port, "GET", "/api/decky/store/icon/23")
            check("CONTROL: exactly 1 MiB -> 200", (st, len(body)), (200, cs._DECKY_ICON_MAX_BYTES))
            check("icon cap constant is the spec's 1 MiB", cs._DECKY_ICON_MAX_BYTES, 1024 * 1024)
            st, _h, body = _req(port, "GET", "/api/decky/store/icon/14")
            check("CDN answers HTML -> 404 (sniff refusal), never the HTML bytes",
                  (st, b"<html" in body), (404, False))
            check("...nothing cached for it", box.icon_cached(14), False)
            # A poisoned cache file is refused too, even without the marker
            # (and, marker off, not refetched).
            os.makedirs(box.icons, exist_ok=True)
            with open(os.path.join(box.icons, "10"), "wb") as f:
                f.write(HTML_BYTES)
            box.set_marker(False)
            st, _h, body = _req(port, "GET", "/api/decky/store/icon/10")
            check("HTML in the cache file -> 404, not served", (st, b"<html" in body), (404, False))
            check("...no CDN egress without the marker", TLS.hits("/icon/png"), 0)
            box.set_marker(True)
            st, _h, body = _req(port, "GET", "/api/decky/store/icon/10")
            check("marker on: the poisoned cache is replaced by a real fetch",
                  (st, body == PNG_BYTES, TLS.hits("/icon/png")), (200, True, 1))
            with open(os.path.join(box.icons, "10"), "rb") as f:
                check("...and the cache file now holds the image", f.read() == PNG_BYTES, True)
    finally:
        srv.shutdown()


def test_has_icon_never_true_then_404():
    """Walk EVERY served row: has_icon:true must answer 200 and has_icon:false
    must answer 404 — first against the real code with the TLS fake, then
    against --mock (the harness's store)."""
    print("test_has_icon_never_true_then_404")
    if TLS:
        srv, port = _server(mock=False)
        try:
            with Box(marker=True):
                # Every kept image type the CDN serves (png/jpg + avif), two
                # off-host/plaintext URLs that must null out, one absent.
                rewired = _rewired_capture({36: "/icon/png", 7: "/icon/avif", 137: "/icon/jpg",
                                            23: "/icon/png", 13: "/icon/png",
                                            14: "https://evil.example/x.png",
                                            21: "http://127.0.0.1:%d/icon/png" % HTTP.port,
                                            10: None})
                _install_capture(rewired)
                rows = cs.decky_store_payload()["plugins"]
                check("every kept row served", len(rows), KEPT_COUNT)
                mismatches = []
                for r in rows:
                    st = _req(port, "GET", "/api/decky/store/icon/%d" % r["id"])[0]
                    want = 200 if r["has_icon"] else 404
                    if st != want:
                        mismatches.append((r["id"], r["has_icon"], st))
                check("real: has_icon <=> icon 200 for every served row", mismatches, [])
                check("...and the split is the expected one",
                      sorted(r["id"] for r in rows if r["has_icon"]), [7, 13, 23, 36, 137])
        finally:
            srv.shutdown()
    else:
        skip("real has_icon walk", "no TLS cert")
    srv, port = _server(mock=True)
    try:
        st, bd = _json(port, "GET", "/api/decky/store")
        check("mock store -> 200 with 8 rows", (st, bd.get("count")), (200, 8))
        mismatches = []
        for r in bd["plugins"]:
            st, h, body = _req(port, "GET", "/api/decky/store/icon/%d" % r["id"])
            want = 200 if r["has_icon"] else 404
            if st != want or (st == 200 and cs._decky_sniff_image(body) != h.get("content-type")):
                mismatches.append((r["id"], r["has_icon"], st, h.get("content-type")))
        check("mock: has_icon <=> icon 200, and served bytes sniff as their content-type", mismatches, [])
        check("mock advertises exactly the two icons (PNG 36, AVIF 7)",
              sorted(r["id"] for r in bd["plugins"] if r["has_icon"]), [7, 36])
        check("mock: bad shape -> 400 too", _req(port, "GET", "/api/decky/store/icon/%C2%B2")[0], 400)
    finally:
        srv.shutdown()


if __name__ == "__main__":
    try:
        for fn in (test_capture_survives_normaliser,
                   test_normaliser_rejects_bad_shapes_with_control,
                   test_normaliser_list_level,
                   test_image_url_host_scheme_rule,
                   test_description_and_versions_caps,
                   test_update_detection_shapes,
                   test_store_overlay_install_type_from_disk,
                   test_no_redirect_handler_and_bounded_fetch,
                   test_store_302_not_followed_control_direct,
                   test_store_stale_served_after_failed_refresh,
                   test_store_size_cap,
                   test_store_payload_marker_gates_cold_fetch,
                   test_store_ttl_honoured,
                   test_store_refresh_rate_limited,
                   test_http_store_routes_auth_and_steam_root,
                   test_icon_route_id_shapes,
                   test_icon_302_not_followed_and_cache_gate,
                   test_icon_avif_served_and_sniff,
                   test_icon_size_cap_and_html_refused,
                   test_has_icon_never_true_then_404):
            fn()
    finally:
        HTTP.stop()
        if TLS:
            TLS.stop()
        shutil.rmtree(WORK, ignore_errors=True)
    if SKIPPED:
        print("\n%d SKIPPED (no openssl cert): %s" % (len(SKIPPED), ", ".join(SKIPPED)))
    if FAILURES:
        print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
        sys.exit(1)
    print("\nall decky-store tests passed")
