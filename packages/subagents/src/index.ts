/**
 * @pi-unipi/subagents — Devin-model subagents for unipi.
 *
 * Tools: `run_subagent` (foreground wait / background notify / resume) and a
 * reader registration for the shared core `read_subagent` tool.
 * Profiles: built-ins `subagent_explore` / `subagent_general` plus custom
 * markdown agents from ~/.unipi/config/agents and <workspace>/.unipi/config/agents.
 * Config `subagents`: enabled (default true), defaultModel, defaultThinking.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  UNIPI_EVENTS, emitEvent, getSettings, registerSettings, getSharedFusionStatus,
} from "@pi-unipi/core";
import {
  ensureReadSubagentTool, registerSubagentReader, setReadSubagentDemand,
  createCompletionDelivery, type HandoffReport,
} from "@pi-unipi/core/child-agent.js";
import { SubagentManager, canSpawn, currentDepth, MAX_DEPTH_ENV } from "./manager.js";
import { loadProfiles, type AgentProfile } from "./profiles.js";
import { badgeHandler } from "./badge.js";

export interface SubagentsConfig {
  enabled: boolean;
  defaultModel?: string;
  defaultThinking?: string;
}

const DEFAULT_CONFIG: SubagentsConfig = { enabled: true };

registerSettings({
  namespace: "subagents",
  label: "Subagents",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Subagents",
      fields: [
        { key: "enabled", type: "boolean", label: "Enabled" },
        { key: "defaultModel", type: "string", label: "Default model (provider/id)" },
        { key: "defaultThinking", type: "string", label: "Default thinking level" },
      ],
    },
  ],
});

function loadConfig(cwd: string): SubagentsConfig {
  try {
    const merged = getSettings("subagents", cwd) as unknown as SubagentsConfig;
    return { enabled: merged.enabled !== false, defaultModel: merged.defaultModel, defaultThinking: merged.defaultThinking };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const RunSubagentParams = Type.Object({
  title: Type.String({ description: "Short 3-8 word title shown to the user" }),
  task: Type.String({
    description: "Complete, self-contained instructions. The subagent does not see this conversation: include the goal, relevant paths, constraints, and what to report back.",
  }),
  profile: Type.String({ description: "" }), // rebuilt per load: every available profile as `name — description`
  is_background: Type.Optional(Type.Boolean({ description: "Run without waiting; report arrives via notification (default false)" })),
  resume: Type.Optional(Type.String({ description: "agent_id of an earlier subagent to continue (keeps its context); always runs in the foreground" })),
});

const RUN_DESCRIPTION =
  "Launch an independent subagent for a self-contained task. It has its own context and does not see this conversation, so put everything it needs in `task`. Foreground (default) waits and returns the subagent's report. With is_background:true it returns immediately and you receive a <subagent_completion_notification> when it finishes; use read_subagent to wait for it — never poll in a loop. Background subagents cannot ask for approval: tool calls that would need approval are denied. Use resume:<agent_id> to continue an earlier subagent with a follow-up task.";

interface RunState {
  record: import("./manager.js").SubagentRecord;
  runtime: import("@pi-unipi/core/child-agent.js").ChildAgentRuntime;
  done: Promise<HandoffReport>;
}

function leadSessionId(ctx: ExtensionContext): string {
  const m = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
  return m?.getSessionId?.() ?? "default";
}

/** Model order: profile.model → (general: parent) → config.defaultModel →
 * Fusion sidekickKey → parent. Exported for tests. */
export function resolveSubagentModel(
  profile: AgentProfile,
  ctx: Pick<ExtensionContext, "model">,
  config: SubagentsConfig,
): string {
  if (profile.model !== undefined) return profile.model;
  const cur = ctx.model as { provider?: string; id?: string } | undefined;
  const parent = cur ? `${String(cur.provider)}/${String(cur.id)}` : "";
  if (profile.id === "subagent_general") return parent;
  if (config.defaultModel !== undefined) return config.defaultModel;
  const sidekickKey = getSharedFusionStatus()?.sidekickKey;
  if (sidekickKey !== undefined) return sidekickKey;
  return parent;
}

/** subagent_general rides the parent's level; defaultThinking covers
 * explore/custom agents without their own `thinking`. Exported for tests. */
export function resolveSubagentThinking(
  profile: AgentProfile,
  ctx: Pick<ExtensionContext, "thinkingLevel">,
  config: SubagentsConfig,
): string {
  const own = profile.id === "subagent_general" ? undefined : config.defaultThinking;
  return profile.thinking ?? own ?? ctx.thinkingLevel ?? "medium";
}

