/*
 * @fetchitai/review - a drop-in "review before you send" panel.
 *
 * Mounts a <fetchit-review> web component (shadow DOM, themeable via CSS custom
 * properties) that takes AI-generated text, runs @fetchitai/engine locally, shows
 * the cleaned text with color-coded highlights, lets the end user accept/reject
 * each class of auto-fix and edit the text by hand, then hands the final text
 * back through onApply(finalText, receipt). No network; the text never leaves
 * the page.
 *
 * Usage:
 *   import { attachReview } from "@fetchitai/review";
 *   attachReview(document.querySelector("#compose"), {
 *     text: aiDraft,
 *     onApply: (finalText, receipt) => sendEmail(finalText),
 *   });
 */
import { clean, applyEdits, findAiSpans, analyzeAiSignals } from "@fetchitai/engine";

// Every category clean() can emit. The engine emits five: invisible, space,
// dash, homoglyph, typography. Until 2026-08-31 this map held only the first
// three, and because the panel rendered Object.keys(CATEGORY_LABEL) while
// _finalText() applied every edit NOT in _rejected, homoglyph and typography
// fixes were always applied, never shown, and impossible to reject. Someone who
// wanted to keep their curly quotes had no way to say so and no sign they had
// been changed.
//
// The labels match the wording the consumer tool uses for the same categories.
const CATEGORY_LABEL = {
  invisible: "Hidden characters",
  space: "Look-alike spaces",
  dash: "Em dashes",
  homoglyph: "Look-alike letters",
  typography: "Smart punctuation",
};

// Fall back to the raw category name for anything the engine adds later. The
// point is that an unlabelled category still gets a checkbox, so a new engine
// category can never again be silently applied with no way to refuse it.
const categoryLabel = (cat) => CATEGORY_LABEL[cat] || cat;

const STYLE = `
:host {
  --fr-red: #AC1D39;
  --fr-navy: #233966;
  --fr-ink: #1E2328;
  --fr-muted: #5A6069;
  --fr-line: #D3D7DD;
  --fr-card: #FFFFFF;
  --fr-ground: #F4F5F7;
  --fr-flag: #FCE9B6;
  --fr-flag-border: #E0A93B;
  --fr-removed: #F6C9CE;
  --fr-radius: 12px;
  --fr-font: "Segoe UI Variable","Segoe UI",-apple-system,system-ui,Arial,sans-serif;
  display: block;
  font-family: var(--fr-font);
  color: var(--fr-ink);
}
* { box-sizing: border-box; }
.wrap {
  border: 1px solid var(--fr-line); border-radius: var(--fr-radius);
  background: var(--fr-card); overflow: hidden;
  display: grid; grid-template-columns: 1fr 300px;
}
@media (max-width: 720px) { .wrap { grid-template-columns: 1fr; } }
.main { padding: 18px 20px; min-width: 0; }
.side { border-left: 1px solid var(--fr-line); background: var(--fr-ground); padding: 18px 18px; }
@media (max-width: 720px) { .side { border-left: 0; border-top: 1px solid var(--fr-line); } }
.title { font-weight: 700; font-size: 1.02rem; color: var(--fr-navy); margin: 0 0 12px; }
.review {
  border: 1px solid var(--fr-line); border-radius: 10px; background: #fff;
  padding: 14px 16px; min-height: 150px; line-height: 1.6; font-size: .98rem;
  white-space: pre-wrap; word-break: break-word;
}
.review mark {
  background: var(--fr-flag); border-bottom: 2px solid var(--fr-flag-border);
  border-radius: 3px; padding: 0 1px; cursor: help;
}
textarea.edit {
  width: 100%; min-height: 150px; border: 1px solid var(--fr-navy); border-radius: 10px;
  padding: 14px 16px; font: inherit; line-height: 1.6; resize: vertical; color: var(--fr-ink);
}
.row { display: flex; gap: 10px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
.btn {
  font: inherit; font-weight: 650; border: 0; border-radius: 9px; padding: 10px 20px;
  cursor: pointer; background: var(--fr-red); color: #fff;
}
.btn:hover { filter: brightness(.94); }
.btn.ghost { background: transparent; color: var(--fr-navy); border: 1.5px solid var(--fr-line); }
.btn.ghost:hover { border-color: var(--fr-navy); filter: none; }
.meter-label { display: flex; justify-content: space-between; align-items: baseline; font-size: .85rem; color: var(--fr-muted); }
.badge { font-weight: 700; font-size: .82rem; padding: 2px 9px; border-radius: 999px; color: #fff; }
.badge.low { background: #2E7D46; } .badge.moderate { background: #C9820A; } .badge.high { background: var(--fr-red); }
/* "unknown" is not a low score, it is the absence of one. Neutral grey, never green. */
.badge.unknown { background: #8A929E; }
.meter { height: 8px; border-radius: 999px; background: #E3E6EB; overflow: hidden; margin: 6px 0 4px; }
.meter > i { display: block; height: 100%; }
.meter.low > i { background: #2E7D46; } .meter.moderate > i { background: #C9820A; } .meter.high > i { background: var(--fr-red); }
.sec { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--fr-muted); margin: 18px 0 8px; font-weight: 700; }
.fix { display: flex; align-items: center; gap: 9px; padding: 7px 0; border-bottom: 1px dashed var(--fr-line); font-size: .9rem; }
.fix:last-child { border-bottom: 0; }
.fix input { width: 16px; height: 16px; accent-color: var(--fr-red); }
.fix .n { margin-left: auto; color: var(--fr-muted); font-variant-numeric: tabular-nums; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--fr-flag); border: 1px solid var(--fr-flag-border); border-radius: 999px; padding: 2px 10px; font-size: .82rem; }
.empty { color: var(--fr-muted); font-size: .88rem; font-style: italic; }
.foot { margin-top: 14px; font-size: .72rem; color: var(--fr-muted); text-align: right; }
.foot a { color: var(--fr-muted); }
`;

