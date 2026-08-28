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

export const ENGINE_VERSION = "0.1.2";
export const RULESET_VERSION = ruleset.rulesetVersion;

const PHRASES = ruleset.phrases;
const ENUMERATORS = ruleset.enumerators;
const INVISIBLE_RANGES = ruleset.invisibleRanges;
const ODD_SPACE_RANGES = ruleset.oddSpaceRanges;
const ODD_SPACE_RULE_ID = ruleset.oddSpaceRuleId;
const ODD_SPACE_LABEL = ruleset.oddSpaceLabel;
export const MIN_CHARS = ruleset.thresholds.MIN_CHARS;
export const MIN_WORDS = ruleset.thresholds.MIN_WORDS;
const LEVEL_MODERATE = ruleset.thresholds.levelModerate;
const LEVEL_HIGH = ruleset.thresholds.levelHigh;

// Regexes that are logic, not data (mirror text_tools.py; may contain dashes).
const EM_DASH_RE = /[ \t]*[—―][ \t]*|[ \t]+–[ \t]+/g;
const MULTI_SPACE_RE = /[ \t]{2,}/g;
const SPACE_BEFORE_PUNCT_RE = /[ \t]+([,.;:!?])/g;
// Whitespace classes are written out as ASCII [ \t\n\r\f\v] rather than \s so
// they match Python's re.ASCII \s exactly; JS \s otherwise also matches Unicode
// spaces, which Python (ASCII) would not. \b and \d are already ASCII in JS.
const RULE_OF_THREE_RE = /\b[A-Za-z]+,[ \t\n\r\f\v]+[A-Za-z]+,[ \t\n\r\f\v]+and[ \t\n\r\f\v]+[A-Za-z]+\b/gi;
const LIST_MARKER_RE = /^[ \t\n\r\f\v]*(?:[-*•·]|\d+[.)])[ \t\n\r\f\v]+/gm;
const CONTRACTION_RE = /\b[A-Za-z]+'(?:t|s|re|ve|ll|d|m)\b/gi;
const WORD_RE = /[A-Za-z']+/g;

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

const DASH_RULE = ["dash.spaced", "dash", "Replaced a spaced dash with a space"];
const COLLAPSE_RULE = ["space.collapse", "space", "Collapsed repeated spaces"];
const SPACE_BEFORE_RULE = ["punct.space-before", "space", "Removed a space before punctuation"];

const RULE_PRIORITY = {
  "dash.spaced": 40,
  "space.lookalike": 30,
  "space.collapse": 20,
  "punct.space-before": 15,
};

// Lowercase only A-Z: length- and position-preserving, so offsets map 1:1 onto
// the input. Every rule phrase is ASCII, so this never misses a match, and it
// is identical to _ascii_lower in Python.
function asciiLower(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const o = text.charCodeAt(i);
    out += o >= 65 && o <= 90 ? String.fromCharCode(o + 32) : text[i];
  }
  return out;
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
  constructor(text, src0, src1, rule = null) {
    this.text = text; // "" for a deletion
    this.src0 = src0; // half-open code-point range in the INPUT
    this.src1 = src1;
    this.rule = rule; // [ruleId, category, message] or null
  }
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
    const merged = cells.slice(ci, cj);
    const src0 = merged[0].src0;
    const src1 = merged[merged.length - 1].src1;
    let best = rule;
    let bestPri = RULE_PRIORITY[rule[0]] || 0;
    for (const c of merged) {
      if (c.rule && (RULE_PRIORITY[c.rule[0]] || 0) > bestPri) {
        best = c.rule;
        bestPri = RULE_PRIORITY[c.rule[0]] || 0;
      }
    }
    out.push(new Cell(replacementFn(m), src0, src1, best));
    last = cj;
    if (m[0].length === 0) regex.lastIndex++; // guard against zero-width loops
  }
  for (let k = last; k < cells.length; k++) out.push(cells[k]);
  return out;
}

// Pass A: invisible removal and look-alike-space normalization, per code point.
// A disabled rule leaves its characters untouched.
function buildCells(cps, disabled) {
  const cells = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i].codePointAt(0);
    const inv = invisibleRule(cp);
    if (inv && !disabled.has(inv.id)) {
      cells.push(new Cell("", i, i + 1, [inv.id, "invisible", "Removed " + inv.label]));
    } else if (isOddSpace(cp) && !disabled.has(ODD_SPACE_RULE_ID)) {
      cells.push(new Cell(" ", i, i + 1, [ODD_SPACE_RULE_ID, "space", "Normalized a " + ODD_SPACE_LABEL]));
    } else {
      cells.push(new Cell(cps[i], i, i + 1, null));
    }
  }
  return cells;
}

function cleanCells(text, disabled) {
  const cps = Array.from(text); // code-point array
  let cells = buildCells(cps, disabled);
  let current = cells.map((c) => c.text).join("");
  // Run the dash/space passes to a FIXED POINT, not once. A single pass is not
  // idempotent: removing an em dash can manufacture the spacing that arms the
  // spaced-en-dash rule ("X—– Y" -> "X – Y", and only a second clean reached
  // "X Y"), which broke the documented clean(clean(x)) === clean(x) contract.
  // Each enabled dash pass strictly reduces the dash count, so this terminates;
  // the equality check breaks the loop when the dash rule is disabled. The
  // guard is a belt for both.
  for (let guard = 0; guard < 8; guard++) {
    EM_DASH_RE.lastIndex = 0;
    if (!EM_DASH_RE.test(current)) break;
    if (!disabled.has(DASH_RULE[0])) cells = regexPass(cells, EM_DASH_RE, () => " ", DASH_RULE);
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
  const cells = buildCells(cps, new Set());
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
  let out = text.replace(EM_DASH_RE, " ");
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
  for (const p of PHRASES) {
    const phrase = p.text;
    let start = lowered.indexOf(phrase);
    while (start !== -1) {
      raw.push([start, start + phrase.length, p.id, phrase]);
      start = lowered.indexOf(phrase, start + phrase.length);
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

  const found = PHRASES.map((p) => p.text).filter((p) => lowered.includes(p));
  if (found.length) {
    let occurrences = 0;
    for (const p of found) occurrences += countOccurrences(lowered, p);
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
      hidden: invisibleN + oddSpaceN,
      flagged: flags.length,
    },
  };
}
