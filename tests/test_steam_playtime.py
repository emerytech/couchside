"""
Per-game playtime out of Steam's localconfig.vdf.

STRUCTURE COPIED FROM REAL HARDWARE (Bazzite, 2026-08-06): the live file carried
304 "Playtime" and 295 "LastPlayed" entries in exactly this shape. The VALUES
here are invented on purpose — that file is the maintainer's own game library
and this repository is public, so the layout is faithful and the data is not.

What these pin: the fields the app filters on ("never played", "under two
hours", "not touched in a year") must be RIGHT, because a wrong playtime is
worse than an absent one — the app would silently filter a game out of view.

Pure stdlib, no pytest — same style as the other agent tests.
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
failures = []


def check(name, cond, detail=""):
    print(("%s %s" % (PASS, name)) if cond else ("%s %s %s" % (FAIL, name, detail)))
    if not cond:
        failures.append(name)


# Real layout, invented numbers. Note the deliberately awkward parts: a game
# with playtime but no LastPlayed, a game with neither, a nested block that
# must NOT be read as an appid, and keys the agent has no business parsing.
FIXTURE = '''
"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"220"
					{
						"LastPlayed"		"1750000000"
						"Playtime"		"1234"
						"BadgeData"		"whatever"
					}
					"440"
					{
						"Playtime"		"90"
					}
					"620"
					{
						"LastPlayed"		"1700000000"
						"Playtime"		"0"
					}
					"730"
					{
						"tags"
						{
							"0"		"favorite"
						}
						"LastPlayed"		"1740000000"
						"Playtime"		"6000"
					}
					"999"
					{
					}
				}
				"friends"
				{
					"12345"
					{
						"Playtime"		"99999"
					}
				}
			}
		}
	}
}
'''


def main():
    print("steam playtime (localconfig.vdf)")
    got = cs.parse_localconfig_playtime(FIXTURE)

    check("reads playtime and last-played for a normal game",
          got.get("220") == {"last_played": 1750000000, "playtime_min": 1234}, got.get("220"))

    check("a game with playtime but no LastPlayed keeps the playtime",
          got.get("440") == {"playtime_min": 90}, got.get("440"))

    check("zero playtime is kept as ZERO, not dropped",
          got.get("620", {}).get("playtime_min") == 0, got.get("620"))

    check("a nested block inside an app is not mistaken for an appid",
          "0" not in got, sorted(got))

    check("an app with neither field yields nothing rather than a fake zero",
          "999" not in got or got.get("999") == {}, got.get("999"))

    # THE CONTROL THAT MATTERS: the friends block also contains a "Playtime"
    # key. Reading it would attribute a stranger's number to appid 12345.
    check("a Playtime OUTSIDE the apps block is never picked up (control)",
          "12345" not in got, got.get("12345"))

    check("finds every real game and no extras",
          sorted(got) == ["220", "440", "620", "730"], sorted(got))

    # Malformed input must degrade to nothing, never to a wrong number.
    check("no apps block -> empty, not a crash", cs.parse_localconfig_playtime("") == {})
    check("garbage -> empty, not a crash",
          cs.parse_localconfig_playtime('"apps" { "abc" { "Playtime" "notanumber" } }') == {})

    if failures:
        print("\nFAILED: %s" % ", ".join(failures))
        raise SystemExit(1)
    print("\nall passed")


main()
