"""Fetch It AI text engine (canonical core).

Emits the language-neutral CleanResult contract shared with @fetchitai/engine
(JavaScript). Ported in lockstep; the parity vectors in
packages/engine-core/vectors.json are the contract both sides must satisfy.

Offsets in every result are CODE POINTS into the input text (offsetUnit
"codePoint"), so Python and JavaScript agree regardless of astral characters.
JS hosts that paint into the DOM convert to UTF-16 with the converter shipped
in the JS package.

This module has no third-party dependencies and no Qt/DOM coupling.
"""
import json
import os
import re

ENGINE_VERSION = "0.5.0"

# --- ruleset (single source of truth, shared with the JS package) -----------
_RULESET_PATH = os.path.join(
    os.path.dirname(__file__), "ruleset.json"
)


def _load_ruleset(path=_RULESET_PATH):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


RULESET = _load_ruleset()
RULESET_VERSION = RULESET["rulesetVersion"]
_PHRASES = RULESET["phrases"]                 # [{id, text}]
_ENUMERATORS = RULESET["enumerators"]         # [{id, text}]
_INVISIBLE_RANGES = RULESET["invisibleRanges"]
_ODD_SPACE_RANGES = RULESET["oddSpaceRanges"]
_ODD_SPACE_RULE_ID = RULESET["oddSpaceRuleId"]
_ODD_SPACE_LABEL = RULESET["oddSpaceLabel"]
_CONFUSABLE_RULE_ID = RULESET["confusableRuleId"]
_CONFUSABLE_LABEL = RULESET["confusableLabel"]
_TYPOGRAPHY_RULE_ID = RULESET["typographyRuleId"]
_TYPOGRAPHY_LABEL = RULESET["typographyLabel"]
# code point -> replacement, built once from the shared tables so both
# languages derive the same lookup from the same data.
_CONFUSABLES = {c["cp"]: c["to"] for c in RULESET["confusables"]}
_TYPOGRAPHY = {c["cp"]: c["to"] for c in RULESET["typography"]}
_T = RULESET["thresholds"]
MIN_CHARS = _T["MIN_CHARS"]
MIN_WORDS = _T["MIN_WORDS"]
_LEVEL_MODERATE = _T["levelModerate"]
_LEVEL_HIGH = _T["levelHigh"]

# --- regexes that are logic, not data (kept in code; may contain dashes) -----
# A RUN of em dashes (U+2014) / horizontal bars (U+2015), optionally
# space-separated, is one match, so "a——b" produces one comma, not two edits;
# an en dash (U+2013) matches only when spaced on both sides, so numeric
# ranges like 3–5 survive. Only spaces/tabs are consumed so line breaks
# survive. Mirrors EM_DASH_RE in the JS engine.
_EM_DASH = re.compile(r"[ \t]*[—―](?:[ \t]*[—―])*[ \t]*|[ \t]+–[ \t]+")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+([,.;:!?])")

# re.ASCII pins \b, \d, \w, \s to ASCII so they match JavaScript's default
# (ASCII) semantics exactly. Without it Python treats accented letters as word
# characters and JS does not, which breaks \b matches near Unicode letters.
_RULE_OF_THREE = re.compile(
    r"\b[A-Za-z]+,\s+[A-Za-z]+,\s+and\s+[A-Za-z]+\b", re.IGNORECASE | re.ASCII
)
_LIST_MARKER = re.compile(r"^\s*(?:[-*•·]|\d+[.)])\s+", re.MULTILINE | re.ASCII)
# U+2019 is included deliberately. Word processors and AI assistants emit the
# curly apostrophe, and matching only the straight one made this signal report
# "almost no contractions" on prose that was full of them, inflating the score
# by 10 points, while _WORD split "don’t" into two words.
_CONTRACTION = re.compile(r"\b[A-Za-z]+['’](?:t|s|re|ve|ll|d|m)\b", re.IGNORECASE | re.ASCII)
_WORD = re.compile(r"[A-Za-z'’]+")
# Markdown that survived a paste out of a chat window into running prose: bold,
# underline-bold and headings. Markdown LINKS and images are deliberately NOT
# counted, because they are common in ordinary writing and scoring them as an AI
# tell is a false positive. Mirrors MARKDOWN_RE in the JS engine.
_MARKDOWN = re.compile(r"\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}[ \t]", re.MULTILINE)

