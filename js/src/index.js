/*
 * @fetchitai/engine - deterministic text cleanup and AI-writing heuristics.
 *
 * Emits the language-neutral CleanResult contract shared with fetchit-engine
 * (Python). Ported in lockstep; packages/engine-core/vectors.json is the
 * contract both sides must satisfy.
 *
 * Every offset in a result is a CODE POINT into the input (offsetUnit
 * "codePoint"), so JS and Python agree regardless of astral characters. DOM
 * hosts that paint highlights convert with toUtf16Offsets() below.
 *
 * Zero runtime dependencies. Runs in browsers, Node, Deno, Bun, and workerd.
 */
import ruleset from "./ruleset.data.js";

export const ENGINE_VERSION = "0.5.0";
export const RULESET_VERSION = ruleset.rulesetVersion;

const PHRASES = ruleset.phrases;
const ENUMERATORS = ruleset.enumerators;
const INVISIBLE_RANGES = ruleset.invisibleRanges;
const ODD_SPACE_RANGES = ruleset.oddSpaceRanges;
const ODD_SPACE_RULE_ID = ruleset.oddSpaceRuleId;
const ODD_SPACE_LABEL = ruleset.oddSpaceLabel;
const CONFUSABLE_RULE_ID = ruleset.confusableRuleId;
const CONFUSABLE_LABEL = ruleset.confusableLabel;
const TYPOGRAPHY_RULE_ID = ruleset.typographyRuleId;
const TYPOGRAPHY_LABEL = ruleset.typographyLabel;
// code point -> replacement, built once from the shared tables so both
// languages derive the same lookup from the same data.
const CONFUSABLES = new Map(ruleset.confusables.map((c) => [c.cp, c.to]));
const TYPOGRAPHY = new Map(ruleset.typography.map((c) => [c.cp, c.to]));
export const MIN_CHARS = ruleset.thresholds.MIN_CHARS;
export const MIN_WORDS = ruleset.thresholds.MIN_WORDS;
const LEVEL_MODERATE = ruleset.thresholds.levelModerate;
const LEVEL_HIGH = ruleset.thresholds.levelHigh;

// Regexes that are logic, not data (mirror core.py; may contain dashes).
// A RUN of em dashes / horizontal bars (optionally space-separated) is one
// match, so "a——b" produces one comma, not two edits; an en dash matches only
// when spaced on both sides, so numeric ranges like 3–5 survive. Only spaces
// and tabs are consumed, so line breaks survive.
const EM_DASH_RE = /[ \t]*[—―](?:[ \t]*[—―])*[ \t]*|[ \t]+–[ \t]+/g;
const MULTI_SPACE_RE = /[ \t]{2,}/g;
const SPACE_BEFORE_PUNCT_RE = /[ \t]+([,.;:!?])/g;
// Whitespace classes are written out as ASCII [ \t\n\r\f\v] rather than \s so
// they match Python's re.ASCII \s exactly; JS \s otherwise also matches Unicode
// spaces, which Python (ASCII) would not. \b and \d are already ASCII in JS.
const RULE_OF_THREE_RE = /\b[A-Za-z]+,[ \t\n\r\f\v]+[A-Za-z]+,[ \t\n\r\f\v]+and[ \t\n\r\f\v]+[A-Za-z]+\b/gi;
const LIST_MARKER_RE = /^[ \t\n\r\f\v]*(?:[-*•·]|\d+[.)])[ \t\n\r\f\v]+/gm;
// U+2019 is included deliberately. Word processors and AI assistants emit the
// curly apostrophe, and matching only the straight one made this signal report
// "almost no contractions" on prose that was full of them, inflating the score
// by 10 points, while WORD_RE split "don’t" into two words.
const CONTRACTION_RE = /\b[A-Za-z]+['’](?:t|s|re|ve|ll|d|m)\b/gi;
const WORD_RE = /[A-Za-z'’]+/g;
// Markdown that survived a paste out of a chat window into running prose: bold,
// underline-bold and headings. Markdown LINKS and images are deliberately NOT
// counted, because they are common in ordinary writing and scoring them as an AI
// tell is a false positive. Mirrors _MARKDOWN in core.py.
const MARKDOWN_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}[ \t]/gm;

// URLs and markdown link targets are literal, not prose: cleaning must leave them
// byte-identical or it breaks the link (an em dash in a path becomes a comma, a
// look-alike letter in a domain gets rewritten). The scheme is spelled out rather
// than using the /i flag, and whitespace is an explicit class rather than \S, so
// JS and Python match the same spans. Mirrors _URL_RE in core.py.
const URL_RE = /(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ww][Ww][Ww]\.)[^ \t\n\r\f\v)]+|\]\([^)\n]+\)/g;

