/**
 * Open the unified settings hub as an overlay — shared by /unipi:settings and
 * any module that wants to land the user on its own rows (`/unipi:skills`
 * opens it filtered to "skills").
 */

import { runCommandByName } from "../../command-runner.js";
import { HUB_OVERLAY_OPTIONS } from "../tui/hub-kit.js";
import { SettingsHub } from "./hub.js";

interface HubHostContext {
  hasUI: boolean;
  cwd?: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom<T>(factory: (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown, options?: unknown): Promise<T>;
  };
}

export async function openSettingsHub(ctx: HubHostContext, options: { filter?: string; onChanged?: (namespace: string) => void } = {}): Promise<void> {
  if (!ctx.hasUI) throw new Error("/unipi:settings needs the interactive TUI");
  await ctx.ui.custom<void>(
    (tui, _theme, _keybindings, done) => {
      const hub = new SettingsHub({
        cwd: ctx.cwd ?? process.cwd(),
        ...(options.filter ? { initialFilter: options.filter } : {}),
        ...(options.onChanged ? { onChanged: options.onChanged } : {}),
        runAction: async (command) => {
          const ran = await runCommandByName(command, ctx);
          if (!ran) ctx.ui.notify(`no handler registered for ${command}`, "warning");
        },
      });
      hub.onClose = () => done();
      return {
        focused: true,
        invalidate: () => hub.invalidate(),
        render: (width: number) => hub.render(width),
        handleInput: (data: string) => {
          hub.handleInput(data);
          tui.requestRender();
        },
        dispose: () => {},
      };
    },
    HUB_OVERLAY_OPTIONS,
  ).catch(() => {
    // Overlay errors are non-blocking.
  });
}
