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
const localReview = JSON.parse(readFileSync(join(here, "..", "js", "review", "package.json"), "utf8")).version;
const localPy = readFileSync(join(here, "..", "py", "pyproject.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];

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

if (new Set([localEngine, localReview, localPy]).size !== 1) {
  console.log("LOCKSTEP BROKEN: local manifest versions differ.");
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