// Phrase matching is WHOLE-WORD, like the enumerators, so "landscape" no longer
// fires inside "landscapers". A \b is applied at an edge only when that edge is a
// word character: three shipped phrases end in a comma ("in conclusion,"), where
// a trailing \b would demand a letter after the comma and never match. All
// phrases start with a letter, so the leading \b is always valid. No lookbehind
// (Safari < 16.4 rejects the literal). Built once; mirrors _PHRASE_RES in core.py.
function phraseBoundary(phrase) {
  return {
    start: /^[A-Za-z0-9]/.test(phrase) ? "\\b" : "",
    end: /[A-Za-z0-9]$/.test(phrase) ? "\\b" : "",
  };
}
const PHRASE_RES = PHRASES.map((p) => {
  const b = phraseBoundary(p.text);
  return { id: p.id, text: p.text, re: new RegExp(b.start + escapeRe(p.text) + b.end, "g") };
});

// A ZERO WIDTH JOINER (U+200D) between two emoji fuses them into one glyph:
// family emoji, professions (woman + ZWJ + laptop), the rainbow and other flags.
// Removing it as an invisible character shatters the emoji into its parts, so a
// ZWJ is kept when BOTH neighbours are emoji-ish. A ZWJ hidden inside Latin text
// has non-emoji neighbours and is still removed. Mirrors _is_emoji_context.
const ZWJ_CP = 0x200d;
function isEmojiContext(cp) {
  return (cp >= 0x1f000 && cp <= 0x1faff) || // pictographs, emoticons, supplemental, regional indicators
    (cp >= 0x2600 && cp <= 0x27bf) ||         // misc symbols + dingbats (☀ ✂ ❤ …)
    (cp >= 0x2b00 && cp <= 0x2bff) ||         // stars, arrows (⭐ …)
    cp === 0xfe0f || cp === 0xfe0e;           // emoji / text variation selectors
}

// One shared whitespace set for trimming, identical to Python _WS.
const WS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
for (let c = 0x2000; c <= 0x200a; c++) WS.add(c);

function engineStrip(text) {
  let a = 0, b = text.length;
  while (a < b && WS.has(text.charCodeAt(a))) a++;
  while (b > a && WS.has(text.charCodeAt(b - 1))) b--;
  return text.slice(a, b);
}

function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    if (s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) <= 0xdbff) i++;
  }
  return n;
}

const DASH_RULE_ID = "dash.spaced";
const DASH_COMMA_RULE = [DASH_RULE_ID, "dash", "Replaced a dash with a comma"];
const DASH_SPACE_RULE = [DASH_RULE_ID, "dash", "Replaced a spaced dash with a space"];
const dashRuleFor = (rep) => (rep[0] === "," ? DASH_COMMA_RULE : DASH_SPACE_RULE);
const COLLAPSE_RULE = ["space.collapse", "space", "Collapsed repeated spaces"];
const CONFUSABLE_RULE = [CONFUSABLE_RULE_ID, "homoglyph", "Replaced a " + CONFUSABLE_LABEL];
const TYPOGRAPHY_RULE = [TYPOGRAPHY_RULE_ID, "typography", "Normalized a " + TYPOGRAPHY_LABEL];
const SPACE_BEFORE_RULE = ["punct.space-before", "space", "Removed a space before punctuation"];

