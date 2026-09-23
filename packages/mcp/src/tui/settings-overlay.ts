/**
 * @pi-unipi/mcp — Settings overlay TUI (hub-kit look)
 *
 * Interactive list of configured MCP servers: enable/disable toggle, edit,
 * delete (with confirm), scope switching via `g`, and sync trigger.
 *
 * Visual + key contract come from the shared hub kit: ▌ group mark, header
 * band, bottom hint line, exact-width rows, relative-height viewport, and
 * ↑↓/jk · Enter/Tab activate · Space quick · g scope · Esc back.
 */

import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ServerState } from "../types.js";
import {
  loadMcpConfig,
  saveMcpConfig,
  loadMetadata,
  saveMetadata,
  getGlobalConfigDir,
  getProjectConfigDir,
} from "../config/manager.js";
import {
  boxInnerWidth,
  frameOverlay,
  hubBoldText as bold,
  hubClampScroll,
  hubExactRow,
  hubFrameTitle,
  hubHeaderBand,
  hubHintLine,
  hubTheme,
  hubKey,
  hubMaxRows,
  hubMarkSpan,
  hubMoreAbove,
  hubMoreBelow,
  hubRowColumns,
  setHubTheme,
  type HubKey,
} from "@pi-unipi/core";

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
  scroll: number;
  viewScope: "global" | "project";
  confirmDelete: string | null;
}

/** Namespace whose package color paints the ▌ mark (mcp = green). */
const MARK_NS = "mcp";

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
  /** Terminal rows for the relative-height viewport (default 30). */
  terminalRows?: number;
}) {
  return (
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    done: (result: { action?: string } | null) => void,
  ) => {
    setHubTheme(theme);
    const registry = params?.registry;
    const cwd = params?.cwd ?? process.cwd();

    const state: SettingsOverlayState = {
      servers: [],
      selectedIndex: 0,
      scroll: 0,
      viewScope: "global",
      confirmDelete: null,
    };

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
      state.scroll = hubClampScroll(
        state.servers.map(() => "row"),
        state.selectedIndex,
        state.scroll,
        viewportRows(),
      );
    }

    /** Relative-height viewport (~hub proportions, minus band + hint). */
    function viewportRows(): number {
      return hubMaxRows(params?.terminalRows ?? 30, 2);
    }

    // Initial load
    refreshServers();

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

        // Pi 0.80 cannot remove a registered tool definition at runtime.
        // Persist the setting now; the next Pi restart applies the new set as
        // one deterministic cache epoch.
        refreshServers();
      } catch {
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
          return;
        }
        if (data === "n" || data === "N" || hubKey(data) === "back") {
          state.confirmDelete = null;
          return;
        }
        return;
      }

      const key: HubKey = hubKey(data);

      if (key === "back") {
        done(null);
        return;
      }

      if (key === "up" || key === "down") {
        const next = state.selectedIndex + (key === "down" ? 1 : -1);
        if (next >= 0 && next < state.servers.length) {
          state.selectedIndex = next;
          state.scroll = hubClampScroll(
            state.servers.map(() => "row"),
            state.selectedIndex,
            state.scroll,
            viewportRows(),
          );
        }
        return;
      }

      // Space = quick action: toggle enable/disable
      if (key === "quick") {
        void toggleServer(state.selectedIndex);
        return;
      }

      // `g` toggles scope (global ↔ project) — replaces the old g/p pair.
      if (typeof key === "object" && key.char === "g") {
        state.viewScope = state.viewScope === "global" ? "project" : "global";
        refreshServers();
        return;
      }

      // `x`: delete (with confirmation) — `d` stays "default" in the hub.
      if (typeof key === "object" && key.char === "x") {
        const server = state.servers[state.selectedIndex];
        if (server) state.confirmDelete = server.name;
        return;
      }

      // Enter/Tab = activate: open the server detail/edit flow.
      if (key === "activate") {
        // Edit UI is not implemented yet — reserved (same as before).
        return;
      }

      // `a`: add (opens the add overlay via the host action wiring)
      if (typeof key === "object" && key.char === "a") {
        done({ action: "add" });
        return;
      }

      // `s`: sync
      if (typeof key === "object" && key.char === "s") {
        done({ action: "sync" });
        return;
      }
    }

    function render(rawWidth: number): string[] {
      const width = rawWidth;
      const inner = boxInnerWidth(width);
      const body: string[] = [];

      // ── Header band ─────────────────────────────────────────────
      body.push(hubHeaderBand({
        inner,
        namespace: MARK_NS,
        text: `MCP servers — ${state.viewScope} · ${state.servers.length} configured`,
      }));

      // ── Server window (relative height) ─────────────────────────
      const rows = viewportRows();
      state.scroll = hubClampScroll(
        state.servers.map(() => "row"),
        state.selectedIndex,
        state.scroll,
        rows,
      );
      if (state.scroll > 0) body.push(hubMoreAbove(state.scroll, inner));

      const end = Math.min(state.servers.length, state.scroll + rows);
      for (let i = state.scroll; i < end; i++) {
        const server = state.servers[i]!;
        const selected = i === state.selectedIndex;

        const statusIcon =
          server.status === "running" ? "●" :
          server.status === "error" ? "✗" :
          server.enabled ? "○" : "○";

        const label = `${statusIcon} ${server.enabled ? "" : "disabled · "}${server.name}`;
        const tools =
          server.status === "running" && server.toolCount > 0
            ? `${server.toolCount} tools`
            : server.status === "error" && server.error
              ? truncate(server.error, 20)
              : "stopped";
        const value = `${truncate(server.command, 24)} · ${tools} · [${server.source}]`;

        body.push(hubExactRow(hubRowColumns({
          inner,
          selected,
          label,
          value,
          markNamespace: MARK_NS,
        }), inner));
      }
      const below = state.servers.length - end;
      if (below > 0) body.push(hubMoreBelow(below, inner));

      // ── Confirm delete ──────────────────────────────────────────
      if (state.confirmDelete) {
        body.push(hubExactRow(hubMarkSpan(MARK_NS) + bold(` ⚠ Delete '${state.confirmDelete}'? y/n`), inner));
      }

      // ── Hint line ───────────────────────────────────────────────
      body.push(hubHintLine(
        "↑↓/jk move · enter edit · space toggle · a add · s sync · x delete · g scope · esc close",
        inner,
      ));

      return frameOverlay(body, width, {
        title: bold(hubFrameTitle("mcp", [], `— ${state.viewScope}`)),
        borderFg: (t) => hubTheme.fg("borderMuted", t),
      });

      function truncate(text: string, n: number): string {
        return text.length > n ? text.slice(0, n - 1) + "…" : text;
      }
    }

    return {
      render,
      invalidate: () => tui.requestRender(),
      handleInput,
    };
  };
}