# URLs and markdown link targets are literal, not prose: cleaning must leave them
# byte-identical. Scheme spelled out (no IGNORECASE) and whitespace an explicit
# class (no \S) so JS and Python match the same spans. Mirrors URL_RE.
_URL_RE = re.compile(r"(?:[Hh][Tt][Tt][Pp][Ss]?://|[Ww][Ww][Ww]\.)[^ \t\n\r\f\v)]+|\]\([^)\n]+\)")


# Phrase matching is WHOLE-WORD, like the enumerators, so "landscape" no longer
# fires inside "landscapers". A \b is applied at an edge only when that edge is a
# word character: three shipped phrases end in a comma ("in conclusion,"), where a
# trailing \b would demand a letter after the comma and never match. All phrases
# start with a letter, so the leading \b is always valid. Built once; mirrors
# PHRASE_RES in the JS engine. re.ASCII pins \b to ASCII to match JS.
def _phrase_boundary(phrase):
    start = r"\b" if re.match(r"[A-Za-z0-9]", phrase) else ""
    end = r"\b" if re.search(r"[A-Za-z0-9]$", phrase) else ""
    return start, end


_PHRASE_RES = [
    (p["id"], p["text"],
     re.compile("".join((_phrase_boundary(p["text"])[0], re.escape(p["text"]), _phrase_boundary(p["text"])[1])), re.ASCII))
    for p in _PHRASES
]


# A ZERO WIDTH JOINER (U+200D) between two emoji fuses them into one glyph:
# family emoji, professions, the rainbow and other flags. Removing it as an
# invisible character shatters the emoji, so a ZWJ is kept when BOTH neighbours
# are emoji-ish. A ZWJ hidden inside Latin text has non-emoji neighbours and is
# still removed. Mirrors isEmojiContext in the JS engine.
_ZWJ_CP = 0x200D


def _is_emoji_context(cp):
    return (0x1F000 <= cp <= 0x1FAFF      # pictographs, emoticons, supplemental, regional indicators
            or 0x2600 <= cp <= 0x27BF     # misc symbols + dingbats
            or 0x2B00 <= cp <= 0x2BFF     # stars, arrows
            or cp == 0xFE0F or cp == 0xFE0E)  # emoji / text variation selectors