// What a matched dash run becomes. A clause dash reads as a pause, so the
// default replacement is a comma. The comma is withheld (single space instead,
// the old behavior, tidied by the collapse and space-before-punct passes) when
// a comma cannot sit there: at a text or line boundary, next to punctuation or
// a bracket it would double up against, next to a dash the match could not
// consume, or between digits, where the dash is a range rather than a pause.
// When the next character is whitespace the comma takes no trailing space, so
// it hugs the word before a line break. Mirrors _dash_replacement in core.py.
const DASH_CP = new Set([0x2014, 0x2015, 0x2013]);
const NO_COMMA_BEFORE = new Set(Array.from(",.;:!?([{", (c) => c.codePointAt(0)));
const NO_COMMA_AFTER = new Set(Array.from(",.;:!?)]}", (c) => c.codePointAt(0)));
function dashReplacement(beforeCp, afterCp) {
  const blockedBefore =
    beforeCp < 0 || WS.has(beforeCp) || NO_COMMA_BEFORE.has(beforeCp) || DASH_CP.has(beforeCp);
  const blockedAfter = afterCp < 0 || NO_COMMA_AFTER.has(afterCp) || DASH_CP.has(afterCp);
  if (blockedBefore || blockedAfter) return " ";
  return WS.has(afterCp) ? "," : ", ";
}

// True when a matched dash run sits directly between two digits, e.g. 1914—1918
// or pages 12 — 14. That is a numeric range, not a clause pause, so the dash and
// its spacing are left exactly as written (the pass returns null to skip it).
function isNumberRangeDash(beforeCp, afterCp) {
  return beforeCp >= 0x30 && beforeCp <= 0x39 && afterCp >= 0x30 && afterCp <= 0x39;
}

// True code point just before / after UTF-16 index i, or -1 at a boundary.
// Python indexes by code point so ord() is enough there; here the char before
// can be the low half of a surrogate pair and must be decoded from its start.
function cpBefore(s, i) {
  if (i <= 0) return -1;
  const u = s.charCodeAt(i - 1);
  if (u >= 0xdc00 && u <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.codePointAt(i - 2);
  }
  return u;
}
function cpAfter(s, i) {
  return i < s.length ? s.codePointAt(i) : -1;
}
const dashMatchReplacement = (m) => {
  const before = cpBefore(m.input, m.index);
  const after = cpAfter(m.input, m.index + m[0].length);
  if (isNumberRangeDash(before, after)) return null; // leave a numeric range dash untouched
  return dashReplacement(before, after);
};

const RULE_PRIORITY = {
  "homoglyph.mixed-script": 45,
  "dash.spaced": 40,
  "typography.smart": 35,
  "space.lookalike": 30,
  "space.collapse": 20,
  "punct.space-before": 15,
};

// Lowercase only A-Z: length- and position-preserving, so offsets map 1:1 onto
// the input. Every rule phrase is ASCII, so this never misses a match, and it
// is identical to _ascii_lower in Python.
function asciiLower(text) {
  // Only A-Z, so length and code-point positions are preserved and offsets map
  // 1:1 onto the input. A native replace is far faster than a char-by-char string
  // build on long text; identical result. Mirrors _ascii_lower's translate table.
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function invisibleRule(cp) {
  for (const r of INVISIBLE_RANGES) {
    if (cp >= r.min && cp <= r.max) return r;
  }
  return null;
}

function isOddSpace(cp) {
  for (const r of ODD_SPACE_RANGES) {
    if (cp >= r.min && cp <= r.max) return true;
  }
  return false;
}

// Map every UTF-16 index of `text` to its code-point index (length + 1 entries).
function utf16ToCodePointMap(text) {
  const map = new Array(text.length + 1);
  let cp = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i);
    const units = code > 0xffff ? 2 : 1;
    for (let u = 0; u < units; u++) map[i + u] = cp;
    i += units;
    cp += 1;
  }
  map[text.length] = cp;
  return map;
}

// One working-buffer unit, carrying provenance back to the input.
class Cell {
  constructor(text, src0, src1, rule = null, prot = false) {
    this.text = text; // "" for a deletion
    this.src0 = src0; // half-open code-point range in the INPUT
    this.src1 = src1;
    this.rule = rule; // [ruleId, category, message] or null
    this.protected = prot; // inside a URL / link target: no pass may touch it
  }
}

