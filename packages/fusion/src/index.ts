/**
 * @pi-unipi/fusion — extension entry
 *
 * Commands
 *   /unipi:model          Devin-style picker over the curated preset
 *   /unipi:fusion-preset  Curate the preset (lead / sidekick lists, defaults)
 *
 * Autocomplete: when the user types `/model`, `/unipi:model` is pinned as the
 * first suggestion (pi's own `/model` cannot be overridden by extensions).
 *
 * Runtime (this package, later step): the `sidekick` tool + lead policy.
 * For now, confirming a Fusion pair sets the lead as the session model and
 * records the pair; the footer shows `Fusion · Lead ◆ Sidekick`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { setSharedFusionStatus, UNIPI_PREFIX } from "@pi-unipi/core";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  effortLabel,
  globalPresetPath,
  isEffortLevel,
  loadPreset,
  modelKey,
  pushRecent,
  saveCuration,
  saveRuntimeState,
  splitModelKey,
  type ActiveSelection,
  type EffortLevel,
  type FusionPreset,
} from "./preset.js";
import { ModelPicker, type PickerModel, type PickerResult } from "./picker.js";
import { PresetEditor, type PresetEditorResult } from "./preset-editor.js";
import { SidekickRuntime } from "./sidekick-runtime.js";
import { estimateSavings } from "./savings.js";
import { EDIT_NUDGE, bashNudge, leadPolicy, sidekickSystemPrompt, type FusionIdentity } from "./prompts.js";
import { isTrivialShell, BASH_NUDGE_EVERY } from "./nudge.js";
import { registerFusionTools } from "./tools.js";
import { shouldShowSidekickWidget } from "./sidekick-widget.js";
import { frameSidekick, markdownText, renderSidekickTranscript, sidekickWorkingHeader, type ThemeLike } from "./transcript.js";

export const MODEL_COMMAND = `${UNIPI_PREFIX}model`;
export const PRESET_COMMAND = `${UNIPI_PREFIX}fusion-preset`;

export function sidekickSessionPath(leadSessionId?: string): string {
  return join(homedir(), ".unipi", "state", "fusion", "sidekick", `${leadSessionId ?? "default"}.jsonl`);
}

type Registry = { getAvailable(): Model<Api>[]; find(provider: string, id: string): Model<Api> | undefined };

function registryOf(ctx: ExtensionContext): Registry | undefined {
  const r = (ctx as unknown as { modelRegistry?: Registry }).modelRegistry;
  return r && typeof r.getAvailable === "function" ? r : undefined;
}

/** Key-based lookup (provider ids can contain slashes, so splitModelKey+find is unreliable). */
const modelBykey = new Map<string, Model<Api>>();
function findModel(reg: Registry | undefined, key: string): Model<Api> | undefined {
  if (modelBykey.size === 0 && reg) for (const m of reg.getAvailable()) modelBykey.set(modelKey(m), m);
  return modelBykey.get(key);
}

function costOf(m: Model<Api> | undefined, override?: PickerModel["cost"]): PickerModel["cost"] {
  const cost = override ?? (m?.cost && typeof m.cost.input === "number" ? { input: m.cost.input, cachedInput: m.cost.cacheRead ?? 0, output: m.cost.output } : undefined);
  return cost && (cost.input > 0 || cost.cachedInput > 0 || cost.output > 0) ? cost : undefined;
}

function toPickerModel(m: Model<Api>, badge?: FusionPreset["badges"][string], override?: PickerModel["cost"]): PickerModel {
  return {
    key: modelKey(m),
    name: m.name || m.id,
    provider: m.provider,
    badge,
    cost: costOf(m, override),
    reasoning: Boolean(m.reasoning),
  };
}

function currentEffort(ctx: ExtensionContext, pi: ExtensionAPI): EffortLevel {
  const fromCtx = (ctx as { thinkingLevel?: unknown }).thinkingLevel;
  if (isEffortLevel(fromCtx)) return fromCtx;
  try {
    const level = pi.getThinkingLevel();
    if (isEffortLevel(level)) return level;
  } catch {
    /* not available in this context */
  }
  return "medium";
}

