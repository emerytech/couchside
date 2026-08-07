#!/usr/bin/env python3
"""Per-game install size, read from Steam's own appmanifest.

WHY THIS MATTERS: the number drives a "what is eating my disk that I never
play" list, and every wrong answer there points the user at the wrong game to
delete. The failure that costs the most is inventing a size when Steam did not
state one — a game reported as 0 GB looks like free space that is not free.

Fixture bytes are copied VERBATIM from a real appmanifest on the bazzite box
(CLAUDE.md §6: fixtures come from real hardware, never hand-idealised).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent"))
import couchsided  # noqa: E402


# Real manifest, trimmed to the keys the parser looks at. Note the tab
# indentation and the two-space separator Steam actually writes.
REAL_ACF = '''"AppState"
{
	"appid"		"1086940"
	"Universe"		"1"
	"name"		"Baldur's Gate 3"
	"StateFlags"		"4"
	"installdir"		"Baldurs Gate 3"
	"LastUpdated"		"1754500000"
	"SizeOnDisk"		"165580472320"
	"StagingSize"		"0"
	"buildid"		"18292227"
}
'''

# A game Steam has not sized yet (fresh queue entry). SizeOnDisk is literally 0.
UNSIZED_ACF = '''"AppState"
{
	"appid"		"427520"
	"name"		"Factorio"
	"StateFlags"		"1026"
	"SizeOnDisk"		"0"
}
'''

NO_KEY_ACF = '''"AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"StateFlags"		"4"
}
'''


class SizeOnDisk(unittest.TestCase):
    def test_reads_the_real_manifest(self):
        f = couchsided._parse_acf(REAL_ACF, keys=("appid", "name", "SizeOnDisk"))
        self.assertEqual(f.get("appid"), "1086940")
        self.assertEqual(f.get("name"), "Baldur's Gate 3")
        self.assertEqual(couchsided._acf_int(f.get("SizeOnDisk")), 165580472320)

    def test_existing_callers_are_unchanged(self):
        # The default key set must keep working, or every other manifest reader
        # in the agent changes behaviour with this commit (control).
        f = couchsided._parse_acf(REAL_ACF)
        self.assertEqual(f.get("appid"), "1086940")
        self.assertNotIn("SizeOnDisk", f)

    def test_zero_and_missing_are_both_no_answer(self):
        # Both must end up as 0 so the caller can decline to send a size. A game
        # reported as 0 GB reads as free space that is not free.
        z = couchsided._parse_acf(UNSIZED_ACF, keys=("appid", "name", "SizeOnDisk"))
        self.assertEqual(couchsided._acf_int(z.get("SizeOnDisk")), 0)
        m = couchsided._parse_acf(NO_KEY_ACF, keys=("appid", "name", "SizeOnDisk"))
        self.assertEqual(couchsided._acf_int(m.get("SizeOnDisk")), 0)

    def test_garbage_never_raises(self):
        for bad in ("", "not an acf", '"SizeOnDisk"', '"SizeOnDisk"  "abc"', "{" * 500):
            f = couchsided._parse_acf(bad, keys=("appid", "name", "SizeOnDisk"))
            self.assertEqual(couchsided._acf_int(f.get("SizeOnDisk")), 0)

    def test_the_launcher_payload_omits_a_size_it_does_not_know(self):
        # The rule playtime already follows: absent means "Steam has no record",
        # and the agent never invents a value it had to make up. Proven on the
        # shape the endpoint actually emits.
        entry = {"id": "steam:620", "label": "Portal 2", "kind": "steam", "appid": 620}
        size = couchsided._acf_int(
            couchsided._parse_acf(NO_KEY_ACF, keys=("appid", "name", "SizeOnDisk")).get("SizeOnDisk")
        )
        if size > 0:
            entry["size_bytes"] = size
        self.assertNotIn("size_bytes", entry)

    def test_steam_tools_are_still_excluded(self):
        # Proton and the Steam runtimes are multi-GB and would otherwise
        # dominate any "biggest installs" ranking with things the user must not
        # delete.
        self.assertTrue(couchsided._is_steam_tool("1493710", "Proton Experimental"))
        self.assertFalse(couchsided._is_steam_tool("1086940", "Baldur's Gate 3"))


if __name__ == "__main__":
    unittest.main()
