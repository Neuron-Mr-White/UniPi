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
import { UNIPI_PREFIX } from "@pi-unipi/core";
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

export const MODEL_COMMAND = `${UNIPI_PREFIX}model`;
export const PRESET_COMMAND = `${UNIPI_PREFIX}fusion-preset`;
const STATUS_KEY = "unipi-fusion";

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

function toPickerModel(m: Model<Api>): PickerModel {
  const cost = m.cost;
  return {
    key: modelKey(m),
    name: m.name || m.id,
    provider: m.provider,
    cost:
      cost && typeof cost.input === "number"
        ? { input: cost.input, cachedInput: cost.cacheRead ?? 0, output: cost.output }
        : undefined,
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
  let active: ActiveSelection | undefined;

  function statusText(preset: FusionPreset, names: (k: string) => string): string | undefined {
    if (!active || active.kind !== "fusion") return undefined;
    const le = preset.effort[active.lead];
    return ` Fusion · ${names(active.lead)}${le ? ` ${effortLabel(le)}` : ""} ◆ ${names(active.sidekick)} `;
  }

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const { preset } = loadPreset(ctx.cwd ?? process.cwd());
    const reg = registryOf(ctx);
    const names = (k: string) => findModel(reg, k)?.name || splitModelKey(k)?.id || k;
    ctx.ui.setStatus(STATUS_KEY, statusText(preset, names));
  }

  async function applyResult(ctx: ExtensionContext, result: PickerResult, preset: FusionPreset, globalPath: string): Promise<void> {
    if (result.type === "cancelled") return;
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
    const effort = result.type === "single" ? result.effort : result.leadEffort;
    try {
      pi.setThinkingLevel(effort);
    } catch {
      /* provider may not support thinking */
    }
    active =
      result.type === "single"
        ? { kind: "single", model: result.model }
        : { kind: "fusion", lead: result.lead, sidekick: result.sidekick };
    const recent = pushRecent(preset.recent, targetKey);
    saveRuntimeState(globalPath, { effort: result.effortMap, recent, active });
    refreshStatus(ctx);
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
      const models = reg.getAvailable().map(toPickerModel);
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
      await applyResult(ctx, result, preset, loaded.globalPath);
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
    modelBykey.clear();
    const { preset } = loadPreset(ctx.cwd ?? process.cwd());
    active = preset.active;
    // Only keep a Fusion status if the session actually runs on that lead.
    if (active?.kind === "fusion" && ctx.model && modelKey(ctx.model) !== active.lead) active = undefined;
    refreshStatus(ctx);
    if (ctx.hasUI) ctx.ui.addAutocompleteProvider(createModelBoostProvider);
  });

  pi.on("model_select", (event, ctx) => {
    // The user switched through pi's own /model or Ctrl+P: leave Fusion mode
    // unless the new model is still the lead.
    if (active?.kind === "fusion" && modelKey(event.model) !== active.lead) {
      active = { kind: "single", model: modelKey(event.model) };
      refreshStatus(ctx);
    }
  });
}

export { loadPreset } from "./preset.js";
export type { ActiveSelection } from "./preset.js";
