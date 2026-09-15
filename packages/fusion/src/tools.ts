import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SidekickRuntime, HandoffProgress, HandoffReport } from "./sidekick-runtime.js";
import { frameSidekick, renderSidekickTranscript, type ThemeLike as TranscriptTheme } from "./transcript.js";

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
}

function duration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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
): Promise<{ report?: HandoffReport; interrupted?: string; aborted?: boolean }> {
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
    const report = await Promise.race([done, timer]);
    if (report !== undefined) return { report };
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
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

function transcriptTheme(theme: ThemeLike): TranscriptTheme {
  return { fg: (color, text) => theme.fg(color, text), bold: (text) => theme.bold(text) };
}

function markdownText(markdown: string): Markdown {
  return new Markdown(markdown, 0, 0, getMarkdownTheme());
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").filter(Boolean).join("\n");
}

function renderToolTranscript(result: { content?: unknown; details?: unknown; isError?: boolean }, options: { expanded?: boolean }, theme: ThemeLike, label: "sidekick" | "read_subagent"): Component {
  const details = result.details as (HandoffReport & { progress?: HandoffProgress }) | { progress?: HandoffProgress } | undefined;
  const progress = details?.progress;
  const report = progress ? undefined : details as HandoffReport | undefined;
  const events = progress?.events ?? report?.events;
  const partial = progress !== undefined;
  const status = partial ? "working" : report?.status === "completed" && !result.isError ? "completed" : "error";
  if (!events) return frameSidekick(theme, status, new Text(contentText(result.content), 0, 0));
  const header = partial
    ? `${theme.fg("accent", theme.bold(`◆ ${label} working`))} ${theme.fg("dim", `· ${String(progress.toolCalls)} tool calls · ${duration(Date.now() - progress.startedAt)}`)}`
    : `${theme.fg(report?.status === "completed" ? "success" : "error", "◆")} ${theme.fg("accent", theme.bold(`${label} ${report?.status ?? "done"}`))} ${theme.fg("dim", report ? `· ${report.id} · ${String(report.toolCalls)} tool calls · ${duration(report.durationMs)} · in ${String(report.usage.input)} / out ${String(report.usage.output)} tokens` : "")}`;
  return frameSidekick(theme, status, renderSidekickTranscript(transcriptTheme(theme), {
    events,
    droppedEvents: progress?.droppedEvents,
    header,
    expanded: options.expanded === true,
    isPartial: partial,
    report,
    renderText: markdownText,
  }));
}

function renderCompletionCard(theme: ThemeLike, report: HandoffReport | undefined): Component {
  const status = report?.status === "completed" ? "completed" : "error";
  if (!report) return frameSidekick(theme, "error", new Text(`${theme.fg("accent", "◆")} ${theme.fg("accent", theme.bold("sidekick done"))}`, 0, 0));
  return frameSidekick(theme, status, renderSidekickTranscript(transcriptTheme(theme), {
    events: report.events ?? [],
    header: `${theme.fg(report.status === "completed" ? "success" : "error", "◆")} ${theme.fg("accent", theme.bold(`sidekick ${report.status}`))} ${theme.fg("dim", `· ${report.id} · ${String(report.toolCalls)} tool calls · ${duration(report.durationMs)}`)}`,
    expanded: false,
    isPartial: false,
    report,
    renderText: markdownText,
  }));
}

export function registerFusionTools(pi: ExtensionAPI, deps: FusionToolDeps): void {
  pi.registerMessageRenderer("sidekick-completion", (message: { details?: HandoffReport }, _options, theme) => renderCompletionCard(theme as unknown as ThemeLike, message.details));

  pi.registerTool({
    name: "sidekick",
    label: "Sidekick",
    description: "Hand off work to your persistent sidekick subagent (one per session; context and shells persist across handoffs; runs on the same machine). block:true (default) waits and returns the report. block:false returns immediately and the report arrives later as a <subagent_completion_notification>. Calling again while a handoff is running injects the message as an interrupt rather than starting a second sidekick.",
    parameters: SidekickParams,
    renderShell: "self",
    renderCall: (args, theme) => frameSidekick(theme as unknown as ThemeLike, "working", new Text(`${theme.fg("toolTitle", theme.bold("◆ sidekick"))} ${theme.fg("dim", firstLine(String(args.message)).slice(0, 100))}`, 0, 0)),
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
        return result(`Handoff ${handoff.id} started in the background. You will receive a <subagent_completion_notification agent_id="${handoff.id}"> when it finishes; use read_subagent to wait.`);
      }
      const waited = await waitForReport(runtime, handoff.id, handoff.done, signal, ctx, onUpdate ? (update) => onUpdate(update as never) : undefined);
      if (waited.report) {
        deps.onReport?.(ctx, waited.report);
        return result(reportText(waited.report), waited.report, waited.report.status !== "completed");
      }
      if (waited.aborted) return result(`${progressText(runtime, handoff.id)}\nHandoff ${handoff.id} aborted.`, undefined, true);
      if (waited.interrupted) return result(`A user message arrived while the sidekick (agent_id ${handoff.id}) was working. The handoff continues in the background. Act on the user's message first, then call read_subagent({agent_id:"${handoff.id}", block:true}) to collect the report or sidekick({message}) to redirect it.\n${waited.interrupted}`);
      return result(`Handoff ${handoff.id} is still running.\n${progressText(runtime, handoff.id)}`);
    },
  });

  pi.registerTool({
    name: "read_subagent",
    label: "Read Sidekick",
    description: "Read a sidekick handoff report by agent_id (omit for the latest). block:true waits for completion (default timeout 2700s when omitted); block:false returns the current progress snapshot immediately.",
    parameters: ReadSubagentParams,
    renderShell: "self",
    renderCall: (args, theme) => frameSidekick(theme as unknown as ThemeLike, "working", new Text(`${theme.fg("toolTitle", theme.bold("◆ read_subagent"))} ${theme.fg("dim", args.agent_id ?? "latest")}`, 0, 0)),
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
      if (params.block !== true) return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`);
      const timeoutMs = (params.timeout ?? 2700) * 1000;
      const waited = await waitForReport(runtime, id, latest.done, signal, ctx, onUpdate ? (update) => onUpdate(update as never) : undefined, timeoutMs);
      if (waited.report) {
        deps.onReport?.(ctx, waited.report);
        return result(reportText(waited.report), waited.report, waited.report.status !== "completed");
      }
      if (waited.aborted) return result(`Handoff ${id} aborted.`, undefined, true);
      if (waited.interrupted) return result(`A user message arrived while the sidekick (agent_id ${id}) was working.\n${waited.interrupted}`);
      return result(`Handoff ${id} is still running.\n${progressText(runtime, id)}`);
    },
  });

}

export { reportText, progressText };