// A boolean per input code point: true where the code point lies inside a URL or
// markdown link target and must be left byte-identical. Mirrors _protected_flags.
function protectedFlags(text) {
  const u2cp = utf16ToCodePointMap(text);
  const flags = new Array(u2cp[text.length]).fill(false);
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    const s = u2cp[m.index];
    const e = u2cp[m.index + m[0].length];
    for (let i = s; i < e; i++) flags[i] = true;
    if (m[0].length === 0) URL_RE.lastIndex++;
  }
  return flags;
}

// Run a regex over the string the cells currently spell, replacing each match's
// cell range with a single edit cell. Match indices are UTF-16; cell boundaries
// are tracked in UTF-16 units too, and these regexes only match BMP characters,
// so matches always align to cell boundaries.
function regexPass(cells, regex, replacementFn, rule) {
  const current = cells.map((c) => c.text).join("");
  regex.lastIndex = 0;
  if (!regex.test(current)) return cells;
  const starts = [];
  let pos = 0;
  for (const c of cells) {
    starts.push(pos);
    pos += c.text.length;
  }
  starts.push(pos);
  const cellAt = (offset) => {
    let lo = 0, hi = cells.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const out = [];
  let last = 0;
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(current)) !== null) {
    const a = m.index;
    const b = m.index + m[0].length;
    const ci = cellAt(a);
    const cj = cellAt(b);
    for (let k = last; k < ci; k++) out.push(cells[k]);
    // A match that touches a protected (URL) cell is left alone, as is a null
    // replacement: copy the cells through untouched, so any sub-edits they carry
    // (a normalized odd space beside a numeric-range dash) survive and the span
    // produces no edit of its own.
    let anyProtected = false;
    for (let k = ci; k < cj; k++) if (cells[k].protected) { anyProtected = true; break; }
    const rep = anyProtected ? null : replacementFn(m);
    if (rep === null) {
      for (let k = ci; k < cj; k++) out.push(cells[k]);
      last = cj;
      if (m[0].length === 0) regex.lastIndex++;
      continue;
    }
    const merged = cells.slice(ci, cj);
    const src0 = merged[0].src0;
    const src1 = merged[merged.length - 1].src1;
    // `rule` may depend on the replacement chosen (the dash pass labels comma
    // and space outcomes differently while keeping one ruleId).
    let best = typeof rule === "function" ? rule(rep) : rule;
    let bestPri = RULE_PRIORITY[best[0]] || 0;
    for (const c of merged) {
      if (c.rule && (RULE_PRIORITY[c.rule[0]] || 0) > bestPri) {
        best = c.rule;
        bestPri = RULE_PRIORITY[c.rule[0]] || 0;
      }
    }
    out.push(new Cell(rep, src0, src1, best));
    last = cj;
    if (m[0].length === 0) regex.lastIndex++; // guard against zero-width loops
  }
  for (let k = last; k < cells.length; k++) out.push(cells[k]);
  return out;
}

// Pass A: invisible removal and look-alike-space normalization, per code point.
// A disabled rule leaves its characters untouched.
function buildCells(cps, disabled, prot) {
  const cells = [];
  for (let i = 0; i < cps.length; i++) {
    // Inside a URL / link target: leave the code point exactly as written.
    if (prot[i]) { cells.push(new Cell(cps[i], i, i + 1, null, true)); continue; }
    const cp = cps[i].codePointAt(0);
    const inv = invisibleRule(cp);
    // A ZWJ flanked by emoji is joining them, not hiding in text: keep it so the
    // emoji sequence survives (see isEmojiContext). Its neighbours are read as
    // code points from the same array, so astral emoji line up.
    const keepZwj = cp === ZWJ_CP &&
      isEmojiContext(i > 0 ? cps[i - 1].codePointAt(0) : -1) &&
      isEmojiContext(i + 1 < cps.length ? cps[i + 1].codePointAt(0) : -1);
    if (inv && !disabled.has(inv.id) && !keepZwj) {
      cells.push(new Cell("", i, i + 1, [inv.id, "invisible", "Removed " + inv.label]));
    } else if (isOddSpace(cp) && !disabled.has(ODD_SPACE_RULE_ID)) {
      cells.push(new Cell(" ", i, i + 1, [ODD_SPACE_RULE_ID, "space", "Normalized a " + ODD_SPACE_LABEL]));
    } else if (TYPOGRAPHY.has(cp) && !disabled.has(TYPOGRAPHY_RULE_ID)) {
      cells.push(new Cell(TYPOGRAPHY.get(cp), i, i + 1, TYPOGRAPHY_RULE));
    } else {
      cells.push(new Cell(cps[i], i, i + 1, null));
    }
  }
  return cells;
}

