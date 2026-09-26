import { Text, type Component } from "@earendil-works/pi-tui";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SidekickRuntime, HandoffProgress, HandoffReport } from "./sidekick-runtime.js";
import { createCompletionDelivery, registerSubagentReader, type SubagentReader } from "@pi-unipi/core/child-agent.js";
import { duration } from "./transcript.js";

const SidekickParams = Type.Object({
  message: Type.String({ description: "A concrete implementation or verification brief for the sidekick" }),
  block: Type.Optional(Type.Boolean({ description: "Wait for completion (default true)" })),
});
const ReadSubagentParams = Type.Object({
  agent_id: Type.Optional(Type.String({ description: "Handoff id; omit to use the latest handoff" })),
  block: Type.Optional(Type.Boolean({ description: "Wait for completion" })),
  timeout: Type.Optional(Type.Number({ description: "Maximum wait in seconds" })),
});

export interface FusionToolDeps {
  getRuntime: (ctx: ExtensionContext) => SidekickRuntime | undefined;
  onReport?: (ctx: ExtensionContext, report: HandoffReport) => void;
  onHandoffStart?: (ctx: ExtensionContext) => void;
  onAttach?: (ctx: ExtensionContext) => void;
  onDetach?: (ctx: ExtensionContext) => void;
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? "";
}

function progressText(runtime: SidekickRuntime, id: string): string {
  const progress = runtime.progress(id);
  if (!progress) return "No active handoff progress.";
  const elapsed = duration(Date.now() - progress.startedAt);
  const tools = progress.recentTools.length > 0 ? `\n${progress.recentTools.map((tool) => `  ${tool}`).join("\n")}` : "";
  const tail = progress.textTail.length > 0 ? `\n  ${progress.textTail}` : "";
  return `◆ sidekick working · ${String(progress.toolCalls)} tool calls · ${elapsed}${tools}${tail}`;
}

function progressKey(runtime: SidekickRuntime, id: string): string {
  const progress = runtime.progress(id);
  if (!progress) return "";
  const last = progress.events.at(-1);
  return `${String(progress.toolCalls)}|${progress.recentTools.join("|")}|${progress.textTail}|${String(progress.events.length)}|${last?.kind === "tool" ? `${String(last.output.length)}|${String(last.done)}` : last?.kind === "text" ? `${String(last.text.length)}|${String(last.open)}` : ""}`;
}

function reportText(report: HandoffReport): string {
  return `${report.text}\n\n--- sidekick ${report.id} · ${report.status} · ${String(report.toolCalls)} tool calls · ${duration(report.durationMs)} · in ${String(report.usage.input)} / out ${String(report.usage.output)} tokens`;
}

function result(text: string, details?: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; details: unknown; isError: boolean } {
  return { content: [{ type: "text", text }], details: details ?? {}, isError };
}

async function waitForReport(
  runtime: SidekickRuntime,
  id: string,
  done: Promise<HandoffReport>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate?: (update: unknown) => void,
  timeoutMs = 2700000,
): Promise<{ report?: HandoffReport; interrupted?: string; aborted?: boolean; error?: string }> {
  const started = Date.now();
  let lastProgressKey = "";
  while (true) {
    if (signal?.aborted) {
      await runtime.abort();
      return { aborted: true };
    }
    if (ctx.hasPendingMessages?.()) return { interrupted: progressText(runtime, id) };
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return {};
    const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.min(500, remaining)));
    const outcome = await Promise.race([
      done.then((report) => ({ report }), (error) => ({ error: error instanceof Error ? error.message : String(error) })),
      timer,
    ]);
    if (outcome !== undefined) {
      if ("error" in outcome) return { error: outcome.error };
      return { report: outcome.report };
    }
    const progress = progressText(runtime, id);
    const key = progressKey(runtime, id);
    if (key !== lastProgressKey) {
      lastProgressKey = key;
      onUpdate?.({ content: [{ type: "text", text: progress }], details: { progress: runtime.progress(id) } });
    }
  }
}

function completionMessage(report: HandoffReport): { customType: string; content: string; display: boolean; details: HandoffReport } {
  return {
    customType: "sidekick-completion",
    content: `<subagent_completion_notification agent_id="${report.id}" status="${report.status}">\n${report.text}\n</subagent_completion_notification>`,
    display: true,
    details: report,
  };
}

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};


type ToolDetails = Partial<HandoffReport> & { progress?: HandoffProgress; background?: boolean; id?: string };

