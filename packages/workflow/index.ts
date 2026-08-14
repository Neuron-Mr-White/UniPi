/**
 * @unipi/workflow — Structured development workflow commands
 *
 * Registers workflow commands that dispatch to skills for LLM instruction.
 * Emits MODULE_READY for inter-module discovery and detects @unipi/ralph.
 * Enforces workflow sandboxes without changing Pi's active tool schemas.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  WORKFLOW_COMMANDS,
  emitEvent,
  getPackageVersion,
  initUnipiDirs,
  getBlockedToolsForLevel,
  getSandboxLevel,
  isToolAllowed,
  type SandboxLevel,
} from "@pi-unipi/core";
import { registerWorkflowCommands } from "./commands.js";
import { WorkflowLifecycle } from "./lifecycle.js";

/** Package version (read from package.json at load time) */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

export const WORKFLOW_SANDBOX_SNAPSHOT_TYPE = "unipi-workflow-sandbox-snapshot";

interface WorkflowSandboxSnapshotDetails {
  active: boolean;
  command?: string;
  level?: SandboxLevel;
}

interface EffectiveSandboxSnapshot {
  content: unknown;
  details?: WorkflowSandboxSnapshotDetails;
}

function sandboxRestrictions(level: SandboxLevel): string[] {
  const common = [
    "Do not attempt to call tools blocked by name.",
    "If the user requests an action that requires a blocked tool, explain that the workflow sandbox does not allow it.",
  ];

  if (level === "brainstorm") {
    return [
      "The write tool is restricted to .unipi/docs/specs/ only.",
      "Use bash only for specific setup operations such as git init or mkdir; use grep, find, and ls for discovery instead of bash.",
      ...common,
    ];
  }

  if (level === "write_unipi") {
    return [
      "The write tool is restricted to .unipi/docs/ only (specs and plans).",
      "Use grep, find, and ls for file discovery instead of guessing filenames.",
      "Bash is blocked; use read, write, edit, grep, find, and ls only.",
      ...common,
    ];
  }

  return common;
}

/** Build a persistent snapshot that explicitly invalidates earlier sandbox state. */
export function formatActiveSandboxSnapshot(command: string, level: SandboxLevel): string {
  const blocked = getBlockedToolsForLevel(level);
  const blockedLine = blocked.length > 0
    ? blocked.join(", ")
    : "none";

  return [
    "# UniPi Workflow Sandbox Snapshot",
    "This snapshot supersedes all prior UniPi workflow sandbox snapshots; use only this snapshot for workflow sandbox status and restrictions.",
    "Status: active",
    `Workflow: /unipi:${command}`,
    `Sandbox level: ${level}`,
    `Blocked tool names: ${blockedLine}`,
    "Pi's provider tool schemas and tool order remain unchanged. Calls to blocked tool names are rejected by the workflow sandbox.",
    ["Restrictions:", ...sandboxRestrictions(level).map((restriction) => `- ${restriction}`)].join("\n"),
  ].join("\n\n");
}

export function formatInactiveSandboxSnapshot(): string {
  return [
    "# UniPi Workflow Sandbox Snapshot",
    "This snapshot supersedes all prior UniPi workflow sandbox snapshots; use only this snapshot for workflow sandbox status and restrictions.",
    "Status: inactive",
    "No UniPi workflow sandbox is active. Prior workflow sandbox restrictions no longer apply.",
  ].join("\n\n");
}

function latestEffectiveSandboxSnapshot(
  branch: SessionEntry[],
): EffectiveSandboxSnapshot | undefined {
  const messages = buildSessionContext(branch).messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "custom" && message.customType === WORKFLOW_SANDBOX_SNAPSHOT_TYPE) {
      return {
        content: message.content,
        details: message.details as WorkflowSandboxSnapshotDetails | undefined,
      };
    }
  }
  return undefined;
}

/** Find state that may survive only as prose inside a compaction summary. */
function latestHistoricalSandboxSnapshot(
  branch: SessionEntry[],
): EffectiveSandboxSnapshot | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom_message" && entry.customType === WORKFLOW_SANDBOX_SNAPSHOT_TYPE) {
      return {
        content: entry.content,
        details: entry.details as WorkflowSandboxSnapshotDetails | undefined,
      };
    }
  }
  return undefined;
}

