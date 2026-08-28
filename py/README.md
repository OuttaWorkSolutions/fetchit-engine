# fetchit-engine

Deterministic text cleanup and AI-writing heuristics that run entirely in your
process. Your users text never leaves it. Pure standard library, no dependencies.

```python
from fetchit_engine import clean, apply_edits

r = clean(ai_draft, {"mode": "auto"})   # apply only auto-safe edits unattended
publish(r["cleaned"]["text"])
if r["aiReport"].get("level") == "high":
    review_queue.put(ai_draft, r)        # hand a human the full result
```

Offsets are code points. See the [repository README](https://github.com/OuttaWorkSolutions/fetchit-engine#the-design-in-four-claims)
for the full CleanResult contract, shared 1:1 with @fetchit/engine (JavaScript).


## License

Apache-2.0. Free for everyone, including commercial use.
