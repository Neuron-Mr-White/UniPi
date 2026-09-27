/**
 * Shared `read_subagent` registry: owners (fusion sidekick, subagents) register
 * readers keyed by agent_id ownership. The tool itself is registered once by
 * whichever package loads first, and dispatches to the owning reader.
 *
 * Demand: `setReadSubagentDemand(pi, owner, wanted)` — `read_subagent` stays in
 * pi's active tool set iff at least one owner wants it; other tools untouched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SubagentReadParams {
  agent_id?: string;
  block?: boolean;
  timeout?: number;
}

export interface SubagentReader {
  /** True when `agent_id` belongs to this owner (undefined = can't tell). */
  owns(id: string, ctx?: ExtensionContext): boolean;
  /** The owner's newest handoff/subagent (id + start time) or undefined. */
  latest(ctx?: ExtensionContext): { id: string; startedAt: number } | undefined;
  read(params: SubagentReadParams, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: ExtensionContext): Promise<unknown>;
}

export interface RegisteredReader extends SubagentReader {
  owner: string;
}

const readers: RegisteredReader[] = [];
const demand = new Map<string, boolean>();

export function registerSubagentReader(owner: string, reader: SubagentReader): RegisteredReader {
  const entry: RegisteredReader = { owner, ...reader };
  const existing = readers.findIndex((r) => r.owner === owner);
  if (existing >= 0) readers[existing] = entry;
  else readers.push(entry);
  return entry;
}

export function subagentReaders(): readonly RegisteredReader[] {
  return readers;
}

export function readerFor(id: string | undefined, ctx?: ExtensionContext): RegisteredReader | undefined {
  if (id !== undefined) return readers.find((r) => r.owns(id, ctx)) ?? readers.find((r) => r.latest(ctx)?.id === id);
  let best: RegisteredReader | undefined;
  let bestAt = -1;
  for (const r of readers) {
    const at = r.latest(ctx)?.startedAt ?? -1;
    if (at > bestAt) { bestAt = at; best = r; }
  }
  return best;
}

/** Recompute and apply `read_subagent` presence in pi's active tool set. */
export function setReadSubagentDemand(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, owner: string, wanted: boolean): void {
  demand.set(owner, wanted);
  const want = [...demand.values()].some(Boolean);
  const current = pi.getActiveTools();
  const has = current.includes("read_subagent");
  if (has === want) return;
  pi.setActiveTools(want ? [...current, "read_subagent"] : current.filter((t) => t !== "read_subagent"));
}

/** Test hook: clear all registrations (incl. the registered tool flag). */
export function resetSubagentRegistry(): void {
  readers.length = 0;
  demand.clear();
  toolOwner = undefined;
}

// ── The shared read_subagent tool (registered once, dispatches by owner) ────

import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { badge, leader, spinner, SPINNER_MS, STATE_BADGE, STATE_COLOR, type KitTheme, type RunState } from "../tui/kit.js";

const ReadSubagentParams = Type.Object({
  agent_id: Type.Optional(Type.String({ description: "Subagent or sidekick id; omit for the most recent" })),
  block: Type.Optional(Type.Boolean({ description: "Wait for completion (default false)" })),
  timeout: Type.Optional(Type.Number({ description: "Maximum wait in seconds (default 30, max 600)" })),
});

let toolOwner: ExtensionAPI | undefined;

interface ReadDetails {
  owner?: string;
  title?: string;
  profile?: string;
  status?: string;
  toolCalls?: number;
}

/** Shared state for one read_subagent row (call + result renderers). */
interface ReadState {
  owner?: string;
  title?: string;
  final?: boolean;
  startedAt?: number;
  timer?: ReturnType<typeof setInterval>;
}

interface ReadContext {
  state: ReadState;
  invalidate(): void;
}

const lines = (render: (w: number) => string[]): Component => ({ invalidate() {}, render });
const secs = (ms: number) => `${String(Math.max(0, Math.floor(ms / 1000)))}s`;

/**
 * Subagent reads are background work → badge lines:
 *   WAIT  Map auth flow ······················· ⢎⡱ 12s
 *   GOT   Map auth flow ······················· completed · 5 tool calls
 * The call line shows while waiting; the result line replaces it.
 */
/**
 * Sidekick reads keep pi's tinted tool box (fusion's choice): the tool renders
 * itself (renderShell "self") so subagent reads can go boxless, and this
 * repaints the standard box for everyone else.
 */
function toolBox(theme: KitTheme, bg: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg", text: string): Component {
  const paint = (theme as KitTheme & { bg?: (c: string, s: string) => string }).bg;
  const box = new Box(1, 1, paint ? (s: string) => paint(bg, s) : undefined);
  box.addChild(new Text(text, 0, 0));
  return box;
}

