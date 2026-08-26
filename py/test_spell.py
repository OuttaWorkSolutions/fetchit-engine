"""Checks for fetchit_engine.spell_core.

Runs against the real pyspellchecker dictionary when it is installed; the
dictionary-independent rules (tokenizing, is_checkable, offsets) are checked
unconditionally. Skips the dictionary-dependent assertions if the extra is
not installed.

    python packages/py/test_spell.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from fetchit_engine import spell_core as sc  # noqa: E402

fails = 0


def check(label, cond):
    global fails
    print(("PASS" if cond else "FAIL"), label)
    if not cond:
        fails += 1


# --- dictionary-independent rules ---
check("is_checkable normal word", sc.is_checkable("hello") is True)
check("is_checkable rejects digits", sc.is_checkable("h3llo") is False)
check("is_checkable rejects ALLCAPS", sc.is_checkable("HTTP") is False)
check("is_checkable rejects CamelCase", sc.is_checkable("CamelCase") is False)
check("is_checkable allows leading cap", sc.is_checkable("Hello") is True)

# offsets: WORD_RE + strip should land on the word, in code points
toks = [(m.start(), m.group()) for m in sc.WORD_RE.finditer("a 'quoted' word")]
check("WORD_RE finds quoted+word", any(t[1].strip("'") == "quoted" for t in toks))

spell = sc.get_spellchecker()
if spell is None:
    print("SKIP dictionary-dependent checks (pyspellchecker not installed)")
else:
    # --- suggestions ---
    s_teh = sc.suggest("teh")
    check("suggest('teh') offers 'the'", "the" in s_teh)
    check("suggest correct word is empty", sc.suggest("hello") == [])
    check("suggest caps restored", sc.suggest("Teh") and sc.suggest("Teh")[0][0].isupper())
    check("suggest respects cap", len(sc.suggest("teh", max_suggestions=2)) <= 2)

    # --- check_text detection + offsets ---
    res = sc.check_text("teh quick brown fox")
    words = {r["text"] for r in res}
    check("check_text flags 'teh'", "teh" in words)
    check("check_text keeps correct words", "quick" not in words and "brown" not in words)
    teh = next(r for r in res if r["text"] == "teh")
    check("check_text offset slices to word", "teh quick brown fox"[teh["start"]:teh["end"]] == "teh")
    check("check_text record shape", teh["ruleId"] == "spell.misspelling" and teh["severity"] == "suggest")
    check("check_text includes suggestions", "the" in teh["suggestions"])

    # --- code-point offsets past an astral character ---
    astral = "\U0001f600 teh"  # emoji is ONE code point
    ares = sc.check_text(astral, with_suggestions=False)
    a = next((r for r in ares if r["text"] == "teh"), None)
    check("astral offset is code point (start==2)", a is not None and a["start"] == 2)
    check("astral offset slices correctly", a is not None and astral[a["start"]:a["end"]] == "teh")

    # --- skip rules in context (each is a single whole token) ---
    # Note: WORD_RE excludes digits, so "h3llo" would split into "h"+"llo"; the
    # digit rule in is_checkable is tested directly above, not here.
    res2 = sc.check_text("HTTP CamelCase JSON")
    check("check_text skips uncheckable tokens", res2 == [])

print("")
if fails:
    print("SPELL_CORE FAILED", fails)
    sys.exit(1)
print("SPELL_CORE OK")
