/**
 * @pi-unipi/fusion — UI-free API (UNI-160 "session control centre")
 *
 * Lets a UI-less caller (the app bridge) read the Fusion preset/active
 * selection and apply a picker result without going through the TUI
 * `ModelPicker` overlay. Published on globalThis under a `Symbol.for` key —
 * the same lazy-lookup pattern as `@pi-unipi/btw`'s UI-free API — so the
 * bridge never needs a hard dependency on this package (Fusion may not be
 * installed).
 */
import type { ActiveSelection, EffortLevel, ModelKey } from "./preset.js";
import type { PickerResult } from "./picker.js";

export interface FusionApiModel {
  key: ModelKey;
  name: string;
}

/** Enough of the preset for a phone-side picker: curated lists, default
 *  pair, remembered per-model effort, and the current selection. */
export interface FusionApiPicker {
  leads: FusionApiModel[];
  sidekicks: FusionApiModel[];
  /** The TUI picker's list order: recent models, then the curated leads and
   *  sidekicks (deduplicated; only models still in the catalogue). The rest
   *  of the catalogue is for search only. */
  curated: FusionApiModel[];
  default: { lead?: ModelKey; sidekick?: ModelKey };
  effort: Readonly<Record<ModelKey, EffortLevel>>;
  active: ActiveSelection | undefined;
}

export interface FusionApi {
  /** `undefined` when no pi session has started yet. */
  getPicker(): FusionApiPicker | undefined;
  /** Same path as the picker's `onDone` handler (model switch, effort,
   *  preset bookkeeping) — minus any TUI notification. */
  apply(result: PickerResult): Promise<{ ok: true } | { ok: false; message: string }>;
}

const FUSION_API_KEY = Symbol.for("unipi.fusion.api");

export function publishFusionApi(api: FusionApi): void {
  (globalThis as unknown as Record<symbol, unknown>)[FUSION_API_KEY] = api;
}

export function getFusionApi(): FusionApi | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[FUSION_API_KEY] as FusionApi | undefined;
}

/** Test seam. */
export function clearFusionApiForTests(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[FUSION_API_KEY];
}