# Sentence split: same as the JS splitSentences(). ASCII whitespace only.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[ \t\n\r\f\v]+", re.ASCII)
# One shared whitespace set for trimming and word splitting, identical in both
# engines. It is the union of what Python str.strip() and JS String.trim()
# consider whitespace, so gating on length never diverges by language.
_WS = frozenset(
    [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x85, 0xA0,
     0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
    + list(range(0x2000, 0x200B))
)


def _strip(text):
    a, b = 0, len(text)
    while a < b and ord(text[a]) in _WS:
        a += 1
    while b > a and ord(text[b - 1]) in _WS:
        b -= 1
    return text[a:b]


def _split_ws(s):
    """Split on ASCII whitespace runs, dropping empties. Matches JS splitWords."""
    return [w for w in re.split(r"[ \t\n\r\f\v]+", s) if w]

# Rule metadata for edits produced by the dash/space normalization passes.
_DASH_RULE_ID = "dash.spaced"
_DASH_COMMA_RULE = (_DASH_RULE_ID, "dash", "Replaced a dash with a comma")
_DASH_SPACE_RULE = (_DASH_RULE_ID, "dash", "Replaced a spaced dash with a space")


def _dash_rule_for(rep):
    return _DASH_COMMA_RULE if rep[:1] == "," else _DASH_SPACE_RULE


_COLLAPSE_RULE = ("space.collapse", "space", "Collapsed repeated spaces")
_CONFUSABLE_RULE = (_CONFUSABLE_RULE_ID, "homoglyph", "Replaced a " + _CONFUSABLE_LABEL)
_TYPOGRAPHY_RULE = (_TYPOGRAPHY_RULE_ID, "typography", "Normalized a " + _TYPOGRAPHY_LABEL)
_SPACE_BEFORE_RULE = ("punct.space-before", "space", "Removed a space before punctuation")

# What a matched dash run becomes. A clause dash reads as a pause, so the
# default replacement is a comma. The comma is withheld (single space instead,
# the old behavior, tidied by the collapse and space-before-punct passes) when
# a comma cannot sit there: at a text or line boundary, next to punctuation or
# a bracket it would double up against, next to a dash the match could not
# consume, or between digits, where the dash is a range rather than a pause.
# When the next character is whitespace the comma takes no trailing space, so
# it hugs the word before a line break. Mirrors dashReplacement in the JS
# engine.
_DASH_CP = frozenset((0x2014, 0x2015, 0x2013))
_NO_COMMA_BEFORE = frozenset(ord(c) for c in ",.;:!?([{")
_NO_COMMA_AFTER = frozenset(ord(c) for c in ",.;:!?)]}")


def _cp_before(s, i):
    return ord(s[i - 1]) if i > 0 else -1


def _cp_after(s, i):
    return ord(s[i]) if i < len(s) else -1


def _dash_replacement(before_cp, after_cp):
    blocked_before = (before_cp < 0 or before_cp in _WS
                      or before_cp in _NO_COMMA_BEFORE or before_cp in _DASH_CP)
    blocked_after = after_cp < 0 or after_cp in _NO_COMMA_AFTER or after_cp in _DASH_CP
    if blocked_before or blocked_after:
        return " "
    return "," if after_cp in _WS else ", "


def _is_number_range_dash(before_cp, after_cp):
    # A matched dash run directly between two digits (1914—1918, pages 12 — 14)
    # is a numeric range, not a clause pause: leave the dash and its spacing as
    # written. The pass returns None to skip it.
    return 0x30 <= before_cp <= 0x39 and 0x30 <= after_cp <= 0x39


def _dash_match_replacement(m):
    before = _cp_before(m.string, m.start())
    after = _cp_after(m.string, m.end())
    if _is_number_range_dash(before, after):
        return None
    return _dash_replacement(before, after)

# Priority when several passes touch the same characters and their cells merge.
# Higher wins the label. Dash beats space cleanup beats invisible.
_RULE_PRIORITY = {
    "homoglyph.mixed-script": 45,
    "dash.spaced": 40,
    "typography.smart": 35,
    "space.lookalike": 30,
    "space.collapse": 20,
    "punct.space-before": 15,
}


_LOWER_TABLE = {c: c + 32 for c in range(65, 91)}


def _ascii_lower(text):
    """Lowercase only A-Z. Length- and position-preserving, so offsets computed
    against the result map 1:1 back onto the input. Every rule phrase is ASCII,
    so this never misses a match, and it is identical in JS. str.translate is far
    faster than a char loop on long text; mirrors asciiLower's regex replace."""
    return text.translate(_LOWER_TABLE)


def _invisible_rule(codepoint):
    for r in _INVISIBLE_RANGES:
        if r["min"] <= codepoint <= r["max"]:
            return r
    return None


def _is_odd_space(codepoint):
    for r in _ODD_SPACE_RANGES:
        if r["min"] <= codepoint <= r["max"]:
            return True
    return False


class _Cell:
    """One unit of the working buffer, carrying provenance back to the input.

    text     current character(s), "" for a deletion
    src0/src1 half-open code-point range in the INPUT this cell represents
    rule     (ruleId, category, message) if this cell is the product of an edit,
             else None
    protected inside a URL / link target: no pass may touch it
    """
    __slots__ = ("text", "src0", "src1", "rule", "protected")

    def __init__(self, text, src0, src1, rule=None, protected=False):
        self.text = text
        self.src0 = src0
        self.src1 = src1
        self.rule = rule
        self.protected = protected


def _protected_flags(text):
    """A boolean per input code point: True where the code point lies inside a URL
    or markdown link target and must be left byte-identical. Python str indices are
    code points, so match offsets line up with cells. Mirrors protectedFlags."""
    flags = [False] * len(text)
    for m in _URL_RE.finditer(text):
        for i in range(m.start(), m.end()):
            flags[i] = True
    return flags


def _regex_pass(cells, regex, replacement, rule):
    """Run a regex over the string the cells currently spell, replacing each
    match's cell range with a single edit cell. Match indices are code points
    (Python native), which line up with cell boundaries because these regexes
    only ever match BMP space/tab/dash/punct characters, never astral ones."""
    current = "".join(c.text for c in cells)
    if not regex.search(current):
        return cells, False
    # offset (in code points) where each cell's text starts in `current`
    starts = []
    pos = 0
    for c in cells:
        starts.append(pos)
        pos += len(c.text)
    starts.append(pos)

    def cell_at(offset):
        # first cell index whose start == offset (boundaries always align)
        lo, hi = 0, len(cells)
        while lo < hi:
            mid = (lo + hi) // 2
            if starts[mid] < offset:
                lo = mid + 1
            else:
                hi = mid
        return lo

    out = []
    last = 0
    changed = False
    for m in regex.finditer(current):
        a, b = m.start(), m.end()
        ci, cj = cell_at(a), cell_at(b)
        out.extend(cells[last:ci])
        # A match that touches a protected (URL) cell is left alone, like a None
        # replacement: copy its cells through untouched, so any sub-edits they
        # carry (a normalized odd space beside a numeric-range dash) survive and
        # the span produces no edit.
        if any(cells[k].protected for k in range(ci, cj)):
            rep = None
        elif callable(replacement):
            rep = replacement(m)
        elif "\\" in replacement:
            rep = m.expand(replacement)
        else:
            rep = replacement
        if rep is None:
            out.extend(cells[ci:cj])
            last = cj
            continue
        merged = cells[ci:cj]
        src0 = merged[0].src0
        src1 = merged[-1].src1
        # `rule` may depend on the replacement chosen (the dash pass labels
        # comma and space outcomes differently while keeping one ruleId).
        base = rule(rep) if callable(rule) else rule
        # if any merged cell already carried a higher-priority rule, keep it
        best = base
        best_pri = _RULE_PRIORITY.get(base[0], 0)
        for c in merged:
            if c.rule and _RULE_PRIORITY.get(c.rule[0], 0) > best_pri:
                best = c.rule
                best_pri = _RULE_PRIORITY.get(c.rule[0], 0)
        out.append(_Cell(rep, src0, src1, best))
        last = cj
        changed = True
    out.extend(cells[last:])
    return out, changed


def _build_cells(text, disabled=frozenset(), prot=None):
    """Pass A: invisible removal and look-alike-space normalization, cell-wise
    by code point. A disabled rule leaves its characters untouched. Code points
    inside a URL / link target are left exactly as written. Returns the cell list
    (input order preserved)."""
    if prot is None:
        prot = _protected_flags(text)
    cells = []
    n = len(text)
    for i, ch in enumerate(text):
        if prot[i]:
            cells.append(_Cell(text[i], i, i + 1, None, True))
            continue
        cp = ord(ch)
        inv = _invisible_rule(cp)
        # A ZWJ flanked by emoji is joining them, not hiding in text: keep it so
        # the emoji sequence survives (see _is_emoji_context).
        keep_zwj = (cp == _ZWJ_CP
                    and _is_emoji_context(ord(text[i - 1]) if i > 0 else -1)
                    and _is_emoji_context(ord(text[i + 1]) if i + 1 < n else -1))
        if inv and inv["id"] not in disabled and not keep_zwj:
            cells.append(_Cell("", i, i + 1, (inv["id"], "invisible", "Removed " + inv["label"])))
        elif _is_odd_space(cp) and _ODD_SPACE_RULE_ID not in disabled:
            cells.append(_Cell(" ", i, i + 1, (_ODD_SPACE_RULE_ID, "space", "Normalized a " + _ODD_SPACE_LABEL)))
        elif cp in _TYPOGRAPHY and _TYPOGRAPHY_RULE_ID not in disabled:
            cells.append(_Cell(_TYPOGRAPHY[cp], i, i + 1, _TYPOGRAPHY_RULE))
        else:
            cells.append(_Cell(ch, i, i + 1, None))
    return cells


def _cells_to_edits(cells, text):
    """Turn edit-cells into CleanResult edit records (input code-point coords)."""
    edits = []
    n = 0
    for c in cells:
        if c.rule is None:
            continue
        original = text[c.src0:c.src1]
        if original == c.text:
            continue  # no-op (e.g. a look-alike space that was already " ")
        n += 1
        rule_id, category, message = c.rule
        edits.append({
            "id": "e%d" % n,
            "ruleId": rule_id,
            "category": category,
            "severity": "auto",
            "start": c.src0,
            "end": c.src1,
            "original": original,
            "replacement": c.text,
            "message": message,
        })
    return edits


def _is_latin_letter(t):
    return len(t) == 1 and (65 <= ord(t) <= 90 or 97 <= ord(t) <= 122)


def _is_confusable_text(t):
    return len(t) == 1 and ord(t) in _CONFUSABLES


def _homoglyph_pass(cells, disabled=frozenset()):
    """A confusable is only a problem when it hides inside a word that is
    otherwise Latin. Replacing them wholesale would destroy genuine Cyrillic or
    Greek text, so a run is rewritten only when it MIXES scripts. Cells whose
    text is empty (an invisible character already removed) are transparent, so
    "a<ZWSP>pple" with a Cyrillic a is still seen as one word.
    Mirrors homoglyphPass in the JS engine."""
    if _CONFUSABLE_RULE_ID in disabled:
        return cells
    # A protected (URL) cell is never wordish, so it breaks the run and its
    # look-alike letters are never rewritten.
    wordish = lambda c: (not c.protected) and (_is_latin_letter(c.text) or _is_confusable_text(c.text))
    i = 0
    while i < len(cells):
        if not wordish(cells[i]):
            i += 1
            continue
        j = i
        last_word = i
        has_latin = False
        has_confusable = False
        while j < len(cells) and (wordish(cells[j]) or cells[j].text == ""):
            if _is_latin_letter(cells[j].text):
                has_latin = True
                last_word = j
            elif _is_confusable_text(cells[j].text):
                has_confusable = True
                last_word = j
            j += 1
        if has_latin and has_confusable:
            for k in range(i, last_word + 1):
                if not _is_confusable_text(cells[k].text):
                    continue
                cells[k] = _Cell(_CONFUSABLES[ord(cells[k].text)],
                                 cells[k].src0, cells[k].src1, _CONFUSABLE_RULE)
        i = max(j, i + 1)
    return cells


def _clean_cells(text, disabled=frozenset()):
    """Full clean pipeline over cells. Mirrors clean_text() in text_tools.py:
    rebuild (invisible + odd space), then, only if a dash was present, the em
    dash pass plus multi-space collapse and space-before-punct tidy. A disabled
    rule id skips its pass entirely, so cleaned text and the edit list agree."""
    cells = _homoglyph_pass(_build_cells(text, disabled), disabled)
    current = "".join(c.text for c in cells)
    # Run the dash/space passes to a FIXED POINT, not once. A single pass is
    # not idempotent: replacing an em dash can manufacture the spacing that
    # arms the spaced-en-dash rule ("X—– Y" -> "X – Y", and only the next
    # iteration reaches "X, Y"), which would break the documented
    # clean(clean(x)) == clean(x) contract. Each enabled dash pass strictly
    # reduces the dash count, so this terminates; the equality check breaks
    # when the dash rule is disabled. Mirrors cleanCells() in the JS engine.
    for _guard in range(8):
        if not _EM_DASH.search(current):
            break
        if _DASH_RULE_ID not in disabled:
            cells, _ = _regex_pass(cells, _EM_DASH, _dash_match_replacement, _dash_rule_for)
        if _COLLAPSE_RULE[0] not in disabled:
            cells, _ = _regex_pass(cells, _MULTI_SPACE, " ", _COLLAPSE_RULE)
        if _SPACE_BEFORE_RULE[0] not in disabled:
            cells, _ = _regex_pass(cells, _SPACE_BEFORE_PUNCT, "\\1", _SPACE_BEFORE_RULE)
        nxt = "".join(c.text for c in cells)
        if nxt == current:
            break
        current = nxt
    return current, cells


# --- public building blocks --------------------------------------------------

def rebuild_text(text):
    """Rebuild from visible characters only (invisible dropped, look-alike
    spaces normalized). Returns (new_text, changed_count). Back-compatible with
    text_tools.rebuild_text."""
    cells = _build_cells(text)
    changed = sum(1 for c in cells if c.rule is not None and text[c.src0:c.src1] != c.text)
    return "".join(c.text for c in cells), changed


def remove_em_dashes(text):
    """Replace clause dashes with a comma where one fits, else a space.
    Returns (new_text, count); count is the number of matched dash groups."""
    count = len(_EM_DASH.findall(text))
    if not count:
        return text, 0

    def _repl(m):
        before = _cp_before(m.string, m.start())
        after = _cp_after(m.string, m.end())
        if _is_number_range_dash(before, after):
            return m.group(0)  # leave a numeric range dash untouched
        return _dash_replacement(before, after)

    new = _EM_DASH.sub(_repl, text)
    new = _MULTI_SPACE.sub(" ", new)
    new = _SPACE_BEFORE_PUNCT.sub(r"\1", new)
    return new, count


def apply_edits(text, accepted_ids, edits):
    """Apply the chosen edits to text (code-point splices, right to left).
    Accepting every edit reproduces CleanResult.cleaned.text exactly."""
    accepted = set(accepted_ids)
    chosen = [e for e in edits if e["id"] in accepted]
    chosen.sort(key=lambda e: e["start"], reverse=True)
    chars = list(text)
    for e in chosen:
        chars[e["start"]:e["end"]] = list(e["replacement"])
    return "".join(chars)


def find_ai_spans(text):
    """(start, end) code-point spans of AI-associated wording, sorted and
    non-overlapping. Matches on an ASCII-lowercased copy so offsets map 1:1 to
    the input (no lowercase round-trip drift)."""
    return [(s["start"], s["end"]) for s in _find_ai_flags(text)]


def _find_ai_flags(text):
    lowered = _ascii_lower(text)
    raw = []
    for pid, ptext, pre in _PHRASE_RES:
        for m in pre.finditer(lowered):
            raw.append((m.start(), m.end(), pid, ptext))
    for w in _ENUMERATORS:
        for m in re.finditer(r"\b" + re.escape(w["text"]) + r"\b", lowered, re.ASCII):
            raw.append((m.start(), m.end(), w["id"], w["text"]))
    raw.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    chosen = []
    reached = 0
    for start, end, rid, txt in raw:
        if start >= reached:
            chosen.append({
                "ruleId": rid, "start": start, "end": end,
                "text": text[start:end], "matched": txt,
            })
            reached = end
    return chosen


def analyze_ai_signals(text):
    """Heuristic AI-writing scan. Returns a report with structured signals
    (each carrying a stable id and its point contribution)."""
    stripped = _strip(text)
    if not stripped:
        return {"status": "empty"}
    words = _WORD.findall(stripped)
    if len(stripped) < MIN_CHARS or len(words) < MIN_WORDS:
        return {"status": "too_short"}

    score = 0
    signals = []
    lowered = _ascii_lower(stripped)

    # 1. Em/en dash density.
    dash_count = sum(stripped.count(d) for d in ("—", "–", "―"))
    dash_rate = dash_count / len(stripped) * 1000
    if dash_rate > 3:
        score += 25
        signals.append({"id": "signal.dash-density", "points": 25,
                        "message": "Heavy em-dash use (%d dashes)" % dash_count})
    elif dash_rate > 1.2:
        score += 12
        signals.append({"id": "signal.dash-density", "points": 12,
                        "message": "Frequent em-dash use (%d dashes)" % dash_count})

    # 2. Stock AI phrases. Whole-word, so "landscape" is not counted inside
    # "landscapers"; the same matcher the flags use, so score and highlights agree.
    # One scan per phrase (count once), not a filter pass plus a separate count.
    found = []
    occurrences = 0
    for _pid, ptext, pre in _PHRASE_RES:
        n = len(pre.findall(lowered))
        if n > 0:
            found.append(ptext)
            occurrences += n
    if found:
        pts = min(30, 10 * len(found))
        score += pts
        shown = ", ".join('"%s"' % p for p in found[:4])
        extra = " and %d more" % (len(found) - 4) if len(found) > 4 else ""
        signals.append({"id": "signal.stock-phrases", "points": pts,
                        "message": "AI-associated wording: %s%s (%d occurrence(s))"
                        % (shown, extra, occurrences)})

    # 3. Contraction rate.
    contractions = len(_CONTRACTION.findall(stripped))
    if len(words) >= 120 and contractions / len(words) * 100 < 0.5:
        score += 10
        signals.append({"id": "signal.contractions", "points": 10,
                        "message": "Almost no contractions (stiff, formal tone)"})

    # 4. Sentence-length uniformity.
    sentences = [s for s in _SENTENCE_SPLIT.split(stripped) if len(_split_ws(s)) >= 3]
    if len(sentences) >= 6:
        lengths = [len(_split_ws(s)) for s in sentences]
        mean = sum(lengths) / len(lengths)
        variance = sum((v - mean) ** 2 for v in lengths) / len(lengths)
        if mean and (variance ** 0.5) / mean < 0.35:
            score += 15
            signals.append({"id": "signal.sentence-uniformity", "points": 15,
                            "message": "Unusually uniform sentence lengths"})

    # 5. Rule of three.
    triads = len(_RULE_OF_THREE.findall(stripped))
    if triads >= 3:
        score += 12
        signals.append({"id": "signal.rule-of-three", "points": 12,
                        "message": "Frequent rule-of-three lists (%d triads)" % triads})
    elif triads == 2:
        score += 6
        signals.append({"id": "signal.rule-of-three", "points": 6,
                        "message": "Some rule-of-three phrasing"})

    # 6. List structure.
    markdown_hits = len(_MARKDOWN.findall(text))
    if markdown_hits >= 2:
        score += 10
        signals.append({"id": "signal.markdown-artifacts", "points": 10,
                        "message": "Markdown left in the text (%d marks), a sign of a paste from a chat window" % markdown_hits})
    elif markdown_hits == 1:
        score += 5
        signals.append({"id": "signal.markdown-artifacts", "points": 5,
                        "message": "A markdown mark left in the text"})

    enum_hits = sum(len(re.findall(r"\b" + re.escape(w["text"]) + r"\b", lowered, re.ASCII))
                    for w in _ENUMERATORS)
    marker_hits = len(_LIST_MARKER.findall(text))
    list_signal = enum_hits + marker_hits
    if list_signal >= 4:
        score += 12
        signals.append({"id": "signal.list-structure", "points": 12,
                        "message": "Heavily list-structured (enumerators / bullets)"})
    elif list_signal >= 2:
        score += 6
        signals.append({"id": "signal.list-structure", "points": 6,
                        "message": "Somewhat list-structured"})

    score = min(score, 100)
    level = "high" if score >= _LEVEL_HIGH else "moderate" if score >= _LEVEL_MODERATE else "low"
    return {"status": "ok", "score": score, "level": level, "signals": signals}


# --- the one-call entry point -----------------------------------------------

def clean(text, options=None):
    """Clean text and return the full CleanResult.

    options (all optional):
      mode: "review" (default) | "auto" - advisory only; the result is identical.
            Callers apply auto edits unattended and show suggest flags to a human.
      rules.disable: list of rule ids to drop from edits and flags.
      rules.customPhrases: extra phrases flagged as AI-associated wording.
    """
    options = options or {}
    rules = options.get("rules") or {}
    disabled = set(rules.get("disable") or [])
    custom = list(rules.get("customPhrases") or [])

    cleaned, cells = _clean_cells(text, disabled)
    edits = _cells_to_edits(cells, text)

    flag_hits = _find_ai_flags(text)
    if custom:
        lowered = _ascii_lower(text)
        for phrase in custom:
            needle = _ascii_lower(phrase)
            if not needle:
                continue
            start = lowered.find(needle)
            while start != -1:
                flag_hits.append({"ruleId": "ai-custom." + re.sub(r"[^a-z0-9]+", "-", needle).strip("-"),
                                  "start": start, "end": start + len(needle),
                                  "text": text[start:start + len(needle)], "matched": needle})
                start = lowered.find(needle, start + len(needle))
        flag_hits.sort(key=lambda s: (s["start"], -(s["end"] - s["start"])))
        deduped = []
        reached = 0
        for h in flag_hits:
            if h["start"] >= reached:
                deduped.append(h)
                reached = h["end"]
        flag_hits = deduped

    flags = []
    fn = 0
    for h in flag_hits:
        if h["ruleId"] in disabled:
            continue
        fn += 1
        flags.append({
            "id": "f%d" % fn,
            "ruleId": h["ruleId"],
            "category": "ai-wording",
            "severity": "suggest",
            "start": h["start"],
            "end": h["end"],
            "text": h["text"],
            "replacement": None,
            "message": "AI-associated wording",
        })

    report = analyze_ai_signals(text)

    # Count the characters an edit actually CONSUMED, not the rule that fired.
    #
    # Attributing by ruleId undercounts: a broader rule can swallow a span that
    # contained invisible characters. " <ZWSP> " is collapsed by space.collapse,
    # which removed the zero-width space while reporting hidden: 0. Since no
    # replacement ever contains an invisible or look-alike character, counting
    # them in `original` is exact regardless of which rule did the removing.
    def _count_consumed(pred):
        return sum(
            1 for e in edits for ch in e["original"] if pred(ord(ch))
        )

    invisible_n = _count_consumed(lambda cp: _invisible_rule(cp) is not None)
    oddspace_n = _count_consumed(_is_odd_space)
    # Dashes count by consumed CHARACTER too: with the fixed-point dash pass, a
    # chain like "—– " merges into one edit that removed two dashes.
    dashes_n = _count_consumed(lambda cp: cp in (0x2014, 0x2015, 0x2013))
    # Same measured-by-consumption rule: a confusable left inside a genuinely
    # Cyrillic word is never consumed, so it is never counted.
    homoglyphs_n = _count_consumed(lambda cp: cp in _CONFUSABLES)
    typography_n = _count_consumed(lambda cp: cp in _TYPOGRAPHY)

    return {
        "engineVersion": ENGINE_VERSION,
        "rulesetVersion": RULESET_VERSION,
        "offsetUnit": "codePoint",
        "input": {"length": len(text)},
        "cleaned": {"text": cleaned, "length": len(cleaned)},
        "edits": edits,
        "flags": flags,
        "aiReport": report,
        "summary": {
            "invisible": invisible_n,
            "oddSpaces": oddspace_n,
            "dashes": dashes_n,
            "homoglyphs": homoglyphs_n,
            "typography": typography_n,
            "hidden": invisible_n + oddspace_n,
            "flagged": len(flags),
        },
    }
