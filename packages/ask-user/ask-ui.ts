/**
 * @pi-unipi/ask-user — the question panel (Devin-style)
 *
 *   ── Planet ✓ · Foods 3 · Last book ─────────────────────────────
 *     Which planet would you most like to visit?
 *     ❭ 1 Mars
 *         The red planet, dusty and cold
 *       2 Saturn
 *         Famous for its rings
 *         Other (type your own)
 *   ────────────────────────────────────────────────────────────────
 *   ↑↓ navigate · ↵ select · ←→ switch question · ? help me out · esc cancel
 *   ? Not ready to answer, help me out!
 *
 * Replaces the input area (no overlay; pi restores the editor on close).
 *   ↑↓        move · digits pick (single: pick + next; multi: toggle)
 *   ␣         toggle (multi)
 *   ↵         select and go to the next question; submits on the last one
 *   ←→ / tab  switch question (on a non-empty "Other" ←→ move the text cursor)
 *   Other     just type — no Enter needed; paste / drop a file path or Ctrl+V
 *             an image to attach it as [Image #N]
 *   ?         "not ready — help me out" (ends the call; the agent asks what to clarify)
 *   esc       cancel (the agent's turn stops)
 * Unanswered questions are submitted as skipped — never blocking.
 */

import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatBytes, stillReferenced, tokenFor, tokenize, type Attachment } from "@pi-unipi/core";
import { readClipboardImageFile } from "./clipboard.js";
import { isAnswered, optionValue, type AskOption, type AskQuestion, type QuestionAnswer } from "./questions.js";

export type PanelResult =
  | { type: "answered"; answers: QuestionAnswer[]; attachments: Attachment[] }
  | { type: "clarify"; answers: QuestionAnswer[] }
  | { type: "action"; question: number; option: AskOption; answers: QuestionAnswer[] }
  | { type: "cancel" };

export interface PanelOptions {
  /** stop: Esc cancels the turn · send: Esc sends what's answered (rest skipped). */
  escape: "stop" | "send";
  /** A digit in a single-choice question also moves on. */
  digitAdvance: boolean;
  /** Show "? Not ready to answer, help me out!". */
  helpLine: boolean;
}

export const DEFAULT_PANEL_OPTIONS: PanelOptions = { escape: "stop", digitAdvance: true, helpLine: true };

interface QState {
  cursor: number;
  picked: Set<string>;
  input: Input;
}

