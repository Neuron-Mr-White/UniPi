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

import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ReadSubagentParams = Type.Object({
  agent_id: Type.Optional(Type.String({ description: "Subagent or sidekick id; omit for the most recent" })),
  block: Type.Optional(Type.Boolean({ description: "Wait for completion (default false)" })),
  timeout: Type.Optional(Type.Number({ description: "Maximum wait in seconds (default 30, max 600)" })),
});

let toolOwner: ExtensionAPI | undefined;

function renderReadResult(result: { details?: unknown; isError?: boolean }, theme: { fg: (c: string, s: string) => string; bold: (s: string) => string }): Component {
  const details = result.details as { owner?: string; title?: string; status?: string } | undefined;
  const mark = result.isError === true ? theme.fg("error", "✗") : theme.fg("accent", "●");
  if (details?.owner === "subagents") {
    return new Text(`${mark} ${theme.fg("dim", `Checked on subagent ${details.title ?? ""} └ ${details.status ?? ""}`)}`, 0, 0);
  }
  // Sidekick/fusion reads keep the compact ◆ status line.
  const status = details?.status ?? "done";
  return new Text(`${theme.fg(result.isError === true ? "error" : "accent", result.isError === true ? "✗" : "◆")} ${theme.fg("toolTitle", theme.bold(`read_subagent ${status}`))}`, 0, 0);
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
    renderCall: (args: { agent_id?: string; block?: boolean }, theme) =>
      new Text(`${theme.fg("toolTitle", theme.bold("● read_subagent"))} ${theme.fg("dim", args.block === true ? "· waiting" : "· snapshot")}`, 0, 0),
    renderResult: (result, _options, theme) => renderReadResult(result as never, theme as never),
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
