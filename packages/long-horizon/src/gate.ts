/**
 * The gate — mode resolution at turn admission, tool-surface enforcement.
 *
 * Wiring:
 *   before_agent_start        resolve mode (explicit > owner > judge > default),
 *                             stash per-turn state, append orchestration fragment
 *                             + owner status line to the system prompt
 *   before_provider_request   filter the payload's tools array to the mode's
 *                             surface (order-preserving; both OpenAI and
 *                             Anthropic tool shapes)
 *   tool_call                 block cross-mode control tools (defense in depth)
 *
 * Prefix-cache discipline: within one mode the filtered tool array is stable
 * and order-preserving; fragment text is deterministic for a given state.
 *
 * Design: docs/long-horizon-design.md §1–§2.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";
import { LH_MODES, MODE_REGISTRY, type LhMode } from "./modes.js";
import type { OwnerCoordinator, OwnerState } from "./owner.js";
import { resolveMode, type ResolutionSource } from "./judge/resolve.js";
import type { FetchLike } from "./judge/typesafe.js";
import { loadSettings, type LongHorizonSettings } from "./settings.js";

export interface GateState {
  readonly mode: LhMode;
  readonly source: ResolutionSource;
  readonly confidence?: number;
}

export interface GateDeps {
  readonly owner: OwnerCoordinator;
  readonly loadSettings?: () => LongHorizonSettings;
  readonly fetchImpl?: FetchLike;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
}

/** Delegation tools governed by the exposure matrix (design §8). */
export const DELEGATION_TOOLS: readonly string[] = [
  "spawn_helper",
  "get_helper_result",
  "bg_delegate",
  "bg_result",
];

/** Every mode-control tool name across modes (todowrite rides all four). */
export const ALL_MODE_TOOLS: readonly string[] = [
  ...new Set(LH_MODES.flatMap((mode) => MODE_REGISTRY[mode].controlTools)),
];

export function toolNameOf(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.name === "string") return record.name; // Anthropic shape
  const fn = record.function;
  if (typeof fn === "object" && fn !== null && typeof (fn as Record<string, unknown>).name === "string") {
    return (fn as Record<string, unknown>).name as string; // OpenAI shape
  }
  return null;
}

/** Tools hidden from the payload in a given mode. */
export function hiddenToolNames(mode: LhMode): Set<string> {
  const definition = MODE_REGISTRY[mode];
  const allowed = new Set(definition.controlTools);
  const hidden = new Set<string>();
  for (const tool of ALL_MODE_TOOLS) {
    if (!allowed.has(tool)) hidden.add(tool);
  }
  if (definition.delegation === "deferred") {
    for (const tool of DELEGATION_TOOLS) hidden.add(tool);
  }
  return hidden;
}

/**
 * Filter a provider payload's tools for a mode. Order-preserving; shapes it
 * does not recognize pass through untouched (fail-open on shape, not on rule).
 */
export function filterPayloadTools<T>(payload: T, mode: LhMode): T {
  if (typeof payload !== "object" || payload === null) return payload;
  const record = payload as Record<string, unknown>;
  const tools = record.tools;
  if (!Array.isArray(tools)) return payload;
  const hidden = hiddenToolNames(mode);
  const filtered = tools.filter((entry) => {
    const name = toolNameOf(entry);
    return name === null ? true : !hidden.has(name);
  });
  if (filtered.length === tools.length) return payload;
  return { ...record, tools: filtered } as T;
}

function ownerStatusLine(owner?: OwnerState, parked?: OwnerState): string {
  const parts: string[] = [];
  if (owner) {
    parts.push(`active owner: ${owner.kind} "${owner.label}" (rev ${owner.revision})`);
  }
  if (parked) {
    const mode = parked.kind === "ralph-loop" ? "ralph" : parked.kind;
    parts.push(`parked owner: ${parked.kind} "${parked.label}" — /unipi:${mode} resume`);
  }
  return parts.join(" · ");
}

/** Deterministic orchestration fragment for the resolved mode. */
export function renderModeFragment(state: GateState, owner?: OwnerState, parked?: OwnerState): string {
  const definition = MODE_REGISTRY[state.mode];
  const lines = [`<long-horizon mode="${state.mode}" source="${state.source}">`];
  lines.push(`Mode: ${definition.label} — ${definition.rubric}.`);
  if (state.mode !== "none") {
    lines.push(
      `Available long-horizon tools: ${definition.controlTools.join(", ")}.` +
        (definition.delegation === "full"
          ? " Delegation tools are available for parallel work."
          : " Delegation tools are hidden; finish here or ask the user to switch modes."),
    );
  }
  const status = ownerStatusLine(owner, parked);
  if (status) lines.push(status);
  lines.push("</long-horizon>");
  return lines.join("\n");
}

export class Gate {
  private turn: GateState | null = null;
  private pendingExplicit: LhMode | null = null;
  private readonly deps: GateDeps;

  constructor(deps: GateDeps) {
    this.deps = deps;
  }

  /** Commands call this before sendUserMessage to force next-turn mode. */
  setExplicit(mode: LhMode): void {
    this.pendingExplicit = mode;
  }

  current(): GateState | null {
    return this.turn;
  }

  async resolveForTurn(prompt: string): Promise<GateState> {
    const settings = this.deps.loadSettings?.() ?? loadSettings();
    const resolution = await resolveMode({
      settings,
      activeOwner: this.deps.owner.getActive(),
      ...(this.pendingExplicit ? { explicit: this.pendingExplicit } : {}),
      prompt,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    this.pendingExplicit = null;
    this.turn = {
      mode: resolution.mode,
      source: resolution.source,
      ...(resolution.confidence !== undefined ? { confidence: resolution.confidence } : {}),
    };
    return this.turn;
  }

  /** pi wiring. Registered once from index.ts. */
  register(pi: ExtensionAPI): void {
    pi.on("before_agent_start", async (event) => {
      const state = await this.resolveForTurn(event.prompt);
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED, {
        mode: state.mode,
        source: state.source,
        ...(state.confidence !== undefined ? { confidence: state.confidence } : {}),
      });
      const fragment = renderModeFragment(
        state,
        this.deps.owner.getActive(),
        this.deps.owner.getParked(),
      );
      return { systemPrompt: `${event.systemPrompt}\n\n${fragment}` };
    });

    pi.on("before_provider_request", (event) => {
      const state = this.turn;
      if (!state) return;
      return filterPayloadTools(event.payload, state.mode);
    });

    pi.on("tool_call", (event) => {
      const state = this.turn;
      if (!state) return;
      const hidden = hiddenToolNames(state.mode);
      const name = (event as { toolName?: string }).toolName;
      if (typeof name === "string" && hidden.has(name)) {
        return {
          block: true,
          reason: `long-horizon: "${name}" is not available in ${state.mode} mode. Switch with /unipi:goal, /unipi:ralph, /unipi:swarm, or /unipi:graph.`,
        };
      }
      return undefined;
    });
  }
}
