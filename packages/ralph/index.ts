/**
 * @unipi/ralph — Long-running iterative development loops
 *
 * Adapted from pi-ralph-wiggum with unipi event integration.
 * Emits MODULE_READY, RALPH_LOOP_START/END events.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  RALPH_COMPLETE_MARKER,
  RALPH_TOOLS,
  emitEvent,
  getPackageVersion,
} from "@unipi/core";
import { infoRegistry } from "@pi-unipi/info-screen";
import { RalphLoopManager } from "./ralph-loop.js";
import { registerRalphTools } from "./tools.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Current loop manager instance (recreated on session reload) */
let manager: RalphLoopManager | null = null;

/**
 * Get or create the loop manager for the current context.
 */
function getManager(ctx: ExtensionContext, pi: ExtensionAPI): RalphLoopManager {
  if (!manager) {
    manager = new RalphLoopManager(ctx, (event, payload) =>
      emitEvent(pi, event, payload),
    );
  }
  return manager;
}

export default function (pi: ExtensionAPI) {
  // Register tools
  // (Manager will be created lazily on first use)

  // Register commands
  registerCommands(pi);

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    manager = null; // Force re-creation with new context
    const mgr = getManager(ctx, pi);

    // Rehydrate from disk
    mgr.rehydrate();

    // Announce module
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.RALPH,
      version: VERSION,
      commands: [
        "unipi:ralph-start",
        "unipi:ralph-stop",
        "unipi:ralph-resume",
        "unipi:ralph-status",
        "unipi:ralph-cancel",
        "unipi:ralph-archive",
        "unipi:ralph-clean",
        "unipi:ralph-list",
        "unipi:ralph-nuke",
      ],
      tools: [RALPH_TOOLS.START, RALPH_TOOLS.DONE],
    });

    // Register info group
    infoRegistry.registerGroup({
      id: "ralph",
      name: "Ralph Loops",
      icon: "🔄",
      priority: 70,
      config: {
        showByDefault: true,
        stats: [
          { id: "activeLoops", label: "Active Loops", show: true },
          { id: "totalIterations", label: "Total Iterations", show: true },
          { id: "status", label: "Status", show: true },
        ],
      },
      dataProvider: async () => {
        const currentLoop = mgr.getCurrentLoop();
        if (!currentLoop) {
          return {
            activeLoops: { value: "0" },
            totalIterations: { value: "0" },
            status: { value: "idle" },
          };
        }

        const state = mgr.loadState(currentLoop);
        return {
          activeLoops: { value: "1" },
          totalIterations: { value: String(state?.iteration ?? 0) },
          status: { value: state?.status ?? "unknown" },
        };
      },
    });
  });

  // Agent lifecycle — check for completion marker
  pi.on("agent_end", async (event, ctx) => {
    const mgr = getManager(ctx, pi);
    const currentLoop = mgr.getCurrentLoop();
    if (!currentLoop) return;

    const state = mgr.loadState(currentLoop);
    if (!state || state.status !== "active") return;

    // Check for completion marker in last assistant message
    const lastAssistant = [...event.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const text =
      lastAssistant && Array.isArray(lastAssistant.content)
        ? lastAssistant.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n")
        : "";

    if (text.includes(RALPH_COMPLETE_MARKER)) {
      mgr.completeLoop(
        state,
        `───────────────────────────────────────────────────────────────────────
✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations
───────────────────────────────────────────────────────────────────────`,
      );
    }
  });

  // Inject ralph instructions when loop is active
  pi.on("before_agent_start", async (event, ctx) => {
    const mgr = getManager(ctx, pi);
    const currentLoop = mgr.getCurrentLoop();
    if (!currentLoop) return;

    const state = mgr.loadState(currentLoop);
    if (!state || state.status !== "active") return;

    const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;

    let instructions = `You are in a Ralph loop working on: ${state.taskFile}\n`;
    if (state.itemsPerIteration > 0) {
      instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
    }
    instructions += `- Update the task file as you progress\n`;
    instructions += `- When FULLY COMPLETE: ${RALPH_COMPLETE_MARKER}\n`;
    instructions += `- Otherwise, call ralph_done tool to proceed to next iteration`;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
    };
  });

  // Save state on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!manager) return;
    const currentLoop = manager.getCurrentLoop();
    if (currentLoop) {
      const state = manager.loadState(currentLoop);
      if (state) manager.saveState(state);
    }
    manager = null;
  });

  // Register tools after manager setup
  pi.on("session_start", async (_event, ctx) => {
    const mgr = getManager(ctx, pi);
    registerRalphTools(pi, mgr);
  });
}

/**
 * Register ralph commands.
 */
