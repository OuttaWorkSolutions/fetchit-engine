"""Structured spellcheck, extracted from the desktop app's spellcheck.py.

Qt-free: this is the reusable detection and ranking logic with the Qt widget
classes removed, returning misspellings and ranked suggestions as plain data.
The desktop SpellHighlighter / SpellCheckTextEdit can be refactored to consume
this later; the tool web engine does not use it (browsers spellcheck natively).

Backed by pyspellchecker, which is an optional extra:
    pip install "fetchit-engine[spell]"
If it is not installed, get_spellchecker() returns None and the functions here
degrade to empty results, exactly like the desktop app does.

Offsets in check_text results are CODE POINTS into the text, matching the rest
of the engine (offsetUnit "codePoint"). Results use the same shape as engine
flags: severity "suggest", a ruleId, category, start/end, and text.
"""
import re

WORD_RE = re.compile(r"[A-Za-z']{2,}")

_spell = None
_spell_load_failed = False


def get_spellchecker():
    """Lazily load the dictionary (~0.3s once). Returns None if pyspellchecker
    is unavailable, so callers keep working without spellcheck."""
    global _spell, _spell_load_failed
    if _spell is None and not _spell_load_failed:
        try:
            from spellchecker import SpellChecker

            _spell = SpellChecker()
        except Exception:
            _spell_load_failed = True
    return _spell


def is_checkable(word):
    """Skip things that are not prose: words with digits, ALL-CAPS acronyms,
    and CamelCase / mid-word capitals. Same rule as the desktop app."""
    if any(ch.isdigit() for ch in word):
        return False
    if word.isupper():
        return False
    if any(ch.isupper() for ch in word[1:]):
        return False
    return True


def suggest(word, max_suggestions=5):
    """Ranked replacement suggestions for one word: the best correction first,
    then remaining candidates alphabetically, capped. Capitalization of the
    original is restored. Returns [] if the word is fine, too long/short, not
    checkable, or the dictionary is unavailable. Mirrors the desktop ranking."""
    spell = get_spellchecker()
    if spell is None:
        return []
    w = word.strip("'")
    # Long garbage strings make candidate search slow; skip them (as the app does).
    if not w or not (2 <= len(w) <= 15) or not is_checkable(w):
        return []
    lw = w.lower()
    if lw not in spell.unknown([lw]):
        return []
    best = spell.correction(lw)
    candidates = set(spell.candidates(lw) or set())
    candidates.discard(lw)
    ordered = []
    if best and best != lw:
        ordered.append(best)
    ordered.extend(sorted(c for c in candidates if c != best))
    ordered = ordered[:max_suggestions]
    if w[0].isupper():
        ordered = [c.capitalize() for c in ordered]
    return ordered


def check_text(text, with_suggestions=True, max_suggestions=5):
    """Find misspelled words in text. Returns a list of records:

        {ruleId, category, severity, start, end, text, suggestions, message}

    start/end are code-point offsets. Every unknown checkable word (2+ letters)
    is reported; suggestions are provided for words 2-15 characters long when
    with_suggestions is true (longer words are still reported, with []).
    Returns [] if the dictionary is unavailable."""
    found = []
    for m in WORD_RE.finditer(text):
        raw = m.group()
        word = raw.strip("'")
        if word and is_checkable(word):
            start = m.start() + raw.index(word)
            found.append((start, start + len(word), word))

    spell = get_spellchecker()
    if spell is None or not found:
        return []

    unknown = spell.unknown({w.lower() for _, _, w in found})
    if not unknown:
        return []

    results = []
    for start, end, word in found:
        if word.lower() in unknown:
            results.append({
                "ruleId": "spell.misspelling",
                "category": "spell",
                "severity": "suggest",
                "start": start,
                "end": end,
                "text": word,
                "suggestions": suggest(word, max_suggestions) if with_suggestions else [],
                "message": "Possible misspelling",
            })
    return results
