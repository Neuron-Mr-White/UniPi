/**
 * @pi-unipi/input-shortcuts — Extension entry point
 *
 * Registers ALT+S (chord overlay) and ALT+I (tab insert) shortcuts.
 * Keybinding customization lives in /unipi:settings (Input Shortcuts group).
 *
 * ARCHITECTURE:
 * - The overlay ONLY captures action selection (pure UI, no side effects)
 * - All actions execute OUTSIDE the overlay via callbacks after done()
 * - Undo history: a BurstTracker watches onTerminalInput and records the
 *   editor text twice per typing burst (open + close) — O(1) per keystroke.
 * - Y copies the LAST ASSISTANT RESPONSE via pi's copyToClipboard;
 *   K adds the editor text to the kanboard backlog (no title).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { MODULES, emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";
import { RegisterStore } from "./registers.ts";
import { EditHistory } from "./undo-redo.ts";
import { BurstTracker } from "./burst.ts";
import { getLastResponseText, type SessionEntryLike } from "./last-response.ts";
import { ChordOverlay, type ChordCallbacks } from "./chord-overlay.ts";
import { loadConfig } from "./settings.ts";
import { installClearedInput } from "./cleared-input.ts";

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
  const history = new EditHistory();
  const burst = new BurstTracker({
    getText: () => ui?.getEditorText() ?? "",
    record: (text) => history.record(text),
    now: Date.now,
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  // Persistent UI reference (captured when the tracker installs, persists for session)
  let ui: ExtensionContext["ui"] | null = null;
  let uninstallInput: (() => void) | null = null;

  /**
   * Install the burst tracker on the editor input stream — idempotent.
   * Called from session_start (so history exists before the first chord)
   * and lazily from the chord handler as a fallback.
   */
  function installBurstTracker(ctx: ExtensionContext): void {
    if (uninstallInput || !ctx.hasUI) return;
    ui = ctx.ui;
    uninstallInput = ctx.ui.onTerminalInput(() => {
      burst.onInput();
    });
  }

  // ─── Action implementations ───────────────────────────────────────────
  // These run OUTSIDE the overlay — editor API is fully accessible.

  function doStash(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    if (text.length > 0) {
      history.record(text); // state before clearing
      registers.setStash(text);
      ctx.ui.setEditorText("");
      history.record("");
      showSuccess(ctx, "✓ stash saved");
    } else {
      const stash = registers.getStash();
      if (stash.length === 0) {
        showError(ctx, "stash empty");
        return;
      }
      history.record("");
      ctx.ui.setEditorText(stash);
      history.record(stash);
      showSuccess(ctx, "✓ stash restored");
    }
  }

  function doUndo(ctx: ExtensionContext): void {
    burst.close(); // capture un-flushed typing before stepping
    const current = ctx.ui.getEditorText();
    const result = history.undo(current);
    if (result.ok) {
      ctx.ui.setEditorText(result.text);
      showSuccess(ctx, "✓ undo");
    } else {
      showError(ctx, "nothing to undo");
    }
  }

  function doRedo(ctx: ExtensionContext): void {
    burst.close();
    const current = ctx.ui.getEditorText();
    const result = history.redo(current);
    if (result.ok) {
      ctx.ui.setEditorText(result.text);
      showSuccess(ctx, "✓ redo");
    } else {
      showError(ctx, "nothing to redo");
    }
  }

  function doAppendStash(ctx: ExtensionContext): void {
    const stashText = registers.getStash();
    if (stashText.length === 0) {
      showError(ctx, "stash empty");
      return;
    }
    const before = ctx.ui.getEditorText();
    history.record(before);
    const after = before + stashText;
    ctx.ui.setEditorText(after);
    history.record(after);
    showSuccess(ctx, "✓ stash appended");
  }

  async function doCopyLastResponse(ctx: ExtensionContext): Promise<void> {
    const entries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    const text = getLastResponseText(entries);
    if (!text) {
      showError(ctx, "no response to copy");
      return;
    }
    try {
      await copyToClipboard(text);
      showSuccess(ctx, "✓ copied last response");
    } catch (error) {
      showError(ctx, `copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function doKanboard(ctx: ExtensionContext): Promise<void> {
    const text = ctx.ui.getEditorText();
    if (text.trim().length === 0) {
      showError(ctx, "nothing to add");
      return;
    }
    const api = globalThis.__unipi_kanboard_api;
    if (!api) {
      showError(ctx, "kanboard not loaded");
      return;
    }
    let result: Awaited<ReturnType<typeof api.captureToBacklog>>;
    try {
      result = await api.captureToBacklog({ cwd: ctx.cwd, text });
    } catch (error) {
      showError(ctx, `kanboard: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!result.ok) {
      showError(ctx, result.reason);
      return;
    }
    // The capture takes ~100ms; only clear the editor if the user has not
    // typed since — otherwise the new text stays and just gets the status.
    if (ctx.ui.getEditorText() === text) {
      history.record(text); // state before clearing
      ctx.ui.setEditorText("");
      history.record("");
    }
    const att = `(${result.attachments} attachment${result.attachments === 1 ? "" : "s"})`;
    showSuccess(ctx, `✓ ${result.id} added to Backlog ${att}`);
  }

  // ─── Register ALT+S shortcut — opens chord overlay ─────────────────────

  pi.registerShortcut(Key.alt("s"), {
    description: "Input shortcuts — stash, undo, redo, append stash, copy last response, kanboard",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;

      // Fallback install (session_start normally did this already).
      installBurstTracker(ctx);

      void ctx.ui.custom<void>(
        async (tui, theme, keybindings, done) => {
          const callbacks: ChordCallbacks = {
            onStash: () => doStash(ctx),
            onUndo: () => doUndo(ctx),
            onRedo: () => doRedo(ctx),
            onAppendStash: () => doAppendStash(ctx),
            onCopyLastResponse: () => doCopyLastResponse(ctx),
            onKanboard: () => doKanboard(ctx),
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

  // ─── Ctrl+C keeps the cleared text (struck through, ↑ restores) ────────
  installClearedInput(pi);

  // ─── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    installBurstTracker(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (uninstallInput) {
      uninstallInput();
      uninstallInput = null;
    }
    burst.cancel();
    ui = null;
    history.clear();
  });

  // ─── Info-screen registration ────────────────────────────────────────────

  const registry = globalThis.__unipi_info_registry;
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
          { id: "stashStatus", label: "Stash", show: true },
        ],
      },
      dataProvider: async () => {
        const config = loadConfig();
        return {
          raw: { value: "", raw: { chordKey: config.chordKey, tabInsertKey: config.tabInsertKey, stash: registers.getStash().length } },
          chordKey: { value: config.chordKey, detail: "Key to open shortcuts overlay" },
          tabInsertKey: { value: config.tabInsertKey, detail: "Key to insert tab" },
          stashStatus: { value: registers.getStash().length > 0 ? "set" : "empty", detail: "Stash register" },
        };
      },
    });
  }

  // ─── Module ready event ──────────────────────────────────────────────────

  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
    name: MODULES.INPUT_SHORTCUTS,
    version: "0.1.0",
    commands: [],
    tools: [],
  });
}
