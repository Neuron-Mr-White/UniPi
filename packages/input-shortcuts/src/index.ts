/**
 * @pi-unipi/input-shortcuts — Extension entry point
 *
 * Registers ALT+S (chord overlay) and ALT+I (tab insert) shortcuts.
 * Provides /unipi:stash-settings command for keybinding customization.
 *
 * IMPORTANT ARCHITECTURE:
 * The chord overlay ONLY captures the user's action selection.
 * All actions (stash, undo, copy, etc.) execute OUTSIDE the overlay
 * where ctx.ui.getEditorText() and setEditorText() actually work.
 * The overlay blocks the editor API while it's open.
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

  // ─── Action implementations ───────────────────────────────────────────
  // These run OUTSIDE the overlay — editor API is fully accessible.

  function doStash(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    if (text.length > 0) {
      undoRedo.snapshot(text);  // snapshot before clearing
      registers.setStash(text);
      ctx.ui.setEditorText("");
      showSuccess(ctx, "✓ stash saved");
    } else {
      const stash = registers.getStash();
      if (stash.length === 0) {
        showError(ctx, "stash empty");
        return;
      }
      undoRedo.snapshot("");  // snapshot empty state before restoring
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
      showError(ctx, result.reason === "throttled" ? "undo throttled" : "nothing to undo");
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
      undoRedo.snapshot(text);  // snapshot before clearing
      ctx.ui.setEditorText("");
      showSuccess(ctx, "✓ cut");
    } else {
      showError(ctx, result.reason ?? "clipboard unavailable");
    }
  }

  function doToggleThinking(ctx: ExtensionContext): void {
    const current = pi.getThinkingLevel();
    const THINKING_CYCLE = ["off", "low", "medium", "high", "xhigh"] as const;
    const idx = THINKING_CYCLE.indexOf(current as any);
    const nextIdx = idx >= 0 ? (idx + 1) % THINKING_CYCLE.length : 0;
    const next = THINKING_CYCLE[nextIdx];
    pi.setThinkingLevel(next as any);
    showSuccess(ctx, `thinking: ${next}`);
  }

  // ─── Register ALT+S shortcut — opens chord overlay ─────────────────────

  pi.registerShortcut(Key.alt("s"), {
    description: "Input shortcuts — stash, undo, redo, copy, cut, toggle thinking",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      // Snapshot current text before opening overlay (for undo on stash/cut)
      const preText = ctx.ui.getEditorText();

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
            onToggleThinking: () => doToggleThinking(ctx),
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
