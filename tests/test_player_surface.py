"""Live Player identity, fixed service switching, and CDP failure fallback."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("player_surface_agent", ROOT / "agent/couchsided.py")
cs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cs)
HOMES = {"netflix": "https://www.netflix.com/"}


class SurfaceTest(unittest.TestCase):
    def classify(self, url):
        page = {"type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/test", "url": url}
        with (patch.object(cs, "PL_MOCK", False),
              patch.object(cs, "_pl_running", return_value=True),
              patch.object(cs, "_PLAYER_SERVICE_URLS", HOMES),
              patch.object(cs, "_pl_cdp_port", return_value=1234),
              patch.object(cs, "_pl_http_get", return_value=[page])):
            return cs.player_surface()

    def test_home(self):
        self.assertEqual(self.classify("file:///private/profile/hub.html"), {"kind": "home"})

    def test_service_without_private_url(self):
        result = self.classify("https://www.netflix.com/watch/123?account=private")
        self.assertEqual(result, {"kind": "service", "service": "netflix"})

    def test_unrelated_and_lookalike_hosts(self):
        for url in ("https://www.netflix.com.evil.example/", "https://example.com/",
                    "file:///private/profile/sample.html", "http://www.netflix.com/"):
            with self.subTest(url=url):
                self.assertIsNone(self.classify(url))

    def test_unreachable_degrades_to_unknown(self):
        with (patch.object(cs, "PL_MOCK", False),
              patch.object(cs, "_pl_running", return_value=True),
              patch.object(cs, "_pl_cdp_port", return_value=1234),
              patch.object(cs, "_pl_http_get", side_effect=OSError())):
            self.assertIsNone(cs.player_surface())


class SwitchTest(unittest.TestCase):
    def test_only_frozen_home_reaches_cdp(self):
        client = MagicMock()
        client._call.return_value = {"frameId": "frame"}
        with (patch.object(cs, "_PLAYER_SERVICE_URLS", HOMES),
              patch.object(cs, "_pl_cdp_port", return_value=1234),
              patch.object(cs, "_PlayerCDP", return_value=client) as constructor):
            for bad in ("https://example.com", "netflix/anything", "NETFLIX", None, {}, []):
                self.assertFalse(cs._pl_switch_service(bad))
            constructor.assert_not_called()
            self.assertTrue(cs._pl_switch_service("netflix"))
            client._call.assert_called_once_with("Page.navigate", {"url": HOMES["netflix"]})
            client.close.assert_called_once()

    def test_browser_error_falls_back(self):
        client = MagicMock()
        client._call.return_value = {"errorText": "failed"}
        with (patch.object(cs, "_PLAYER_SERVICE_URLS", HOMES),
              patch.object(cs, "_pl_cdp_port", return_value=1234),
              patch.object(cs, "_PlayerCDP", return_value=client)):
            self.assertFalse(cs._pl_switch_service("netflix"))
            client.close.assert_called_once()

    def test_open_reuses_home_but_preserves_deep_link_relaunch(self):
        with (patch.object(cs, "PL_MOCK", False),
              patch.object(cs, "player_available", return_value=True),
              patch.object(cs, "_pl_validate", return_value=HOMES["netflix"]),
              patch.object(cs, "_pl_conf_write"),
              patch.object(cs, "_pl_running", return_value=True),
              patch.object(cs, "_pl_switch_service", return_value=True) as switch,
              patch.object(cs, "player_close") as close,
              patch.object(cs, "_pl_appid", return_value=42),
              patch.object(cs, "_pl_relaunch") as relaunch):
            self.assertTrue(cs.player_open("netflix")["reused"])
            close.assert_not_called()
            relaunch.assert_not_called()
            switch.reset_mock()
            cs.player_open("netflix", path="/validated-title")
            switch.assert_not_called()
            close.assert_called_once()
            relaunch.assert_called_once_with(42, True)


if __name__ == "__main__":
    unittest.main()
