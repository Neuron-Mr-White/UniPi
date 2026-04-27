/**
 * @pi-unipi/mcp — Settings overlay TUI
 *
 * Interactive list of configured MCP servers with enable/disable toggle,
 * edit, delete, scope switching, and sync trigger.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ServerState } from "../types.js";
import {
  loadMcpConfig,
  saveMcpConfig,
  loadMetadata,
  saveMetadata,
  getGlobalConfigDir,
  getProjectConfigDir,
} from "../config/manager.js";

/** Server display item */
interface ServerDisplayItem {
  name: string;
  status: ServerState["status"];
  command: string;
  toolCount: number;
  source: "G" | "P" | "P↑";
  enabled: boolean;
  error?: string;
}

/** State for the settings overlay */
interface SettingsOverlayState {
  servers: ServerDisplayItem[];
  selectedIndex: number;
  viewScope: "global" | "project";
  confirmDelete: string | null;
}

/**
 * Render the MCP settings overlay.
 */
export function renderMcpSettingsOverlay(params?: {
  registry?: {
    getAll: () => ServerState[];
    getServerState: (name: string) => ServerState | null;
    startServer: (resolved: any) => Promise<void>;
    stopServer: (name: string) => Promise<void>;
  };
  cwd?: string;
  onComplete?: () => void;
}) {
  return (
    tui: any,
    theme: any,
    _kb: any,
    done: (result: { action?: string } | null) => void,
  ) => {
    const registry = params?.registry;
    const cwd = params?.cwd ?? process.cwd();

    const state: SettingsOverlayState = {
      servers: [],
      selectedIndex: 0,
      viewScope: "global",
      confirmDelete: null,
    };

    let cachedLines: string[] | undefined;

    function refreshServers() {
      const configDir =
        state.viewScope === "global"
          ? getGlobalConfigDir()
          : getProjectConfigDir(cwd);

      let config;
      try {
        config = loadMcpConfig(configDir);
      } catch {
        config = { mcpServers: {} };
      }

      let meta;
      try {
        meta = loadMetadata(configDir);
      } catch {
        meta = { servers: {}, sync: { enabled: true, lastSyncAt: null, syncIntervalMs: 86400000 } };
      }

      const items: ServerDisplayItem[] = [];

      for (const [name, def] of Object.entries(config.mcpServers)) {
        const serverMeta = meta.servers[name];
        const enabled = serverMeta?.enabled ?? true;
        const runtimeState = registry?.getServerState(name);

        items.push({
          name,
          status: runtimeState?.status ?? "stopped",
          command: `${def.command} ${(def.args ?? []).slice(0, 3).join(" ")}`,
          toolCount: runtimeState?.toolCount ?? 0,
          source: state.viewScope === "global" ? "G" : "P",
          enabled,
          error: runtimeState?.error,
        });
      }

      state.servers = items;
      if (state.selectedIndex >= items.length) {
        state.selectedIndex = Math.max(0, items.length - 1);
      }
    }

    // Initial load
    refreshServers();

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    async function toggleServer(index: number) {
      const server = state.servers[index];
      if (!server) return;

      const configDir =
        state.viewScope === "global"
          ? getGlobalConfigDir()
          : getProjectConfigDir(cwd);

      try {
        const meta = loadMetadata(configDir);
        const newEnabled = !server.enabled;

        meta.servers[server.name] = {
          ...(meta.servers[server.name] ?? {}),
          enabled: newEnabled,
          addedAt: meta.servers[server.name]?.addedAt ?? new Date().toISOString(),
        };
        saveMetadata(configDir, meta);

        // Try to stop if disabling
        if (!newEnabled && registry) {
          try {
            await registry.stopServer(server.name);
          } catch {
            // Ignore stop errors
          }
        }

        refreshServers();
        refresh();
      } catch (err) {
        // Silently fail
      }
    }

    function deleteServer(name: string) {
      const configDir =
        state.viewScope === "global"
          ? getGlobalConfigDir()
          : getProjectConfigDir(cwd);

      try {
        const config = loadMcpConfig(configDir);
        delete config.mcpServers[name];
        saveMcpConfig(configDir, config);

        const meta = loadMetadata(configDir);
        delete meta.servers[name];
        saveMetadata(configDir, meta);

        refreshServers();
        refresh();
      } catch {
        // Ignore errors
      }
    }

    function handleInput(data: string) {
      // Confirm delete mode
      if (state.confirmDelete) {
        if (data === "y" || data === "Y") {
          deleteServer(state.confirmDelete);
          state.confirmDelete = null;
          refresh();
          return;
        }
        if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
          state.confirmDelete = null;
          refresh();
          return;
        }
        return;
      }

      // Close
      if (matchesKey(data, Key.escape) || data === "q") {
        done(null);
        return;
      }

      // Navigation (arrows + vim j/k)
      if (matchesKey(data, Key.up) || data === "k") {
        if (state.selectedIndex > 0) {
          state.selectedIndex--;
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.down) || data === "j") {
        if (state.selectedIndex < state.servers.length - 1) {
          state.selectedIndex++;
          refresh();
        }
        return;
      }

      // Space: toggle enable/disable
      if (data === " ") {
        toggleServer(state.selectedIndex);
        return;
      }

      // 'g': switch to global view
      if (data === "g") {
        state.viewScope = "global";
        refreshServers();
        refresh();
        return;
      }

      // 'p': switch to project view
      if (data === "p") {
        state.viewScope = "project";
        refreshServers();
        refresh();
        return;
      }

      // 'd': delete (with confirmation)
      if (data === "d") {
        const server = state.servers[state.selectedIndex];
        if (server) {
          state.confirmDelete = server.name;
          refresh();
        }
        return;
      }

      // Enter/e: edit (placeholder)
      if (data === "\r" || data === "e") {
        // Edit not yet implemented in TUI — notify would need ctx
        return;
      }

      // 'a': add (would open add overlay — placeholder)
      if (data === "a") {
        done({ action: "add" });
        return;
      }

      // 's': sync
      if (data === "s") {
        done({ action: "sync" });
        return;
      }
    }

    /** Pad content to exact visible width, accounting for ANSI codes and emoji */
    function padVisible(content: string, targetWidth: number): string {
      const vw = visibleWidth(content);
      const pad = Math.max(0, targetWidth - vw);
      return content + " ".repeat(pad);
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const innerWidth = Math.max(22, width - 2);

      // ── Header ──────────────────────────────────────────────────────
      const header = " MCP Settings ";
      const scopeLabel = state.viewScope === "global" ? "● Global" : "● Project";
      const headerPad = Math.max(0, innerWidth - visibleWidth(header) - visibleWidth(scopeLabel));
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
        theme.bold(header) +
        theme.fg("accent", " ".repeat(headerPad) + scopeLabel) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      // ── Server list ─────────────────────────────────────────────────
      if (state.servers.length === 0) {
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("muted", " No servers configured"), innerWidth) +
          theme.fg("accent", "│"),
        );
      } else {
        for (let i = 0; i < state.servers.length; i++) {
          const server = state.servers[i];
          const selected = i === state.selectedIndex;

          const statusIcon =
            server.status === "running"
              ? theme.fg("success", "●")
              : server.status === "error"
                ? theme.fg("error", "✗")
                : server.enabled
                  ? theme.fg("muted", "○")
                  : theme.fg("dim", "○");

          const name = selected ? theme.bold(server.name) : theme.fg("text", server.name);
          const cmd = theme.fg("muted", truncateToWidth(server.command, 24));
          const tools =
            server.status === "running" && server.toolCount > 0
              ? theme.fg("accent", `${server.toolCount} tools`)
              : server.status === "error" && server.error
                ? theme.fg("error", truncateToWidth(server.error, 20))
                : theme.fg("dim", "stopped");

          const source = theme.fg("muted", `[${server.source}]`);
          const prefix = selected ? theme.fg("accent", "▸ ") : "  ";

          const line = ` ${prefix}${statusIcon} ${name}  ${cmd}  ${tools}  ${source}`;
          lines.push(
            theme.fg("accent", "│") +
            padVisible(truncateToWidth(line, innerWidth), innerWidth) +
            theme.fg("accent", "│"),
          );
        }
      }

      // ── Confirm delete ─────────────────────────────────────────────
      if (state.confirmDelete) {
        lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("warning", ` Delete '${state.confirmDelete}'? (y/n)`), innerWidth) +
          theme.fg("accent", "│"),
        );
      }

      // ── Keybinds ───────────────────────────────────────────────────
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
      const binds = " ↑↓ select  Space toggle  a add  s sync  g global  p project  d delete  q/Esc close";
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("muted", truncateToWidth(binds, innerWidth)), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `╰${"─".repeat(innerWidth)}╯`));

      cachedLines = lines;
      return lines;
    }

    return { render, invalidate: refresh, handleInput };
  };
}
