/**
 * @pi-unipi/input-shortcuts — Extension entry point
 *
 * Registers ALT+S (chord overlay) and ALT+I (tab insert) shortcuts.
 * Provides /unipi:stash-settings command for keybinding customization.
 *
 * ARCHITECTURE:
 * - The overlay ONLY captures action selection (pure UI, no side effects)
 * - All actions execute OUTSIDE the overlay via callbacks after done()
 * - Undo works via onTerminalInput: snapshots text before each keypress
 * - Cut/Copy: overlay closes immediately, then action runs (non-blocking)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { MODULES, emitEvent, UNIPI_EVENTS, INPUT_SHORTCUTS_COMMANDS } from "@pi-unipi/core";
import { RegisterStore } from "./registers.ts";
import { UndoRedoBuffer } from "./undo-redo.ts";
import { ChordOverlay, type ChordCallbacks } from "./chord-overlay.ts";
import { SettingsOverlay } from "./settings-overlay.ts";
import { loadConfig } from "./settings-overlay.ts";
import { copyToClipboard } from "./clipboard.ts";

// ─── Status feedback ────────────────────────────────────────────────────────

const STATUS_KEY = "input-shortcuts";
const STATUS_SUCCESS_MS = 2000;
const STATUS_ERROR_MS = 3000;

function showSuccess(ctx: ExtensionContext, text: string): void {
  ctx.ui.setStatus(STATUS_KEY, text);
  setTimeout(() => {
    try { ctx.ui.setStatus(STATUS_KEY, undefined); } catch {}
  }, STATUS_SUCCESS_MS);
}

function showError(ctx: ExtensionContext, text: string): void {
  ctx.ui.setStatus(STATUS_KEY, text);
  setTimeout(() => {
    try { ctx.ui.setStatus(STATUS_KEY, undefined); } catch {}
  }, STATUS_ERROR_MS);
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function inputShortcutsExtension(pi: ExtensionAPI): void {
  // Shared state
  const registers = new RegisterStore();
  const undoRedo = new UndoRedoBuffer();

  // Persistent UI reference (captured on first handler call, persists for session)
  let ui: ExtensionContext["ui"] | null = null;
  let inputListenerRegistered = false;

  // ─── Text change detection via onTerminalInput ────────────────────────
  // Snapshots the editor text BEFORE each keypress, enabling undo for typed text.
  //
  // Three independent triggers commit a snapshot (they don't conflict):
  //   1. Pause: user stops typing for 500ms → snapshot the text before this typing session
  //   2. Count: user types 20+ characters since last snapshot → snapshot mid-typing
  //   3. Time: 3 seconds elapsed since last snapshot (even if still typing) → snapshot
  //
  // How it works:
  //   - On each keypress, capture text BEFORE the editor processes it
  //   - `pendingSnapshot` = text before the current typing session started (first keypress)
  //   - `keystrokeCount` = how many edit keys pressed since last snapshot
  //   - `lastSnapshotAt` = timestamp of last snapshot commit
  //   - 500ms timer resets on each keypress (fires only on pause)
  //
  // Example: user types "hello world" continuously:
  //   - Key 1: pendingSnapshot = "", count=1
  //   - Key 10: count=10 (no trigger yet)
  //   - Key 20: count=20 → COMMIT snapshot="", reset. Now pendingSnapshot=current
  //   - User pauses 500ms → COMMIT snapshot=current, reset
  //
  // Example: user types slowly (1 char per second):
  //   - Key 1: pendingSnapshot="", count=1, timer starts
  //   - Key 2 (1s later): timer was reset, count=2
  //   - ... (timer fires after each pause between keys)
  //   - Each pause triggers a snapshot

  let pendingSnapshot: string | null = null;
  let keystrokeCount = 0;
  let lastSnapshotAt = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  const SNAPSHOT_PAUSE_MS = 500;    // pause trigger
  const SNAPSHOT_COUNT_THRESHOLD = 20; // character count trigger
  const SNAPSHOT_TIME_MS = 3000;    // time trigger

  /** Commit the pending snapshot and reset all tracking state. */
  function commitSnapshot(): void {
    if (pendingSnapshot !== null) {
      undoRedo.snapshot(pendingSnapshot);
    }
    pendingSnapshot = null;
    keystrokeCount = 0;
    lastSnapshotAt = Date.now();
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
  }

  function setupInputListener(): void {
    if (inputListenerRegistered || !ui) return;
    inputListenerRegistered = true;

    ui.onTerminalInput((data: string) => {
      if (!ui) return;

      // Only snapshot for edit keys (printable, backspace, delete, enter)
      const isEditKey = data.length === 1 || data === "\x7f" || data === "\x1b[3~" || data === "\r" || data === "\n";
      if (!isEditKey) return;

      // Capture text BEFORE the keypress is processed by the editor
      const textBefore = ui.getEditorText();

      // On first keypress of a new session, store the pending snapshot
      if (pendingSnapshot === null) {
        pendingSnapshot = textBefore;
        lastSnapshotAt = Date.now();
      }

      keystrokeCount++;

      // ─── Trigger 1: Character count threshold (20 chars) ─────────
      if (keystrokeCount >= SNAPSHOT_COUNT_THRESHOLD) {
        commitSnapshot();
        // Don't return — let the pause timer restart below
      }

      // ─── Trigger 2: Time threshold (3 seconds) ───────────────────
      if (pendingSnapshot !== null && Date.now() - lastSnapshotAt >= SNAPSHOT_TIME_MS) {
        commitSnapshot();
      }

      // ─── Trigger 3: Pause timer (500ms after last keypress) ──────
      // Reset the pause timer on each keypress
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
      }
      snapshotTimer = setTimeout(() => {
        // User stopped typing — commit the snapshot
        if (pendingSnapshot !== null) {
          commitSnapshot();
        }
      }, SNAPSHOT_PAUSE_MS);
    });
  }

  // ─── Action implementations ───────────────────────────────────────────
  // These run OUTSIDE the overlay — editor API is fully accessible.

  function doStash(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    if (text.length > 0) {
      undoRedo.snapshot(text); // snapshot before clearing
      registers.setStash(text);
      ctx.ui.setEditorText("");
      showSuccess(ctx, "✓ stash saved");
    } else {
      const stash = registers.getStash();
      if (stash.length === 0) {
        showError(ctx, "stash empty");
        return;
      }
      undoRedo.snapshot(""); // snapshot empty state before restoring
      ctx.ui.setEditorText(stash);
      showSuccess(ctx, "✓ stash restored");
    }
  }

  function doUndo(ctx: ExtensionContext): void {
    const current = ctx.ui.getEditorText();
    const result = undoRedo.undo(current);
    if (result.ok) {
      ctx.ui.setEditorText(result.text);
      showSuccess(ctx, "✓ undo");
    } else {
      showError(ctx, "nothing to undo");
    }
  }

  function doRedo(ctx: ExtensionContext): void {
    const current = ctx.ui.getEditorText();
    const result = undoRedo.redo(current);
    if (result.ok) {
      ctx.ui.setEditorText(result.text);
      showSuccess(ctx, "✓ redo");
    } else {
      showError(ctx, "nothing to redo");
    }
  }

  function doAppendRegister(ctx: ExtensionContext, index: number): void {
    const regText = registers.getRegister(index);
    if (regText.length === 0) {
      showError(ctx, `register ${index} empty`);
      return;
    }
    const current = ctx.ui.getEditorText();
    undoRedo.snapshot(current);
    ctx.ui.setEditorText(current + regText);
    showSuccess(ctx, `✓ register ${index} appended`);
  }

  function doAppendStash(ctx: ExtensionContext): void {
    const stashText = registers.getStash();
    if (stashText.length === 0) {
      showError(ctx, "stash empty");
      return;
    }
    const current = ctx.ui.getEditorText();
    undoRedo.snapshot(current);
    ctx.ui.setEditorText(current + stashText);
    showSuccess(ctx, "✓ stash appended");
  }

  function doCopy(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    if (text.length === 0) {
      showError(ctx, "nothing to copy");
      return;
    }
    const result = copyToClipboard(text);
    if (result.ok) {
      showSuccess(ctx, "✓ copied");
    } else {
      showError(ctx, result.reason ?? "clipboard unavailable");
    }
  }

  function doCut(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    if (text.length === 0) {
      showError(ctx, "nothing to cut");
      return;
    }
    const result = copyToClipboard(text);
    if (result.ok) {
      undoRedo.snapshot(text); // snapshot before clearing
      ctx.ui.setEditorText("");
      showSuccess(ctx, "✓ cut");
    } else {
      showError(ctx, result.reason ?? "clipboard unavailable");
    }
  }

  function doToggleThinking(): void {
    const current = pi.getThinkingLevel();
    const THINKING_CYCLE = ["off", "low", "medium", "high", "xhigh"] as const;
    const idx = THINKING_CYCLE.indexOf(current as any);
    const nextIdx = idx >= 0 ? (idx + 1) % THINKING_CYCLE.length : 0;
    const next = THINKING_CYCLE[nextIdx];
    pi.setThinkingLevel(next as any);
    // Note: no ctx available here for status, but thinking level is visible in UI
  }

  // ─── Register ALT+S shortcut — opens chord overlay ─────────────────────

  pi.registerShortcut(Key.alt("s"), {
    description: "Input shortcuts — stash, undo, redo, copy, cut, toggle thinking",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      // Capture persistent UI reference and setup input listener (once)
      if (!ui) {
        ui = ctx.ui;
        setupInputListener();
      }

      void ctx.ui.custom<void>(
        async (tui, theme, keybindings, done) => {
          const callbacks: ChordCallbacks = {
            onStash: () => doStash(ctx),
            onUndo: () => doUndo(ctx),
            onRedo: () => doRedo(ctx),
            onAppendRegister: (index) => doAppendRegister(ctx, index),
            onAppendStash: () => doAppendStash(ctx),
            onCopy: () => doCopy(ctx),
            onCut: () => doCut(ctx),
            onToggleThinking: () => doToggleThinking(),
          };

          return new ChordOverlay(tui, theme, keybindings, done, callbacks);
        },
        {
          overlay: true,
          overlayOptions: {
            width: 42,
            maxHeight: 20,
            anchor: "top-center",
            margin: { top: 2, left: 2, right: 2 },
          },
        },
      );
    },
  });

  // ─── Register ALT+I shortcut — insert tab ──────────────────────────────

  pi.registerShortcut(Key.alt("i"), {
    description: "Insert tab character into input",
    handler: async (ctx: ExtensionContext) => {
      const text = ctx.ui.getEditorText();
      ctx.ui.setEditorText(text + "\t");
    },
  });

  // ─── Register /unipi:stash-settings command ────────────────────────────

  pi.registerCommand(`unipi:${INPUT_SHORTCUTS_COMMANDS.STASH_SETTINGS}`, {
    description: "Open input shortcuts settings overlay to customize keybindings",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      void ctx.ui.custom<void>(
        async (_tui, _theme, _keybindings, done) => {
          return new SettingsOverlay(done);
        },
        {
          overlay: true,
          overlayOptions: {
            width: "60%",
            minWidth: 40,
            maxHeight: "50%",
            anchor: "top-center",
            margin: { top: 2, left: 2, right: 2 },
          },
        },
      );
    },
  });

  // ─── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    pendingSnapshot = null;
    keystrokeCount = 0;
    lastSnapshotAt = 0;
    undoRedo.clear();
  });

  // ─── Info-screen registration ────────────────────────────────────────────

  const globalObj = globalThis as any;
  const registry = globalObj.__unipi_info_registry;
  if (registry) {
    registry.registerGroup({
      id: "input-shortcuts",
      name: "Input Shortcuts",
      icon: "⌨️",
      priority: 115,
      config: {
        showByDefault: true,
        stats: [
          { id: "chordKey", label: "Chord key", show: true },
          { id: "tabInsertKey", label: "Tab insert key", show: true },
          { id: "registersUsed", label: "Registers used", show: true },
          { id: "stashStatus", label: "Stash", show: true },
        ],
      },
      dataProvider: async () => {
        const config = loadConfig();
        let used = 0;
        for (let i = 0; i <= 9; i++) {
          if (registers.getRegister(i).length > 0) used++;
        }
        return {
          chordKey: { value: config.chordKey, detail: "Key to open shortcuts overlay" },
          tabInsertKey: { value: config.tabInsertKey, detail: "Key to insert tab" },
          registersUsed: { value: `${used}/10`, detail: "Non-empty numbered registers" },
          stashStatus: { value: registers.getStash().length > 0 ? "set" : "empty", detail: "Stash register" },
        };
      },
    });
  }

  // ─── Module ready event ──────────────────────────────────────────────────

  emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
    name: MODULES.INPUT_SHORTCUTS,
    version: "0.1.0",
    commands: [`unipi:${INPUT_SHORTCUTS_COMMANDS.STASH_SETTINGS}`],
    tools: [],
  });
}
