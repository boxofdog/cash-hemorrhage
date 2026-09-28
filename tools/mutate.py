#!/usr/bin/env python3
"""Mutation check: does the test suite notice when the code is broken on purpose?

    python3 tools/mutate.py tools/mutations/loans.py

A mutations file defines:
    TESTS = ["test-loans.js", ...]            # files under tests/ to run
    MUTATIONS = [(name, old_text, new_text)]  # each old_text must occur exactly once in main.js

Each mutation is applied to main.js on its own, the tests run, and main.js is
restored (always — even on Ctrl-C). A mutation the tests don't notice
("SURVIVED") is a gap in the tests, unless it's equivalent (changes nothing
observable); name those with a leading "_" so they read as expected.
"""
import os, runpy, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.join(ROOT, "main.js")

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    spec = runpy.run_path(sys.argv[1])
    tests, mutations = spec["TESTS"], spec["MUTATIONS"]
    src = open(MAIN, encoding="utf8").read()
    backup = tempfile.NamedTemporaryFile(delete=False, suffix=".main.js")
    backup.write(src.encode("utf8"))
    backup.close()
    results = []
    try:
        for name, old, new in mutations:
            n = src.count(old)
            if n != 1:
                results.append((name, f"NOT FOUND (x{n}) — update the mutation"))
                continue
            open(MAIN, "w", encoding="utf8").write(src.replace(old, new))
            caught = []
            for t in tests:
                r = subprocess.run(["node", os.path.join(ROOT, "tests", t)], cwd=os.path.join(ROOT, "tests"),
                                   capture_output=True, text=True, timeout=600,
                                   env=dict(os.environ, BT_NO_BROWSER="1"))
                if r.returncode != 0:
                    last = (r.stdout.strip().splitlines() or [""])[-1]
                    caught.append(f"{t}: {last[:70]}")
            results.append((name, "killed  " + " | ".join(caught) if caught else "SURVIVED"))
    finally:
        shutil.copy(backup.name, MAIN)
        os.unlink(backup.name)
    assert open(MAIN, encoding="utf8").read() == src, "main.js was not restored!"
    for name, r in results:
        print(f"{name:42s} {r}")
    bad = [n for n, r in results if (r == "SURVIVED" and not n.startswith("_")) or r.startswith("NOT FOUND")]
    print(f"\n{len(results) - len(bad)}/{len(results)} ok; main.js restored.")
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    main()