/** Pin `/unipi:model` first whenever the user is typing `/model…`. */
export function createModelBoostProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    ...current,
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (!/^\/m(o(d(e(l)?)?)?)?$/iu.test(text)) return base;
      if (!base) return base;
      const idx = base.items.findIndex((i) => i.value === MODEL_COMMAND);
      if (idx <= 0) return base;
      const items = [...base.items];
      const [boosted] = items.splice(idx, 1);
      if (boosted === undefined) return base;
      return { ...base, items: [boosted, ...items] };
    },
  };
}

export default function fusionExtension(pi: ExtensionAPI): void {
  if (process.env.UNIPI_FUSION_CHILD === "1") return;

  let active: ActiveSelection | undefined;
  let runtime: SidekickRuntime | undefined;
  let lastCtx: ExtensionContext | undefined;
  let leadToolCalls = 0;
  let editNudgedThisTurn = false;
  let bashStreak = 0;
  let attached = false;
  let widgetTimer: NodeJS.Timeout | undefined;
  let widgetTimerKind: "publish" | "clear" | undefined;
  let widgetLastAt = 0;

  function identity(ctx: ExtensionContext): FusionIdentity {
    const reg = registryOf(ctx);
    const names = (k: string) => findModel(reg, k)?.name || splitModelKey(k)?.id || k;
    return {
      leadName: names(active?.kind === "fusion" ? active.lead : ""),
      leadEffort: active?.kind === "fusion" ? effortLabel(active.leadEffort ?? "medium") : "",
      sidekickName: names(active?.kind === "fusion" ? active.sidekick : ""),
      sidekickEffort: active?.kind === "fusion" ? effortLabel(active.sidekickEffort ?? "medium") : "",
    };
  }

  function statusSavings(ctx: ExtensionContext): number | undefined {
    if (active?.kind !== "fusion" || runtime === undefined) return undefined;
    const reg = registryOf(ctx);
    const preset = loadPreset(ctx.cwd ?? process.cwd()).preset;
    const lead = findModel(reg, active.lead);
    const side = findModel(reg, active.sidekick);
    return estimateSavings(runtime.usage, costOf(lead, preset.prices[active.lead]), costOf(side, preset.prices[active.sidekick])).savedUsd;
  }

  function publishStatus(ctx: ExtensionContext): void {
    lastCtx = ctx;
    const reg = registryOf(ctx);
    const names = (k: string) => findModel(reg, k)?.name || splitModelKey(k)?.id || k;
    if (active?.kind === "fusion") {
      // Displayed in the input-box model slot (footer glance frame):
      // the working lead lit, the sidekick muted.
      setSharedFusionStatus({
        leadName: names(active.lead),
        leadEffort: active.leadEffort ?? "",
        sidekickName: names(active.sidekick),
        sidekickEffort: active.sidekickEffort ?? "",
        savedUsd: statusSavings(ctx),
        busy: runtime?.isBusy() ?? false,
        leadToolCalls,
        sidekickToolCalls: runtime?.totalToolCalls() ?? 0,
      });
    } else {
      setSharedFusionStatus(undefined);
    }
  }

  function clearSidekickWidget(): void {
    if (widgetTimer !== undefined) {
      clearTimeout(widgetTimer);
      widgetTimer = undefined;
      widgetTimerKind = undefined;
    }
    const ctx = lastCtx;
    if (!ctx?.hasUI || typeof ctx.ui.setWidget !== "function") return;
    const clear = () => {
      widgetTimer = undefined;
      widgetTimerKind = undefined;
      widgetLastAt = Date.now();
      ctx.ui.setWidget("fusion-sidekick", undefined);
    };
    const wait = Math.max(0, 150 - (Date.now() - widgetLastAt));
    if (wait === 0) clear();
    else {
      widgetTimerKind = "clear";
      widgetTimer = setTimeout(clear, wait);
      widgetTimer.unref();
    }
  }

  function publishSidekickWidget(): void {
    const ctx = lastCtx;
    if (!ctx?.hasUI || typeof ctx.ui.setWidget !== "function") return;
    const progress = runtime?.progress();
    if (!runtime || !shouldShowSidekickWidget(runtime.isBusy(), attached) || !progress) {
      ctx.ui.setWidget("fusion-sidekick", undefined);
      return;
    }
    ctx.ui.setWidget("fusion-sidekick", (_tui, theme) => {
      const themeLike = theme as unknown as ThemeLike & { bg: (color: string, text: string) => string };
      return frameSidekick(themeLike, "working", renderSidekickTranscript(themeLike, {
        events: progress.events,
        droppedEvents: progress.droppedEvents,
        header: sidekickWorkingHeader(themeLike, progress),
        expanded: false,
        isPartial: true,
        renderText: markdownText,
      }));
    }, { placement: "aboveEditor" });
  }

  function publishSidekickWidgetLater(): void {
    const ctx = lastCtx;
    if (!ctx?.hasUI || typeof ctx.ui.setWidget !== "function") return;
    if (widgetTimer !== undefined && widgetTimerKind === "publish") return;
    if (widgetTimer !== undefined) {
      clearTimeout(widgetTimer);
      widgetTimer = undefined;
      widgetTimerKind = undefined;
    }
    const wait = Math.max(0, 150 - (Date.now() - widgetLastAt));
    const publish = () => {
      widgetTimer = undefined;
      widgetTimerKind = undefined;
      widgetLastAt = Date.now();
      publishSidekickWidget();
    };
    if (wait === 0) publish();
    else {
      widgetTimerKind = "publish";
      widgetTimer = setTimeout(publish, wait);
      widgetTimer.unref();
    }
  }

  function publishStatusLater(): void {
    if (lastCtx) {
      publishStatus(lastCtx);
      publishSidekickWidgetLater();
    }
  }

  function leadSessionId(ctx: ExtensionContext): string {
    const manager = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
    return manager?.getSessionId?.() ?? "default";
  }

  function getRuntime(ctx: ExtensionContext): SidekickRuntime | undefined {
    if (active?.kind !== "fusion") return undefined;
    if (runtime === undefined) {
      runtime = new SidekickRuntime({
        cwd: ctx.cwd ?? process.cwd(),
        model: active.sidekick,
        thinking: active.sidekickEffort ?? "medium",
        sessionFile: sidekickSessionPath(leadSessionId(ctx)),
        systemPrompt: sidekickSystemPrompt(identity(ctx)),
        onProgress: () => publishStatusLater(),
      });
    }
    return runtime;
  }

  function stopRuntime(): void {
    clearSidekickWidget();
    attached = false;
    runtime?.kill();
    runtime = undefined;
    leadToolCalls = 0;
  }

  function savingsStats(ctx: ExtensionContext): string {
    if (active?.kind !== "fusion" || runtime === undefined) return "Fusion is not active — pick a Fusion pair with /unipi:model.";
    const reg = registryOf(ctx);
    const preset = loadPreset(ctx.cwd ?? process.cwd()).preset;
    const leadCost = costOf(findModel(reg, active.lead), preset.prices[active.lead]);
    const sidekickCost = costOf(findModel(reg, active.sidekick), preset.prices[active.sidekick]);
    const savings = estimateSavings(runtime.usage, leadCost, sidekickCost);
    const pricing = leadCost === undefined && sidekickCost === undefined
      ? '\nPricing unavailable from provider — set "prices" in ~/.unipi/config/fusion/preset.json to estimate savings.'
      : "";
    return `Sidekick tokens: in ${String(runtime.usage.input)} · out ${String(runtime.usage.output)} · cached ${String(runtime.usage.cacheRead)} · cache write ${String(runtime.usage.cacheWrite)}\nSidekick cost: $${savings.sidekickUsd.toFixed(2)} · at lead prices: $${savings.atLeadUsd.toFixed(2)} · saved: $${savings.savedUsd.toFixed(2)}\nHandoffs: ${String(runtime.reports.size)} · runtime alive: ${String(runtime.isAlive())} · busy: ${String(runtime.isBusy())}${pricing}`;
  }

  registerFusionTools(pi, {
    getRuntime,
    onReport: (ctx) => {
      attached = false;
      clearSidekickWidget();
      publishStatus(ctx);
    },
    onHandoffStart: (ctx) => publishStatus(ctx),
    onAttach: () => {
      attached = true;
      clearSidekickWidget();
    },
    onDetach: () => {
      attached = false;
      publishSidekickWidgetLater();
    },
  });
  pi.registerCommand("unipi:fusion-stats", {
    description: "Estimated Fusion savings (sidekick tokens priced at lead rates)",
    handler: async (_args, ctx) => ctx.ui.notify(savingsStats(ctx), "info"),
  });
  pi.on("before_agent_start", (event, ctx) => active?.kind === "fusion" ? { systemPrompt: `${event.systemPrompt}\n\n${leadPolicy(identity(ctx))}` } : undefined);
  pi.on("turn_start", () => {
    editNudgedThisTurn = false;
  });
  pi.on("tool_result", (event) => {
    if (active?.kind !== "fusion") return;
    const toolName: string = event.toolName;
    if (toolName === "sidekick" || toolName === "read_subagent") {
      bashStreak = 0;
      return;
    }
    leadToolCalls += 1;
    publishStatusLater();
    if (toolName === "edit" || toolName === "write") {
      if (editNudgedThisTurn) return;
      editNudgedThisTurn = true;
      return { content: [...event.content, { type: "text" as const, text: EDIT_NUDGE }] };
    }
    if (toolName !== "bash") return;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (isTrivialShell(command)) return;
    bashStreak += 1;
    if (bashStreak < BASH_NUDGE_EVERY) return;
    const content = [...event.content, { type: "text" as const, text: bashNudge(bashStreak) }];
    bashStreak = 0;
    return { content };
  });

  async function applyResult(ctx: ExtensionContext, result: PickerResult, preset: FusionPreset, loaded: { globalPath: string; projectPath: string; hasProjectLayer: boolean }): Promise<void> {
    if (result.type === "cancelled") return;
    const samePair = result.type === "fusion" && active?.kind === "fusion" && active.lead === result.lead && active.sidekick === result.sidekick;
    const reg = registryOf(ctx);
    const targetKey = result.type === "single" ? result.model : result.lead;
    const model = findModel(reg, targetKey);
    if (!model) {
      ctx.ui.notify(`Model ${targetKey} is not available. Run /login or fix the preset.`, "error");
      return;
    }
    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(`Could not switch to ${targetKey}.`, "error");
      return;
    }
    if (!samePair) stopRuntime();
    const effort = result.type === "single" ? result.effort : result.leadEffort;
    try {
      pi.setThinkingLevel(effort);
    } catch {
      /* provider may not support thinking */
    }
    active =
      result.type === "single"
        ? { kind: "single", model: result.model }
        : {
            kind: "fusion",
            lead: result.lead,
            sidekick: result.sidekick,
            leadEffort: result.leadEffort,
            sidekickEffort: result.sidekickEffort,
          };
    const recent = pushRecent(preset.recent, targetKey);
    if (result.type === "fusion") {
      // Remember the confirmed pair as the preset default (the preset editor
      // never edits defaults; confirming here is the natural place).
      const layerPath = loaded.hasProjectLayer ? loaded.projectPath : loaded.globalPath;
      saveCuration(layerPath, {
        lead: preset.lead.includes(result.lead) ? preset.lead : [result.lead, ...preset.lead],
        sidekick: preset.sidekick.includes(result.sidekick)
          ? preset.sidekick
          : [result.sidekick, ...preset.sidekick],
        default: { lead: result.lead, sidekick: result.sidekick },
      });
    }
    saveRuntimeState(loaded.globalPath, { effort: result.effortMap, recent, active });
    publishStatus(ctx);
    const label =
      result.type === "single"
        ? `${model.name || model.id} · ${effortLabel(effort)}`
        : `Fusion · ${model.name || model.id} ${effortLabel(effort)} ◆ ${
            findModel(reg, result.sidekick)?.name ?? splitModelKey(result.sidekick)?.id ?? result.sidekick
          } ${effortLabel(result.sidekickEffort)}`;
    ctx.ui.notify(label, "info");
  }

  pi.registerCommand("unipi:model", {
    description: "Pick a model or a Fusion lead+sidekick pair (Devin-style picker over your preset)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error(`/${MODEL_COMMAND} needs the interactive TUI`);
      const reg = registryOf(ctx);
      if (!reg) {
        ctx.ui.notify("Model registry unavailable in this context.", "error");
        return;
      }
      const cwd = ctx.cwd ?? process.cwd();
      const loaded = loadPreset(cwd);
      const preset = loaded.preset;
      const models = reg.getAvailable().map((m) => toPickerModel(m, preset.badges[modelKey(m)], preset.prices[modelKey(m)]));
      if (models.length === 0) {
        ctx.ui.notify("No models available. Use /login to add a provider.", "warning");
        return;
      }
      const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
      // Session truth wins over persisted state: if the user switched via pi's
      // own /model since, show that as the pinned row.
      if (active === undefined && preset.active !== undefined) active = preset.active;
      if (currentKey !== undefined) {
        if (active === undefined || (active.kind === "single" && active.model !== currentKey) || (active.kind === "fusion" && active.lead !== currentKey)) {
          active = { kind: "single", model: currentKey };
        }
      }
      const fallbackEffort = currentEffort(ctx, pi);
      const result = await ctx.ui.custom<PickerResult>(
        (tui, theme, _kb, done) =>
          new ModelPicker({
            state: {
              models,
              fusionLeads: preset.lead,
              fusionSidekicks: preset.sidekick,
              fusionDefault: preset.default,
              recent: preset.recent,
              active,
              currentModelKey: currentKey,
              effort: preset.effort,
              fallbackEffort,
            },
            theme: { fg: (c, s) => theme.fg(c as never, s), bold: (s) => theme.bold(s) },
            onDone: done,
            onRenderRequest: () => tui.requestRender(),
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "88%", minWidth: 72, maxHeight: "80%" },
        },
      );
      await applyResult(ctx, result, preset, loaded);
    },
  });

  pi.registerCommand("unipi:fusion-preset", {
    description: "Curate the model preset used by /unipi:model (lead + sidekick lists, defaults)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error(`/${PRESET_COMMAND} needs the interactive TUI`);
      const reg = registryOf(ctx);
      if (!reg) {
        ctx.ui.notify("Model registry unavailable in this context.", "error");
        return;
      }
      const cwd = ctx.cwd ?? process.cwd();
      const loaded = loadPreset(cwd);
      const models = reg.getAvailable().map((m) => ({ key: modelKey(m), name: m.name || m.id }));
      const result = await ctx.ui.custom<PresetEditorResult>(
        (tui, theme, _kb, done) =>
          new PresetEditor({
            models,
            initial: { lead: loaded.preset.lead, sidekick: loaded.preset.sidekick, default: loaded.preset.default },
            active,
            initialTarget: loaded.hasProjectLayer ? "project" : "global",
            theme: { fg: (c, s) => theme.fg(c as never, s), bold: (s) => theme.bold(s) },
            onDone: done,
            onRenderRequest: () => tui.requestRender(),
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "80%", minWidth: 64, maxHeight: "80%" },
        },
      );
      if (result.type !== "saved") return;
      const path = result.target === "project" ? loaded.projectPath : loaded.globalPath;
      saveCuration(path, result.curation);
      ctx.ui.notify(
        `Saved preset → ${path}\n${String(result.curation.lead.length)} lead · ${String(result.curation.sidekick.length)} sidekick`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_e, ctx) => {
    stopRuntime();
    editNudgedThisTurn = false;
    bashStreak = 0;
    modelBykey.clear();
    active = loadPreset(ctx.cwd ?? process.cwd()).preset.active;
    if (active?.kind === "fusion" && (!ctx.model || modelKey(ctx.model) !== active.lead)) {
      const leadKey = active.lead;
      const lead = findModel(registryOf(ctx), leadKey);
      const restored = lead !== undefined && await pi.setModel(lead);
      if (restored) {
        try {
          pi.setThinkingLevel(active.leadEffort ?? "medium");
        } catch {
          /* provider may not support thinking */
        }
      } else {
        active = undefined;
        if (ctx.hasUI) ctx.ui.notify(`Fusion lead ${leadKey} unavailable — Fusion off`, "warning");
      }
    }
    publishStatus(ctx);
    if (ctx.hasUI) ctx.ui.addAutocompleteProvider(createModelBoostProvider);
  });

  pi.on("session_shutdown", () => {
    stopRuntime();
    setSharedFusionStatus(undefined);
  });

  pi.on("model_select", (event, ctx) => {
    // The user switched through pi's own /model or Ctrl+P: leave Fusion mode
    // unless the new model is still the lead.
    if (active?.kind === "fusion" && modelKey(event.model) !== active.lead) {
      stopRuntime();
      active = { kind: "single", model: modelKey(event.model) };
      const loaded = loadPreset(ctx.cwd ?? process.cwd());
      saveRuntimeState(globalPresetPath(), { effort: loaded.preset.effort, recent: loaded.preset.recent, active });
      publishStatus(ctx);
    }
  });
}

export { loadPreset } from "./preset.js";
export type { ActiveSelection } from "./preset.js";
