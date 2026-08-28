// Seeded parity fuzzer: generate random strings from a stress alphabet and
// assert JS clean() === Python clean() plus the structural invariants. Seeded
// so any failure is reproducible.
//
//   node packages/js/test/fuzz.mjs [count] [seed]
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { clean, applyEdits } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const COUNT = Number(process.argv[2] || 4000);
let seed = Number(process.argv[3] || 12345) >>> 0;

// mulberry32 PRNG (reproducible)
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// stress alphabet: everything the engine reasons about
const CHARS = [
  "a", "b", "c", "z", "I", "A", "Q", " ", "  ", "\t", ",", ".", ";", ":", "!", "?",
  "\n", "'", "-", "0", "5", "9", "(", ")", "[", "]", "\"",
  "—", "–", "―",                     // dashes
  "​", "‌", "‍", "‎", "‏", // zero-width / bidi marks
  "‪", "‮", "⁠", "⁤", "﻿", "­", "᠎", // invisibles
  " ", " ", " ", " ", "　", // look-alike spaces
  "İ", "ẞ", "Ｄ",                     // length-drift / fullwidth traps
  "😀", "🌀",                   // astral emoji
  "󠁁",                                   // astral tag-block invisible
  "delve", "tapestry", "rich tapestry", "firstly", "moreover",
  "it's important to note", "game changer", "game-changer",
];

const items = [];
for (let i = 0; i < COUNT; i++) {
  const len = Math.floor(rand() * 14);
  let s = "";
  for (let j = 0; j < len; j++) s += pick(CHARS);
  const opt =
    rand() < 0.15
      ? { rules: { disable: [pick(["dash.spaced", "space.lookalike", "invisible.zero-width", "space.collapse", "punct.space-before"])] } }
      : rand() < 0.1
      ? { rules: { customPhrases: [pick(["circle back", "touch base", "delve"])] } }
      : undefined;
  items.push(opt ? { input: s, options: opt } : { input: s });
}

const inPath = join(tmpdir(), `fetchit-fuzz-${seed}.json`);
writeFileSync(inPath, JSON.stringify(items));

const pyRaw = execFileSync("python", [join(root, "py", "parity_emit.py"), inPath], {
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
const py = JSON.parse(pyRaw);

function stable(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
  return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}";
}

let failures = 0;
for (let i = 0; i < items.length; i++) {
  const js = clean(items[i].input, items[i].options);
  const again = clean(js.cleaned.text, items[i].options);
  if (again.cleaned.text !== js.cleaned.text) {
    failures++;
    console.log(`FAIL not idempotent  [case ${i}] ${JSON.stringify(items[i].input).slice(0, 80)}`);
  }
  if (stable(js) !== stable(py[i])) {
    failures++;
    if (failures <= 5) {
      console.log(`DIVERGE #${i} input=${JSON.stringify(items[i].input)} opt=${JSON.stringify(items[i].options)}`);
      console.log("  JS:", stable(js).slice(0, 400));
      console.log("  PY:", stable(py[i]).slice(0, 400));
    }
    continue;
  }
  const applied = applyEdits(items[i].input, js.edits.map((e) => e.id), js.edits);
  if (applied !== js.cleaned.text) {
    failures++;
    if (failures <= 5) console.log(`APPLY!=CLEAN #${i} input=${JSON.stringify(items[i].input)}`);
  }
}

console.log("");
if (failures === 0) {
  console.log(`FUZZ OK  ${COUNT} random cases (seed ${process.argv[3] || 12345}), JS === PY, invariants hold`);
  process.exit(0);
} else {
  console.log(`FUZZ FAILED  ${failures}/${COUNT} diverged (seed ${process.argv[3] || 12345})`);
  process.exit(1);
}
