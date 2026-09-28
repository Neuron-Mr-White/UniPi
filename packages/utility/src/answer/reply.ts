/**
 * @pi-unipi/utility — /unipi:answer "reply" panel (the default method)
 *
 * Like /unipi:btw: the panel replaces the input area (ctx.ui.custom without
 * `overlay`; pi restores the editor and your draft when it closes). The agent's
 * last reply is shown in a scrollable viewport above a FIXED input box, so you
 * can read any part of a long reply while typing — nothing scrolls away.
 *
 *   ── /unipi:answer · reply ───────────── 3 questions · tab answers them one by one ──
 *   …the reply, markdown, scrolled with ↑↓ / PgUp PgDn…
 *   ─────────────────────────────────────────────────────── lines 12–40 of 88 ──
 *   ❭ your answer (multi-line: shift+enter)
 *   ↵ send · ↑↓ scroll · pgup/pgdn page · tab questions · esc back
 *
 * ↑/↓ scroll the reply while the input is one line; in a multi-line answer
 * they move the cursor (PgUp/PgDn still scroll).
 */

import { Editor, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";

export type ReplyPanelResult = { type: "send"; text: string } | { type: "questions"; draft: string } | { type: "cancel" };

export class ReplyPanel implements Component, Focusable {
  private readonly editor: Editor;
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }
  private scroll = 0;
  /** Start at the end — questions usually close a reply. */
  private atEnd = true;
  private body: string[] = [];
  private bodyWidth = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly reply: string,
    private readonly questionCount: number,
    private readonly done: (result: ReplyPanelResult) => void,
    draft = "",
  ) {
    this.editor = new Editor(tui, { borderColor: (text: string) => theme.fg("borderMuted", text), selectList: getSelectListTheme() });
    if (draft) this.editor.setText(draft);
    this.editor.onSubmit = (text: string) => {
      const value = text.trim();
      if (value) this.done({ type: "send", text: value });
    };
  }

  invalidate(): void {
    this.bodyWidth = 0;
    this.editor.invalidate?.();
  }

  private viewport(): number {
    return Math.max(4, (process.stdout.rows ?? 30) - 12);
  }

  private lines(width: number): string[] {
    if (this.bodyWidth !== width) {
      const md = new Markdown(this.reply, 0, 0, getMarkdownTheme());
      this.body = md.render(width).flatMap((l) => wrapTextWithAnsi(l, Math.max(1, width)));
      this.bodyWidth = width;
    }
    return this.body;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const t = this.theme;
    const body = this.lines(w - 1);
    const view = this.viewport();
    const max = Math.max(0, body.length - view);
    if (this.atEnd) this.scroll = max;
    this.scroll = Math.max(0, Math.min(this.scroll, max));
    const shown = body.slice(this.scroll, this.scroll + view);

    const title = " /unipi:answer · reply ";
    const qs = this.questionCount > 0 ? ` ${this.questionCount} question${this.questionCount === 1 ? "" : "s"} · tab answers them one by one ` : "";
    const top = `${t.fg("borderMuted", "──")}${t.fg("accent", title)}${t.fg("borderMuted", "─".repeat(Math.max(0, w - 2 - visibleWidth(title) - visibleWidth(qs))))}${t.fg("dim", qs)}`;
    const pos = body.length > view ? ` lines ${this.scroll + 1}–${this.scroll + shown.length} of ${body.length} ` : "";
    const mid = `${t.fg("borderMuted", "─".repeat(Math.max(0, w - visibleWidth(pos))))}${t.fg("dim", pos)}`;
    const hint = t.fg("dim", `↵ send · shift+↵ newline · ↑↓ scroll · pgup/pgdn page${this.questionCount > 0 ? " · tab questions" : ""} · esc back`);

    return [
      truncateToWidth(top, w, ""),
      ...shown.map((l) => truncateToWidth(l, w, "")),
      ...Array.from({ length: Math.max(0, view - shown.length) }, () => ""),
      truncateToWidth(mid, w, ""),
      ...this.editor.render(w),
      truncateToWidth(hint, w, ""),
    ];
  }

  private scrollBy(delta: number): void {
    const max = Math.max(0, this.body.length - this.viewport());
    this.scroll = Math.max(0, Math.min(max, this.scroll + delta));
    this.atEnd = this.scroll >= max;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.done({ type: "cancel" });
      return;
    }
    if (matchesKey(data, Key.tab) && this.questionCount > 0) {
      this.done({ type: "questions", draft: this.editor.getText() });
      return;
    }
    const page = Math.max(1, this.viewport() - 2);
    if (matchesKey(data, Key.pageUp)) return this.scrollBy(-page);
    if (matchesKey(data, Key.pageDown)) return this.scrollBy(page);
    const singleLine = this.editor.getLines().length <= 1;
    if (singleLine && matchesKey(data, Key.up)) return this.scrollBy(-1);
    if (singleLine && matchesKey(data, Key.down)) return this.scrollBy(1);
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  dispose(): void {}
}
