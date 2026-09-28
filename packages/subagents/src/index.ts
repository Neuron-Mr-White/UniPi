/**
 * @pi-unipi/subagents — Devin-model subagents for unipi.
 *
 * Tools: `run_subagent` (foreground wait / background notify / resume) and a
 * reader registration for the shared core `read_subagent` tool.
 * Profiles: built-ins `subagent_explore` / `subagent_general` plus custom
 * markdown agents from ~/.unipi/config/agents and <workspace>/.unipi/config/agents.
 * Config `subagents`: enabled, defaultModel, defaultThinking, maxConcurrent —
 * re-read every turn, so settings and agent files apply without a restart.
 *
 * TUI (Devin parity): spawn card with a live tail, `Subagent "…" completed`
 * lines, the `N subagents (k running) · ↓ select` strip, the dock (↵ view,
 * f foreground, x cancel), Ctrl+B to background a foreground subagent.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  UNIPI_EVENTS, emitEvent, getSettings, registerSettings, getSharedFusionStatus, SPINNER_MS,
} from "@pi-unipi/core";
import {
  ensureReadSubagentTool, registerSubagentReader, setReadSubagentDemand,
  createCompletionDelivery, type HandoffReport,
} from "@pi-unipi/core/child-agent.js";
import {
  SubagentManager, canSpawn, getSharedSubagents, subscribeSubagents, recordStatusFor,
  MAX_CONCURRENT, type SubagentRecord, type SubagentRun, type SubagentStatus,
} from "./manager.js";
import { loadProfiles, type AgentProfile } from "./profiles.js";
import { buildTranscript, itemsFromEvents } from "./transcript.js";
import {
  SubagentDock, SubagentStrip, elapsed, plural, profileLabel, statusColor, statusGlyph, tailLines, STATUS_LABEL, type ThemeLike,
} from "./ui.js";
import { AGENTS_COMMAND, registerAgentsCommand } from "./agents.js";
import {
  cardOutcome, renderCompletion, renderRunCall, renderRunResult, type CardContext, type CardDetails, type RunArgs,
} from "./cards.js";

export interface SubagentsConfig {
  enabled: boolean;
  defaultModel?: string;
  defaultThinking?: string;
  maxConcurrent?: number;
}

const DEFAULT_CONFIG: SubagentsConfig = { enabled: true, defaultThinking: "inherit", maxConcurrent: MAX_CONCURRENT };
const AUTO_MODEL = "auto (Fusion sidekick → your model)";

registerSettings({
  namespace: "subagents",
  label: "Subagents",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Subagents",
      fields: [
        { key: "enabled", type: "boolean", label: "Enabled", description: "Offer run_subagent / read_subagent to the agent. Applies from the next turn." },
        {
          key: "defaultModel", type: "model", label: "Default subagent model", capability: "text",
          description: "Model for subagent_explore and custom agents without a model: line. subagent_general always runs on your model.",
          emptyLabel: AUTO_MODEL, emptyOption: AUTO_MODEL,
        },
        {
          key: "defaultThinking", type: "enum", label: "Default thinking level",
          description: "For subagent_explore and custom agents without thinking:. subagent_general uses yours.",
          options: [{ value: "inherit", label: "inherit (your level)" }, "off", "minimal", "low", "medium", "high", "xhigh"],
        },
        { key: "maxConcurrent", type: "number", label: "Max running at once", min: 1, max: 16, description: "Further run_subagent calls are refused until one finishes." },
      ],
    },
    {
      title: "Agents",
      fields: [
        { key: "manageAgents", type: "action", label: "Manage agents…", description: "List, create, edit, copy or delete custom agents (global or this project).", command: AGENTS_COMMAND },
      ],
    },
  ],
});

export function loadConfig(cwd: string): SubagentsConfig {
  try {
    const m = getSettings("subagents", cwd) as unknown as SubagentsConfig;
    const n = Number(m.maxConcurrent);
    return {
      enabled: m.enabled !== false,
      defaultModel: typeof m.defaultModel === "string" && m.defaultModel.trim() ? m.defaultModel.trim() : undefined,
      defaultThinking: typeof m.defaultThinking === "string" && m.defaultThinking !== "inherit" && m.defaultThinking ? m.defaultThinking : undefined,
      maxConcurrent: Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_CONCURRENT,
    };
  } catch {
    return { enabled: true, maxConcurrent: MAX_CONCURRENT };
  }
}

const RunSubagentParams = Type.Object({
  title: Type.String({ description: "Short 3-8 word title shown to the user" }),
  task: Type.String({
    description: "Complete, self-contained instructions. The subagent does not see this conversation: include the goal, relevant paths, constraints, and what to report back.",
  }),
  profile: Type.String({ description: "" }), // rebuilt at load: profile list
  is_background: Type.Optional(Type.Boolean({ description: "Run without waiting; report arrives via notification (default false)" })),
  resume: Type.Optional(Type.String({ description: "agent_id of an earlier subagent to continue (keeps its context); always runs in the foreground" })),
});

const RUN_DESCRIPTION =
  "Launch an independent subagent for a self-contained task. It has its own context and does not see this conversation, so put everything it needs in `task`. Foreground (default) waits and returns the subagent's report. With is_background:true it returns immediately and you receive a <subagent_completion_notification> when it finishes; use read_subagent to wait for it — never poll in a loop. Background subagents cannot ask for approval: tool calls that would need approval are denied. Use resume:<agent_id> to continue an earlier subagent with a follow-up task.";

const STRIP_KEY = "subagents-strip";
const FG_KEY = "subagents-foreground";
const WORKING = "Subagent running · Ctrl+B to run in background";


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

export { cardOutcome };

export default function subagents(pi: ExtensionAPI): void {
  const manager = new SubagentManager();
  const delivery = createCompletionDelivery<HandoffReport>((report) => deliverCompletion(report));

  let profiles: AgentProfile[] = [];
  let config: SubagentsConfig = { ...DEFAULT_CONFIG };
  let enabled = false;
  let uiCtx: ExtensionContext | undefined;
  const warned = new Set<string>();

  // UI state
  let stripTui: TUI | undefined;
  let stripInstalled = false;
  let fgInstalled = false;
  let dockOpen = false;
  let workingShown = false;
  let unsubInput: (() => void) | undefined;
  /** Foreground waiters (run_subagent / read_subagent block) → move to bg. */
  const fgWaits = new Map<string, () => void>();
  /** Background agents the user foregrounded from the dock (f). */
  const watched = new Set<string>();

  function deliverCompletion(report: HandoffReport): void {
    const rec = manager.record(report.id);
    if (rec?.cancelledBy === "session") return; // the session is gone
    const status = rec?.status ?? recordStatusFor(report);
    const head = status === "cancelled"
      ? rec?.cancelledBy === "user" ? "Cancelled by the user." : "Cancelled."
      : status === "failed" ? `Failed${report.error ? `: ${report.error}` : "."}` : "";
    const body = [head, report.text].filter((s) => s && s.trim()).join("\n\n");
    try {
      pi.sendMessage(
        {
          customType: "subagent-completion",
          content: `<subagent_completion_notification agent_id="${report.id}" status="${status}">\n${body}\n</subagent_completion_notification>`,
          display: true,
          details: {
            owner: "subagents", id: report.id, title: rec?.title ?? report.id, profile: rec?.profile, status,
            cancelledBy: rec?.cancelledBy, toolCalls: report.toolCalls, durationMs: report.durationMs, report: report.text.slice(0, 20_000),
          },
        } as never,
        { deliverAs: "followUp", triggerTurn: true } as never,
      );
    } catch {
      /* session replaced while it finished */
    }
  }

  /** Re-read config + agent files; returns the load warnings. Safe at load. */
  function reload(cwd: string): string[] {
    config = loadConfig(cwd);
    enabled = config.enabled;
    const loaded = loadProfiles(cwd);
    profiles = loaded.profiles;
    return loaded.warnings;
  }

  /** reload + tool sync + warnings (runtime only — not during loading). */
  function refresh(cwd: string, ctx?: ExtensionContext): void {
    // Warnings surface once per distinct message per process.
    for (const w of reload(cwd)) {
      if (warned.has(w)) continue;
      warned.add(w);
      (ctx ?? uiCtx)?.ui?.notify?.(`subagents: ${w}`, "warning");
    }
    setReadSubagentDemand(pi, "subagents", enabled);
    syncRunSubagent();
  }

  function syncRunSubagent(): void {
    const want = enabled && canSpawn();
    const current = pi.getActiveTools();
    const has = current.includes("run_subagent");
    if (has !== want) pi.setActiveTools(want ? [...current, "run_subagent"] : current.filter((t) => t !== "run_subagent"));
  }

  // Profiles load before registration so the tool schema's profile list is
  // complete; later additions reach the model through the prompt section.
  reload(process.cwd());

  const transcriptOf = (rec: SubagentRecord) =>
    buildTranscript({ sessionFile: rec.sessionFile, task: rec.task, running: rec.status === "running", events: manager.events(rec.id) });
  const liveItems = (id: string) => itemsFromEvents(manager.events(id) ?? []);

  // ── UI sync ───────────────────────────────────────────────────────────────

  function syncUi(): void {
    const ctx = uiCtx;
    if (!ctx?.hasUI) return;
    try {
      for (const id of watched) {
        if (manager.run(id) === undefined) watched.delete(id);
      }
      const wantStrip = getSharedSubagents().length > 0;
      if (wantStrip && !stripInstalled) {
        stripInstalled = true;
        ctx.ui.setWidget(STRIP_KEY, (tui, theme) => {
          stripTui = tui;
          return new SubagentStrip(theme, getSharedSubagents);
        }, { placement: "belowEditor" });
      } else if (!wantStrip && stripInstalled) {
        stripInstalled = false;
        stripTui = undefined;
        ctx.ui.setWidget(STRIP_KEY, undefined);
      } else {
        stripTui?.requestRender();
      }
      const wantFg = watched.size > 0;
      if (wantFg && !fgInstalled) {
        fgInstalled = true;
        ctx.ui.setWidget(FG_KEY, (tui, theme) => {
          const timer = setInterval(() => tui.requestRender(), SPINNER_MS);
          timer.unref?.();
          return { invalidate() {}, render: (w: number) => renderWatched(w, theme), dispose: () => clearInterval(timer) };
        }, { placement: "aboveEditor" });
      } else if (!wantFg && fgInstalled) {
        fgInstalled = false;
        ctx.ui.setWidget(FG_KEY, undefined);
      }
      const wantWorking = fgWaits.size > 0 || watched.size > 0;
      if (wantWorking !== workingShown) {
        workingShown = wantWorking;
        ctx.ui.setWorkingMessage(wantWorking ? WORKING : undefined);
      }
    } catch {
      /* UI is best-effort; the runs are unaffected */
    }
  }
  const unsubRegistry = subscribeSubagents(syncUi);

  function renderWatched(width: number, theme: ThemeLike): string[] {
    const out: string[] = [];
    for (const id of watched) {
      const rec = manager.record(id);
      if (rec === undefined) continue;
      // Same Devin card as a foreground run_subagent.
      const head = `${statusGlyph(rec.status, theme)} ${theme.bold(`${profileLabel(rec.profile)} subagent`)} ${rec.title}`;
      const foot = theme.fg("dim", `└ Running · ${elapsed(Date.now() - rec.startedAt)} · ${plural(manager.toolCalls(id), "tool call")} · ctrl+b background`);
      out.push(truncateToWidth(head, width), ...tailLines(liveItems(id), width, theme, 4), truncateToWidth(`  ${foot}`, width));
    }
    return out;
  }

  function foregroundAgent(id: string): string | undefined {
    const run = manager.run(id);
    if (run === undefined) return "Already finished — ask the agent to resume it.";
    if (fgWaits.has(id) || watched.has(id)) return undefined;
    if (uiCtx) run.runtime.attachUi(uiCtx.ui as never);
    manager.setBackground(id, false);
    watched.add(id);
    syncUi();
    return undefined;
  }

  /** Ctrl+B: every foreground subagent goes to the background. */
  function backgroundAll(): boolean {
    let any = false;
    for (const move of [...fgWaits.values()]) {
      move();
      any = true;
    }
    for (const id of watched) {
      manager.run(id)?.runtime.detachUi();
      manager.setBackground(id, true);
      any = true;
    }
    watched.clear();
    syncUi();
    return any;
  }

  function cancelAgent(id: string): string | undefined {
    return manager.cancel(id, "user") ? undefined : "Not running.";
  }

  async function openDock(ctx: ExtensionContext, initialId?: string): Promise<void> {
    if (dockOpen || !ctx.hasUI) return;
    dockOpen = true;
    try {
      await ctx.ui.custom<void>((tui, theme, _kb, done) => new SubagentDock(tui, theme, {
        records: getSharedSubagents,
        transcript: transcriptOf,
        toolCalls: (rec) => manager.toolCalls(rec.id),
        subscribe: subscribeSubagents,
        foreground: foregroundAgent,
        cancel: cancelAgent,
      }, () => done(), initialId));
    } finally {
      dockOpen = false;
    }
  }

  /** The editor is focused, empty and not autocompleting (↓ may open the dock). */
  function editorIdle(): boolean {
    const tui = stripTui as { getFocusedComponent?: () => unknown } | undefined;
    const f = tui?.getFocusedComponent?.() as { getText?: () => string; isShowingAutocomplete?: () => boolean } | null | undefined;
    if (!f || typeof f.getText !== "function" || typeof f.isShowingAutocomplete !== "function") return false;
    return f.getText() === "" && !f.isShowingAutocomplete();
  }

  function onTerminalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, "ctrl+b")) return backgroundAll() ? { consume: true } : undefined;
    if (matchesKey(data, Key.down) && !dockOpen && stripInstalled && uiCtx && editorIdle()) {
      void openDock(uiCtx);
      return { consume: true };
    }
    return undefined;
  }

  // ── run_subagent ──────────────────────────────────────────────────────────

  if (canSpawn()) {
    const profileParam = profiles.map((p) => `${p.id} — ${p.description}`).join("; ");
    pi.registerTool({
      name: "run_subagent",
      label: "Run Subagent",
      description: RUN_DESCRIPTION,
      parameters: Type.Object({
        ...RunSubagentParams.properties,
        profile: Type.String({ description: `Profile name. Available: ${profileParam}. Custom agents added later are listed in the Subagents section of the system prompt.` }),
      }),
      renderShell: "self",
      renderCall: (args: RunArgs, theme, context) => renderRunCall(args, theme, context as unknown as CardContext),
      renderResult: (result, opts, theme, context) =>
        renderRunResult(result as never, opts, theme, context as unknown as CardContext, (context as { args?: RunArgs }).args ?? {}, {
          tail: (id, w) => tailLines(liveItems(id), w, theme, 4),
          toolCalls: (id) => manager.toolCalls(id),
          startedAt: (id) => manager.record(id)?.startedAt,
        }),
      execute: runSubagent as never,
    });
  }

  function textResult(text: string, details: CardDetails, isError = false) {
    return { content: [{ type: "text" as const, text }], details, isError };
  }

  function doneDetails(rec: SubagentRecord, report: HandoffReport): CardDetails {
    return {
      owner: "subagents", id: rec.id, title: rec.title, profile: rec.profile, phase: "done",
      status: rec.status === "running" ? recordStatusFor(report, rec.cancelledBy) : rec.status,
      toolCalls: report.toolCalls, durationMs: report.durationMs, error: report.error, cancelledBy: rec.cancelledBy,
    };
  }

  function reportText(rec: SubagentRecord, report: HandoffReport, status: SubagentStatus): string {
    const head = status === "cancelled" ? `Subagent ${rec.id} was cancelled${rec.cancelledBy === "user" ? " by the user" : ""}. Partial output:\n\n` : "";
    return `${head}${report.text}\n\n--- subagent ${rec.id} · ${status} · ${plural(report.toolCalls, "tool call")} · ${(report.durationMs / 1000).toFixed(1)}s`;
  }

  /**
   * Wait for a run while the lead's UI can answer its approvals. Ends on the
   * report, Esc (aborted), Ctrl+B (moved), a pending user message
   * (interrupted) or the timeout.
   */
  async function waitForeground(
    run: SubagentRun,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    onUpdate: ((u: unknown) => void) | undefined,
    timeoutMs: number,
  ): Promise<{ report?: HandoffReport; interrupted?: boolean; aborted?: boolean; moved?: boolean; error?: string }> {
    const id = run.record.id;
    let move!: () => void;
    const moved = new Promise<"moved">((r) => {
      move = () => r("moved");
    });
    run.runtime.attachUi(ctx.ui as never);
    delivery.attach(id);
    fgWaits.set(id, move);
    manager.setBackground(id, false);
    syncUi();
    const started = Date.now();
    try {
      while (true) {
        if (signal?.aborted) return { aborted: true };
        if (ctx.hasPendingMessages?.()) return { interrupted: true };
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) return {};
        const tick = new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.min(400, remaining)));
        const outcome = await Promise.race([run.done.then((r) => ({ report: r }), (e) => ({ error: String(e) })), moved, tick]);
        if (outcome === "moved") return { moved: true };
        if (outcome !== undefined) return outcome;
        onUpdate?.({
          content: [{ type: "text" as const, text: `Subagent "${run.record.title}" working · ${plural(manager.toolCalls(id), "tool call")}` }],
          details: { owner: "subagents", id, title: run.record.title, profile: run.record.profile, status: "running", startedAt: run.record.startedAt } satisfies CardDetails,
        });
      }
    } finally {
      fgWaits.delete(id);
      run.runtime.detachUi();
      syncUi();
    }
  }

  async function runSubagent(
    _toolCallId: string,
    params: { title: string; task: string; profile: string; is_background?: boolean; resume?: string },
    signal: AbortSignal | undefined,
    onUpdate: ((u: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ) {
    const cwd = ctx.cwd ?? process.cwd();
    const resumeId = params.resume?.trim() || undefined;
    const profileName = resumeId !== undefined ? (manager.record(resumeId)?.profile ?? params.profile) : params.profile;
    const profile = profiles.find((p) => p.id === profileName);
    if (!profile) {
      return textResult(`Unknown profile "${params.profile}". Available: ${profiles.map((p) => p.id).join(", ")}`, { owner: "subagents", status: "failed", title: params.title }, true);
    }

    const start = manager.start({
      title: params.title,
      task: params.task,
      profile,
      model: resolveSubagentModel(profile, ctx, config),
      thinking: resolveSubagentThinking(profile, ctx, config),
      cwd,
      leadSessionId: leadSessionId(ctx),
      background: resumeId === undefined && params.is_background === true,
      resume: resumeId,
      maxConcurrent: config.maxConcurrent,
    });
    if ("error" in start) return textResult(start.error, { owner: "subagents", status: "failed", title: params.title, error: start.error }, true);
    const { run } = start;
    const rec = run.record;
    const id = rec.id;
    const base: CardDetails = { owner: "subagents", id, title: rec.title, profile: rec.profile };

    if (rec.background) {
      delivery.detach(id, run.done);
      return textResult(
        `Subagent ${id} started in the background. You will receive a <subagent_completion_notification agent_id="${id}"> when it finishes; use read_subagent to wait.`,
        { ...base, status: "running", phase: "started" },
      );
    }

    const waited = await waitForeground(run, signal, ctx, onUpdate, 2_700_000);
    if (waited.report) {
      delivery.consume(id);
      const details = doneDetails(rec, waited.report);
      return textResult(reportText(rec, waited.report, details.status!), details, details.status !== "completed");
    }
    if (waited.aborted) {
      // Esc stopped the turn: the tool result reports the cancel; a completion
      // notice would wake the lead right after the user stopped it.
      delivery.consume(id);
      manager.cancel(id, "user");
      return textResult(`The user cancelled subagent "${rec.title}" (${id}). Don't restart it unless asked; it can be resumed with resume:${id}.`, { ...base, status: "cancelled", phase: "done", cancelledBy: "user", toolCalls: manager.toolCalls(id), durationMs: Date.now() - rec.startedAt }, true);
    }
    delivery.detach(id, run.done);
    manager.setBackground(id, true);
    if (waited.moved) {
      return textResult(
        `The user moved subagent "${rec.title}" (${id}) to the background so you don't wait for it. It keeps working; you will receive a <subagent_completion_notification agent_id="${id}"> when it finishes. Do not wait for it with read_subagent — continue with other work, or end your turn and let the notification wake you.`,
        { ...base, status: "running", phase: "moved" },
      );
    }
    if (waited.interrupted) {
      return textResult(
        `A user message arrived while subagent "${rec.title}" (${id}) was working. It continues in the background. Act on the user's message first; its completion notification will arrive when it finishes (or call read_subagent({agent_id:"${id}", block:true})).`,
        { ...base, status: "running", phase: "moved" },
      );
    }
    if (waited.error) return textResult(`Subagent ${id} failed: ${waited.error}`, { ...base, status: "failed", phase: "done", error: waited.error }, true);
    return textResult(`Subagent ${id} is still running in the background; its completion notification will arrive when it finishes.`, { ...base, status: "running", phase: "moved" });
  }

  // ── Reader registration for the shared read_subagent tool ────────────────
  registerSubagentReader("subagents", {
    owns: (id) => manager.record(id) !== undefined || manager.run(id) !== undefined,
    latest: () => manager.latest(),
    read: async (params, signal, onUpdate, ctx) => {
      const id = params.agent_id ?? manager.latest()?.id;
      const record = id !== undefined ? manager.record(id) : undefined;
      if (id === undefined || record === undefined) {
        return textResult(params.agent_id !== undefined ? `No subagent found for ${params.agent_id}.` : "No subagent has run yet.", { owner: "subagents" }, true);
      }
      const base: CardDetails = { owner: "subagents", id, title: record.title, profile: record.profile };
      const run = manager.run(id);
      if (record.status !== "running" || run === undefined) {
        const text = record.report !== undefined
          ? `${record.status === "cancelled" ? `Cancelled${record.cancelledBy === "user" ? " by the user" : ""}. Partial output:\n\n` : ""}${record.report}\n\n--- subagent ${id} · ${record.status} · ${plural(record.toolCalls, "tool call")}`
          : `Subagent ${id} ${record.status}${record.error !== undefined ? `: ${record.error}` : ""}`;
        return textResult(text, { ...base, status: record.status, phase: "done", toolCalls: record.toolCalls, cancelledBy: record.cancelledBy }, record.status !== "completed");
      }
      if (params.block !== true) {
        return textResult(`Subagent "${record.title}" (${id}) is running — ${plural(manager.toolCalls(id), "tool call")} so far.`, { ...base, status: "running" });
      }
      const wasBackground = record.background;
      const waited = await waitForeground(run, signal, ctx, onUpdate, Math.min(600, params.timeout ?? 30) * 1000);
      if (waited.report) {
        delivery.consume(id);
        const details = doneDetails(record, waited.report);
        return textResult(reportText(record, waited.report, details.status!), details, details.status !== "completed");
      }
      delivery.detach(id, run.done);
      if (wasBackground) manager.setBackground(id, true);
      if (waited.error) return textResult(`Subagent ${id} failed: ${waited.error}`, { ...base, status: "failed", error: waited.error }, true);
      if (waited.aborted) return textResult(`Stopped waiting for subagent ${id}; it keeps running in the background.`, { ...base, status: "running" });
      if (waited.moved) return textResult(`The user moved subagent ${id} to the background; stop waiting and continue — its completion notification will arrive.`, { ...base, status: "running" });
      if (waited.interrupted) return textResult(`A user message arrived while waiting for subagent "${record.title}" (${id}); it keeps running. Act on the message first.`, { ...base, status: "running" });
      return textResult(`Subagent ${id} is still running.`, { ...base, status: "running" });
    },
  });
  ensureReadSubagentTool(pi);

  // Background completion notice — badge: `DONE Explore title ···· 7s · 1 tool call`.
  pi.registerMessageRenderer("subagent-completion", (message: { details?: CardDetails & { report?: string } }, opts: { expanded?: boolean }, theme) =>
    renderCompletion(message.details, opts.expanded === true, theme));

  // ── Prompt section (only while enabled) ───────────────────────────────────
  pi.on("before_agent_start", (event, ctx) => {
    refresh(ctx.cwd ?? process.cwd(), ctx);
    if (!enabled) {
      delete event.systemPromptOptions.sections["subagents"];
      return undefined;
    }
    const fusionActive = getSharedFusionStatus() !== undefined;
    const out = [
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
      "- The user can move a foreground subagent to the background (Ctrl+B) or cancel any subagent. When that happens, continue accordingly; don't restart a cancelled subagent unless asked.",
      "- Resume a finished, failed, or cancelled subagent with resume:<agent_id> and a follow-up task; it keeps its context.",
      "- The user does not see subagent output directly: summarize what matters from the report, and verify anything critical before relying on it.",
    ];
    if (fusionActive) out.push("While Fusion is active, do not use subagents other than the sidekick unless the user explicitly asks you to.");
    event.systemPromptOptions.sections["subagents"] = out.join("\n");
    return undefined;
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  pi.registerCommand("unipi:subagents", {
    description: "Open the subagent panel (also ↓ from an empty input)",
    handler: async (_args, ctx) => {
      if (getSharedSubagents().length === 0) {
        ctx.ui.notify("No subagents in this session yet.", "info");
        return;
      }
      await openDock(ctx);
    },
  });
  registerAgentsCommand(pi, { onChange: (cwd) => refresh(cwd) });

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    stripInstalled = false;
    fgInstalled = false;
    workingShown = false;
    manager.restore(ctx.cwd ?? process.cwd(), leadSessionId(ctx));
    refresh(ctx.cwd ?? process.cwd(), ctx);
    unsubInput?.();
    unsubInput = ctx.hasUI ? ctx.ui.onTerminalInput(onTerminalInput) : undefined;
    syncUi();
  });
  pi.on("session_shutdown", () => {
    manager.shutdown();
    unsubInput?.();
    unsubInput = undefined;
    unsubRegistry();
    uiCtx = undefined;
  });

  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, { module: "subagents" });
}
