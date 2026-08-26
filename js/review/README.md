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
CSS custom properties). The free version shows a small "Powered by Fetch It AI"
badge; a commercial license removes it.

## License

Free for **noncommercial** use under the PolyForm Noncommercial License 1.0.0
(see LICENSE). **Commercial use requires a paid license** ($49/year; enterprise
per deal). See COMMERCIAL.md or https://fetchitai.com/developers.
