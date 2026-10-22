import importlib.util
import json
from pathlib import Path
import unittest
from test_steam_themes import cs
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
fixtures=json.loads((ROOT/'protocol/fixtures/theme-v1.json').read_text())
class ThemeFormat(unittest.TestCase):
    def test_valid_and_unsafe_documents(self):
        self.assertEqual(cs._theme_document_validate(fixtures['valid']),fixtures['valid'])
        for patch in fixtures['invalidPatches']:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                cs._theme_document_validate(dict(fixtures['valid'],**patch))
    def test_application_must_match_document(self):
        doc=fixtures['valid']
        with self.assertRaises(ValueError):cs._steam_theme_validate({'installed':True,'enabled':True,'studio':doc})
        result=cs._steam_theme_validate({'installed':True,'enabled':True,'theme':doc['layout'],'accent':doc['accent'],'motion':doc['motion'],'studio':doc})
        self.assertEqual(result['studio'],doc)
    def test_old_settings_remain_readable(self):
        self.assertIsNone(cs._steam_theme_validate({'installed':True,'enabled':True})['studio'])

    def test_old_companion_refuses_studio_without_mutating(self):
        before=dict(cs._STEAM_THEME_MOCK)
        doc=fixtures['valid']
        with patch.object(cs, 'steam_themes_state', return_value={'companion_ready':True,'studio_ready':False,'themes':[{'id':'horizon'}]}):
            with self.assertRaises(ValueError):
                cs.steam_themes_save({'installed':True,'enabled':True,'theme':'horizon','accent':'blue','motion':True,'studio':doc},mock=True)
        self.assertEqual(cs._STEAM_THEME_MOCK,before)
