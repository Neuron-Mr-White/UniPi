import { Text, type Component } from "@earendil-works/pi-tui";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SidekickRuntime, HandoffProgress, HandoffReport } from "./sidekick-runtime.js";
import { duration, markdownText, renderSidekickTranscript, sidekickWorkingHeader } from "./transcript.js";

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

// Model-facing result text carries handoff ids and protocol instructions the
// lead needs; none of it may reach the terminal. Anything rendered as plain
// content goes through this first.
const HANDOFF_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
function displayText(text: string): string {
  return text
    .replace(/<\/?subagent_completion_notification[^>]*>/g, "")
    .replace(/use `?read_subagent`?[^.\n]*\.?/gi, "")
    .replace(HANDOFF_ID, "")
    .replace(/agent_id[ =]?"?"?/g, "")
    .replace(/read_subagent\([^)]*\)/g, "read_subagent")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\bHandoff\s*(?=(is|was|failed|aborted|started)\b)/g, "The handoff ")
    .replace(/ for\s*\./g, ".")
    .replace(/ +$/gm, "")
    .trim();
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").filter(Boolean).join("\n");
}

function backgroundComponent(theme: ThemeLike): Component {
  return new Text(`${theme.fg("accent", theme.bold("◆ sidekick"))} ${theme.fg("dim", "· continuing in background")}`, 0, 0);
}

type ToolDetails = Partial<HandoffReport> & { progress?: HandoffProgress; background?: boolean; id?: string };

function reportHeader(theme: ThemeLike, label: string, report: HandoffReport | undefined): string {
  const status = report?.status ?? "done";
  return `${theme.fg(status === "completed" ? "success" : "error", "◆")} ${theme.fg("accent", theme.bold(`${label} ${status}`))} ${theme.fg("dim", report ? `· ${String(report.toolCalls)} tool calls · ${duration(report.durationMs)} · in ${String(report.usage.input)} / out ${String(report.usage.output)} tokens` : "")}`;
}

function renderToolTranscript(result: { content?: unknown; details?: unknown; isError?: boolean }, options: { expanded?: boolean }, theme: ThemeLike, label: "sidekick" | "read_subagent"): Component {
  const details = result.details as ToolDetails | undefined;
  if (details?.background === true) return backgroundComponent(theme);
  const hasProgress = details !== undefined && "progress" in details;
  const progress = details?.progress;
  if (hasProgress && progress === undefined) return backgroundComponent(theme);
  const report = progress ? undefined : details as HandoffReport | undefined;
  const events = progress?.events ?? report?.events;
  const partial = progress !== undefined;
  if (!events) return new Text(displayText(contentText(result.content)), 0, 0);
  const header = partial ? sidekickWorkingHeader(theme, progress, label) : reportHeader(theme, label, report);
  return renderSidekickTranscript(theme, {
    events,
    droppedEvents: progress?.droppedEvents,
    header,
    expanded: options.expanded === true,
    isPartial: partial,
    report,
    renderText: markdownText,
  });
}

function renderCompletionCard(theme: ThemeLike, report: HandoffReport | undefined): Component {
  if (!report) return new Text(`${theme.fg("accent", "◆")} ${theme.fg("accent", theme.bold("sidekick done"))}`, 0, 0);
  return renderSidekickTranscript(theme, {
    events: report.events ?? [],
    header: reportHeader(theme, "sidekick", report),
    expanded: false,
    isPartial: false,
    report,
    renderText: markdownText,
  });
}