// A confusable is only a problem when it is hiding inside a word that is
// otherwise Latin. Replacing them wholesale would destroy genuine Cyrillic or
// Greek text, so a run is rewritten only when it mixes scripts. Cells whose
// text is empty (an invisible character already removed) are transparent, so
// "a<ZWSP>pple" with a Cyrillic a is still seen as one word.
function isLatinLetter(t) {
  if (t.length !== 1) return false;
  const c = t.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isConfusableText(t) {
  return t.length === 1 && CONFUSABLES.has(t.codePointAt(0));
}
function homoglyphPass(cells, disabled) {
  if (disabled.has(CONFUSABLE_RULE_ID)) return cells;
  let i = 0;
  while (i < cells.length) {
    // A protected (URL) cell is never wordish, so it breaks the run and its
    // look-alike letters are never rewritten.
    const wordish = (c) => !c.protected && (isLatinLetter(c.text) || isConfusableText(c.text));
    if (!wordish(cells[i])) { i++; continue; }
    let j = i, lastWord = i, hasLatin = false, hasConfusable = false;
    while (j < cells.length && (wordish(cells[j]) || cells[j].text === "")) {
      if (isLatinLetter(cells[j].text)) { hasLatin = true; lastWord = j; }
      else if (isConfusableText(cells[j].text)) { hasConfusable = true; lastWord = j; }
      j++;
    }
    if (hasLatin && hasConfusable) {
      for (let k = i; k <= lastWord; k++) {
        if (!isConfusableText(cells[k].text)) continue;
        const to = CONFUSABLES.get(cells[k].text.codePointAt(0));
        cells[k] = new Cell(to, cells[k].src0, cells[k].src1, CONFUSABLE_RULE);
      }
    }
    i = Math.max(j, i + 1);
  }
  return cells;
}

function cleanCells(text, disabled) {
  const cps = Array.from(text); // code-point array
  let cells = homoglyphPass(buildCells(cps, disabled, protectedFlags(text)), disabled);
  let current = cells.map((c) => c.text).join("");
  // Run the dash/space passes to a FIXED POINT, not once. A single pass is not
  // idempotent: replacing an em dash can manufacture the spacing that arms the
  // spaced-en-dash rule ("X—– Y" -> "X – Y", and only the next iteration
  // reaches "X, Y"), which would break the documented clean(clean(x)) ===
  // clean(x) contract. Each enabled dash pass strictly reduces the dash count,
  // so this terminates; the equality check breaks the loop when the dash rule
  // is disabled. The guard is a belt for both.
  for (let guard = 0; guard < 8; guard++) {
    EM_DASH_RE.lastIndex = 0;
    if (!EM_DASH_RE.test(current)) break;
    if (!disabled.has(DASH_RULE_ID)) cells = regexPass(cells, EM_DASH_RE, dashMatchReplacement, dashRuleFor);
    if (!disabled.has(COLLAPSE_RULE[0])) cells = regexPass(cells, MULTI_SPACE_RE, () => " ", COLLAPSE_RULE);
    if (!disabled.has(SPACE_BEFORE_RULE[0])) cells = regexPass(cells, SPACE_BEFORE_PUNCT_RE, (m) => m[1], SPACE_BEFORE_RULE);
    const next = cells.map((c) => c.text).join("");
    if (next === current) break;
    current = next;
  }
  return { cleaned: current, cells, cps };
}

function cellsToEdits(cells, cps) {
  const edits = [];
  let n = 0;
  for (const c of cells) {
    if (c.rule === null) continue;
    const original = cps.slice(c.src0, c.src1).join("");
    if (original === c.text) continue;
    n += 1;
    const [ruleId, category, message] = c.rule;
    edits.push({
      id: "e" + n,
      ruleId,
      category,
      severity: "auto",
      start: c.src0,
      end: c.src1,
      original,
      replacement: c.text,
      message,
    });
  }
  return edits;
}

// --- public building blocks -------------------------------------------------

export function rebuildText(text) {
  const cps = Array.from(text);
  const cells = buildCells(cps, new Set(), protectedFlags(text));
  let changed = 0;
  for (const c of cells) {
    if (c.rule !== null && cps.slice(c.src0, c.src1).join("") !== c.text) changed++;
  }
  return { text: cells.map((c) => c.text).join(""), changed };
}

export function removeEmDashes(text) {
  const matches = text.match(EM_DASH_RE);
  const count = matches ? matches.length : 0;
  if (!count) return { text, count: 0 };
  let out = text.replace(EM_DASH_RE, (m, offset, s) => {
    const before = cpBefore(s, offset), after = cpAfter(s, offset + m.length);
    if (isNumberRangeDash(before, after)) return m; // leave a numeric range dash untouched
    return dashReplacement(before, after);
  });
  out = out.replace(MULTI_SPACE_RE, " ");
  out = out.replace(SPACE_BEFORE_PUNCT_RE, "$1");
  return { text: out, count };
}

export function applyEdits(text, acceptedIds, edits) {
  const accepted = new Set(acceptedIds);
  const chosen = edits.filter((e) => accepted.has(e.id)).sort((a, b) => b.start - a.start);
  let cps = Array.from(text);
  for (const e of chosen) {
    cps.splice(e.start, e.end - e.start, ...Array.from(e.replacement));
  }
  return cps.join("");
}

function findAiFlags(text) {
  const lowered = asciiLower(text);
  const u2cp = utf16ToCodePointMap(text);
  const raw = [];
  for (const pm of PHRASE_RES) {
    pm.re.lastIndex = 0;
    let m;
    while ((m = pm.re.exec(lowered)) !== null) {
      raw.push([m.index, m.index + m[0].length, pm.id, pm.text]);
      if (m[0].length === 0) pm.re.lastIndex++;
    }
  }
  for (const w of ENUMERATORS) {
    const re = new RegExp("\\b" + escapeRe(w.text) + "\\b", "g");
    let m;
    while ((m = re.exec(lowered)) !== null) {
      raw.push([m.index, m.index + m[0].length, w.id, w.text]);
    }
  }
  // sort/greedy in UTF-16 space (BMP phrases -> identical ordering to code points)
  raw.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
  const chosen = [];
  let reached = 0;
  for (const [s, e, rid, matched] of raw) {
    if (s >= reached) {
      chosen.push({ ruleId: rid, start: u2cp[s], end: u2cp[e], text: sliceUtf16(text, s, e), matched });
      reached = e;
    }
  }
  return chosen;
}

function sliceUtf16(text, a, b) {
  return text.slice(a, b);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findAiSpans(text) {
  return findAiFlags(text).map((f) => [f.start, f.end]);
}

// Non-overlapping substring count (Python str.count semantics).
function countOccurrences(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

function splitWords(s) {
  return s.split(/[ \t\n\r\f\v]+/).filter(Boolean);
}

// Split on whitespace after . ! or ?, without a lookbehind (Safari < 16.4
// treats an unsupported lookbehind literal as a syntax error). Same result as
// Python re.split(r"(?<=[.!?])\s+").
function splitSentences(text) {
  const out = [];
  const re = /([.!?])([ \t\n\r\f\v]+)/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(start, m.index + 1));
    start = m.index + m[0].length;
  }
  out.push(text.slice(start));
  return out;
}

export function analyzeAiSignals(text) {
  const stripped = engineStrip(text);
  if (!stripped) return { status: "empty" };
  const words = stripped.match(WORD_RE) || [];
  const strippedLen = codePointLength(stripped); // code points, to match Python len()
  if (strippedLen < MIN_CHARS || words.length < MIN_WORDS) {
    return { status: "too_short" };
  }

  let score = 0;
  const signals = [];
  const lowered = asciiLower(stripped);

  const dashCount =
    countOccurrences(stripped, "—") +
    countOccurrences(stripped, "–") +
    countOccurrences(stripped, "―");
  const dashRate = (dashCount / strippedLen) * 1000;
  if (dashRate > 3) {
    score += 25;
    signals.push({ id: "signal.dash-density", points: 25, message: `Heavy em-dash use (${dashCount} dashes)` });
  } else if (dashRate > 1.2) {
    score += 12;
    signals.push({ id: "signal.dash-density", points: 12, message: `Frequent em-dash use (${dashCount} dashes)` });
  }

  // Whole-word, so "landscape" is not counted inside "landscapers". Same matcher
  // the flags use, so the score and the highlights agree on what is a phrase. One
  // scan per phrase (count once), not a filter pass plus a separate count pass.
  const found = [];
  let occurrences = 0;
  for (const pm of PHRASE_RES) {
    const n = (lowered.match(pm.re) || []).length;
    if (n > 0) { found.push(pm.text); occurrences += n; }
  }
  if (found.length) {
    const pts = Math.min(30, 10 * found.length);
    score += pts;
    const shown = found.slice(0, 4).map((p) => `"${p}"`).join(", ");
    const extra = found.length > 4 ? ` and ${found.length - 4} more` : "";
    signals.push({ id: "signal.stock-phrases", points: pts, message: `AI-associated wording: ${shown}${extra} (${occurrences} occurrence(s))` });
  }

  const contractions = countMatches(stripped, CONTRACTION_RE);
  if (words.length >= 120 && (contractions / words.length) * 100 < 0.5) {
    score += 10;
    signals.push({ id: "signal.contractions", points: 10, message: "Almost no contractions (stiff, formal tone)" });
  }

  const sentences = splitSentences(stripped).filter((s) => splitWords(s).length >= 3);
  if (sentences.length >= 6) {
    const lengths = sentences.map((s) => splitWords(s).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, n) => a + (n - mean) * (n - mean), 0) / lengths.length;
    if (mean && Math.sqrt(variance) / mean < 0.35) {
      score += 15;
      signals.push({ id: "signal.sentence-uniformity", points: 15, message: "Unusually uniform sentence lengths" });
    }
  }

  const triads = countMatches(stripped, RULE_OF_THREE_RE);
  if (triads >= 3) {
    score += 12;
    signals.push({ id: "signal.rule-of-three", points: 12, message: `Frequent rule-of-three lists (${triads} triads)` });
  } else if (triads === 2) {
    score += 6;
    signals.push({ id: "signal.rule-of-three", points: 6, message: "Some rule-of-three phrasing" });
  }

  const markdownHits = countMatches(text, MARKDOWN_RE);
  if (markdownHits >= 2) {
    score += 10;
    signals.push({ id: "signal.markdown-artifacts", points: 10, message: `Markdown left in the text (${markdownHits} marks), a sign of a paste from a chat window` });
  } else if (markdownHits === 1) {
    score += 5;
    signals.push({ id: "signal.markdown-artifacts", points: 5, message: "A markdown mark left in the text" });
  }

  let enumHits = 0;
  for (const w of ENUMERATORS) {
    enumHits += countMatches(lowered, new RegExp("\\b" + escapeRe(w.text) + "\\b", "g"));
  }
  const markerHits = countMatches(text, LIST_MARKER_RE);
  const listSignal = enumHits + markerHits;
  if (listSignal >= 4) {
    score += 12;
    signals.push({ id: "signal.list-structure", points: 12, message: "Heavily list-structured (enumerators / bullets)" });
  } else if (listSignal >= 2) {
    score += 6;
    signals.push({ id: "signal.list-structure", points: 6, message: "Somewhat list-structured" });
  }

  score = Math.min(score, 100);
  const level = score >= LEVEL_HIGH ? "high" : score >= LEVEL_MODERATE ? "moderate" : "low";
  return { status: "ok", score, level, signals };
}

