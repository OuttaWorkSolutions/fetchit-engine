// Verify every page that inlines the engine consumes it correctly: the
// generated block must behave identically to @fetchitai/engine, and the
// adapters (cleanText, findAiSpans as UTF-16, analyzeAiSignals as string
// signals) must reproduce the shapes those pages' UI code depends on.
//
//   node packages/js/test/tool-inline.mjs
//
// The page list is derived from build-tool.mjs's TARGETS, so adding a page
// there without running this is impossible to miss.
import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as pkg from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

// Read the build script's TARGETS rather than repeating the list here.
const buildSrc = readFileSync(join(root, "packages", "engine-core", "build-tool.mjs"), "utf8");
const targetsBlock = buildSrc.slice(buildSrc.indexOf("const TARGETS = ["), buildSrc.indexOf("];", buildSrc.indexOf("const TARGETS = [")));
const pages = [...targetsBlock.matchAll(/"public",\s*"([^"]+)"/g)].map((m) => m[1]);
if (!pages.length) {
  console.log("FAIL: could not read TARGETS from build-tool.mjs");
  process.exit(1);
}

const vectors = JSON.parse(readFileSync(join(root, "packages", "engine-core", "vectors.json"), "utf8")).vectors;
const eq = (a, x) => JSON.stringify(a) === JSON.stringify(x);

let fails = 0;
for (const page of pages) {
  const html = readFileSync(join(root, "public", page), "utf8");
  const b = html.indexOf("const FetchitEngine");
  const e = html.indexOf("// ==== END @fetchitai/engine ====");
  if (b === -1 || e === -1) {
    console.log(`FAIL: no generated engine block in ${page}`);
    fails++;
    continue;
  }
  const block = html.slice(b, e);
  const tool = new Function(
    block + "\n;return { FetchitEngine, cleanText, findAiSpans, analyzeAiSignals };"
  )();

  let pageFails = 0;
  for (const v of vectors) {
    // 1. inlined engine === package engine (options included)
    if (!eq(tool.FetchitEngine.clean(v.input, v.options), pkg.clean(v.input, v.options))) {
      pageFails++; console.log(`FAIL inlined!=package  ${page}  ${v.name}`);
    }
    // The pages' UI never passes options, so their adapters do a full clean.
    const r = pkg.clean(v.input);
    // 2. cleanText adapter shape
    const ct = tool.cleanText(v.input);
    if (ct.text !== r.cleaned.text || ct.hidden !== r.summary.hidden || ct.dashes !== r.summary.dashes ||
        ct.homoglyphs !== r.summary.homoglyphs || ct.typography !== r.summary.typography) {
      pageFails++; console.log(`FAIL cleanText  ${page}  ${v.name}`);
    }
    // 3. findAiSpans adapter returns UTF-16 spans that slice to the same text
    const cpSpans = tool.FetchitEngine.findAiSpans(v.input);
    const u16Spans = tool.findAiSpans(v.input);
    const cps = Array.from(v.input);
    let ok = cpSpans.length === u16Spans.length;
    for (let i = 0; i < cpSpans.length && ok; i++) {
      const cpText = cps.slice(cpSpans[i][0], cpSpans[i][1]).join("");
      const u16Text = v.input.slice(u16Spans[i][0], u16Spans[i][1]);
      if (cpText !== u16Text) ok = false;
    }
    if (!ok) { pageFails++; console.log(`FAIL findAiSpans utf16  ${page}  ${v.name}`); }
    // 4. analyzeAiSignals adapter yields string signals
    const a = tool.analyzeAiSignals(v.input);
    const pa = pkg.analyzeAiSignals(v.input);
    if (a.status !== pa.status) { pageFails++; console.log(`FAIL analyze status  ${page}  ${v.name}`); }
    if (pa.status === "ok" && !eq(a.signals, pa.signals.map((s) => s.message))) {
      pageFails++; console.log(`FAIL analyze signals  ${page}  ${v.name}`);
    }
  }
  if (pageFails === 0) console.log(`  ${basename(page)}: engine === package, adapters correct`);
  fails += pageFails;
}

console.log("");
if (fails === 0) {
  console.log(`TOOL INLINE OK  ${pages.length} page(s) x ${vectors.length} vectors`);
  process.exit(0);
} else {
  console.log(`TOOL INLINE FAILED  ${fails} problem(s)`);
  process.exit(1);
}
