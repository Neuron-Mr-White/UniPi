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
import { FIRST_EDIT_NUDGE, leadPolicy, sidekickSystemPrompt, type FusionIdentity } from "./prompts.js";
import { registerFusionTools } from "./tools.js";

export const MODEL_COMMAND = `${UNIPI_PREFIX}model`;
export const PRESET_COMMAND = `${UNIPI_PREFIX}fusion-preset`;
export const STATS_COMMAND = `${UNIPI_PREFIX}fusion-stats`;

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

function costOf(m: Model<Api> | undefined): PickerModel["cost"] {
  const cost = m?.cost;
  return cost && typeof cost.input === "number"
    ? { input: cost.input, cachedInput: cost.cacheRead ?? 0, output: cost.output }
    : undefined;
}

function toPickerModel(m: Model<Api>, badge?: FusionPreset["badges"][string]): PickerModel {
  return {
    key: modelKey(m),
    name: m.name || m.id,
    provider: m.provider,
    badge,
    cost: costOf(m),
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
  let nudged = false;

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
    const lead = findModel(reg, active.lead);
    const side = findModel(reg, active.sidekick);
    return estimateSavings(runtime.usage, costOf(lead), costOf(side)).savedUsd;
  }

  function publishStatus(ctx: ExtensionContext): void {
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
      });
    } else {
      setSharedFusionStatus(undefined);
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
      });
    }
    return runtime;
  }

  function stopRuntime(): void {
    runtime?.kill();
    runtime = undefined;
  }

  function savingsStats(ctx: ExtensionContext): string {
    if (active?.kind !== "fusion" || runtime === undefined) return "Fusion is not active — pick a Fusion pair with /unipi:model.";
    const reg = registryOf(ctx);
    const savings = estimateSavings(runtime.usage, costOf(findModel(reg, active.lead)), costOf(findModel(reg, active.sidekick)));
    return `Sidekick tokens: in ${String(runtime.usage.input)} · out ${String(runtime.usage.output)} · cached ${String(runtime.usage.cacheRead)} · cache write ${String(runtime.usage.cacheWrite)}\nSidekick cost: $${savings.sidekickUsd.toFixed(2)} · at lead prices: $${savings.atLeadUsd.toFixed(2)} · saved: $${savings.savedUsd.toFixed(2)}\nHandoffs: ${String(runtime.reports.size)} · runtime alive: ${String(runtime.isAlive())} · busy: ${String(runtime.isBusy())}`;
  }

  registerFusionTools(pi, {
    getRuntime,
    onReport: (ctx) => publishStatus(ctx),
  });
  pi.registerCommand(STATS_COMMAND, {
    description: "Estimated Fusion savings (sidekick tokens priced at lead rates)",
    handler: async (_args, ctx) => ctx.ui.notify(savingsStats(ctx), "info"),
  });
  pi.on("before_agent_start", (event, ctx) => active?.kind === "fusion" ? { systemPrompt: `${event.systemPrompt}\n\n${leadPolicy(identity(ctx))}` } : undefined);
  pi.on("tool_result", (event) => {
    if (active?.kind !== "fusion" || nudged || (event.toolName !== "edit" && event.toolName !== "write")) return;
    nudged = true;
    return { content: [...event.content, { type: "text", text: FIRST_EDIT_NUDGE }] };
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
      const models = reg.getAvailable().map((m) => toPickerModel(m, preset.badges[modelKey(m)]));
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

  pi.on("session_start", (_e, ctx) => {
    stopRuntime();
    nudged = false;
    modelBykey.clear();
    active = loadPreset(ctx.cwd ?? process.cwd()).preset.active;
    // Only keep a Fusion status if the session actually runs on that lead.
    if (active?.kind === "fusion" && ctx.model && modelKey(ctx.model) !== active.lead) active = undefined;
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
      publishStatus(ctx);
    }
  });
}

export { loadPreset } from "./preset.js";
export type { ActiveSelection } from "./preset.js";
