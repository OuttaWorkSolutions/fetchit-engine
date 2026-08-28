"""Standalone invariant checks for fetchit-engine (no Node required).

Runs every parity vector through the Python engine and asserts the structural
invariants that must hold regardless of language:
  - accepting every edit reproduces cleaned.text
  - edit and flag offsets are code points that slice the original text
  - the summary accounts for every character actually removed

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

        # Measure against the input and the output, NOT against the edit list.
        # This check used to re-implement the engine's own attribution, so it
        # agreed with it even when both were wrong: " <ZWSP> " reported
        # hidden: 0 because space.collapse swallowed the span. Comparing what
        # actually disappeared is independent of which rule fired.
        # Idempotency: cleaning cleaned text must change nothing.
        r2 = fe.clean(r["cleaned"]["text"], options=v.get("options"))
        if r2["cleaned"]["text"] != r["cleaned"]["text"]:
            failures += 1
            print("FAIL not idempotent  [%s]" % v["name"])

        s = r["summary"]
        text_in, text_out = v["input"], r["cleaned"]["text"]
        count = lambda t, pred: sum(1 for ch in t if pred(ord(ch)))
        inv = count(text_in, lambda cp: fe.core._invisible_rule(cp) is not None) - count(
            text_out, lambda cp: fe.core._invisible_rule(cp) is not None
        )
        odd = count(text_in, fe.core._is_odd_space) - count(text_out, fe.core._is_odd_space)
        is_dash = lambda cp: cp in (0x2014, 0x2015, 0x2013)
        dsh = count(text_in, is_dash) - count(text_out, is_dash)
        if (s["invisible"], s["oddSpaces"], s["dashes"], s["hidden"], s["flagged"]) != (
            inv, odd, dsh, inv + odd, len(r["flags"])
        ):
            failures += 1
            print(
                "FAIL summary counts  [%s] reported inv=%s odd=%s hidden=%s, "
                "actually removed inv=%s odd=%s hidden=%s"
                % (v["name"], s["invisible"], s["oddSpaces"], s["hidden"], inv, odd, inv + odd)
            )

    print("")
    if failures:
        print("PY INVARIANTS FAILED  %d problem(s)" % failures)
        return 1
    print("PY INVARIANTS OK  %d vectors" % len(doc["vectors"]))
    return 0


if __name__ == "__main__":
    sys.exit(run())