export default function subagents(pi: ExtensionAPI): void {
  const manager = new SubagentManager();
  const delivery = createCompletionDelivery<HandoffReport>((report) => {
    const rec = report && managerRecordOf(report);
    pi.sendMessage(
      {
        customType: "subagent-completion",
        content: `<subagent_completion_notification agent_id="${report.id}" status="${report.status}">\n${report.text}\n</subagent_completion_notification>`,
        display: true,
        details: { owner: "subagents", title: rec?.title ?? report.id, status: report.status, toolCalls: report.toolCalls, durationMs: report.durationMs },
      } as never,
      { deliverAs: "followUp", triggerTurn: true } as never,
    );
  });
  const reportRecords = new Map<string, { title: string }>();
  const managerRecordOf = (report: HandoffReport) => manager.record(report.id) ?? reportRecords.get(report.id);

  let profiles: AgentProfile[] = [];
  let config: SubagentsConfig = { ...DEFAULT_CONFIG };
  let enabled = false;
  let lastCtx: ExtensionContext | undefined;
  const warned = new Set<string>();

  function refreshFiles(cwd: string): void {
    config = loadConfig(cwd);
    enabled = config.enabled;
    profiles = loadProfiles(cwd).profiles;
  }

  function refresh(cwd: string, ctx?: ExtensionContext): void {
    config = loadConfig(cwd);
    enabled = config.enabled;
    const loaded = loadProfiles(cwd);
    profiles = loaded.profiles;
    // Warnings surface once per distinct message per process — not as
    // persisted chat entries that pile up across sessions.
    for (const w of loaded.warnings) {
      if (warned.has(w)) continue;
      warned.add(w);
      (ctx?.ui ?? lastCtx?.ui)?.notify?.(`subagents: ${w}`, "warning");
    }
    setReadSubagentDemand(pi, "subagents", enabled);
    syncRunSubagent(pi);
  }

  // Profiles load before registration so the tool schema's profile list is
  // complete (load cwd global+project dirs; pi re-registration isn't used —
  // custom agents added mid-process appear on the next session_start).
  refreshFiles(process.cwd());

  // run_subagent is registered at load when the depth guard allows spawning
  // (children see it only below UNIPI_SUBAGENT_MAX_DEPTH); its presence in the
  // active set then follows `enabled` via session_start sync.
  if (canSpawn()) {
    const profileParam = profiles.map((p) => `${p.id} — ${p.description}`).join("; ");
    pi.registerTool({
      name: "run_subagent",
      label: "Run Subagent",
      description: RUN_DESCRIPTION,
      parameters: Type.Object({ ...RunSubagentParams.properties, profile: Type.String({ description: `Available profiles: ${profileParam}` }) }),
      renderCall: (args: { title?: string }, theme) => new Text(`${theme.fg("toolTitle", theme.bold("● run_subagent"))} ${theme.fg("dim", args.title ?? "")}`, 0, 0),
      renderResult: (result, _o, theme) => {
        const r = result as unknown as { details?: { title?: string; status?: string }; isError?: boolean };
        const d = r.details;
        return new Text(`${theme.fg(r.isError === true ? "error" : "accent", r.isError === true ? "✗" : "●")} ${theme.fg("dim", `Subagent "${d?.title ?? ""}" ${d?.status ?? "done"}`)}`, 0, 0);
      },
      execute: runSubagent as never,
    });
  }

  function syncRunSubagent(api: ExtensionAPI): void {
    const want = enabled && canSpawn();
    const current = api.getActiveTools();
    const has = current.includes("run_subagent");
    if (has !== want) api.setActiveTools(want ? [...current, "run_subagent"] : current.filter((t) => t !== "run_subagent"));
  }

  const resolveModelKey = (profile: AgentProfile, ctx: ExtensionContext) =>
    resolveSubagentModel(profile, ctx, config);
  const resolveThinking = (profile: AgentProfile, ctx: ExtensionContext) =>
    resolveSubagentThinking(profile, ctx, config);

  function completionDetails(record: import("./manager.js").SubagentRecord, report: HandoffReport) {
    return { owner: "subagents", title: record.title, status: report.status, toolCalls: report.toolCalls, durationMs: report.durationMs };
  }

  async function runSubagent(
    _toolCallId: string,
    params: { title: string; task: string; profile: string; is_background?: boolean; resume?: string },
    signal: AbortSignal | undefined,
    onUpdate: ((u: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError: boolean }> {
    const result = (text: string, details?: unknown, isError = false) => ({ content: [{ type: "text" as const, text }], details: details ?? {}, isError });
    const cwd = ctx.cwd ?? process.cwd();
    const resumeId = params.resume?.trim() || undefined;
    const profileName = resumeId !== undefined ? (manager.record(resumeId)?.profile ?? params.profile) : params.profile;
    const profile = profiles.find((p) => p.id === profileName) ?? profiles.find((p) => p.id === "subagent_general");
    if (!profile) return result(`Unknown profile ${params.profile}. Available: ${profiles.map((p) => p.id).join(", ")}`, undefined, true);

    const start = manager.start({
      title: params.title,
      task: params.task,
      profile,
      model: resolveModelKey(profile, ctx),
      thinking: resolveThinking(profile, ctx),
      cwd,
      leadSessionId: leadSessionId(ctx),
      background: resumeId === undefined && params.is_background === true,
      resume: resumeId,
      onDone: (run, report) => {
        reportRecords.set(report.id, { title: run.record.title });
        // Deliver the completion unless a waiter is attached (exactly-once).
      },
    });
    if ("error" in start) return result(start.error, undefined, true);
    const { run } = start;
    const id = run.record.id;

    if (run.record.background) {
      delivery.detach(id, run.done);
      return result(
        `Subagent ${id} started in the background. You will receive a <subagent_completion_notification agent_id="${id}"> when it finishes; use read_subagent to wait.`,
        { owner: "subagents", title: run.record.title, status: "running", id, background: true },
      );
    }

    // Foreground: attach lead UI for approval forwarding; detach on pending
    // user message exactly like fusion's interrupted handoff.
    run.runtime.attachUi?.(ctx.ui as never);
    delivery.attach(id);
    const waited = await waitRun(run, signal, ctx, onUpdate);
    run.runtime.detachUi?.();
    if (waited.report) {
      delivery.consume(id);
      const report = waited.report;
      reportRecords.set(id, { title: run.record.title });
      const text = `${report.text}\n\n--- subagent ${id} · ${report.status} · ${String(report.toolCalls)} tool calls · ${(report.durationMs / 1000).toFixed(1)}s`;
      return result(text, { owner: "subagents", title: run.record.title, status: report.status, id }, report.status !== "completed");
    }
    delivery.detach(id, run.done);
    if (waited.aborted) {
      return result(`Subagent ${id} aborted — resume it later with resume:${id}.`, { owner: "subagents", title: run.record.title, status: "cancelled", id }, true);
    }
    if (waited.interrupted) {
      return result(
        `A user message arrived while subagent "${run.record.title}" (${id}) was working. It continues in the background. Act on the user's message first, then call read_subagent({agent_id:"${id}", block:true}) to collect the report.\n${waited.interrupted}`,
        { owner: "subagents", title: run.record.title, status: "running", id },
      );
    }
    if (waited.error) return result(`Subagent ${id} failed: ${waited.error}`, { owner: "subagents", title: run.record.title, status: "failed", id }, true);
    return result(`Subagent ${id} is still running.`, { owner: "subagents", title: run.record.title, status: "running", id });
  }

  async function waitRun(
    run: RunState,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    onUpdate?: (u: unknown) => void,
    timeoutMs = 2_700_000,
  ): Promise<{ report?: HandoffReport; interrupted?: string; aborted?: boolean; error?: string }> {
    const started = Date.now();
    let lastKey = "";
    while (true) {
      if (signal?.aborted) {
        await run.runtime.abort();
        return { aborted: true };
      }
      if (ctx.hasPendingMessages?.()) return { interrupted: progressLine(run) };
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) return {};
      const timer = new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.min(500, remaining)));
      const outcome = await Promise.race([run.done.then((r) => ({ report: r }), (e) => ({ error: String(e) })), timer]);
      if (outcome !== undefined) {
        if ("error" in outcome) return { error: outcome.error };
        return { report: outcome.report };
      }
      const line = progressLine(run);
      if (line !== lastKey) {
        lastKey = line;
        onUpdate?.({ content: [{ type: "text" as const, text: line }], details: { owner: "subagents", title: run.record.title, status: "running" } });
      }
    }
  }

  function progressLine(run: RunState): string {
    const r = run.record;
    const calls = run.runtime.progress(r.id)?.toolCalls ?? r.toolCalls;
    return `● Subagent "${r.title}" working · ${String(calls)} tool calls · ${((Date.now() - r.startedAt) / 1000).toFixed(1)}s`;
  }

  // ── Reader registration for the shared read_subagent tool ────────────────
  registerSubagentReader("subagents", {
    owns: (id) => manager.record(id) !== undefined || manager.run(id) !== undefined,
    latest: () => manager.latest(),
    read: async (params, signal, onUpdate, ctx) => {
      const result = (text: string, details?: unknown, isError = false) => ({ content: [{ type: "text" as const, text }], details: details ?? {}, isError });
      const rec = params.agent_id !== undefined ? manager.record(params.agent_id) : undefined;
      const run = params.agent_id !== undefined ? manager.run(params.agent_id) : undefined;
      const id = params.agent_id ?? manager.latest()?.id;
      if (id === undefined || (rec === undefined && run === undefined)) {
        return result(params.agent_id !== undefined ? `No subagent found for ${params.agent_id}.` : "No subagent has run yet.", undefined, true);
      }
      const record = manager.record(id)!;
      const done = run?.done;
      if (record.status !== "running" || run === undefined || done === undefined) {
        const text = record.report !== undefined
          ? `${record.report}\n\n--- subagent ${id} · ${record.status} · ${String(record.toolCalls)} tool calls`
          : `Subagent ${id} ${record.status}${record.error !== undefined ? `: ${record.error}` : ""}`;
        return result(text, { owner: "subagents", title: record.title, status: record.status, id }, record.status !== "completed");
      }
      if (params.block !== true) {
        return result(`Subagent "${record.title}" (${id}) is running — ${String(record.toolCalls)} tool calls so far.`, { owner: "subagents", title: record.title, status: "running", id });
      }
      run.runtime.attachUi?.(ctx.ui as never);
      delivery.attach(id);
      const waited = await waitRun(run, signal, ctx, onUpdate, Math.min(600, params.timeout ?? 30) * 1000);
      run.runtime.detachUi?.();
      if (waited.report) {
        delivery.consume(id);
        const report = waited.report;
        return result(`${report.text}\n\n--- subagent ${id} · ${report.status} · ${String(report.toolCalls)} tool calls`, { owner: "subagents", title: record.title, status: report.status, id }, report.status !== "completed");
      }
      delivery.detach(id, done);
      if (waited.error) return result(`Subagent ${id} failed: ${waited.error}`, { owner: "subagents", title: record.title, status: "failed", id }, true);
      if (waited.aborted) return result(`Subagent ${id} aborted.`, { owner: "subagents", title: record.title, status: "cancelled", id }, true);
      if (waited.interrupted) return result(`A user message arrived while subagent "${record.title}" (${id}) was working.\n${waited.interrupted}`, { owner: "subagents", title: record.title, status: "running", id });
      return result(`Subagent ${id} is still running.`, { owner: "subagents", title: record.title, status: "running", id });
    },
  });
  ensureReadSubagentTool(pi);

  // Completion renderer — one dim line, Devin-style.
  pi.registerMessageRenderer("subagent-completion", (message: { details?: { title?: string; status?: string; toolCalls?: number; durationMs?: number } }, _o, theme) =>
    new Text(`${theme.fg("accent", "●")} ${theme.fg("dim", `Subagent "${message.details?.title ?? ""}" ${message.details?.status ?? ""} └ ${message.details?.durationMs !== undefined ? (message.details.durationMs / 1000).toFixed(1) + "s" : ""} · ${String(message.details?.toolCalls ?? 0)} tool calls`)}`, 0, 0));

  // ── Prompt section (only while enabled) ───────────────────────────────────
  pi.on("before_agent_start", (event, ctx) => {
    if (!enabled) {
      delete event.systemPromptOptions.sections["subagents"];
      return undefined;
    }
    // The shared status exists only while a Fusion pair is active.
    const fusionActive = getSharedFusionStatus() !== undefined;
    const lines = [
      "You can delegate self-contained subtasks to subagents with `run_subagent`. A subagent is an independent agent with its own context: it does not see this conversation, so put everything it needs in `task` — the goal, relevant paths, constraints, and exactly what to report back.",
      "",
      "Profiles:",
      ...profiles.map((p) => `- ${p.id}: ${p.description}`),
      "subagent_explore is read-only and runs on a cheaper model; subagent_general can make changes and runs on your own model, so it costs like a full extra session.",
      "",
      "- Use subagents for broad or parallelizable work: independent searches, investigations across several areas, or implementation slices that don't touch the same files. Skip them when a direct read or search answers the question.",
      "- Launch independent subagents in the same response so they run in parallel, and keep their work disjoint.",
      "- Foreground (the default) waits and returns the report. Set is_background:true only when you have other work to do meanwhile; you will receive a <subagent_completion_notification> when it finishes. Don't poll read_subagent in a loop.",
      "- Background subagents cannot ask for approval: tool calls that would need approval are denied. Run approval-needing work in the foreground.",
      "- Resume a finished, failed, or cancelled subagent with resume:<agent_id> and a follow-up task; it keeps its context.",
      "- The user does not see subagent output directly: summarize what matters from the report, and verify anything critical before relying on it.",
    ];
    if (fusionActive) {
      lines.push("While Fusion is active, do not use subagents other than the sidekick unless the user explicitly asks you to.");
    }
    event.systemPromptOptions.sections["subagents"] = lines.join("\n");
    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    manager.restore(ctx.cwd ?? process.cwd(), leadSessionId(ctx));
    refresh(ctx.cwd ?? process.cwd(), ctx);
  });
  pi.on("session_shutdown", () => {
    manager.abortAll();
  });

  // Badge naming — in-process one-shot (no child pi).
  pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST, async (data) => {
    await badgeHandler(pi, data as never, lastCtx);
  });

  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, { module: "subagents" });
}
