# @fetchit/engine

Deterministic text cleanup and AI-writing heuristics that run entirely in your
process. Your users text never leaves it.

```js
import { clean, applyEdits, toUtf16Offsets } from "@fetchit/engine";

const result = clean(aiDraft);
// result.edits    auto-safe fixes (invisible chars, look-alike spaces, dashes)
// result.flags    AI-associated wording, for a human to accept or reject
// result.aiReport heuristic score

// apply what a human accepted:
const finalText = applyEdits(aiDraft, accepted, result.edits);
```

Offsets are code points. For DOM highlighting, convert with
`toUtf16Offsets(result, inputText)`. See the [repository README](https://github.com/OuttaWorkSolutions/fetchit-engine#the-design-in-four-claims)
for the full CleanResult contract.

Free for noncommercial use under PolyForm Noncommercial 1.0.0.
Commercial use requires a paid license: see COMMERCIAL.md.

## License

Free for **noncommercial** use under the PolyForm Noncommercial License 1.0.0
(see LICENSE). **Commercial use requires a paid license** ($49/year; enterprise
per deal). See COMMERCIAL.md or https://fetchitai.com/developers.
