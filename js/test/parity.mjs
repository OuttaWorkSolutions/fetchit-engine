// Parity harness: run every vector through the JS engine and the Python engine
// and assert the two CleanResults are identical. Also checks structural
// invariants (apply-all-edits reproduces cleaned; offsets slice originals).
//
//   node packages/js/test/parity.mjs
//
// Exit 0 = parity holds, nonzero = a mismatch (printed).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clean, applyEdits } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// Read the character ranges from the single-source ruleset rather than
// re-declaring them, so the invariant cannot drift from the engine.
const rulesetData = JSON.parse(
  readFileSync(join(here, "..", "..", "engine-core", "ruleset.json"), "utf8"),
);
const INVISIBLE_RANGES = rulesetData.invisibleRanges;
const ODD_SPACE_RANGES = rulesetData.oddSpaceRanges;
const root = join(here, "..", "..");
const vectors = JSON.parse(readFileSync(join(root, "engine-core", "vectors.json"), "utf8")).vectors;

// canonical stable stringify (sorted keys) so key order never causes a false diff
function stable(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
  return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}";
}

// First diverging path between two values, for a readable failure message.
function firstDiff(a, b, path = "") {
  if (stable(a) === stable(b)) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return `${path}: JS=${JSON.stringify(a)} PY=${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array/non-array`;
    if (a.length !== b.length) return `${path}.length: JS=${a.length} PY=${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return `${path}: differ`;
}

// Python side
const pyRaw = execFileSync("python", [join(root, "py", "parity_emit.py")], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const pyResults = JSON.parse(pyRaw);

let failures = 0;
vectors.forEach((v, i) => {
  const js = clean(v.input, v.options);
  const py = pyResults[i];
  const diff = firstDiff(js, py);
  if (diff) {
    failures++;
    console.log(`FAIL parity  [${v.name}]  ${diff}`);
  }

  // invariant: accepting every edit reproduces cleaned.text
  const applied = applyEdits(v.input, js.edits.map((e) => e.id), js.edits);
  if (applied !== js.cleaned.text) {
    failures++;
    console.log(`FAIL applyEdits(all)!=cleaned  [${v.name}]`);
  }

  // invariant: edit offsets are code points that slice the original text
  const cps = Array.from(v.input);
  for (const e of js.edits) {
    if (cps.slice(e.start, e.end).join("") !== e.original) {
      failures++;
      console.log(`FAIL edit offset not codepoint  [${v.name}] ${e.id}`);
      break;
    }
  }
  // invariant: flag offsets are code points that slice the original text
  for (const f of js.flags) {
    if (cps.slice(f.start, f.end).join("") !== f.text) {
      failures++;
      console.log(`FAIL flag offset not codepoint  [${v.name}] ${f.id}`);
      break;
    }
  }

  // invariant: cleaning is idempotent, as the README promises. A single-pass
  // pipeline broke this: removing an em dash could arm the spaced-en-dash rule
  // for the NEXT clean ("X—– Y").
  const again = clean(js.cleaned.text, v.options);
  if (again.cleaned.text !== js.cleaned.text) {
    failures++;
    console.log(`FAIL not idempotent  [${v.name}] ${JSON.stringify(js.cleaned.text)} -> ${JSON.stringify(again.cleaned.text)}`);
  }

  // invariant: the summary accounts for every character actually removed.
  //
  // This is measured against the input and the output rather than against the
  // edit list, so it cannot be satisfied by whichever rule happened to fire.
  // Both engines once reported hidden: 0 for " <ZWSP> " because space.collapse
  // swallowed the span, and a cross-engine diff could never catch it: they were
  // wrong in exactly the same way. This invariant would have.
  const countIn = (s, pred) => {
    let n = 0;
    for (const ch of s) if (pred(ch.codePointAt(0))) n += 1;
    return n;
  };
  const isInvisibleCp = (cp) => INVISIBLE_RANGES.some((r) => cp >= r.min && cp <= r.max);
  const isOddSpaceCp = (cp) => ODD_SPACE_RANGES.some((r) => cp >= r.min && cp <= r.max);

  const invisibleRemoved =
    countIn(v.input, isInvisibleCp) - countIn(js.cleaned.text, isInvisibleCp);
  const oddSpacesRemoved =
    countIn(v.input, isOddSpaceCp) - countIn(js.cleaned.text, isOddSpaceCp);

  if (js.summary.invisible !== invisibleRemoved) {
    failures++;
    console.log(
      `FAIL summary.invisible  [${v.name}] reported ${js.summary.invisible}, actually removed ${invisibleRemoved}`,
    );
  }
  if (js.summary.oddSpaces !== oddSpacesRemoved) {
    failures++;
    console.log(
      `FAIL summary.oddSpaces  [${v.name}] reported ${js.summary.oddSpaces}, actually removed ${oddSpacesRemoved}`,
    );
  }
  const isDashCp = (cp) => cp === 0x2014 || cp === 0x2015 || cp === 0x2013;
  const dashesRemoved = countIn(v.input, isDashCp) - countIn(js.cleaned.text, isDashCp);
  if (js.summary.dashes !== dashesRemoved) {
    failures++;
    console.log(`FAIL summary.dashes  [${v.name}] reported ${js.summary.dashes}, actually removed ${dashesRemoved}`);
  }
  if (js.summary.hidden !== invisibleRemoved + oddSpacesRemoved) {
    failures++;
    console.log(
      `FAIL summary.hidden  [${v.name}] reported ${js.summary.hidden}, actually removed ${invisibleRemoved + oddSpacesRemoved}`,
    );
  }
});

console.log("");
if (failures === 0) {
  console.log(`PARITY OK  ${vectors.length} vectors, JS === PY, invariants hold`);
  process.exit(0);
} else {
  console.log(`PARITY FAILED  ${failures} problem(s) across ${vectors.length} vectors`);
  process.exit(1);
}
