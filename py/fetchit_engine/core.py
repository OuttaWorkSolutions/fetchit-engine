"""Fetch It AI text engine (canonical core).

Emits the language-neutral CleanResult contract shared with @fetchit/engine
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

ENGINE_VERSION = "0.1.2"

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
_T = RULESET["thresholds"]
MIN_CHARS = _T["MIN_CHARS"]
MIN_WORDS = _T["MIN_WORDS"]
_LEVEL_MODERATE = _T["levelModerate"]
_LEVEL_HIGH = _T["levelHigh"]

# --- regexes that are logic, not data (kept in code; may contain dashes) -----
# Em dash (U+2014) / horizontal bar (U+2015) in any spacing; en dash (U+2013)
# only when spaced on both sides. Only spaces/tabs are consumed so line breaks
# survive. Mirrors _EM_DASH in text_tools.py.
_EM_DASH = re.compile(r"[ \t]*[—―][ \t]*|[ \t]+–[ \t]+")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+([,.;:!?])")

# re.ASCII pins \b, \d, \w, \s to ASCII so they match JavaScript's default
# (ASCII) semantics exactly. Without it Python treats accented letters as word
# characters and JS does not, which breaks \b matches near Unicode letters.
_RULE_OF_THREE = re.compile(
    r"\b[A-Za-z]+,\s+[A-Za-z]+,\s+and\s+[A-Za-z]+\b", re.IGNORECASE | re.ASCII
)
_LIST_MARKER = re.compile(r"^\s*(?:[-*•·]|\d+[.)])\s+", re.MULTILINE | re.ASCII)
_CONTRACTION = re.compile(r"\b[A-Za-z]+'(?:t|s|re|ve|ll|d|m)\b", re.IGNORECASE | re.ASCII)
_WORD = re.compile(r"[A-Za-z']+")
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
_DASH_RULE = ("dash.spaced", "dash", "Replaced a spaced dash with a space")
_COLLAPSE_RULE = ("space.collapse", "space", "Collapsed repeated spaces")
_SPACE_BEFORE_RULE = ("punct.space-before", "space", "Removed a space before punctuation")

# Priority when several passes touch the same characters and their cells merge.
# Higher wins the label. Dash beats space cleanup beats invisible.
_RULE_PRIORITY = {
    "dash.spaced": 40,
    "space.lookalike": 30,
    "space.collapse": 20,
    "punct.space-before": 15,
}


def _ascii_lower(text):
    """Lowercase only A-Z. Length- and position-preserving, so offsets computed
    against the result map 1:1 back onto the input. Every rule phrase is ASCII,
    so this never misses a match, and it is identical in JS."""
    out = []
    for ch in text:
        o = ord(ch)
        if 65 <= o <= 90:
            out.append(chr(o + 32))
        else:
            out.append(ch)
    return "".join(out)


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
    """
    __slots__ = ("text", "src0", "src1", "rule")

    def __init__(self, text, src0, src1, rule=None):
        self.text = text
        self.src0 = src0
        self.src1 = src1
        self.rule = rule


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
        merged = cells[ci:cj]
        src0 = merged[0].src0
        src1 = merged[-1].src1
        # if any merged cell already carried a higher-priority rule, keep it
        best = rule
        best_pri = _RULE_PRIORITY.get(rule[0], 0)
        for c in merged:
            if c.rule and _RULE_PRIORITY.get(c.rule[0], 0) > best_pri:
                best = c.rule
                best_pri = _RULE_PRIORITY.get(c.rule[0], 0)
        rep = m.expand(replacement) if "\\" in replacement else replacement
        out.append(_Cell(rep, src0, src1, best))
        last = cj
        changed = True
    out.extend(cells[last:])
    return out, changed


def _build_cells(text, disabled=frozenset()):
    """Pass A: invisible removal and look-alike-space normalization, cell-wise
    by code point. A disabled rule leaves its characters untouched. Returns the
    cell list (input order preserved)."""
    cells = []
    for i, ch in enumerate(text):
        cp = ord(ch)
        inv = _invisible_rule(cp)
        if inv and inv["id"] not in disabled:
            cells.append(_Cell("", i, i + 1, (inv["id"], "invisible", "Removed " + inv["label"])))
        elif _is_odd_space(cp) and _ODD_SPACE_RULE_ID not in disabled:
            cells.append(_Cell(" ", i, i + 1, (_ODD_SPACE_RULE_ID, "space", "Normalized a " + _ODD_SPACE_LABEL)))
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


def _clean_cells(text, disabled=frozenset()):
    """Full clean pipeline over cells. Mirrors clean_text() in text_tools.py:
    rebuild (invisible + odd space), then, only if a dash was present, the em
    dash pass plus multi-space collapse and space-before-punct tidy. A disabled
    rule id skips its pass entirely, so cleaned text and the edit list agree."""
    cells = _build_cells(text, disabled)
    current = "".join(c.text for c in cells)
    # Run the dash/space passes to a FIXED POINT, not once. A single pass is
    # not idempotent: removing an em dash can manufacture the spacing that arms
    # the spaced-en-dash rule ("X—– Y" -> "X – Y", and only a second clean
    # reached "X Y"), which broke the documented clean(clean(x)) == clean(x)
    # contract. Each enabled dash pass strictly reduces the dash count, so this
    # terminates; the equality check breaks when the dash rule is disabled.
    # Mirrors cleanCells() in the JS engine exactly.
    for _guard in range(8):
        if not _EM_DASH.search(current):
            break
        if _DASH_RULE[0] not in disabled:
            cells, _ = _regex_pass(cells, _EM_DASH, " ", _DASH_RULE)
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
    """Replace spaced dashes with a single space. Returns (new_text, count).
    Back-compatible with text_tools.remove_em_dashes."""
    count = len(_EM_DASH.findall(text))
    if not count:
        return text, 0
    new = _EM_DASH.sub(" ", text)
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
    for p in _PHRASES:
        phrase = p["text"]
        start = lowered.find(phrase)
        while start != -1:
            raw.append((start, start + len(phrase), p["id"], phrase))
            start = lowered.find(phrase, start + len(phrase))
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

    # 2. Stock AI phrases.
    found = [p["text"] for p in _PHRASES if p["text"] in lowered]
    if found:
        occurrences = sum(lowered.count(p) for p in found)
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
            "hidden": invisible_n + oddspace_n,
            "flagged": len(flags),
        },
    }
