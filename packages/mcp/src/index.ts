/**
 * @pi-unipi/mcp — Extension entry point
 *
 * Registers commands, handles session lifecycle, wires up MCP server management.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  MCP_COMMANDS,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import type { ResolvedServer } from "./types.js";
import { loadAndResolve, getGlobalConfigDir } from "./config/manager.js";
import { syncCatalog, loadCatalog } from "./config/sync.js";
import { ServerRegistry } from "./bridge/registry.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Module-local registry instance */
let registry: ServerRegistry | null = null;

/** Get info registry from global */
function getInfoRegistry() {
  const g = globalThis as any;
  return g.__unipi_info_registry;
}

/** Get the server registry (for commands) */
function getRegistry(): ServerRegistry | null {
  return registry;
}

export default function (pi: ExtensionAPI) {
  // Register skills directory
  const skillsDir = new URL("../skills", import.meta.url).pathname;
  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Session start — load configs, start servers
  pi.on("session_start", async (_event, ctx) => {
    // Create registry with pi integration callbacks
    registry = new ServerRegistry({
      emitEvent: (event, payload) => emitEvent(pi, event, payload),
      registerTool: (tool) => {
        try {
          (pi as any).registerTool?.(tool) ??
            (pi as any).registerExternalTool?.(tool);
        } catch {
          // Tool registration may not be available in all contexts
        }
      },
      unregisterTool: (toolName) => {
        try {
          (pi as any).unregisterTool?.(toolName) ??
            (pi as any).unregisterExternalTool?.(toolName);
        } catch {
          // Ignore
        }
      },
    });

    // Load and resolve server configs
    const cwd = ctx.cwd ?? process.cwd();
    let servers: ResolvedServer[] = [];

    try {
      const result = loadAndResolve(cwd);
      servers = result.servers;
    } catch (err) {
      console.error(
        "[MCP] Failed to load config:",
        err instanceof Error ? err.message : err,
      );
    }

    // Start enabled servers (parallel, non-blocking errors)
    const startPromises = servers
      .filter((s) => s.enabled)
      .map(async (server) => {
        try {
          await registry!.startServer(server);
          console.log(
            `[MCP] Started server '${server.name}' (${registry!.getServerState(server.name)?.toolCount ?? 0} tools)`,
          );
        } catch (err) {
          console.error(
            `[MCP] Failed to start server '${server.name}':`,
            err instanceof Error ? err.message : err,
          );
        }
      });

    await Promise.allSettled(startPromises);

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
        dataProvider: async () => ({
          total: { value: String(reg.getAll().length) },
          active: { value: String(reg.getActive().length) },
          tools: { value: String(reg.getTotalToolCount()) },
          failed: {
            value: String(reg.getFailed().length),
            detail:
              reg.getFailed().length > 0
                ? reg.getFailed().map((f) => f.name).join(", ")
                : undefined,
          },
        }),
      });
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
      ],
      tools: activeServers.flatMap((s) =>
        registry?.getEntry(s.name)?.toolNames ?? [],
      ),
    });
  });

  // Session shutdown — stop all servers
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (registry) {
      await registry.stopAll();
      registry = null;
    }
  });

  // ── Register commands ─────────────────────────────────────────

  // /unipi:mcp-status — text summary of all servers
  pi.registerCommand(`unipi:${MCP_COMMANDS.STATUS}`, {
    description: "Show status of all configured MCP servers",
    handler: async (_args: string, ctx: any) => {
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
    handler: async (_args: string, ctx: any) => {
      try {
        ctx.ui.notify("Syncing MCP catalog from GitHub...", "info");
        const catalog = await syncCatalog();
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

  // /unipi:mcp-add — placeholder (TUI overlay in Task 7)
  pi.registerCommand(`unipi:${MCP_COMMANDS.ADD}`, {
    description: "Add an MCP server (browse catalog or custom config)",
    handler: async (_args: string, ctx: any) => {
      // TODO: Task 7 — implement TUI overlay
      ctx.ui.notify(
        "MCP Add overlay not yet implemented. Edit ~/.unipi/config/mcp/mcp-config.json manually.",
        "info",
      );
    },
  });

  // /unipi:mcp-settings — placeholder (TUI overlay in Task 8)
  pi.registerCommand(`unipi:${MCP_COMMANDS.SETTINGS}`, {
    description: "Manage MCP server settings",
    handler: async (_args: string, ctx: any) => {
      // TODO: Task 8 — implement TUI overlay
      const reg = getRegistry();
      if (!reg) {
        ctx.ui.notify("MCP extension not initialized", "warning");
        return;
      }

      const all = reg.getAll();
      if (all.length === 0) {
        ctx.ui.notify(
          "No servers configured. Config: ~/.unipi/config/mcp/mcp-config.json",
          "info",
        );
        return;
      }

      const lines = ["MCP Settings:\n"];
      for (const state of all) {
        lines.push(`- ${state.name}: ${state.status} (${state.toolCount} tools)`);
      }
      lines.push("\nTUI settings overlay not yet implemented.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
