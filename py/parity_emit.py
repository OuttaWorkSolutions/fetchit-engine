"""Emit fetchit-engine CleanResults for every parity vector as a JSON array.

Used by packages/js/test/parity.mjs, which runs the same vectors through the JS
engine and deep-compares. Prints JSON to stdout; no other output.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import fetchit_engine as fe  # noqa: E402

HERE = os.path.dirname(__file__)
VECTORS = os.path.join(HERE, "..", "engine-core", "vectors.json")


def main():
    # Optional argv[1]: path to a JSON array of {input, options?} (used by the
    # fuzzer). Default: the shared vectors file.
    if len(sys.argv) > 1:
        items = json.load(open(sys.argv[1], encoding="utf-8"))
    else:
        items = json.load(open(VECTORS, encoding="utf-8"))["vectors"]
    out = [fe.clean(it["input"], it.get("options")) for it in items]
    sys.stdout.write(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()