const noContext = (): ReadContext => ({ state: {}, invalidate() {} });

function renderReadCall(args: SubagentReadParams, theme: KitTheme, context: ReadContext = noContext()): Component {
  const st = context.state;
  st.owner ??= readerFor(args.agent_id)?.owner;
  st.startedAt ??= Date.now();
  if (st.owner !== "subagents") {
    if (st.final) return lines(() => []);
    return toolBox(theme, "toolPendingBg", `${theme.fg("toolTitle", theme.bold("● read_subagent"))} ${theme.fg("dim", args.block === true ? "· waiting" : "· snapshot")}`);
  }
  if (args.block === true && !st.final && st.timer === undefined) {
    st.timer = setInterval(() => context.invalidate(), SPINNER_MS);
    st.timer.unref?.();
  }
  return lines((w) => {
    if (st.final) return [];
    const who = st.title ?? args.agent_id ?? "latest subagent";
    const right = args.block === true ? `${spinner(theme)} ${theme.fg("dim", secs(Date.now() - (st.startedAt ?? Date.now())))}` : theme.fg("dim", "checking…");
    return [leader(theme, `${badge(theme, "accent", args.block === true ? "WAIT" : "READ")} ${who}`, right, w)];
  });
}

function renderReadResult(result: { details?: unknown; isError?: boolean }, opts: { isPartial?: boolean }, theme: KitTheme, context: ReadContext = noContext()): Component {
  const d = result.details as ReadDetails | undefined;
  const st = context.state;
  if (d?.owner) st.owner = d.owner;
  if (d?.title) st.title = d.title;
  if (st.owner === "subagents") {
    if (opts.isPartial) return lines(() => []);
    if (st.timer) clearInterval(st.timer);
    st.timer = undefined;
    st.final = true;
    const status = d?.status ?? (result.isError === true ? "failed" : "completed");
    const state = (status in STATE_COLOR ? status : "failed") as RunState;
    const label = state === "running" ? "READ" : state === "completed" ? "GOT " : STATE_BADGE[state];
    const chip = badge(theme, STATE_COLOR[state], label);
    const bits = [state === "running" ? "still running" : status, d?.toolCalls !== undefined ? `${String(d.toolCalls)} tool call${d.toolCalls === 1 ? "" : "s"}` : ""].filter(Boolean);
    return lines((w) => [leader(theme, `${chip} ${d?.title ?? st.title ?? "subagent"}`, theme.fg("dim", bits.join(" · ")), w)]);
  }
  // Sidekick/fusion reads keep the compact ◆ status line in a tool box; the
  // call box above is dropped once the result box replaces it.
  if (!opts.isPartial) st.final = true;
  const status = d?.status ?? "done";
  const err = result.isError === true;
  return toolBox(theme, opts.isPartial ? "toolPendingBg" : err ? "toolErrorBg" : "toolSuccessBg", `${theme.fg(err ? "error" : "accent", err ? "✗" : "◆")} ${theme.fg("toolTitle", theme.bold(`read_subagent ${status}`))}`);
}

/**
 * Register the shared `read_subagent` tool (idempotent — the first loader
 * wins). Owners must have registered a reader via `registerSubagentReader`.
 */
export function ensureReadSubagentTool(pi: ExtensionAPI): void {
  if (toolOwner === pi) return;
  toolOwner = pi;
  pi.registerTool({
    name: "read_subagent",
    label: "Read Subagent",
    description:
      "Read a subagent's or the sidekick's result by agent_id (omit for the most recent). block:true waits for completion up to timeout seconds (default 30, max 600); block:false returns the current status immediately.",
    parameters: ReadSubagentParams,
    renderShell: "self",
    renderCall: (args: SubagentReadParams, theme, context) => renderReadCall(args, theme, context as unknown as ReadContext),
    renderResult: (result, options, theme, context) => renderReadResult(result as never, options, theme, context as unknown as ReadContext),
    async execute(_toolCallId, params: SubagentReadParams, signal, onUpdate, ctx) {
      const reader = readerFor(params.agent_id, ctx);
      if (!reader) {
        return { content: [{ type: "text" as const, text: params.agent_id !== undefined ? `No subagent found for ${params.agent_id}.` : "No subagent has run yet." }], details: {}, isError: true };
      }
      const timeoutSec = Math.min(600, params.timeout ?? 30);
      return (await reader.read({ ...params, timeout: timeoutSec }, signal, onUpdate === undefined ? undefined : (u) => onUpdate(u as never), ctx)) as never;
    },
  });
}
