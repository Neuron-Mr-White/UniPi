/**
 * TUI overlay component for the ALT+S chord.
 *
 * One state: the root action menu. Uses the ctx.ui.custom() pattern from
 * btw/compactor.
 *
 * IMPORTANT: The overlay ONLY captures the user's action selection.
 * Actions are NOT executed inside the overlay — they are deferred to the
 * caller via callbacks (onStash, onUndo, …). The caller closes the
 * overlay via done(), then executes the action outside the overlay context
 * where ctx.ui.getEditorText() / setEditorText() actually work.
 *
 * Closes on ESC or after selecting an action; an unknown key closes silently.
 * No timeout.
 */

import {
  Container,
  Key,
  matchesKey,
  Text,
  type Focusable,
  type TUI,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";

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
  onAppendStash: () => void;
  onCopyLastResponse: () => void | Promise<void>;
  onKanboard: () => void | Promise<void>;
}

// ─── Action menu lines ──────────────────────────────────────────────────────

const ROOT_ACTIONS: Array<{ key: string; label: string }> = [
  { key: "S", label: "Stash / Restore" },
  { key: "U", label: "Undo" },
  { key: "R", label: "Redo" },
  { key: "A", label: "Append stash" },
  { key: "Y", label: "Copy last response" },
  { key: "K", label: "Add to kanboard backlog" },
];

// ─── ChordOverlay Component ─────────────────────────────────────────────────────────

export class ChordOverlay extends Container implements Focusable {
  private _focused = true;
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
    this.actionLines = ROOT_ACTIONS.map(
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

    this.handleRootKey(data.toLowerCase());
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
        this.closeThenExecute(() => this.callbacks.onAppendStash());
        break;
      case "y":
        this.closeThenExecute(() => this.callbacks.onCopyLastResponse());
        break;
      case "k":
        this.closeThenExecute(() => this.callbacks.onKanboard());
        break;
      default:
        // Unknown key — silent close
        this.close();
        break;
    }
  }

  /**
   * Close the overlay, then execute the action.
   * The action runs AFTER the overlay is dismissed, so ctx.ui.getEditorText()
   * and setEditorText() work correctly (they don't work while overlay is open).
   */
  private closeThenExecute(action: () => void | Promise<void>): void {
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
    const title = "Input Shortcuts";
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