/**
 * Compact one-line tool status — the steps themselves stream as
 * `sidekick-step` entries, so the tool card is just the status line:
 * `◆ sidekick working · N steps · 12s` → `◆ sidekick done · N steps · 34s ·
 * in X / out Y tokens`.
 */
function renderToolStatus(result: { content?: unknown; details?: unknown; isError?: boolean }, theme: ThemeLike): Component {
  const details = result.details as ToolDetails | undefined;
  if (details?.background === true) {
    return new Text(`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold("sidekick"))} ${theme.fg("dim", "· continuing in background")}`, 0, 0);
  }
  const progress = details?.progress;
  if (progress !== undefined) {
    const steps = progress.toolCalls;
    const elapsed = duration(Date.now() - progress.startedAt);
    return new Text(`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold("sidekick"))} ${theme.fg("dim", `working · ${String(steps)} steps · ${elapsed}`)}`, 0, 0);
  }
  const report = details as HandoffReport | undefined;
  const failed = result.isError === true || (report !== undefined && report.status !== "completed" && report.status !== undefined);
  const glyph = failed ? theme.fg("error", "✗") : theme.fg("accent", "◆");
  const label = failed ? "sidekick failed" : "sidekick done";
  const meta = report?.durationMs !== undefined
    ? ` · ${String(report.toolCalls)} steps · ${duration(report.durationMs)} · in ${String(report.usage?.input ?? 0)} / out ${String(report.usage?.output ?? 0)} tokens`
    : "";
  return new Text(`${glyph} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("dim", meta)}`, 0, 0);
}

function renderCompletionLine(theme: ThemeLike, report: HandoffReport | undefined): Component {
  const failed = report !== undefined && report.status !== "completed";
  const glyph = failed ? theme.fg("error", "✗") : theme.fg("accent", "◆");
  const label = failed ? "sidekick failed" : "sidekick finished";
  const meta = report?.durationMs !== undefined ? ` · ${String(report.toolCalls)} steps · ${duration(report.durationMs)}` : "";
  return new Text(`${glyph} ${theme.fg("dim", `${label}${meta}`)}`, 0, 0);
}

