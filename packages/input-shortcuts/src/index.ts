/**
 * @pi-unipi/input-shortcuts — Extension entry point
 *
 * Registers ALT+S (chord overlay) and ALT+I (tab insert) shortcuts.
 * Provides /unipi:stash-settings command for keybinding customization.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { MODULES, emitEvent, UNIPI_EVENTS, INPUT_SHORTCUTS_COMMANDS } from "@pi-unipi/core";
import { RegisterStore } from "./registers.ts";
import { UndoRedoBuffer } from "./undo-redo.ts";
import { ChordOverlay, type ChordCallbacks } from "./chord-overlay.ts";
import { SettingsOverlay } from "./settings-overlay.ts";
import { loadConfig } from "./settings-overlay.ts";

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
