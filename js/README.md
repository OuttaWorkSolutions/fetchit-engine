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


## License

Apache-2.0. Free for everyone, including commercial use.
