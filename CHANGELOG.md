# Changelog

Two things are versioned here, and they move independently:

- **Engine version** is the package version (`@fetchitai/engine`, `fetchit-engine`).
  It follows semver and is kept in lockstep across both languages: npm 1.4.0 and
  pip 1.4.0 behave identically.
- **Ruleset version** (`rulesetVersion`, a date) covers the AI phrase list, the
  enumerators, the character ranges, and the scoring thresholds. Scores and flags
  are only comparable within one ruleset version, which is why every result
  carries the stamp.

## Unreleased

Nothing yet.

## @fetchitai/review 0.2.1

**Fixed: the peer dependency range excluded the matching engine.** review
0.2.0 shipped with peer `@fetchitai/engine: "^0.1.2"`, so installing it next
to engine 0.2.0 failed with ERESOLVE for every user. The range is now
`>=0.1.2 <1.0.0`, which accepts every 0.x engine, so a lockstep engine bump
can no longer strand the widget. No code changes; do not use review 0.2.0.
Caught by clean-install verification minutes after publish;
`engine-core/check-published.mjs` now validates the peer range against the
local engine version so this class of mistake is loud before publishing.

## 0.2.0 - ruleset 2026-08-18

**Changed: clause dashes are now replaced with a comma, not a space.** The
`dash.spaced` rule (em dashes and horizontal bars in any spacing, en dashes
when spaced on both sides) replaces the matched dash run with `", "`, which is
how a human editor usually rewrites an em dash: `"The results—which
surprised everyone—came late."` cleans to
`"The results, which surprised everyone, came late."`. The comma is withheld,
falling back to the old single space, wherever a comma cannot sit: at a text
or line boundary, next to punctuation or a bracket it would double up against,
next to a dash the match could not consume, or between digits, where the dash
is a range rather than a pause (`"pages 12—14"` still cleans to
`"pages 12 14"`, and unspaced en dash ranges like `2019–2024` remain
untouched). Before a line break the comma hugs the word (`"line one—\nline
two"` cleans to `"line one,\nline two"`). Edit messages distinguish the two
outcomes ("Replaced a dash with a comma" / "Replaced a spaced dash with a
space"); the rule id is unchanged, so existing `rules.disable` lists keep
working.

**Changed: a run of em dashes is one match.** `"wait——what"` produces one edit
and one comma instead of two space edits. `removeEmDashes()` /
`remove_em_dashes()` count matched dash groups, apply the same comma logic,
and keep their `(text, count)` shape.

Idempotency, byte parity, and the measured summary counts all hold: verified
over the 45 parity vectors and 24,000 fuzz cases across six seeds in both
languages, with digits, brackets, and quotes added to the fuzz alphabet to
exercise the new context decisions. Eleven vectors cover the comma behavior,
including astral-plane characters adjacent to a dash (a UTF-16 surrogate trap
the JS side now decodes explicitly).

**`@fetchitai/review` 0.2.0:** no changes; version moves in lockstep.

## 0.1.2 - ruleset 2026-08-18

**Fixed: `clean()` was not idempotent on dash chains.** The dash/space passes
ran once, so removing an em dash could manufacture the spacing that arms the
spaced-en-dash rule for the NEXT clean: `"X—– Y"` cleaned to `"X – Y"`, and only a
second clean reached `"X Y"`. That broke the documented
`clean(clean(x)) === clean(x)` contract that makes unattended pipeline use
safe. The passes now run to a fixed point, so one clean finishes the job.
Found by an empirical idempotency sweep during a full repo audit; 28 of 531
generated cases failed before the fix, zero after (verified across 20,000
fuzz cases on five seeds, in both languages).

**Changed: `summary.dashes` counts removed dash characters**, consistent with
the 0.1.1 rule that counts measure consumed characters rather than edit
records. A merged chain edit that removed two dashes now reports 2.

**`@fetchitai/review` 0.1.2:** the internal HTML escaper now escapes quotes as
well. No interpolation reaches an attribute today, so this changes nothing
observable; it exists so a future attribute interpolation cannot become an
XSS.

**Harness:** idempotency is now a standing invariant in the parity gate, the
fuzzer, and the Python checks, alongside a dashes-removed check measured
against input and output. Three dash-chain vectors added (34 total).

## 0.1.1 - ruleset 2026-08-18

Patch release. Cleaning behaviour is unchanged; only the reported counts move.

**Fixed: `summary` under-reported removed characters.**

Counts were attributed by which rule fired, so a broader rule that swallowed a
span hid what was inside it. `" <ZWSP> "` is collapsed by `space.collapse`,
which removed the zero-width space while reporting `invisible: 0` and
`hidden: 0`. `summary.hidden` is the number a caller shows a user ("stripped N
hidden characters"), so it could claim nothing was stripped when something was.

Counts are now taken from the characters each edit actually consumed, which is
exact regardless of which rule did the removing. Both engines had the bug
identically, which is why cross-language parity never caught it.

**Also:** the parity harness and the standalone Python checks now verify the
summary against the input and the output rather than re-deriving it from the
edit list. The old check re-implemented the engine's own attribution, so it
agreed with the engine even when both were wrong. Four vectors cover invisible
and look-alike characters adjacent to spaces.

## 0.1.0 - ruleset 2026-08-18

First public release.

**Engine**

- `clean(text, options?)` returns the full CleanResult: `edits` (deterministic,
  `severity: "auto"`), `flags` (AI wording, `severity: "suggest"`), `aiReport`
  with structured signals, and `summary` counts.
- Applying every edit reproduces `cleaned.text` exactly, and `rules.disable`
  genuinely skips a rule so the text and the edit list can never disagree.
- Offsets are code points in both languages. `toUtf16Offsets()` converts for DOM
  hosts.
- Also exported: `applyEdits`, `rebuildText`, `removeEmDashes`, `findAiSpans`,
  `analyzeAiSignals`.
- Python adds `spell_core` behind the optional `[spell]` extra: structured
  misspellings and ranked suggestions, shaped like engine flags.

**Ruleset 2026-08-18**

- 65 AI-associated phrases and 9 enumerators, each with a stable rule id.
- 9 invisible character ranges (zero width, bidi controls, soft hyphen, byte
  order mark, the Unicode tag block, and more) and 5 look-alike space ranges.
- Thresholds: 200 characters and 40 words minimum for a score; band cutoffs at
  20 and 45.

**Parity**

- `engine-core/vectors.json` holds 27 vectors that must produce identical results
  in both languages, plus a seeded fuzzer run across 80,000 or more random cases
  with no divergence.
- Four parity traps are fixed and regression tested: lowercase round-trip drift,
  the code point versus UTF-16 offset split, `.trim()` and `.strip()` disagreeing
  on U+FEFF, and Python's Unicode `\b` / `\d` / `\s` versus JavaScript's ASCII
  defaults.

**`@fetchitai/review` 0.1.0**

- `<fetchit-review>` web component, shadow DOM, themeable through `--fr-*` custom
  properties. Per category accept and reject with live rescoring, hand edit mode,
  and `onApply(finalText, receipt)`.
- A small "Powered by Fetch It AI" badge is shown by default and hidden with
  `badge: false`.

**License**

- Apache-2.0. Free for everyone, commercial use included. An earlier draft of
  this project carried PolyForm Noncommercial to support a paid commercial tier;
  that tier was dropped before any release, so the restriction went with it.
  Nothing was ever published under the old terms.
