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
import { emitEvent, isChildProcess, UNIPI_EVENTS, setSharedLongHorizonMode } from "@pi-unipi/core";
import { LH_MODES, MODE_REGISTRY, modeForOwnerKind, type LhMode } from "./modes.js";
import type { OwnerCoordinator, OwnerEvent, OwnerState } from "./owner.js";
import { resolveMode, type ResolutionSource } from "./judge/resolve.js";
import type { FetchLike } from "./judge/typesafe.js";
import { loadSettings, type LongHorizonSettings } from "./settings.js";
import { SWARM_ORCHESTRATION_PROMPT } from "./tools/swarm.js";
import { GRAPH_ORCHESTRATION_PROMPT } from "./tools/graph.js";

export interface GateState {
  readonly mode: LhMode;
  readonly source: ResolutionSource;
  readonly confidence?: number;
  /** Resolved from the sticky session mode (/unipi:regular, goal stop), not a one-shot. */
  readonly sticky?: boolean;
}

export interface GateDeps {
  readonly owner: OwnerCoordinator;
  readonly loadSettings?: () => LongHorizonSettings;
  readonly fetchImpl?: FetchLike;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
  /**
   * Suspend-and-switch hook: called when an explicit override differs from
   * the active owner's mode. Wired by index (pauses the goal machine, parks
   * the owner). If it returns false (park slot held), the override is
   * refused and the owner keeps the turn.
   */
  readonly onExplicitSwitch?: (mode: LhMode) => boolean;
}

/** Delegation tools governed by the exposure matrix (design §8). */
// Devin-model subagents are first-class: run_subagent is available in every
// mode. The delegation matrix mechanism is kept for future mode tools.
export const DELEGATION_TOOLS: readonly string[] = [];

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

/**
 * The gate owns mode-tool membership in pi's ACTIVE tool set: the payload
 * filter alone leaves the tools declared in the system prompt, visible to
 * pi's active-set consumers and to every other module. Touches ONLY names in
 * ALL_MODE_TOOLS — adds the mode's controlTools, removes the rest — and
 * preserves the order of every other tool. Skips setActiveTools when
 * membership already matches (prefix-cache and re-entrancy safety). Returns
 * whether the active set changed. (pi ignores unregistered names; harmless.)
 */
export function syncModeTools(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  mode: LhMode,
): boolean {
  const current = pi.getActiveTools();
  const wanted = new Set<string>(MODE_REGISTRY[mode].controlTools);
  if (ALL_MODE_TOOLS.every((name) => current.includes(name) === wanted.has(name))) return false;
  const kept = current.filter((name) => !ALL_MODE_TOOLS.includes(name) || wanted.has(name));
  const additions = [...wanted].filter((name) => !kept.includes(name));
  pi.setActiveTools([...kept, ...additions]);
  return true;
}

function ownerPresenceLine(owner?: OwnerState, parked?: OwnerState): string {
  // Presence only — numbers change every settlement and would bust the prefix
  // cache. Live status rides tail messages (continuation hints), not here.
  const parts: string[] = [];
  if (owner) parts.push(`an active ${owner.kind} owner is driving this session`);
  if (parked) parts.push(`a parked ${parked.kind} owner exists (see /unipi:continue)`);
  return parts.join("; ");
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
          : ""),
    );
  }
  const status = ownerPresenceLine(owner, parked);
  if (status) lines.push(status);
  lines.push("</long-horizon>");
  // The swarm prescription rides the fragment in swarm mode (deterministic text).
  if (state.mode === "swarm") return `${lines.join("\n")}\n${SWARM_ORCHESTRATION_PROMPT}`;
  if (state.mode === "graph") return `${lines.join("\n")}\n${GRAPH_ORCHESTRATION_PROMPT}`;
  return lines.join("\n");
}

