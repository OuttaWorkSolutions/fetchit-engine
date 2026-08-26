"""Standalone invariant checks for fetchit-engine (no Node required).

Runs every parity vector through the Python engine and asserts the structural
invariants that must hold regardless of language:
  - accepting every edit reproduces cleaned.text
  - edit and flag offsets are code points that slice the original text
  - summary counts agree with the edit list

Cross-language equality (Python === JS) is checked by
packages/js/test/parity.mjs, which runs these same vectors through both.

    python packages/py/test_parity.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import fetchit_engine as fe  # noqa: E402

HERE = os.path.dirname(__file__)
VECTORS = os.path.join(HERE, "..", "engine-core", "vectors.json")


def run():
    doc = json.load(open(VECTORS, encoding="utf-8"))
    failures = 0
    for v in doc["vectors"]:
        text = v["input"]
        r = fe.clean(text, v.get("options"))
        cps = list(text)

        applied = fe.apply_edits(text, [e["id"] for e in r["edits"]], r["edits"])
        if applied != r["cleaned"]["text"]:
            failures += 1
            print("FAIL applyEdits(all)!=cleaned  [%s]" % v["name"])

        for e in r["edits"]:
            if "".join(cps[e["start"]:e["end"]]) != e["original"]:
                failures += 1
                print("FAIL edit offset  [%s] %s" % (v["name"], e["id"]))
                break
        for f in r["flags"]:
            if "".join(cps[f["start"]:f["end"]]) != f["text"]:
                failures += 1
                print("FAIL flag offset  [%s] %s" % (v["name"], f["id"]))
                break

        s = r["summary"]
        inv = sum(1 for e in r["edits"] if e["category"] == "invisible")
        odd = sum(1 for e in r["edits"] if e["ruleId"] == "space.lookalike")
        dsh = sum(1 for e in r["edits"] if e["ruleId"] == "dash.spaced")
        if (s["invisible"], s["oddSpaces"], s["dashes"], s["hidden"], s["flagged"]) != (
            inv, odd, dsh, inv + odd, len(r["flags"])
        ):
            failures += 1
            print("FAIL summary counts  [%s]" % v["name"])

    print("")
    if failures:
        print("PY INVARIANTS FAILED  %d problem(s)" % failures)
        return 1
    print("PY INVARIANTS OK  %d vectors" % len(doc["vectors"]))
    return 0


if __name__ == "__main__":
    sys.exit(run())