// Convert a CleanResult's code-point offsets to UTF-16 for DOM hosts. Returns a
// shallow copy with start/end on edits and flags remapped; input.length and
// cleaned.length are left as code-point lengths (they describe the strings).
export function toUtf16Offsets(result, inputText) {
  const map = utf16ToCodePointMap(inputText);
  const inv = new Array(map[inputText.length] + 1);
  for (let u = 0; u <= inputText.length; u++) {
    if (inv[map[u]] === undefined) inv[map[u]] = u;
  }
  inv[map[inputText.length]] = inputText.length;
  const remap = (arr) => arr.map((x) => ({ ...x, start: inv[x.start], end: inv[x.end] }));
  return {
    ...result,
    offsetUnit: "utf16CodeUnit",
    edits: remap(result.edits),
    flags: remap(result.flags),
  };
}

export function clean(text, options = {}) {
  const rules = options.rules || {};
  const disabled = new Set(rules.disable || []);
  const custom = rules.customPhrases || [];

  const { cleaned, cells, cps } = cleanCells(text, disabled);
  const edits = cellsToEdits(cells, cps);

  let flagHits = findAiFlags(text);
  if (custom.length) {
    const lowered = asciiLower(text);
    const u2cp = utf16ToCodePointMap(text);
    for (const phrase of custom) {
      const needle = asciiLower(phrase);
      if (!needle) continue;
      let start = lowered.indexOf(needle);
      while (start !== -1) {
        flagHits.push({
          ruleId: "ai-custom." + needle.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
          start: u2cp[start],
          end: u2cp[start + needle.length],
          text: text.slice(start, start + needle.length),
          matched: needle,
        });
        start = lowered.indexOf(needle, start + needle.length);
      }
    }
    flagHits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const deduped = [];
    let reached = 0;
    for (const h of flagHits) {
      if (h.start >= reached) {
        deduped.push(h);
        reached = h.end;
      }
    }
    flagHits = deduped;
  }

  const flags = [];
  let fn = 0;
  for (const h of flagHits) {
    if (disabled.has(h.ruleId)) continue;
    fn += 1;
    flags.push({
      id: "f" + fn,
      ruleId: h.ruleId,
      category: "ai-wording",
      severity: "suggest",
      start: h.start,
      end: h.end,
      text: h.text,
      replacement: null,
      message: "AI-associated wording",
    });
  }

  const report = analyzeAiSignals(text);
  // Count the characters an edit actually CONSUMED, not the rule that fired.
  //
  // Attributing by ruleId undercounts: a broader rule can swallow a span that
  // contained invisible characters. " <ZWSP> " is collapsed by space.collapse,
  // which removed the zero-width space while reporting hidden: 0. Since no
  // replacement ever contains an invisible or look-alike character, counting
  // them in `original` is exact regardless of which rule did the removing.
  const countConsumed = (pred) => {
    let n = 0;
    for (const e of edits) {
      for (const ch of e.original) if (pred(ch.codePointAt(0))) n += 1;
    }
    return n;
  };
  const invisibleN = countConsumed((cp) => invisibleRule(cp) !== null);
  const oddSpaceN = countConsumed(isOddSpace);
  // Dashes count by consumed CHARACTER too: with the fixed-point dash pass, a
  // chain like "—– " merges into one edit that removed two dashes.
  const isDashCp = (cp) => cp === 0x2014 || cp === 0x2015 || cp === 0x2013;
  const dashesN = countConsumed(isDashCp);
  // Same measured-by-consumption rule as the others: a confusable left inside a
  // genuinely Cyrillic word is never consumed, so it is never counted.
  const homoglyphsN = countConsumed((cp) => CONFUSABLES.has(cp));
  const typographyN = countConsumed((cp) => TYPOGRAPHY.has(cp));
  const cpLen = Array.from(text).length;

  return {
    engineVersion: ENGINE_VERSION,
    rulesetVersion: RULESET_VERSION,
    offsetUnit: "codePoint",
    input: { length: cpLen },
    cleaned: { text: cleaned, length: Array.from(cleaned).length },
    edits,
    flags,
    aiReport: report,
    summary: {
      invisible: invisibleN,
      oddSpaces: oddSpaceN,
      dashes: dashesN,
      homoglyphs: homoglyphsN,
      typography: typographyN,
      // hidden keeps its original meaning (invisible + look-alike spaces),
      // because callers show it as "stripped N hidden characters".
      hidden: invisibleN + oddSpaceN,
      flagged: flags.length,
    },
  };
}