function isActiveSnapshot(snapshot: EffectiveSandboxSnapshot): boolean {
  if (typeof snapshot.details?.active === "boolean") return snapshot.details.active;
  return typeof snapshot.content === "string" && snapshot.content.includes("Status: active");
}

export default function (pi: ExtensionAPI) {
  const workflowLifecycle = new WorkflowLifecycle();
  let ralphDetected = false;
  let sandboxCommand: string | null = null;

  registerWorkflowCommands(pi, {
    isRalphDetected: () => ralphDetected,
    activateSandbox: (event) => {
      if (!workflowLifecycle.start(event)) return false;
      sandboxCommand = event.command;
      emitEvent(pi, UNIPI_EVENTS.WORKFLOW_START, event);
      return true;
    },
    abortWorkflow: () => {
      sandboxCommand = null;
      workflowLifecycle.reset();
    },
  });

  // Keep tool schemas/order stable and enforce only the existing blocked names.
  pi.on("tool_call", async (event, _ctx) => {
    if (!sandboxCommand) return;

    const level = getSandboxLevel(sandboxCommand);
    if (!isToolAllowed(level, event.toolName)) {
      const blocked = getBlockedToolsForLevel(level);
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed in ${level} sandbox. Blocked: ${blocked.join(", ")}`,
      };
    }
  });

  // Persist hidden append-only sandbox state without mutating the system prompt.
  pi.on("before_agent_start", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const latest = latestEffectiveSandboxSnapshot(branch);
    const historical = latestHistoricalSandboxSnapshot(branch);

    if (sandboxCommand) {
      const level = getSandboxLevel(sandboxCommand);
      const content = formatActiveSandboxSnapshot(sandboxCommand, level);
      if (latest?.content === content) return undefined;

      return {
        message: {
          customType: WORKFLOW_SANDBOX_SNAPSHOT_TYPE,
          content,
          display: false,
          details: {
            active: true,
            command: sandboxCommand,
            level,
          } satisfies WorkflowSandboxSnapshotDetails,
        },
      };
    }

    // A clean session gets no marker. Only an effective active snapshot needs
    // an append-only inactive successor after agent_end completes the workflow.
    const prior = latest ?? historical;
    if (!prior || !isActiveSnapshot(prior)) return undefined;

    return {
      message: {
        customType: WORKFLOW_SANDBOX_SNAPSHOT_TYPE,
        content: formatInactiveSandboxSnapshot(),
        display: false,
        details: {
          active: false,
        } satisfies WorkflowSandboxSnapshotDetails,
      },
    };
  });

  // Pi 0.80.2 compatibility: agent_end remains the workflow completion boundary.
  pi.on("agent_end", async (event, _ctx) => {
    const completedWorkflow = workflowLifecycle.complete(event.messages);
    if (!completedWorkflow) return;

    sandboxCommand = null;
    emitEvent(pi, UNIPI_EVENTS.WORKFLOW_END, completedWorkflow);
  });

  // Announce module presence on session start.
  pi.on("session_start", async (_event, ctx) => {
    initUnipiDirs();

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.WORKFLOW,
      version: VERSION,
      commands: Object.values(WORKFLOW_COMMANDS),
      tools: [],
    });

    if (!ralphDetected) {
      try {
        const allTools = pi.getAllTools();
        ralphDetected = allTools.some((tool) => tool.name === "ralph_start");
      } catch {
        // Ignore — ralph not present.
      }
    }

    if (ctx.hasUI) {
      const ralphStatus = ralphDetected ? "✓ rl" : "○ rl";
      ctx.ui.setStatus("unipi-workflow", `⚡ wf ${ralphStatus}`);
    }
  });

  pi.events.on(UNIPI_EVENTS.MODULE_READY, (data) => {
    const event = data as { name?: string };
    if (event?.name === MODULES.RALPH) ralphDetected = true;
  });

  pi.on("session_shutdown", async () => {
    ralphDetected = false;
    sandboxCommand = null;
    workflowLifecycle.reset();
  });
}
