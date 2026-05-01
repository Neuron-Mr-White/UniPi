/**
 * TUI overlay component for ALT+S chord mode.
 *
 * Two states: root chord (action menu) and register sub-chord (register list).
 * Uses ctx.ui.custom() pattern from btw/compactor.
 * 300ms timeout auto-closes overlay.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  Text,
  type Focusable,
  type TUI,
  type KeybindingsManager,
} from "@mariozechner/pi-tui";
import type { ChordState } from "./types.js";
import { CHORD_TIMEOUT_MS, THINKING_CYCLE } from "./types.js";
import type { RegisterStore } from "./registers.js";
import type { UndoRedoBuffer } from "./undo-redo.js";
import { copyToClipboard } from "./clipboard.js";
import { showSuccess, showError, clearStatus } from "./status.js";

/** Theme-like interface matching pi-coding-agent's Theme */
interface ThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
  italic?(text: string): string;
}

/** Callbacks for actions that need the pi API object */
export interface ChordCallbacks {
  getThinkingLevel: () => string;
  setThinkingLevel: (level: string) => void;
}

// ─── Action menu lines ──────────────────────────────────────────────────────

const ROOT_ACTIONS: Array<{ key: string; label: string }> = [
  { key: "S", label: "Stash/Restore" },
  { key: "R", label: "Redo" },
  { key: "U", label: "Undo" },
  { key: "A", label: "Append from register" },
  { key: "Y", label: "Copy to clipboard" },
  { key: "D", label: "Cut to clipboard" },
  { key: "T", label: "Toggle thinking" },
];

function buildRegisterActions(): Array<{ key: string; label: string }> {
  const actions: Array<{ key: string; label: string }> = [];
  for (let i = 0; i <= 9; i++) {
    actions.push({ key: String(i), label: `Register ${i}` });
  }
  actions.push({ key: "S", label: "Stash register" });
  return actions;
}

// ─── ChordOverlay Component ─────────────────────────────────────────────────

export class ChordOverlay extends Container implements Focusable {
  private _focused = true;
  private state: ChordState = "chord_root";
  private actionLines: Text[] = [];
  private tui: TUI;
  private theme: ThemeLike;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private done: () => void;
  private ctx: ExtensionContext;
  private registers: RegisterStore;
  private undoRedo: UndoRedoBuffer;
  private callbacks: ChordCallbacks;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    tui: TUI,
    theme: ThemeLike,
    _keybindings: KeybindingsManager,
    done: () => void,
    ctx: ExtensionContext,
    registers: RegisterStore,
    undoRedo: UndoRedoBuffer,
    callbacks: ChordCallbacks,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.ctx = ctx;
    this.registers = registers;
    this.undoRedo = undoRedo;
    this.callbacks = callbacks;

