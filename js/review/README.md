# @fetchit/review

A drop-in "review before you send" panel. Mount it beside any text box and the
reader sees the cleaned text with color-coded highlights, accepts or rejects each
change, edits by hand, then hands the final text back to your app. Runs
`@fetchit/engine` locally, so the text never leaves the page.

```js
import { attachReview } from "@fetchit/review";

attachReview(document.querySelector("#compose"), {
  text: aiDraft,
  onApply: (finalText, receipt) => sendEmail(finalText),
});
```

It renders a `<fetchit-review>` web component (shadow DOM, themeable via `--fr-*`
CSS custom properties). It shows a small "Powered by Fetch It AI" badge,
which is appreciated but entirely optional: pass `badge: false` to hide it.

## License

Apache-2.0. Free for everyone, including commercial use.
