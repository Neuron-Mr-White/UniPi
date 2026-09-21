/**
 * @pi-unipi/long-horizon — Extension entry
 *
 * Mode-gated long-horizon execution: /goal /ralph /swarm /graph behind a
 * prompt judge (TypeSafe jev). One automation owner per session, max one
 * parked. Design: docs/long-horizon-design.md.
 */

import { join, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitEvent, getPackageVersion, UNIPI_EVENTS } from "@pi-unipi/core";
import { OwnerCoordinator, type OwnerEvent } from "./src/owner.js";
import { Gate } from "./src/gate.js";
import { registerLongHorizonCommands } from "./src/commands.js";
import { loadSettings } from "./src/settings.js";
import { GoalMachine } from "./src/engine/goal-state.js";
import { GoalToolset } from "./src/tools/goal.js";
import { GoalContinuation } from "./src/engine/continuation.js";
import { RalphLoop } from "./src/engine/ralph.js";
import { registerRalphTools } from "./src/tools/ralph.js";
import { SwarmLedger, registerSwarmTools } from "./src/tools/swarm.js";
import { GraphLedger, registerGraphTools } from "./src/tools/graph.js";
import { TodoStore, registerTodoTool } from "./src/tools/todo.js";
import { wireRuntime } from "./src/runtime.js";

export * from "./src/modes.js";
export * from "./src/owner.js";
export * from "./src/gate.js";

const LH_DIR = ".unipi/long-horizon";

export default function longHorizon(pi: ExtensionAPI): void {
  const version = getPackageVersion("long-horizon");
  const statePath = () => join(resolve(process.cwd()), LH_DIR, "state.json");

  // Owner lifecycle → unipi event bus (footer/info-screen consume these).
  const owner = new OwnerCoordinator({
    statePath,
    onChange: (_snapshot, event: OwnerEvent) => {
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, {
        event: event.type,
        ...("owner" in event && event.owner
          ? { ownerId: event.owner.ownerId, kind: event.owner.kind, status: event.owner.status }
          : {}),
      });
    },
  });

  const suspendActiveFor = (mode: string): boolean => {
    const active = owner.getActive();
    if (!active) return true;
    if (active.kind === "goal") machine.pause("paused(superseded)");
    const suspended = owner.suspend(`paused(superseded_by:${mode})`);
    if (suspended) {
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, {
        event: "suspended",
        ownerId: suspended.ownerId,
        reason: `paused(superseded_by:${mode})`,
      });
    }
    return Boolean(suspended);
  };
  const gate = new Gate({ owner, loadSettings, onExplicitSwitch: suspendActiveFor });
  gate.register(pi);
  // Decision badge renderer — special background so routing decisions are
  // visible in the transcript (UI-only; appendEntry never reaches the LLM).
  try {
    pi.registerEntryRenderer<{ mode: string; source: string; confidence?: number }>(
      "long-horizon-decision",
      (entry, _options, theme) => {
        const data = entry.data;
        if (!data) return undefined;
        const t = theme as unknown as {
          bg?: (c: string, t: string) => string;
          fg?: (c: string, t: string) => string;
          bold?: (t: string) => string;
        };
        const badge = t.bg?.("customMessageBg", ` ⟐ long-horizon ${t.bold?.(data.mode) ?? data.mode} `) ?? ` ⟐ ${data.mode} `;
        const via =
          data.source === "judge"
            ? `judged${data.confidence !== undefined ? ` (${data.confidence.toFixed(2)})` : ""}`
            : data.source === "explicit"
              ? "/unipi command"
              : data.source === "owner"
                ? "active owner"
                : data.source === "judge_abstained_low_confidence"
                  ? "judge abstained → default"
                  : "default";
        const line = `${t.fg?.("customMessageText", badge) ?? badge} ${t.fg?.("dim", via) ?? via}`;
        return new Text(line, 0, 0);
      },
    );
  } catch {
    // Renderer registration is UI-dependent; skip where unavailable.
  }

  // Goal engine: machine + tools + continuation + runtime wiring.
  const machine = new GoalMachine({
    statePath: () => join(resolve(process.cwd()), LH_DIR, "goal.json"),
  });
  const toolset = new GoalToolset({ machine, owner });
  toolset.register(pi);
  const todoStore = new TodoStore();
  registerTodoTool(pi, todoStore);
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("verifier unbound"); } },
    send: (message) => {
      void pi.sendUserMessage(message);
    },
  });
  // Ralph loop rides the same goal machine + verifier; footer events preserved.
  const ralph = new RalphLoop({
    machine,
    owner,
    ralphDir: () => join(resolve(process.cwd()), ".unipi", "ralph"),
    send: (message) => {
      void pi.sendUserMessage(message);
    },
    onEvent: (event) => {
      if (event.type === "loop_start") {
        emitEvent(pi, UNIPI_EVENTS.RALPH_LOOP_START, { name: event.name, iteration: event.iteration, total: event.total });
      } else if (event.type === "iteration_done") {
        emitEvent(pi, UNIPI_EVENTS.RALPH_ITERATION_DONE, { name: event.name, iteration: event.iteration, remaining: event.remaining });
      } else if (event.type === "loop_end") {
        emitEvent(pi, UNIPI_EVENTS.RALPH_LOOP_END, { name: event.name, reason: event.reason, iterations: event.iterations });
      }
    },
  });
  registerRalphTools(pi, ralph);
  const swarm = new SwarmLedger(owner);
  registerSwarmTools(pi, { ledger: swarm, owner });
  const graph = new GraphLedger(owner);
  registerGraphTools(pi, { ledger: graph });
  wireRuntime(pi, { machine, toolset, continuation, gate, loadSettings, ralph });
  registerLongHorizonCommands(pi, gate, owner, ralph);

  // Crash recovery: repair, don't resume — reload durable state so the gate
  // reattaches the owner's tool surface; the continuation arms a recovery
  // fragment for the first post-restart turn.
  pi.on("session_start", () => {
    owner.restore();
    machine.restore();
    if (machine.getActive()) continuation.armRecovery();
  });

  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
    name: "@pi-unipi/long-horizon",
    version,
    commands: [
      "unipi:goal",
      "unipi:ralph",
      "unipi:swarm",
      "unipi:graph",
    ],
    tools: ["create_goal", "get_goal", "update_goal", "todowrite", "ralph_done", "loop_status", "swarm_report", "swarm_status", "swarm_yield", "update_agent_graph", "graph_output", "view_agent_graph"],
  });
}