    this.renderRootMenu();
    this.startTimeouter();
  }

  private renderRootMenu(): void {
    this.state = "chord_root";
    this.actionLines = ROOT_ACTIONS.map(
      (a) => new Text(`  ${this.theme.fg("accent", `[${a.key}]`)} ${a.label}`, 1, 0),
    );
    this.requestRender();
  }

  private renderRegisterMenu(): void {
    this.state = "chord_reg";
    const regActions = buildRegisterActions();
    this.actionLines = regActions.map(
      (a) => new Text(`  ${this.theme.fg("accent", `[${a.key}]`)} ${a.label}`, 1, 0),
    );
    this.requestRender();
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private startTimeouter(): void {
    this.clearTimeouter();
    this.timeoutHandle = setTimeout(() => {
      this.close();
    }, CHORD_TIMEOUT_MS);
  }

  private clearTimeouter(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  handleInput(data: string): void {
    this.clearTimeouter();

    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }

    const key = data.toLowerCase();

    if (this.state === "chord_root") {
      this.handleRootKey(key);
    } else if (this.state === "chord_reg") {
      this.handleRegKey(key);
    }
  }

  private handleRootKey(key: string): void {
    switch (key) {
      case "s":
        this.actionStash();
        break;
      case "r":
        this.actionRedo();
        break;
      case "u":
        this.actionUndo();
        break;
      case "a":
        this.enterRegChord();
        return; // don't close
      case "y":
        this.actionCopy();
        break;
      case "d":
        this.actionCut();
        break;
      case "t":
        this.actionToggleThinking();
        break;
      default:
        // Unknown key — silent close
        break;
    }
    this.close();
  }

  private handleRegKey(key: string): void {
    if (key === "s") {
      this.actionAppendStash();
    } else if (/^[0-9]$/.test(key)) {
      this.actionAppendRegister(parseInt(key, 10));
    } else {
      // Unknown key — silent close
    }
    this.close();
  }

  private enterRegChord(): void {
    this.renderRegisterMenu();
    this.startTimeouter();
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  private actionStash(): void {
    const text = this.ctx.ui.getEditorText();
    if (text.length > 0) {
      // Save current text to stash, snapshot before clearing
      this.undoRedo.snapshot(text);
      this.registers.setStash(text);
      this.ctx.ui.setEditorText("");
      showSuccess(this.ctx, "✓ stash saved");
    } else {
      // Restore stash
      const stash = this.registers.getStash();
      if (stash.length === 0) {
        showError(this.ctx, "stash empty");
        return;
      }
      this.ctx.ui.setEditorText(stash);
      showSuccess(this.ctx, "✓ stash restored");
    }
  }

  private actionRedo(): void {
    const current = this.ctx.ui.getEditorText();
    const result = this.undoRedo.redo(current);
    if (result.ok) {
      this.ctx.ui.setEditorText(result.text);
      showSuccess(this.ctx, "✓ redo");
    } else {
      showError(this.ctx, "nothing to redo");
    }
  }

  private actionUndo(): void {
    const current = this.ctx.ui.getEditorText();
    const result = this.undoRedo.undo(current);
    if (result.ok) {
      this.ctx.ui.setEditorText(result.text);
      showSuccess(this.ctx, "✓ undo");
    } else {
      showError(this.ctx, result.reason === "throttled" ? "undo throttled" : "nothing to undo");
    }
  }

  private actionAppendRegister(index: number): void {
    const regText = this.registers.getRegister(index);
    if (regText.length === 0) {
      showError(this.ctx, `register ${index} empty`);
      return;
    }
    const current = this.ctx.ui.getEditorText();
    this.undoRedo.snapshot(current);
    this.ctx.ui.setEditorText(current + regText);
    showSuccess(this.ctx, `✓ register ${index} appended`);
  }

  private actionAppendStash(): void {
    const stashText = this.registers.getStash();
    if (stashText.length === 0) {
      showError(this.ctx, "stash empty");
      return;
    }
    const current = this.ctx.ui.getEditorText();
    this.undoRedo.snapshot(current);
    this.ctx.ui.setEditorText(current + stashText);
    showSuccess(this.ctx, "✓ stash appended");
  }

  private actionCopy(): void {
    const text = this.ctx.ui.getEditorText();
    if (text.length === 0) {
      showError(this.ctx, "nothing to copy");
      return;
    }
    const result = copyToClipboard(text);
    if (result.ok) {
      showSuccess(this.ctx, "✓ copied");
    } else {
      showError(this.ctx, result.reason ?? "clipboard unavailable");
    }
  }

  private actionCut(): void {
    const text = this.ctx.ui.getEditorText();
    if (text.length === 0) {
      showError(this.ctx, "nothing to cut");
      return;
    }
    const result = copyToClipboard(text);
    if (result.ok) {
      this.undoRedo.snapshot(text);
      this.ctx.ui.setEditorText("");
      showSuccess(this.ctx, "✓ cut");
    } else {
      showError(this.ctx, result.reason ?? "clipboard unavailable");
    }
  }

  private actionToggleThinking(): void {
    const current = this.callbacks.getThinkingLevel();
    const idx = THINKING_CYCLE.indexOf(current as any);
    const nextIdx = idx >= 0 ? (idx + 1) % THINKING_CYCLE.length : 0;
    const next = THINKING_CYCLE[nextIdx];
    this.callbacks.setThinkingLevel(next);
    showSuccess(this.ctx, `thinking: ${next}`);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  private close(): void {
    this.clearTimeouter();
    clearStatus(this.ctx);
    this.done();
  }

  dispose(): void {
    this.clearTimeouter();
  }

  render(width: number): string[] {
    const dialogWidth = Math.min(40, Math.max(28, width));
    const innerWidth = dialogWidth - 2;

    const lines: string[] = [];

    // Top border
    lines.push(this.theme.fg("borderMuted", `┌${"─".repeat(innerWidth)}┐`));

    // Title
    const title = this.state === "chord_root" ? "Input Shortcuts" : "Append from register";
    const titlePadded = title.padEnd(innerWidth);
    lines.push(`${this.theme.fg("borderMuted", "│")}${this.theme.fg("accent", titlePadded)}${this.theme.fg("borderMuted", "│")}`);

    // Separator
    lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));

    // Action lines
    for (const line of this.actionLines) {
      const rendered = line.render(innerWidth)[0] ?? "";
      const padded = rendered.padEnd(innerWidth);
      lines.push(`${this.theme.fg("borderMuted", "│")}${padded}${this.theme.fg("borderMuted", "│")}`);
    }

    // Bottom border
    lines.push(this.theme.fg("borderMuted", `└${"─".repeat(innerWidth)}┘`));

    return lines;
  }
}
