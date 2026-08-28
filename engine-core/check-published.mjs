// Answers ONE question from the registries themselves: are the local package
// versions actually published? Never trust memory (anyone's) about publish
// state; run this.
//
//   node packages/engine-core/check-published.mjs        (private repo)
//   node engine-core/check-published.mjs                 (public repo)
//
// Exit 0: every local version is live on its registry. Exit 1: something is
// unpublished or the registries disagree with the working tree.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const localEngine = JSON.parse(readFileSync(join(here, "..", "js", "package.json"), "utf8")).version;
const reviewPkg = JSON.parse(readFileSync(join(here, "..", "js", "review", "package.json"), "utf8"));
const localReview = reviewPkg.version;
const localPy = readFileSync(join(here, "..", "py", "pyproject.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];

// Minimal semver-satisfies for the plain a.b.c versions and simple ranges this
// project uses (^a.b.c, and space-joined >=/<=/</>/exact tokens). Exists
// because @fetchitai/review@0.2.0 shipped with peer "^0.1.2" while the engine
// moved to 0.2.0, which made co-installing the two fail with ERESOLVE for
// every user. The lockstep bump must include the peer range, and this check
// makes forgetting that loud.
function parseV(v) {
  return v.split(".").map(Number);
}
function cmpV(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function satisfies(version, range) {
  const v = parseV(version);
  return range.trim().split(/\s+/).every((tok) => {
    if (tok.startsWith("^")) {
      const base = parseV(tok.slice(1));
      if (cmpV(v, base) < 0) return false;
      const up = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
      return cmpV(v, up) < 0;
    }
    if (tok.startsWith(">=")) return cmpV(v, parseV(tok.slice(2))) >= 0;
    if (tok.startsWith("<=")) return cmpV(v, parseV(tok.slice(2))) <= 0;
    if (tok.startsWith("<")) return cmpV(v, parseV(tok.slice(1))) < 0;
    if (tok.startsWith(">")) return cmpV(v, parseV(tok.slice(1))) > 0;
    return cmpV(v, parseV(tok)) === 0;
  });
}

async function npmInfo(name) {
  const r = await fetch("https://registry.npmjs.org/" + encodeURIComponent(name));
  if (!r.ok) throw new Error(name + ": registry HTTP " + r.status);
  const j = await r.json();
  return { latest: j["dist-tags"].latest, versions: Object.keys(j.versions) };
}

async function pypiInfo(name) {
  const r = await fetch("https://pypi.org/pypi/" + name + "/json");
  if (!r.ok) throw new Error(name + ": PyPI HTTP " + r.status);
  const j = await r.json();
  return { latest: j.info.version, versions: Object.keys(j.releases) };
}

let bad = 0;
function report(label, local, info) {
  const published = info.versions.includes(local);
  const isLatest = info.latest === local;
  const status = !published ? "NOT PUBLISHED" : isLatest ? "published, latest" : "published, but latest is " + info.latest;
  if (!published || !isLatest) bad++;
  console.log(
    label.padEnd(22) + "local " + local.padEnd(9) + "registry latest " + info.latest.padEnd(9) + status,
  );
}

try {
  report("@fetchitai/engine", localEngine, await npmInfo("@fetchitai/engine"));
  report("@fetchitai/review", localReview, await npmInfo("@fetchitai/review"));
  report("fetchit-engine", localPy, await pypiInfo("fetchit-engine"));
} catch (e) {
  console.log("CHECK FAILED (network or registry error): " + e.message);
  process.exit(2);
}

// Lockstep: engine (js) and py are the same artifact in two languages and
// must match exactly. review tracks the same major.minor but may take its own
// patches (0.2.1 exists only because 0.2.0 shipped a broken peer range).
if (localEngine !== localPy) {
  console.log("LOCKSTEP BROKEN: @fetchitai/engine " + localEngine + " != fetchit-engine " + localPy);
  bad++;
}
if (parseV(localReview)[0] !== parseV(localEngine)[0] || parseV(localReview)[1] !== parseV(localEngine)[1]) {
  console.log("LOCKSTEP BROKEN: review " + localReview + " is not on the engine's " + localEngine + " major.minor line.");
  bad++;
}
const peerRange = (reviewPkg.peerDependencies || {})["@fetchitai/engine"];
if (!peerRange) {
  console.log("PEER RANGE MISSING: review declares no @fetchitai/engine peer dependency.");
  bad++;
} else if (!satisfies(localEngine, peerRange)) {
  console.log(
    "PEER RANGE BROKEN: review's peer @fetchitai/engine \"" + peerRange +
    "\" does not accept the local engine " + localEngine + ". Co-install will ERESOLVE.",
  );
  bad++;
}

console.log("");
if (bad === 0) {
  console.log("PUBLISH STATE OK: everything local is live on the registries.");
  process.exit(0);
} else {
  console.log("ACTION NEEDED: the owner publishes (npm OTP / PyPI token), from fetchit-engine/:");
  console.log("  cd js            then: npm publish --access public");
  console.log("  cd js/review     then: npm publish --access public");
  console.log("  cd py            then: python -m build   then: python -m twine upload dist/<the new files>");
  process.exit(1);
}