export function registerFusionTools(pi: ExtensionAPI, deps: FusionToolDeps): void {
  pi.registerMessageRenderer("sidekick-completion", (message: { details?: HandoffReport }, _options, theme) => renderCompletionLine(theme as unknown as ThemeLike, message.details));

  // One delivery mechanism for every handoff nobody is waiting on.
  const completion = createCompletionDelivery<HandoffReport>((report) => {
    pi.sendMessage(completionMessage(report) as never, { deliverAs: "followUp", triggerTurn: true } as never);
  });

  pi.registerTool({
    name: "sidekick",
    label: "Sidekick",
    description: "Hand off work to your persistent sidekick subagent (one per session; context and shells persist across handoffs; runs on the same machine). block:true (default) waits and returns the report. block:false returns immediately and the report arrives later as a <subagent_completion_notification>. Calling again while a handoff is running injects the message as an interrupt rather than starting a second sidekick.",
    parameters: SidekickParams,
    renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", theme.bold("◆ sidekick"))} ${theme.fg("dim", firstLine(String(args.message)).slice(0, 100))}`, 0, 0),
    renderResult: (result, _options, theme) => renderToolStatus(result, theme as unknown as ThemeLike),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = deps.getRuntime(ctx);
      if (!runtime) return result("Fusion is not active — pick a Fusion pair with /unipi:model.", undefined, true);
      const wasBusy = runtime.isBusy();
      const handoff = runtime.handoff(params.message);
      if (!wasBusy) deps.onHandoffStart?.(ctx);
      if (params.block === false) {
        void handoff.done.then((report) => deps.onReport?.(ctx, report)).catch(() => undefined);
        completion.detach(handoff.id, handoff.done);
        deps.onDetach?.(ctx);
        return result(`Handoff ${handoff.id} started in the background. You will receive a <subagent_completion_notification agent_id="${handoff.id}"> when it finishes; use read_subagent to wait.`, { background: true, id: handoff.id });
      }
      deps.onAttach?.(ctx);
      runtime.attachUi?.(ctx.ui as never);
      completion.attach(handoff.id);
      const waited = await waitForReport(runtime, handoff.id, handoff.done, signal, ctx, onUpdate ? (update) => onUpdate(update as never) : undefined);
      runtime.detachUi?.();
      if (waited.report) {
        completion.consume(handoff.id);
        deps.onReport?.(ctx, waited.report);
        return result(reportText(waited.report), waited.report, waited.report.status !== "completed");
      }
      completion.detach(handoff.id, handoff.done);
      deps.onDetach?.(ctx);
      if (waited.error) return result(`Handoff ${handoff.id} failed: ${waited.error}`, undefined, true);
      if (waited.aborted) return result(`${progressText(runtime, handoff.id)}\nHandoff ${handoff.id} aborted.`, undefined, true);
      if (waited.interrupted) return result(`A user message arrived while the sidekick (agent_id ${handoff.id}) was working. The handoff continues in the background. Act on the user's message first, then call read_subagent({agent_id:"${handoff.id}", block:true}) to collect the report or sidekick({message}) to redirect it.\n${waited.interrupted}`, { progress: runtime.progress(handoff.id), id: handoff.id });
      return result(`Handoff ${handoff.id} is still running.\n${progressText(runtime, handoff.id)}`, { progress: runtime.progress(handoff.id), id: handoff.id });
    },
  });

  // Fusion registers a READER for the shared `read_subagent` tool (core).
  // Same semantics as before: consume completions, block:true waits with the
  // shared timeout cap, interrupted waits detach to background.
  const reader: SubagentReader = {
    owns: (id, ctx) => runtime_reports_owns(deps, id, ctx ?? lastCtx),
    latest: (ctx) => {
      const ctx0 = ctx ?? lastCtx;
      const rt = ctx0 === undefined ? undefined : deps.getRuntime(ctx0);
      const latest = rt?.latest();
      if (!latest || !rt) return undefined;
      return { id: latest.id, startedAt: rt.progress(latest.id)?.startedAt ?? 0 };
    },
    read: async (params, signal, onUpdate, ctx) => {
      const runtime = deps.getRuntime(ctx);
      if (!runtime) return result("Fusion is not active — pick a Fusion pair with /unipi:model.", undefined, true);
      const latest = runtime.latest();
      if (!latest) return result("No sidekick handoff has run yet.", undefined, true);
      const id = params.agent_id ?? latest.id;
      const selected = runtime.reports.get(id);
      if (selected) {
        completion.consume(id);
        return result(reportText(selected), { ...selected, owner: "fusion" }, selected.status !== "completed");
      }
      if (id !== latest.id) return result(`No sidekick handoff found for ${id}.`, undefined, true);
      if (params.block !== true) return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`, { progress: runtime.progress(id), id, owner: "fusion" });
      deps.onAttach?.(ctx);
      runtime.attachUi?.(ctx.ui as never);
      completion.attach(id);
      const timeoutMs = Math.min(600, params.timeout ?? 30) * 1000;
      const waited = await waitForReport(runtime, id, latest.done, signal, ctx, onUpdate, timeoutMs);
      runtime.detachUi?.();
      if (waited.report) {
        completion.consume(id);
        deps.onReport?.(ctx, waited.report);
        return result(reportText(waited.report), { ...waited.report, owner: "fusion" }, waited.report.status !== "completed");
      }
      completion.detach(id, latest.done);
      deps.onDetach?.(ctx);
      if (waited.error) return result(`Handoff ${id} failed: ${waited.error}`, undefined, true);
      if (waited.aborted) return result(`Handoff ${id} aborted.`, undefined, true);
      if (waited.interrupted) return result(`A user message arrived while the sidekick (agent_id ${id}) was working.\n${waited.interrupted}`, { progress: runtime.progress(id), id, owner: "fusion" });
      return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`, { progress: runtime.progress(id), id, owner: "fusion" });
    },
  };
  let lastCtx: ExtensionContext | undefined;
  registerSubagentReader("fusion", {
    owns: (id, ctx) => reader.owns(id, ctx),
    latest: (ctx) => reader.latest(ctx),
    read: (params, signal, onUpdate, ctx) => {
      lastCtx = ctx;
      return reader.read(params, signal, onUpdate, ctx);
    },
  });

  function runtime_reports_owns(d: FusionToolDeps, id: string, ctx: ExtensionContext | undefined): boolean {
    const rt = ctx === undefined ? undefined : d.getRuntime(ctx);
    return rt !== undefined && (rt.reports.has(id) || rt.latest()?.id === id);
  }

}

export { reportText, progressText };
