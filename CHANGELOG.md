# Changelog

Two things are versioned here, and they move independently:

- **Engine version** is the package version (`@fetchit/engine`, `fetchit-engine`).
  It follows semver and is kept in lockstep across both languages: npm 1.4.0 and
  pip 1.4.0 behave identically.
- **Ruleset version** (`rulesetVersion`, a date) covers the AI phrase list, the
  enumerators, the character ranges, and the scoring thresholds. Scores and flags
  are only comparable within one ruleset version, which is why every result
  carries the stamp.

## Unreleased

Nothing yet.

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

**`@fetchit/review` 0.1.0**

- `<fetchit-review>` web component, shadow DOM, themeable through `--fr-*` custom
  properties. Per category accept and reject with live rescoring, hand edit mode,
  and `onApply(finalText, receipt)`.
