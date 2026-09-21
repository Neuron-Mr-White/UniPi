/**
 * Mode registry — the five long-horizon modes and what each exposes.
 *
 * Design: docs/long-horizon-design.md §1 (exposure matrix) and §8 (tool
 * classification). Mode control tools are root-session only; delegation tools
 * are governed by the gate, not by this registry.
 */

export const LH_MODES = ["goal", "ralph", "swarm", "graph", "none"] as const;

export type LhMode = (typeof LH_MODES)[number];

/** Owner kinds — the continuation machines that can own a session. `none` never owns. */
export type OwnerKind = "goal" | "ralph-loop" | "swarm" | "graph";

export type PromptFragmentId = "goal" | "ralph" | "swarm" | "graph";

export interface ModeDefinition {
  readonly id: LhMode;
  readonly label: string;
  /** One-line routing rubric (mirrors the judge criteria). */
  readonly rubric: string;
  /** Mode-exclusive control tools exposed when this mode is active. */
  readonly controlTools: readonly string[];
  /** Orchestration prompt fragment injected while this mode is active. */
  readonly promptFragment: PromptFragmentId | null;
  /** Which owner kind this mode creates, if any. */
  readonly ownerKind: OwnerKind | null;
  /** Delegation tools fully exposed (vs deferred) in this mode. */
  readonly delegation: "full" | "deferred";
}

export const MODE_REGISTRY: Readonly<Record<LhMode, ModeDefinition>> = {
  goal: {
    id: "goal",
    label: "Goal",
    rubric: "One objective pursued across many turns until verifiably true",
    controlTools: ["create_goal", "get_goal", "update_goal", "todowrite"],
    promptFragment: "goal",
    ownerKind: "goal",
    delegation: "deferred",
  },
  ralph: {
    id: "ralph",
    label: "Ralph",
    rubric: "Work through a task file / checklist over many iterations",
    controlTools: ["ralph_done", "loop_status", "todowrite"],
    promptFragment: "ralph",
    ownerKind: "ralph-loop",
    delegation: "deferred",
  },
  swarm: {
    id: "swarm",
    label: "Swarm",
    rubric: "Independent items parallel workers settle, then synthesize",
    controlTools: ["swarm_status", "swarm_yield", "swarm_report", "todowrite"],
    promptFragment: "swarm",
    ownerKind: "swarm",
    delegation: "full",
  },
  graph: {
    id: "graph",
    label: "Graph",
    rubric: "Multi-step work where later steps depend on earlier results",
    controlTools: ["view_agent_graph", "update_agent_graph", "graph_output", "todowrite"],
    promptFragment: "graph",
    ownerKind: "graph",
    delegation: "full",
  },
  none: {
    id: "none",
    label: "Plain",
    rubric: "Straight-to-the-point request — no long-horizon machinery",
    controlTools: [],
    promptFragment: null,
    ownerKind: null,
    delegation: "deferred",
  },
};

export function isLhMode(value: string): value is LhMode {
  return (LH_MODES as readonly string[]).includes(value);
}

/** Mode that owns a given owner kind, for owner→mode tool reattachment. */
export function modeForOwnerKind(kind: OwnerKind): LhMode {
  switch (kind) {
    case "goal":
      return "goal";
    case "ralph-loop":
      return "ralph";
    case "swarm":
      return "swarm";
    case "graph":
      return "graph";
  }
}
