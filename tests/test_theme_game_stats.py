import unittest
from unittest.mock import patch
from test_steam_themes import cs

class GameStats(unittest.TestCase):
    def test_opt_in_and_invalid_id_do_not_fetch(self):
        with patch.object(cs, '_steam_webapi_configured', return_value=False), patch.object(cs, '_steam_owned_cached') as fetch:
            self.assertEqual(cs._steam_theme_game_stats('../x'), {})
            self.assertEqual(cs._steam_theme_game_stats('123')['configured'], False)
            fetch.assert_not_called()

    def test_summary_is_scoped_and_account_switch_discards(self):
        with patch.object(cs, '_steam_webapi_configured', return_value=True), patch.object(cs, '_steam_account', return_value='account'), patch.object(cs, '_steam_account_current', return_value=True) as current, patch.object(cs, '_steam_owned_cached', return_value=[{'appid':123,'playtime_forever':90,'rtime_last_played':100}]), patch.object(cs, '_steam_achievements_payload', return_value={'connected':True,'has_achievements':True,'unlocked':2,'total':10,'percent':20,'rarest':{'name':'secret'}}):
            result=cs._steam_theme_game_stats('123')
            self.assertEqual(result['hours'],1.5)
            self.assertEqual(result['achievements'],{'unlocked':2,'total':10,'percent':20})
            self.assertNotIn('hours',cs._steam_theme_game_stats('456'))
            current.return_value=False
            self.assertNotIn('hours',cs._steam_theme_game_stats('123'))