const OTHER_LABEL = "Other (type your own)";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export class AskPanel implements Component, Focusable {
  private q = 0;
  private readonly states: QState[];
  private attachments: Attachment[] = [];
  private paste: string | null = null;
  private note: string | null = null;
  private finished = false;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly questions: readonly AskQuestion[],
    private readonly done: (result: PanelResult) => void,
    private readonly readClipboard: () => string | undefined = () => readClipboardImageFile(),
    private readonly options: PanelOptions = DEFAULT_PANEL_OPTIONS,
  ) {
    this.states = questions.map(() => ({ cursor: 0, picked: new Set<string>(), input: new Input({ prompt: "" }) }));
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.syncFocus();
  }

  // ── state helpers ──────────────────────────────────────────────────────
  private get question(): AskQuestion {
    return this.questions[this.q]!;
  }
  private get state(): QState {
    return this.states[this.q]!;
  }
  private hasOther(q = this.q): boolean {
    return this.questions[q]!.other !== false;
  }
  private otherIndex(q = this.q): number {
    return this.hasOther(q) ? this.questions[q]!.options.length : -1;
  }
  private rowCount(q = this.q): number {
    return this.questions[q]!.options.length + (this.hasOther(q) ? 1 : 0);
  }
  private onOther(): boolean {
    return this.state.cursor === this.otherIndex();
  }
  private otherText(q = this.q): string {
    return this.states[q]!.input.getValue();
  }
  private syncFocus(): void {
    this.states.forEach((s, i) => (s.input.focused = this._focused && i === this.q && s.cursor === this.otherIndex(i)));
  }

  answers(): QuestionAnswer[] {
    return this.questions.map((_, i) => {
      const s = this.states[i]!;
      const text = s.input.getValue().trim();
      const a: QuestionAnswer = { selected: [...s.picked], skipped: false, ...(text ? { custom_text: text } : {}) };
      a.skipped = !isAnswered(a);
      return a;
    });
  }

  private finish(result: PanelResult): void {
    if (this.finished) return;
    this.finished = true;
    this.done(result);
  }

  private submit(): void {
    const text = this.states.map((s) => s.input.getValue()).join("\n");
    this.finish({ type: "answered", answers: this.answers(), attachments: stillReferenced(text, this.attachments) });
  }

  /** Enter / pick: go to the next question, or submit from the last. */
  private advance(): void {
    if (this.q < this.questions.length - 1) {
      this.q++;
      this.syncFocus();
    } else this.submit();
  }

  private switchTo(delta: number): void {
    const next = Math.max(0, Math.min(this.questions.length - 1, this.q + delta));
    if (next !== this.q) {
      this.q = next;
      this.syncFocus();
    }
  }

  private pick(index: number, move = true): void {
    const opt = this.question.options[index];
    if (!opt) return;
    const s = this.state;
    if (this.question.multi_select) {
      const v = optionValue(opt);
      if (s.picked.has(v)) s.picked.delete(v);
      else s.picked.add(v);
      return;
    }
    s.picked = new Set([optionValue(opt)]);
    s.input.setValue(""); // single choice: the last action wins
    if (opt.action) {
      this.finish({ type: "action", question: this.q, option: opt, answers: this.answers() });
      return;
    }
    if (move) this.advance();
  }

  /** Text into "Other": file paths become [Image #N] / [File #N] tokens. */
  private insertText(text: string): void {
    if (!this.hasOther()) return;
    if (!this.onOther()) {
      this.state.cursor = this.otherIndex();
      this.syncFocus();
    }
    const { text: tokens, added } = tokenize(text, this.attachments);
    this.attachments.push(...added);
    this.state.input.handleInput(`${PASTE_START}${tokens}${PASTE_END}`);
    if (!this.question.multi_select && this.otherText().trim()) this.state.picked.clear();
  }

  private attachClipboardImage(): void {
    const file = this.readClipboard();
    if (!file) {
      this.note = "No image on the clipboard (over SSH, paste a file path instead)";
      return;
    }
    this.insertText(`${this.otherText() && !/\s$/.test(this.otherText()) ? " " : ""}${file} `);
  }

  // ── input ──────────────────────────────────────────────────────────────
  handleInput(data: string): void {
    if (this.finished) return;
    this.note = null;
    // Bracketed paste may arrive in pieces: collect it whole, then tokenize.
    if (this.paste !== null || data.includes(PASTE_START)) {
      this.paste = (this.paste ?? "") + data;
      const end = this.paste.indexOf(PASTE_END);
      if (end < 0) return;
      const body = this.paste.slice(this.paste.indexOf(PASTE_START) + PASTE_START.length, end);
      this.paste = null;
      this.insertText(body);
      return this.tui.requestRender();
    }

    const s = this.state;
    const other = this.onOther();
    const multi = this.question.multi_select === true;

    if (matchesKey(data, Key.escape)) return this.options.escape === "send" ? this.submit() : this.finish({ type: "cancel" });
    if (matchesKey(data, Key.up)) {
      s.cursor = Math.max(0, s.cursor - 1);
    } else if (matchesKey(data, Key.down)) {
      s.cursor = Math.min(this.rowCount() - 1, s.cursor + 1);
    } else if (matchesKey(data, Key.tab)) {
      this.switchTo(1);
    } else if (matchesKey(data, "shift+tab")) {
      this.switchTo(-1);
    } else if ((matchesKey(data, Key.left) || matchesKey(data, Key.right)) && !(other && this.otherText())) {
      this.switchTo(matchesKey(data, Key.left) ? -1 : 1);
    } else if (matchesKey(data, Key.enter) || data === "\r") {
      if (other) {
        if (!multi && this.otherText().trim()) s.picked.clear();
        this.advance();
      } else if (multi) {
        const opt = this.question.options[s.cursor];
        if (s.picked.size === 0 && opt) s.picked.add(optionValue(opt));
        this.advance();
      } else this.pick(s.cursor);
    } else if (matchesKey(data, Key.ctrl("v")) || matchesKey(data, Key.alt("v"))) {
      if (this.hasOther()) this.attachClipboardImage();
    } else if (other) {
      s.input.handleInput(data);
      if (!multi && this.otherText().trim()) s.picked.clear();
    } else if (data === " " && multi) {
      this.pick(s.cursor);
    } else if (/^[1-9]$/.test(data)) {
      const i = Number(data) - 1;
      if (i < this.question.options.length) {
        s.cursor = i;
        this.pick(i, this.options.digitAdvance);
      } else if (i === this.otherIndex()) s.cursor = i;
    } else if (data === "?") {
      return this.finish({ type: "clarify", answers: this.answers() });
    } else {
      return; // typing is for "Other" — ignored elsewhere, like Devin
    }
    this.syncFocus();
    this.tui.requestRender();
  }

  // ── render ─────────────────────────────────────────────────────────────
  invalidate(): void {}

  private chip(i: number): string {
    const t = this.theme;
    const q = this.questions[i]!;
    const s = this.states[i]!;
    const active = i === this.q;
    const label = active ? t.fg("accent", q.header) : t.fg("dim", q.header);
    let mark = "";
    if (q.multi_select && s.picked.size > 0) mark = ` ${active ? t.fg("accent", String(s.picked.size + (s.input.getValue().trim() ? 1 : 0))) : t.fg("dim", String(s.picked.size))}`;
    else if (s.picked.size > 0 || s.input.getValue().trim()) mark = ` ${t.fg("dim", "✓")}`;
    return label + mark;
  }

  render(width: number): string[] {
    // Never wider than the terminal (pi-tui throws on over-wide lines).
    const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const t = this.theme;
    const fit = (line: string) => truncateToWidth(line, w, "");
    const lines: string[] = [];

    const chips = this.questions.map((_, i) => this.chip(i)).join(t.fg("dim", " · "));
    const head = `${t.fg("borderMuted", "──")} ${chips} `;
    lines.push(fit(head + t.fg("borderMuted", "─".repeat(Math.max(0, w - visibleWidth(head))))));

    for (const l of wrapTextWithAnsi(this.question.question, Math.max(1, w - 4))) lines.push(fit(`  ${l}`));

    const s = this.state;
    const other = this.onOther();
    const multi = this.question.multi_select === true;
    const hl = (text: string) => t.bg("selectedBg", text);
    this.question.options.forEach((opt, i) => {
      const at = s.cursor === i;
      const picked = s.picked.has(optionValue(opt));
      const marker = multi
        ? picked ? t.fg("accent", "■") : t.fg("dim", "□")
        : at ? t.bold(t.fg("accent", "❭")) : " ";
      const num = other ? "" : `${t.fg("dim", String(i + 1))} `;
      const label = at ? t.bold(t.fg("accent", opt.label)) : picked ? t.bold(opt.label) : opt.label;
      const row = `  ${marker} ${num}${label}`;
      lines.push(fit(at ? hl(row) : row));
      if (opt.description) {
        const indent = other ? "    " : "      ";
        for (const d of wrapTextWithAnsi(opt.description, Math.max(1, w - indent.length - 1))) {
          const desc = `${indent}${t.fg("muted", d)}`;
          lines.push(fit(at ? hl(desc) : desc));
        }
      }
    });

    if (this.hasOther()) {
      const text = this.otherText();
      const n = this.otherIndex() + 1;
      if (other) {
        lines.push(fit(hl(`  ${t.bold(t.fg("accent", "❭"))} ${t.bold(t.fg("accent", OTHER_LABEL))}`)));
        const field = s.input.render(Math.max(4, w - 6))[0] ?? "";
        lines.push(fit(`    ${t.fg("accent", "└")} ${field}`));
      } else if (text) {
        lines.push(fit(`  ${multi ? t.fg("accent", "■") : " "} ${t.fg("dim", String(n))} ${OTHER_LABEL}`));
        lines.push(fit(`      ${t.fg("dim", "└")} ${t.fg("muted", text)}`));
      } else {
        lines.push(fit(`  ${multi ? t.fg("dim", "□") : " "}   ${OTHER_LABEL}`));
      }
      const used = stillReferenced(text, this.attachments);
      for (const a of used) lines.push(fit(`      ${t.fg("accent", tokenFor(a))} ${t.fg("dim", `${a.name} · ${formatBytes(a.bytes)}`)}`));
    }

    lines.push(t.fg("borderMuted", "─".repeat(w)));
    if (this.note) lines.push(fit(t.fg("warning", this.note)));
    const esc = this.options.escape === "send" ? "esc send" : "esc cancel";
    const keys = ["↑↓ navigate", ...(multi && !other ? ["␣ toggle"] : []), "↵ select", ...(other ? ["ctrl+v image"] : []), ...(this.questions.length > 1 ? ["←→ switch question"] : []), ...(other ? [] : ["? help me out"]), esc];
    lines.push(fit(t.fg("dim", keys.join(" · "))));
    if (this.options.helpLine) lines.push(fit(t.fg("warning", "? Not ready to answer, help me out!")));
    return lines;
  }

  dispose(): void {}
}
