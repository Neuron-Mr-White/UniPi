/**
 * @pi-unipi/input-shortcuts — Extension entry point
 *
 * Registers ALT+S (chord overlay) and ALT+I (tab insert) shortcuts.
 * Provides /unipi:stash-settings command for keybinding customization.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { RegisterStore } from "./registers.js";
import { UndoRedoBuffer } from "./undo-redo.js";
import { ChordOverlay, type ChordCallbacks } from "./chord-overlay.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { loadConfig } from "./settings-overlay.js";

export default function inputShortcutsExtension(pi: ExtensionAPI): void {
  // Shared state
  const registers = new RegisterStore();
  const undoRedo = new UndoRedoBuffer();

  // Thinking toggle callbacks — need pi reference
  const chordCallbacks: ChordCallbacks = {
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: (level) => pi.setThinkingLevel(level as any),
  };

  // ─── Register ALT+S shortcut — opens chord overlay ─────────────────────

  pi.registerShortcut(Key.alt("s"), {
    description: "Input shortcuts — stash, undo, redo, copy, cut, toggle thinking",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      void ctx.ui.custom<void>(
        async (tui, theme, keybindings, done) => {
          const overlay = new ChordOverlay(
            tui,
            theme,
            keybindings,
            () => done(),
            ctx,
            registers,
            undoRedo,
            chordCallbacks,
          );
          return overlay;
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

  pi.registerCommand("stash-settings", {
    description: "Open input shortcuts settings overlay to customize keybindings",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      void ctx.ui.custom<void>(
        async (_tui, _theme, _keybindings, done) => {
          return new SettingsOverlay(
            () => done(),
          );
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
}
