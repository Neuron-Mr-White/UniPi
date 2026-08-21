/**
 * @pi-unipi/subagents — /unipi:* slash commands (Phase 7)
 *
 * subagents-fleet: open the fleet inspector surface.
 * subagents-doctor: run the doctor report.
 * subagents-guide: print a guide topic.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import { listAsyncRunSummaries } from "./fleet-data.js";
import { buildGuideText } from "./guide.js";

export interface SlashDeps {
  manager: AgentManager;
  config: { maxConcurrent: number; enabled: boolean; types: Record<string, { enabled?: boolean }> };
  asyncDirRoot: string;
  retainedDir?: string;
}

export function registerSlashCommands(pi: ExtensionAPI, getCtx: () => ExtensionContext | undefined, deps: SlashDeps): void {
  const send = (markdown: string): void => {
    pi.sendMessage(
      { customType: "unipi-response", content: markdown, display: true },
      { deliverAs: "followUp" },
    );
  };

  pi.registerCommand("unipi:subagents-fleet", {
    description: "Show active subagent fleet (in-process + process runs)",
    handler: async (_args, _ctx) => {
      const inProcess = deps.manager.listAgents().filter((a) => a.status === "running" || a.status === "queued");
      const asyncRuns = listAsyncRunSummaries(deps.asyncDirRoot).filter(
        (r) => r.state === "running" || r.state === "queued" || r.state === "pending",
      );
      const lines: string[] = ["Active subagent fleet:", ""];
      if (inProcess.length === 0 && asyncRuns.length === 0) {
        lines.push("  (no active work — use spawn_helper to delegate)");
      } else {
        if (inProcess.length > 0) {
          lines.push(`In-process (${inProcess.length}):`);
          for (const record of inProcess) {
            lines.push(`  - ${record.id} [${record.type}] ${record.status}: ${record.description}`);
          }
        }
        if (asyncRuns.length > 0) {
          lines.push(`Process runs (${asyncRuns.length}):`);
          for (const run of asyncRuns) {
            lines.push(`  - ${run.runId} [${run.agent}] ${run.state}`);
          }
        }
        lines.push("", "FleetView panel: ↓ to inspect · enter opens transcripts.");
      }
      send(lines.join("\n"));
    },
  });

  pi.registerCommand("unipi:subagents-doctor", {
    description: "Subagents configuration and capacity diagnosis",
    handler: async () => {
      send(
        "Run the full report via spawn_helper({ action: \"doctor\" }). Quick check:\n" +
          `- extension enabled: ${deps.config.enabled}\n` +
          `- known agent types: ${deps.manager.getKnownTypes().length}\n` +
          `- max concurrent: ${deps.config.maxConcurrent}`,
      );
    },
  });

  pi.registerCommand("unipi:subagents-guide", {
    description: "Subagents guide (topic argument optional)",
    handler: async (args, _ctx) => {
      const topic = args?.trim() || "overview";
      send(buildGuideText(topic));
    },
  });
}
