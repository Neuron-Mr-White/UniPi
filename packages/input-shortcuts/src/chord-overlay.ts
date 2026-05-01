/**
 * TUI overlay component for ALT+S chord mode.
 *
 * Two states: root chord (action menu) and register sub-chord (register list).
 * Uses ctx.ui.custom() pattern from btw/compactor.
 *
 * IMPORTANT: The overlay ONLY captures the user's action selection.
 * Actions are NOT executed inside the overlay — they are deferred to the
 * caller via callbacks (onStash, onUndo, etc.). The caller closes the
 * overlay via done(), then executes the action outside the overlay context
 * where ctx.ui.getEditorText() / setEditorText() actually work.
 *
 * Closes on ESC or after selecting an action. No timeout.
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
import type { ChordState } from "./types.ts";
import { THINKING_CYCLE } from "./types.ts";

/** Theme-like interface matching pi-coding-agent's Theme */
interface ThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
  italic?(text: string): string;
}

/** Action callbacks — actions execute OUTSIDE the overlay context */
export interface ChordCallbacks {
  onStash: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAppendRegister: (index: number) => void;
  onAppendStash: () => void;
  onCopy: () => void;
  onCut: () => void;
  onToggleThinking: () => void;
}

// ─── Action menu lines ──────────────────────────────────────────────────────

const ROOT_ACTIONS: Array<{ key: string; label: string }> = [
  { key: "S", label: "Stash / Restore" },
  { key: "U", label: "Undo" },
  { key: "R", label: "Redo" },
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
  private done: () => void;
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
    callbacks: ChordCallbacks,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.callbacks = callbacks;

    this.renderRootMenu();
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

  handleInput(data: string): void {
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
        this.closeThenExecute(() => this.callbacks.onStash());
        break;
      case "u":
        this.closeThenExecute(() => this.callbacks.onUndo());
        break;
      case "r":
        this.closeThenExecute(() => this.callbacks.onRedo());
        break;
      case "a":
        this.enterRegChord();
        return; // don't close — show register sub-menu
      case "y":
        this.closeThenExecute(() => this.callbacks.onCopy());
        break;
      case "d":
        this.closeThenExecute(() => this.callbacks.onCut());
        break;
      case "t":
        this.closeThenExecute(() => this.callbacks.onToggleThinking());
        break;
      default:
        // Unknown key — silent close
        this.close();
        break;
    }
  }

  private handleRegKey(key: string): void {
    if (key === "s") {
      this.closeThenExecute(() => this.callbacks.onAppendStash());
    } else if (/^[0-9]$/.test(key)) {
      const index = parseInt(key, 10);
      this.closeThenExecute(() => this.callbacks.onAppendRegister(index));
    } else {
      // Unknown key — silent close
      this.close();
    }
  }

  private enterRegChord(): void {
    this.renderRegisterMenu();
  }

  /**
   * Close the overlay, then execute the action.
   * The action runs AFTER the overlay is dismissed, so ctx.ui.getEditorText()
   * and setEditorText() work correctly (they don't work while overlay is open).
   */
  private closeThenExecute(action: () => void): void {
    this.done(); // close the overlay
    // Use setTimeout(0) to defer action to next tick — overlay will be dismissed by then
    setTimeout(action, 0);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  private close(): void {
    this.done();
  }

  dispose(): void {}

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