function registerCommands(pi: ExtensionAPI): void {
  const HELP = `Ralph Loop — Long-running development loops

Commands:
  /unipi:ralph start <name|path> [options]  Start a new loop
  /unipi:ralph stop                         Pause current loop
  /unipi:ralph resume <name>                Resume a paused loop
  /unipi:ralph status                       Show all loops
  /unipi:ralph cancel <name>                Delete loop state
  /unipi:ralph archive <name>               Move loop to archive
  /unipi:ralph clean [--all]                Clean completed loops
  /unipi:ralph list --archived              Show archived loops
  /unipi:ralph nuke [--yes]                 Delete all ralph data

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)

To stop: press ESC to interrupt, then run /unipi:ralph-stop when idle`;

  pi.registerCommand("unipi:ralph", {
    description: "Ralph loop commands (start, stop, resume, status, etc.)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0];
      const rest = parts.slice(1).join(" ");

      // We need manager for most commands
      // For 'start', we'll handle it specially
      if (cmd === "start") {
        handleStart(rest, ctx, pi);
      } else if (cmd === "stop") {
        handleStop(ctx, pi);
      } else if (cmd === "resume") {
        handleResume(rest, ctx, pi);
      } else if (cmd === "status" || cmd === "list") {
        handleList(rest, ctx, pi);
      } else if (cmd === "cancel") {
        handleCancel(rest, ctx, pi);
      } else if (cmd === "archive") {
        handleArchive(rest, ctx, pi);
      } else if (cmd === "clean") {
        handleClean(rest, ctx, pi);
      } else if (cmd === "nuke") {
        handleNuke(rest, ctx, pi);
      } else {
        if (ctx.hasUI) ctx.ui.notify(HELP, "info");
      }
    },
  });

  // Dedicated stop command for idle-only use
  pi.registerCommand("unipi:ralph-stop", {
    description: "Stop active Ralph loop (idle only)",
    handler: async (_args, ctx) => {
      handleStop(ctx, pi);
    },
  });
}

function handleStart(rest: string, ctx: ExtensionContext, pi: ExtensionAPI): void {
  const tokens = rest.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  let name = "";
  let maxIterations = 50;
  let itemsPerIteration = 0;
  let reflectEvery = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (tok === "--max-iterations" && next) {
      maxIterations = parseInt(next, 10) || 0;
      i++;
    } else if (tok === "--items-per-iteration" && next) {
      itemsPerIteration = parseInt(next, 10) || 0;
      i++;
    } else if (tok === "--reflect-every" && next) {
      reflectEvery = parseInt(next, 10) || 0;
      i++;
    } else if (!tok.startsWith("--")) {
      name = tok.replace(/^"|"$/g, "");
    }
  }

  if (!name) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "Usage: /unipi:ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
        "warning",
      );
    return;
  }

  const mgr = getManager(ctx, pi);
  const isPath = name.includes("/") || name.includes("\\");
  const loopName = isPath
    ? name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_")
    : name;
  const taskFile = isPath ? name : `.unipi/ralph/${loopName}.md`;

  const existing = mgr.loadState(loopName);
  if (existing?.status === "active") {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Loop "${loopName}" is already active. Use /unipi:ralph resume ${loopName}`,
        "warning",
      );
    return;
  }

  // Check if task file exists, create if not
  const fullPath = require("node:path").resolve(ctx.cwd, taskFile);
  const fs = require("node:fs");
  if (!fs.existsSync(fullPath)) {
    const { ensureDir } = require("@unipi/core");
    ensureDir(fullPath);
    fs.writeFileSync(
      fullPath,
      `# Task\n\nDescribe your task here.\n\n## Goals\n- Goal 1\n\n## Checklist\n- [ ] Item 1\n\n## Notes\n(Update this as you work)\n`,
      "utf-8",
    );
    if (ctx.hasUI) ctx.ui.notify(`Created task file: ${taskFile}`, "info");
  }

  const { tryRead } = require("@unipi/core");
  const content = tryRead(fullPath);
  if (!content) {
    if (ctx.hasUI) ctx.ui.notify(`Could not read task file: ${taskFile}`, "error");
    return;
  }

  const state = mgr.startLoop(loopName, taskFile, content, {
    maxIterations,
    itemsPerIteration,
    reflectEvery,
  });

  pi.sendUserMessage(mgr.buildPrompt(state, content, false));
}

function handleStop(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!ctx.isIdle()) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Agent is busy. Press ESC to interrupt, then run /unipi:ralph-stop.",
        "warning",
      );
    }
    return;
  }

  const mgr = getManager(ctx, pi);
  let currentLoop = mgr.getCurrentLoop();
  let state = currentLoop ? mgr.loadState(currentLoop) : null;

  if (!state) {
    const active = mgr.listLoops().find((l) => l.status === "active");
    if (!active) {
      if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
      return;
    }
    state = active;
  }

  if (state.status !== "active") {
    if (ctx.hasUI)
      ctx.ui.notify(`Loop "${state.name}" is not active`, "warning");
    return;
  }

  mgr.stopLoop(
    state,
    `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`,
  );
}

