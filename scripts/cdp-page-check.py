#!/usr/bin/env python3
"""Repro for: CDP Runtime.evaluate reports about:blank while /json/list shows
the service URL.

Runs ON the box against a already-running tile. Prints one deterministic block
so runs can be diffed against each other.

Deliberately reports BOTH sides of every fact:
  - what /json/list says the target URL is
  - what the page itself says it is, via the same socket
so "the target metadata and the document disagree" and "the page never loaded"
are distinguishable, which they were not from the earlier ad-hoc probing.
"""
import importlib.util
import json
import sys

AGENT = "/tmp/couchsided-test.py"
spec = importlib.util.spec_from_file_location("cs", AGENT)
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


def main():
    port = cs._pl_cdp_port()
    print("portfile          :", port)
    if port is None:
        print("VERDICT: no port file -> tile not running")
        return 1

    try:
        targets = cs._pl_http_get(port, "/json/list")
    except Exception as e:
        print("VERDICT: /json/list failed:", e)
        return 1

    print("targets           :", json.dumps(
        [(t.get("type"), str(t.get("url"))[:60], str(t.get("id"))[:12])
         for t in targets]))

    pages = [t for t in targets if t.get("type") == "page"
             and t.get("webSocketDebuggerUrl")]
    loaded = [t for t in pages
              if str(t.get("url", "")).startswith(("http://", "https://"))]
    chosen = (loaded or pages)[0] if (loaded or pages) else None
    if chosen is None:
        print("VERDICT: no page target")
        return 1
    print("chosen target url :", str(chosen.get("url"))[:60])
    print("chosen ws url     :", str(chosen.get("webSocketDebuggerUrl"))[:70])

    # Same socket, several questions. If the document disagrees with the target
    # metadata, that is a context/attach problem. If they AGREE that it is
    # about:blank, the page simply never loaded and CDP is telling the truth.
    probes = {
        "document.URL": "document.URL",
        "location.href": "location.href",
        "readyState": "document.readyState",
        "title": "document.title",
        "videos": "document.querySelectorAll('video').length",
        "frames": "window.length",
        "bodyLen": "(document.body ? document.body.innerHTML.length : -1)",
        "isTopFrame": "(window.top === window.self)",
    }
    for name, expr in probes.items():
        print("  %-16s: %r" % (name, cs._pl_cdp_run(expr)))

    tgt = str(chosen.get("url"))
    doc = cs._pl_cdp_run("document.URL")
    print()
    if isinstance(doc, str) and doc.startswith("about:blank") \
            and tgt.startswith("http"):
        print("VERDICT: DISAGREEMENT — target says %r, document says %r."
              % (tgt[:40], doc))
        print("         => attach/context problem, not a load failure.")
    elif isinstance(doc, str) and doc.startswith("http"):
        print("VERDICT: AGREEMENT on a real page (%r)." % doc[:40])
    else:
        print("VERDICT: target %r and document %r AGREE it is blank."
              % (tgt[:40], doc))
        print("         => the page never loaded; CDP is reporting truth.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