export function registerFusionTools(pi: ExtensionAPI, deps: FusionToolDeps): void {
  pi.registerMessageRenderer("sidekick-completion", (message: { details?: HandoffReport }, _options, theme) => renderCompletionCard(theme as unknown as ThemeLike, message.details));

  pi.registerTool({
    name: "sidekick",
    label: "Sidekick",
    description: "Hand off work to your persistent sidekick subagent (one per session; context and shells persist across handoffs; runs on the same machine). block:true (default) waits and returns the report. block:false returns immediately and the report arrives later as a <subagent_completion_notification>. Calling again while a handoff is running injects the message as an interrupt rather than starting a second sidekick.",
    parameters: SidekickParams,
    renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", theme.bold("◆ sidekick"))} ${theme.fg("dim", firstLine(String(args.message)).slice(0, 100))}`, 0, 0),
    renderResult: (result, options, theme) => renderToolTranscript(result, options, theme as unknown as ThemeLike, "sidekick"),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = deps.getRuntime(ctx);
      if (!runtime) return result("Fusion is not active — pick a Fusion pair with /unipi:model.", undefined, true);
      const wasBusy = runtime.isBusy();
      const handoff = runtime.handoff(params.message);
      if (!wasBusy) deps.onHandoffStart?.(ctx);
      if (params.block === false) {
        void handoff.done.then((report) => {
          deps.onReport?.(ctx, report);
          pi.sendMessage(completionMessage(report) as never, { deliverAs: "followUp", triggerTurn: true } as never);
        }).catch(() => undefined);
        deps.onDetach?.(ctx);
        return result(`Handoff ${handoff.id} started in the background. You will receive a <subagent_completion_notification agent_id="${handoff.id}"> when it finishes; use read_subagent to wait.`, { background: true, id: handoff.id });
      }
      deps.onAttach?.(ctx);
      const waited = await waitForReport(runtime, handoff.id, handoff.done, signal, ctx, onUpdate ? (update) => onUpdate(update as never) : undefined);
      if (waited.report) {
        deps.onReport?.(ctx, waited.report);
        return result(reportText(waited.report), waited.report, waited.report.status !== "completed");
      }
      deps.onDetach?.(ctx);
      if (waited.error) return result(`Handoff ${handoff.id} failed: ${waited.error}`, undefined, true);
      if (waited.aborted) return result(`${progressText(runtime, handoff.id)}\nHandoff ${handoff.id} aborted.`, undefined, true);
      if (waited.interrupted) return result(`A user message arrived while the sidekick (agent_id ${handoff.id}) was working. The handoff continues in the background. Act on the user's message first, then call read_subagent({agent_id:"${handoff.id}", block:true}) to collect the report or sidekick({message}) to redirect it.\n${waited.interrupted}`, { progress: runtime.progress(handoff.id), id: handoff.id });
      return result(`Handoff ${handoff.id} is still running.\n${progressText(runtime, handoff.id)}`, { progress: runtime.progress(handoff.id), id: handoff.id });
    },
  });

  pi.registerTool({
    name: "read_subagent",
    label: "Read Sidekick",
    description: "Read a sidekick handoff report by agent_id (omit for the latest). block:true waits for completion (default timeout 2700s when omitted); block:false returns the current progress snapshot immediately.",
    parameters: ReadSubagentParams,
    renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", theme.bold("◆ read_subagent"))} ${theme.fg("dim", args.block === false ? "· snapshot" : "· waiting")}`, 0, 0),
    renderResult: (result, options, theme) => renderToolTranscript(result, options, theme as unknown as ThemeLike, "read_subagent"),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = deps.getRuntime(ctx);
      if (!runtime) return result("Fusion is not active — pick a Fusion pair with /unipi:model.", undefined, true);
      const latest = runtime.latest();
      if (!latest) return result("No sidekick handoff has run yet.", undefined, true);
      const id = params.agent_id ?? latest.id;
      const selected = runtime.reports.get(id);
      if (selected) return result(reportText(selected), selected, selected.status !== "completed");
      if (id !== latest.id) return result(`No sidekick handoff found for ${id}.`, undefined, true);
      if (params.block !== true) return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`, { progress: runtime.progress(id), id });
      deps.onAttach?.(ctx);
      const timeoutMs = (params.timeout ?? 2700) * 1000;
      const waited = await waitForReport(runtime, id, latest.done, signal, ctx, onUpdate ? (update) => onUpdate(update as never) : undefined, timeoutMs);
      if (waited.report) {
        deps.onReport?.(ctx, waited.report);
        return result(reportText(waited.report), waited.report, waited.report.status !== "completed");
      }
      deps.onDetach?.(ctx);
      if (waited.error) return result(`Handoff ${id} failed: ${waited.error}`, undefined, true);
      if (waited.aborted) return result(`Handoff ${id} aborted.`, undefined, true);
      if (waited.interrupted) return result(`A user message arrived while the sidekick (agent_id ${id}) was working.\n${waited.interrupted}`, { progress: runtime.progress(id), id });
      return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`, { progress: runtime.progress(id), id });
    },
  });

}

export { reportText, progressText };
