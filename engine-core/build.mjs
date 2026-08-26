// Copies the single-source ruleset.json into both language packages.
// engine-core/ruleset.json is the ONLY hand-edited copy; run this after changing
// it so the packages stay in lockstep.
//   node engine-core/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "ruleset.json");
const raw = readFileSync(src, "utf8");
JSON.parse(raw); // fail loudly if the source is not valid JSON

// Python reads the JSON directly (fs is always available there).
const pyTarget = join(here, "..", "py", "fetchit_engine", "ruleset.json");
writeFileSync(pyTarget, raw);
console.log("wrote", pyTarget);

// JS inlines the ruleset as an ESM module so it needs no JSON import attributes
// and works unchanged in browsers, bundlers, Node, Deno, and Bun.
const jsTarget = join(here, "..", "js", "src", "ruleset.data.js");
const banner = "// GENERATED from engine-core/ruleset.json by build.mjs. Do not edit.\n";
writeFileSync(jsTarget, banner + "export default " + JSON.stringify(JSON.parse(raw)) + ";\n");
console.log("wrote", jsTarget);

console.log("ruleset in lockstep");