export class Gate {
  private turn: GateState | null = null;
  private pendingExplicit: LhMode | null = null;
  /** Sticky per-session mode (/unipi:regular): judge/default skip until an explicit command clears it. */
  private sessionOverride: LhMode | null = null;
  /** Mode of the last badge shown, so only mode TRANSITIONS reprint. */
  private lastBadge: LhMode | null = null;
  private readonly deps: GateDeps;
  private pi?: ExtensionAPI;

  constructor(deps: GateDeps) {
    this.deps = deps;
  }

  /** Commands call this before sendUserMessage to force next-turn mode (one-shot;
   *  an explicit command also escapes a sticky session mode). */
  setExplicit(mode: LhMode): void {
    this.pendingExplicit = mode;
    this.sessionOverride = null;
    // The command's own next turn re-resolves and re-syncs; syncing now covers
    // the gap where the kickoff rides a path that never re-enters
    // before_agent_start (mid-run stash delivery → agent.continue()).
    if (this.pi) syncModeTools(this.pi, mode);
  }

  /** Pin the session to a mode (/unipi:regular, goal stop): every later turn resolves to it. */
  setSessionMode(mode: LhMode): void {
    this.sessionOverride = mode;
    this.pendingExplicit = null;
    setSharedLongHorizonMode(mode);
    if (this.pi) {
      syncModeTools(this.pi, mode);
      emitEvent(this.pi, UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED, {
        mode,
        source: "explicit",
      });
    }
  }

  /**
   * Owner transitions between turns sync the active set too (UNI-90): an owner
   * activated, resumed, or restored OUTSIDE before_agent_start — slash
   * commands, command runners (/unipi:continue, unipi:goal-start/resume),
   * crash recovery — flips its mode's tools on immediately, so a kickoff
   * delivered via agent.continue() (which never re-enters
   * before_agent_start) still has them. Wired from index's single owner
   * onChange closure; suspend/finish/clear deliberately sync nothing (the
   * next turn's resolution is authoritative, and a suspend-and-switch already
   * synced its new mode via setExplicit). Best-effort: never throws.
   */
  onOwnerChanged(event: OwnerEvent): void {
    try {
      if (!this.pi) return;
      if (event.type !== "activated" && event.type !== "resumed" && event.type !== "restored") return;
      if (isChildProcess() && process.env.UNIPI_LH_ALLOW_CHILD !== "1") return;
      const owner = event.type === "restored" ? event.snapshot.active : event.owner;
      if (!owner) return;
      syncModeTools(this.pi, modeForOwnerKind(owner.kind));
    } catch {
      // An owner transition must never fail because of tool syncing.
    }
  }

  /** Fresh or resumed sessions start with the mode tools OFF; a restored
   *  active owner re-syncs its mode's tools ON right after via
   *  onOwnerChanged. Wired from index's single session_start handler so the
   *  extension keeps exactly one. Best-effort: never throws. */
  resetModeTools(): void {
    try {
      if (!this.pi) return;
      syncModeTools(this.pi, "none");
    } catch {
      // Session start must never fail because of tool syncing.
    }
  }

  current(): GateState | null {
    return this.turn;
  }

