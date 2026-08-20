/**
 * @pi-unipi/mcp — Extension entry point
 *
 * Registers commands, handles session lifecycle, wires up MCP server management.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  MCP_COMMANDS,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import type { ResolvedServer } from "./types.js";
import { loadAndResolve, getGlobalConfigDir } from "./config/manager.js";
import { syncCatalog } from "./config/sync.js";
import { ServerRegistry } from "./bridge/registry.js";
import { compareCodeUnits } from "./bridge/translator.js";
import { renderMcpAddOverlay } from "./tui/add-overlay.js";
import { renderMcpSettingsOverlay } from "./tui/settings-overlay.js";

/** Package version */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Module-local registry instance */
let registry: ServerRegistry | null = null;

/** Get info registry from global */
function getInfoRegistry() {
  return globalThis.__unipi_info_registry;
}

/** Get the server registry (for commands) */
function getRegistry(): ServerRegistry | null {
  return registry;
}

export default function (pi: ExtensionAPI) {

  // Session start — load configs, start servers
  pi.on("session_start", async (_event, ctx) => {
    // Create registry with pi integration callbacks
    const toolApi = pi as ExtensionAPI & {
      registerExternalTool?: (tool: unknown) => void;
      unregisterTool?: (toolName: string) => void;
      unregisterExternalTool?: (toolName: string) => void;
    };
    const registerTool = typeof toolApi.registerTool === "function"
      ? (tool: unknown) => toolApi.registerTool(tool as Parameters<typeof toolApi.registerTool>[0])
      : typeof toolApi.registerExternalTool === "function"
        ? (tool: unknown) => toolApi.registerExternalTool!(tool)
        : () => {
            throw new Error("Pi does not expose a supported MCP tool registration API");
          };
    const canUnregisterTools =
      typeof toolApi.unregisterTool === "function" ||
      typeof toolApi.unregisterExternalTool === "function";
    const unregisterTool = typeof toolApi.unregisterTool === "function"
      ? (toolName: string) => toolApi.unregisterTool!(toolName)
      : typeof toolApi.unregisterExternalTool === "function"
        ? (toolName: string) => toolApi.unregisterExternalTool!(toolName)
        : () => {};

    registry = new ServerRegistry({
      emitEvent: (event, payload) => emitEvent(pi, event, payload),
      registerTool,
      unregisterTool,
      canUnregisterTools,
    });

    // Load and resolve server configs
    const cwd = ctx.cwd ?? process.cwd();
    let servers: ResolvedServer[] = [];

    try {
      const result = loadAndResolve(cwd);
      servers = result.servers;
    } catch (_err) {
      // Config load failure — servers will be empty, visible via /unipi:mcp-status.
    }

    // Connect/discover in parallel, then register the successful combined set
    // after a barrier so tool order is stable across runs.
    try {
      await registry.startServers(servers.filter((server) => server.enabled));
    } catch (_err) {
      // Errors are tracked in registry state and surfaced by the info screen.
    }

    // Register info-screen group
    const infoRegistry = getInfoRegistry();
    if (infoRegistry && registry) {
      const reg = registry;
      infoRegistry.registerGroup({
        id: "mcp",
        name: "MCP Servers",
        icon: "🔌",
        priority: 15,
        config: {
          showByDefault: true,
          stats: [
            { id: "total", label: "Total servers", show: true },
            { id: "active", label: "Active", show: true },
            { id: "tools", label: "Total tools", show: true },
            { id: "failed", label: "Failed", show: true },
          ],
        },
        dataProvider: async () => {
          try {
            const all = reg.getAll();
            const active = reg.getActive();
            const failed = reg.getFailed();
            const toolCount = reg.getTotalToolCount();
            return {
              total: { value: String(all.length) },
              active: { value: String(active.length) },
              tools: { value: String(toolCount) },
              failed: {
                value: String(failed.length),
                detail:
                  failed.length > 0
                    ? failed.map((f) => f.name).join(", ")
                    : undefined,
              },
            };
          } catch (err) {
            // Removed console.error — info-screen shows "?" on error.
            return {
              total: { value: "?" },
              active: { value: "?" },
              tools: { value: "?" },
              failed: { value: "?" },
            };
          }
        },
      });
      // Trigger initial data fetch so the info overlay shows real values
      // instead of the empty GroupData from notifyGroupRegistered.
      infoRegistry.getGroupData("mcp").catch(() => {});
    }

    // Emit MODULE_READY
    const activeServers = registry?.getActive() ?? [];
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.MCP,
      version: VERSION,
      commands: [
        `unipi:${MCP_COMMANDS.ADD}`,
        `unipi:${MCP_COMMANDS.SETTINGS}`,
        `unipi:${MCP_COMMANDS.SYNC}`,
        `unipi:${MCP_COMMANDS.STATUS}`,
        `unipi:${MCP_COMMANDS.RELOAD}`,
      ],
      tools: activeServers
        .flatMap((server) => registry?.getEntry(server.name)?.toolNames ?? [])
        .sort(compareCodeUnits),
    });
  });

  // Session shutdown tears down clients. Pi tears down this extension's tool
  // registry itself, so do not claim per-tool unregistration here.
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (registry) {
      await registry.disconnectAll();
      registry = null;
    }
  });

  // ── Register commands ─────────────────────────────────────────

  // /unipi:mcp-status — text summary of all servers
  pi.registerCommand(`unipi:${MCP_COMMANDS.STATUS}`, {
    description: "Show status of all configured MCP servers",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const reg = getRegistry();
      if (!reg) {
        ctx.ui.notify("MCP extension not initialized", "warning");
        return;
      }

      const all = reg.getAll();
      if (all.length === 0) {
        ctx.ui.notify("No MCP servers configured. Use /unipi:mcp-add to add one.", "info");
        return;
      }

      const lines: string[] = ["MCP Server Status:\n"];

      for (const state of all) {
        const icon =
          state.status === "running"
            ? "●"
            : state.status === "error"
              ? "✗"
              : state.status === "starting"
                ? "◐"
                : "○";

        const toolInfo =
          state.status === "running" && state.toolCount > 0
            ? ` (${state.toolCount} tools)`
            : state.status === "error" && state.error
              ? ` — ${state.error}`
              : "";

        lines.push(`${icon} ${state.name} — ${state.status}${toolInfo}`);
      }

      const totalTools = reg.getTotalToolCount();
      const active = reg.getActive().length;
      lines.push(
        `\n---\n${active} active, ${reg.getFailed().length} failed, ${totalTools} total tools`,
      );

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /unipi:mcp-sync — force catalog sync
  pi.registerCommand(`unipi:${MCP_COMMANDS.SYNC}`, {
    description: "Sync MCP server catalog from GitHub",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        ctx.ui.notify("Syncing MCP catalog from GitHub...", "info");
        const catalog = await syncCatalog();
        emitEvent(pi, UNIPI_EVENTS.MCP_CATALOG_SYNCED, {
          totalServers: catalog.totalServers,
          source: catalog.source,
        });
        ctx.ui.notify(
          `MCP Catalog Synced\nSource: ${catalog.source}\nServers: ${catalog.totalServers}\nUpdated: ${catalog.lastUpdated}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `MCP sync failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // /unipi:mcp-add — add server overlay
  pi.registerCommand(`unipi:${MCP_COMMANDS.ADD}`, {
    description: "Add an MCP server (browse catalog or custom config)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("MCP Add requires an interactive UI.", "warning");
        return;
      }

      ctx.ui.custom(
        renderMcpAddOverlay({
          onComplete: () => {
            ctx.ui.notify("MCP server saved. Restart pi to activate.", "info");
          },
        }),
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            minWidth: 80,
            anchor: "center",
            margin: 2,
          },
        },
      );
    },
  });

  // /unipi:mcp-settings — settings overlay
  pi.registerCommand(`unipi:${MCP_COMMANDS.SETTINGS}`, {
    description: "Manage MCP server settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("MCP Settings requires an interactive UI.", "warning");
        return;
      }

      const cwd = ctx.cwd ?? process.cwd();

      function openSettings() {
        ctx.ui.custom(
          renderMcpSettingsOverlay({
            registry: registry ?? undefined,
            cwd,
            onComplete: () => {},
          }),
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 70,
              anchor: "center",
              margin: 2,
            },
          },
        );
      }

      openSettings();
    },
  });

  // /unipi:mcp-reload — restart all MCP servers
  pi.registerCommand(`unipi:${MCP_COMMANDS.RELOAD}`, {
    description: "Explain how to reload MCP servers safely",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Pi 0.80 does not expose dynamic tool removal. Restarting in place can
      // leave stale schemas in the provider-visible tool list, so require a
      // process/extension restart to establish a clean cache epoch.
      ctx.ui.notify("Restart Pi to reload MCP servers and tool schemas safely.", "info");
    },
  });
}