function handleResume(
  rest: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const loopName = rest.trim();
  if (!loopName) {
    if (ctx.hasUI) ctx.ui.notify("Usage: /unipi:ralph resume <name>", "warning");
    return;
  }

  const mgr = getManager(ctx, pi);
  const state = mgr.resumeLoop(loopName);
  if (!state) {
    if (ctx.hasUI) ctx.ui.notify(`Loop "${loopName}" not found or completed`, "error");
    return;
  }

  if (ctx.hasUI)
    ctx.ui.notify(
      `Resumed: ${loopName} (iteration ${state.iteration})`,
      "info",
    );

  const content = mgr.tryReadTask(state);
  if (!content) {
    if (ctx.hasUI)
      ctx.ui.notify(`Could not read task file: ${state.taskFile}`, "error");
    return;
  }

  const needsReflection =
    state.reflectEvery > 0 &&
    state.iteration > 1 &&
    (state.iteration - 1) % state.reflectEvery === 0;
  pi.sendUserMessage(mgr.buildPrompt(state, content, needsReflection));
}

function handleList(
  rest: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const archived = rest.trim() === "--archived";
  const mgr = getManager(ctx, pi);
  const loops = mgr.listLoops(archived);

  if (loops.length === 0) {
    if (ctx.hasUI)
      ctx.ui.notify(
        archived
          ? "No archived loops"
          : "No loops found. Use /unipi:ralph list --archived for archived.",
        "info",
      );
    return;
  }

  const label = archived ? "Archived loops" : "Ralph loops";
  if (ctx.hasUI)
    ctx.ui.notify(
      `${label}:\n${loops.map((l) => mgr.formatLoop(l)).join("\n")}`,
      "info",
    );
}

function handleCancel(
  rest: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const loopName = rest.trim();
  if (!loopName) {
    if (ctx.hasUI) ctx.ui.notify("Usage: /unipi:ralph cancel <name>", "warning");
    return;
  }

  const mgr = getManager(ctx, pi);
  const state = mgr.loadState(loopName);
  if (!state) {
    if (ctx.hasUI) ctx.ui.notify(`Loop "${loopName}" not found`, "error");
    return;
  }

  if (mgr.getCurrentLoop() === loopName) mgr.setCurrentLoop(null);
  const { tryDelete } = require("@unipi/core");
  tryDelete(
    require("node:path").resolve(
      ctx.cwd,
      `.unipi/ralph/${loopName.replace(/[^a-zA-Z0-9_-]/g, "_")}.state.json`,
    ),
  );
  if (ctx.hasUI) ctx.ui.notify(`Cancelled: ${loopName}`, "info");
  mgr.updateUI();
}

function handleArchive(
  rest: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const loopName = rest.trim();
  if (!loopName) {
    if (ctx.hasUI) ctx.ui.notify("Usage: /unipi:ralph archive <name>", "warning");
    return;
  }

  const mgr = getManager(ctx, pi);
  if (mgr.archiveLoop(loopName)) {
    if (ctx.hasUI) ctx.ui.notify(`Archived: ${loopName}`, "info");
  } else {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Cannot archive "${loopName}" — not found or still active`,
        "warning",
      );
  }
}

function handleClean(
  rest: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const mgr = getManager(ctx, pi);
  const cleaned = mgr.cleanCompleted(rest.trim() === "--all");

  if (cleaned.length === 0) {
    if (ctx.hasUI) ctx.ui.notify("No completed loops to clean", "info");
    return;
  }

  const suffix = rest.trim() === "--all" ? " (all files)" : " (state only)";
  if (ctx.hasUI)
    ctx.ui.notify(
      `Cleaned ${cleaned.length} loop(s)${suffix}:\n${cleaned.map((n) => `  • ${n}`).join("\n")}`,
      "info",
    );
}

function handleNuke(
  rest: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const force = rest.trim() === "--yes";

  const run = () => {
    const mgr = getManager(ctx, pi);
    if (mgr.nukeAll()) {
      if (ctx.hasUI) ctx.ui.notify("Removed .unipi/ralph directory.", "info");
    } else {
      if (ctx.hasUI) ctx.ui.notify("No .unipi/ralph directory found.", "info");
    }
  };

  if (!force) {
    if (ctx.hasUI) {
      void ctx.ui
        .confirm(
          "Delete all Ralph loop files?",
          "This deletes all .unipi/ralph state, task, and archive files.",
        )
        .then((confirmed) => {
          if (confirmed) run();
        });
    } else {
      if (ctx.hasUI)
        ctx.ui.notify(
          "Run /unipi:ralph nuke --yes to confirm. This deletes all .unipi/ralph data.",
          "warning",
        );
    }
    return;
  }

  run();
}