  async resolveForTurn(prompt: string): Promise<GateState> {
    // Children are the hands, the lead is the voice: no LH modes, no judge,
    // no owners in fusion/subagent children (escape hatch: UNIPI_LH_ALLOW_CHILD).
    if (isChildProcess() && process.env.UNIPI_LH_ALLOW_CHILD !== "1") {
      this.pendingExplicit = null;
      this.turn = { mode: "none", source: "child" };
      return this.turn;
    }
    const settings = this.deps.loadSettings?.() ?? loadSettings();
    // Explicit switch away from an active owner suspends it first (max-1
    // park slot; a held slot refuses the override and the owner keeps mode).
    let explicit = this.sessionOverride ?? this.pendingExplicit;
    if (explicit) {
      const active = this.deps.owner.getActive();
      if (active && modeForOwnerKind(active.kind) !== explicit) {
        // Suspend-and-switch: the hook (when wired) also pauses engines; the
        // fallback parks the owner directly. Park-slot-full refuses the switch.
        const switched = this.deps.onExplicitSwitch
          ? this.deps.onExplicitSwitch(explicit)
          : Boolean(this.deps.owner.suspend(`paused(superseded_by:${explicit})`));
        if (!switched) explicit = null; // refused — owner wins this turn
      }
    }
    const resolution = await resolveMode({
      settings,
      activeOwner: this.deps.owner.getActive(),
      ...(explicit ? { explicit } : {}),
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
      ...(this.sessionOverride !== null && explicit === this.sessionOverride ? { sticky: true } : {}),
    };
    return this.turn;
  }

  /** pi wiring. Registered once from index.ts. */
  register(pi: ExtensionAPI): void {
    this.pi = pi;
    // Decision badge: a UI-only session entry (never sent to the LLM) so the
    // user always sees how the turn was routed — rendered with a distinct
    // background by the entry renderer registered in index.ts.
    pi.on("before_agent_start", async (event) => {
      const state = await this.resolveForTurn(event.prompt);
      // pi's live loadout is authoritative for this turn (agent-session honors
      // setActiveTools from before_agent_start unless a handler edited
      // systemPromptOptions.selectedTools), so flip the mode tools before
      // anything else consumes the resolution.
      syncModeTools(pi, state.mode);
      // Shared holder the footer pulls each render (timing-independent), plus
      // the event for the badge/other listeners.
      setSharedLongHorizonMode(state.mode);
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED, {
        mode: state.mode,
        source: state.source,
        ...(state.confidence !== undefined ? { confidence: state.confidence } : {}),
      });
      // Only surface the routing badge when it's INTERESTING. The footer shows
      // the current mode persistently, so the badge is for MODE TRANSITIONS,
      // not a per-turn stamp. Dedup on the resolved MODE (not source), so a
      // run of identical `none`/`goal` turns — whether judged or default —
      // prints at most once.
      //   - explicit switch            → always worth showing (user action)
      //   - mode changed from last     → worth showing
      //   - same mode as last shown    → silent (footer already reflects it)
      const showBadge =
        (state.source === "explicit" && !state.sticky) || this.lastBadge !== state.mode;
      this.lastBadge = state.mode;
      if (showBadge) {
        try {
          pi.appendEntry("long-horizon-decision", {
            mode: state.mode,
            source: state.source,
            ...(state.confidence !== undefined ? { confidence: state.confidence } : {}),
          });
        } catch {
          // Best-effort badge; never block a turn on it.
        }
      }
      const fragment = renderModeFragment(
        state,
        this.deps.owner.getActive(),
        this.deps.owner.getParked(),
      );
      // A named section, not a systemPrompt replacement: a forced prompt is
      // opaque to pi (forceSystemPrompt) and would drop sections other modules
      // added — e.g. fusion's lead policy. renderModeFragment already emits
      // the <long-horizon> wrapper; strip it, pi re-wraps the section.
      const inner = fragment
        .replace(/^<long-horizon[^>]*>\n?/, "")
        .replace(/\n?<\/long-horizon>(\n|$)/, "$1");
      event.systemPromptOptions.sections["long-horizon"] = inner;
      return undefined;
    });

    pi.on("before_provider_request", (event) => {
      const state = this.turn;
      if (!state) return;
      return filterPayloadTools(event.payload, state.mode);
    });

    pi.on("tool_call", (event) => {
      try {
        const state = this.turn;
        if (!state) return undefined;
        const hidden = hiddenToolNames(state.mode);
        const name = (event as { toolName?: string }).toolName;
        if (typeof name === "string" && hidden.has(name)) {
          return {
            block: true,
            reason: `long-horizon: "${name}" is not available in ${state.mode} mode. Switch with /unipi:goal, /unipi:ralph, /unipi:swarm, or /unipi:graph.`,
          };
        }
        return undefined;
      } catch {
        // A guard handler must never abort a turn.
        return undefined;
      }
    });
  }
}