function cpToUtf16Spans(text, cpSpans) {
  const cps = Array.from(text);
  const map = new Array(cps.length + 1);
  let u = 0;
  for (let i = 0; i < cps.length; i++) { map[i] = u; u += cps[i].length; }
  map[cps.length] = u;
  return cpSpans.map(([s, e]) => [map[s], map[e]]);
}

class FetchitReview extends HTMLElement {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._input = "";
    this._onApply = null;
    this._rejected = new Set(); // categories the user turned off
    this._working = null;       // manual-edit text; null = use auto-clean
    this._editing = false;
    this._badge = true;
    this._buttons = { apply: true, copy: true, edit: true };
  }

  /**
   * Replacing the text drops any hand edit, because that edit belonged to the
   * old text. Category toggles are KEPT: they are a standing preference about
   * which fixes the reader wants ("never touch my curly quotes"), not a fact
   * about one document, and silently re-enabling a fix somebody had switched
   * off is the kind of surprise this widget exists to avoid. Call
   * resetRejected() for a genuinely clean slate.
   */
  set text(v) { this._input = v == null ? "" : String(v); this._working = null; this._render(); }
  get text() { return this._input; }

  /** The text the host would receive from Apply right now, edits and toggles applied. */
  get finalText() { return this._finalText(); }

  set onApply(fn) { this._onApply = fn; }
  get onApply() { return this._onApply; }

  /** Attribution footer. A real accessor, so setting it re-renders. */
  set badge(v) { this._badge = v !== false; this._render(); }
  get badge() { return this._badge; }

  /** Which action buttons to show, e.g. { copy: false }. Unspecified keys stay on. */
  set buttons(v) { this._buttons = Object.assign({ apply: true, copy: true, edit: true }, v || {}); this._render(); }
  get buttons() { return Object.assign({}, this._buttons); }

  /** Turn every automatic fix back on. */
  resetRejected() { this._rejected.clear(); this._render(); }

  /**
   * Detach and drop references. Listeners live on nodes inside the shadow root,
   * so clearing it releases them; the element is removed if still in the tree.
   */
  destroy() {
    this._root.innerHTML = "";
    this._onApply = null;
    this._working = null;
    if (this.isConnected && this.parentNode) this.parentNode.removeChild(this);
  }

  connectedCallback() { if (!this._root.firstChild) this._render(); }

  _finalText() {
    // While the hand editor is open, the TEXTAREA is the current text. _working
    // only catches up when Done is pressed, so reading it here would hand back
    // the text from before this edit session. A host that hides its own body
    // field and reads finalText at Send would then send the pre-edit copy
    // without any sign - the exact silent drop this getter exists to prevent,
    // one layer down. Apply and Copy route through here too, so all three agree.
    if (this._editing) {
      const ta = this._root.querySelector("textarea.edit");
      if (ta) return ta.value;
    }
    if (this._working != null) return this._working;
    const r = clean(this._input);
    const accepted = r.edits.filter((e) => !this._rejected.has(e.category)).map((e) => e.id);
    return applyEdits(this._input, accepted, r.edits);
  }

  _render() {
    const result = clean(this._input);
    const text = this._finalText();
    const report = analyzeAiSignals(text);
    // The engine returns too_short / empty when it DECLINES to score. Until
    // 2026-08-31 both rendered as a green LOW at 0%, which told the reader the
    // text had been checked and come back clean when nothing had been checked
    // at all. Short drafts are common, so this was the usual case, not an edge
    // one. Say "not checked" instead, in neutral grey.
    const scored = report.status === "ok";
    const level = scored ? report.level : "unknown";
    const score = scored ? report.score : 0;
    const badgeText = scored ? level.toUpperCase() : "NOT CHECKED";
    const badgeTitle = scored
      ? "Heuristic estimate of AI-writing signals. Not proof."
      : report.status === "empty"
        ? "No text to check yet."
        : "Too short to check: the estimate needs a longer passage to mean anything.";

    // group auto-edits by category for the accept/reject toggles
    const byCat = {};
    for (const e of result.edits) byCat[e.category] = (byCat[e.category] || 0) + 1;

    // AI-phrase highlights on the CURRENT text (what the user will send)
    const spans = cpToUtf16Spans(text, findAiSpans(text));
    const phrases = [...new Set(spans.map(([s, e]) => text.slice(s, e)))];

    // Quotes included: no user string reaches an attribute today, but escaping
    // them means a future attribute interpolation cannot become an XSS.
    const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    let reviewHtml = "";
    if (!this._editing) {
      let cur = 0;
      for (const [s, e] of spans) {
        if (s > cur) reviewHtml += esc(text.slice(cur, s));
        reviewHtml += `<mark title="AI-associated wording. Consider rewording.">${esc(text.slice(s, e))}</mark>`;
        cur = e;
      }
      reviewHtml += esc(text.slice(cur));
      if (!text) reviewHtml = `<span class="empty">Nothing to review yet.</span>`;
    }

    // Iterate the categories the engine ACTUALLY emitted, not a fixed label
    // list, so every applied fix is visible and refusable by construction.
    const fixesHtml = Object.keys(byCat)
      .map((cat) => `
        <label class="fix">
          <input type="checkbox" data-cat="${esc(cat)}" ${this._rejected.has(cat) ? "" : "checked"}>
          <span>${esc(categoryLabel(cat))}</span>
          <span class="n">${byCat[cat]}</span>
        </label>`).join("") || `<div class="empty">No automatic fixes needed.</div>`;

    const phrasesHtml = phrases.length
      ? `<div class="chips">${phrases.map((p) => `<span class="chip">${esc(p)}</span>`).join("")}</div>`
      : `<div class="empty">No AI-sounding phrases found.</div>`;

    this._root.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <div class="main">
          <p class="title">Review before you send</p>
          ${this._editing
            ? `<textarea class="edit">${esc(text)}</textarea>`
            : `<div class="review">${reviewHtml}</div>`}
          <div class="row">
            ${this._buttons.apply ? `<button class="btn" id="apply">Apply</button>` : ""}
            ${this._buttons.copy ? `<button class="btn ghost" id="copy">Copy</button>` : ""}
            ${this._buttons.edit ? `<button class="btn ghost" id="edit">${this._editing ? "Done" : "Edit"}</button>` : ""}
          </div>
        </div>
        <div class="side">
          <div class="meter-label">
            <span>AI-writing signals</span>
            <span class="badge ${level}" title="${esc(badgeTitle)}">${esc(badgeText)}</span>
          </div>
          <div class="meter ${level}"><i style="width:${score}%"></i></div>
          <div class="sec">Automatic fixes</div>
          ${fixesHtml}
          <div class="sec">AI-sounding phrases</div>
          ${phrasesHtml}
          ${this._badge ? `<div class="foot">Powered by <a href="https://fetchitai.com" target="_blank" rel="noopener">Fetch It AI</a></div>` : ""}
        </div>
      </div>`;

    this._root.querySelectorAll('input[data-cat]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cat = cb.getAttribute("data-cat");
        if (cb.checked) this._rejected.delete(cat); else this._rejected.add(cat);
        this._working = null; // toggles operate on the auto-clean, not a hand edit
        this._render();
      });
    });
    // Any of these can be switched off via the buttons option, so bind defensively.
    const on = (id, fn) => { const el = this._root.getElementById(id); if (el) el.addEventListener("click", fn); };

    on("apply", () => {
      const finalText = this._finalText();
      if (this._onApply) this._onApply(finalText, { rulesetVersion: result.rulesetVersion, rejected: [...this._rejected] });
      this.dispatchEvent(new CustomEvent("apply", { detail: { text: finalText } }));
    });
    on("copy", () => {
      const t = this._finalText();
      if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {});
    });
    on("edit", () => {
      if (this._editing) {
        const ta = this._root.querySelector("textarea.edit");
        this._working = ta ? ta.value : this._working;
      }
      this._editing = !this._editing;
      this._render();
      if (this._editing) { const ta = this._root.querySelector("textarea.edit"); if (ta) ta.focus(); }
    });
  }
}

if (typeof customElements !== "undefined" && !customElements.get("fetchit-review")) {
  customElements.define("fetchit-review", FetchitReview);
}

/**
 * Mount the widget inside `host`.
 *
 * options:
 *   text     initial text to review
 *   onApply  (finalText, meta) called when Apply is pressed
 *   badge    false hides the attribution footer
 *   buttons  { apply, copy, edit } - any set to false hides that button.
 *            Hosts that write the result back themselves usually want
 *            { apply: false }, since in a host where the destination field is
 *            hidden, an Apply the reader forgets to press silently sends the
 *            pre-edit copy. Read `el.finalText` instead.
 */
export function attachReview(host, options = {}) {
  const el = document.createElement("fetchit-review");
  if (options.buttons) el.buttons = options.buttons;
  // Attribution is on by default and off on request. Under Apache-2.0 a
  // caller could delete the markup anyway, so gating it would be theatre.
  if (options.badge === false) el.badge = false;
  if (options.text != null) el.text = options.text;
  if (options.onApply) el.onApply = options.onApply;
  host.appendChild(el);
  return el;
}

export { FetchitReview };
