"""
The Windows agent's own log is in the watchlist as a PSEUDO-unit, not a service.

It is listed so the agent's log passes the journal route's allowlist and appears
in the app's Logs picker. But `sc query couchside-agent` can only ever return
ERROR_SERVICE_DOES_NOT_EXIST, so the units card rendered a permanent yellow
"inactive/not-found" warning for something that cannot run — reported from a
real Windows box.

These pin the fix: the pseudo-unit is flagged `log_only` (so the app can drop it
from the units card while keeping it in the Logs picker) and reports the truth
about the agent, which is by definition running whenever it answers.

Pure stdlib, no pytest — same style as the other agent tests.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "agent", "win", "couchsided-win.py")
spec = importlib.util.spec_from_file_location("couchsided_win", AGENT)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

PASS = "  \033[32mPASS\033[0m"
FAIL = "  \033[31mFAIL\033[0m"
failures = []


def check(name, cond, detail=""):
    print(("%s %s" % (PASS, name)) if cond else ("%s %s %s" % (FAIL, name, detail)))
    if not cond:
        failures.append(name)


def main():
    print("win log-only pseudo-unit")

    # sc.exe does not exist off Windows; real_units() must still be callable
    # because the pseudo-unit is answered without shelling out at all.
    units = cw.real_units()
    by_name = {u["name"]: u for u in units}

    agent_unit = by_name.get(cw.AGENT_LOG_UNIT)
    check("the agent's log unit is present (Logs picker depends on it)",
          agent_unit is not None)

    if agent_unit is not None:
        check("it is flagged log_only so the units card can drop it",
              agent_unit.get("log_only") is True, agent_unit)
        check("it does NOT report the old inactive/not-found warning",
              (agent_unit.get("active"), agent_unit.get("sub")) != ("inactive", "not-found"),
              agent_unit)
        check("it reports the agent as running, which it is whenever this answers",
              agent_unit.get("active") == "active" and agent_unit.get("sub") == "running",
              agent_unit)

    # CONTROL: a REAL watched service must not be flagged log_only, or the fix
    # would hide genuine units from the card.
    real = [u for u in units if u["name"] != cw.AGENT_LOG_UNIT]
    check("real services are never flagged log_only (control)",
          all(u.get("log_only") is not True for u in real),
          [u["name"] for u in real if u.get("log_only")])
    check("there IS at least one real service to compare against (control)",
          len(real) >= 1)

    if failures:
        print("\nFAILED: %s" % ", ".join(failures))
        raise SystemExit(1)
    print("\nall passed")


main()
