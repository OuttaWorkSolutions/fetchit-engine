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
