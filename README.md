# Fetch It AI engine

Deterministic text cleanup and AI writing tells, as a library you run inside your
own process. It strips the invisible characters and look-alike spaces that
survive a copy and paste out of an AI chat, swaps clause em dashes for natural
commas, and flags the wording that commonly reads as AI written.

**Your users' text never leaves your process.** There is no network call, no API
key for the core, and no model. The engine is a set of pure functions.

```js
import { clean, applyEdits } from "@fetchitai/engine";

const result = clean(aiDraft);
// result.edits     deterministic fixes, safe to apply unattended
// result.flags     wording that reads as AI written, for a human to judge
// result.aiReport  the tells score, with structured signals

const finalText = applyEdits(aiDraft, acceptedIds, result.edits);
```

```python
from fetchit_engine import clean

r = clean(ai_draft, mode="auto")   # unattended: applies "auto" edits only
publish(r.cleaned.text)
audit_log.write(r.to_json())       # machine-readable receipt of every change
```

## Install

```bash
npm install @fetchitai/engine
pip install fetchit-engine
```

The optional Python spellcheck extra: `pip install "fetchit-engine[spell]"`.

## What is in here

| Path | What it is |
| --- | --- |
| `engine-core/` | The single source of truth: `ruleset.json` and the `vectors.json` parity contract |
| `js/` | `@fetchitai/engine` (npm). ESM, zero dependencies, TypeScript types |
| `js/review/` | `@fetchitai/review`, a drop-in browser review panel |
| `py/` | `fetchit-engine` (pip). Pure standard library |

## The design, in four claims

**One engine, two languages, held in lockstep.** `engine-core/vectors.json` is a
set of inputs whose results must be byte identical in JavaScript and Python. It
runs in both test suites and it *is* the cross-language contract. npm 1.4.0 and
pip 1.4.0 behave identically, by test rather than by intention.

**Severity is the safety model.** `auto` edits (invisible characters, look-alike
spaces, dash policy) are deterministic, meaning preserving, and idempotent, so
they are safe to apply with no human present. `suggest` flags (AI wording) are
never auto-applied, because the engine has no rewrite to offer and pretending
otherwise would make the human review step theater.

**Offsets are pinned and explicit.** Every edit and flag carries code point
offsets, so Python and JavaScript agree even on astral text such as emoji.
Browser hosts painting into the DOM call `toUtf16Offsets(result, inputText)`.

**Every change is logged.** `clean()` returns a record of each individual edit
with its rule id, its offsets, and the exact original and replacement, so the
result doubles as an audit trail. Applying every edit reproduces `cleaned.text`
exactly.

## What it deliberately does not do

- **It does not rewrite your sentences.** AI wording is flagged, never replaced.
- **It is not an AI detector.** The tells score is a curated English heuristic:
  a tally of wording and structure, not a probability that a machine wrote
  something. Good human writers trip it. Treat it as a hint about how generic
  the prose reads.
- **It does not remove watermarks.** Rebuilding text strips invisible characters
  that survive a copy and paste. Statistical watermarks such as SynthID live in
  word choice, not in stray characters, and this cannot touch them.

## Running the parity gate

```bash
node js/test/parity.mjs     # JS === Python across every vector, plus invariants
node js/test/fuzz.mjs       # seeded random cases, both engines compared
python py/test_parity.py    # Python-side invariants, no Node needed
python py/test_spell.py     # spell_core (needs the [spell] extra for a full run)
```

After editing `engine-core/ruleset.json`, rebuild it into both packages:

```bash
node engine-core/build.mjs
```

## License

**Apache-2.0** (see `LICENSE`). Free for everyone, including commercial use,
with no separate license to buy and nothing to sign.
