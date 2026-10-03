/**
 * @unipi/memory — Memory switches
 *
 * Settings namespace `memory` via the unified settings hub. These are
 * behavior switches only now — MemPalace embeds itself, so there is nothing
 * to configure for vectors.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSettings, getSettingsScoped, registerSettings, setSettings } from "@pi-unipi/core";

export interface MemoryConfig {
  /** Put memory in front of the agent at session start (reminder + wake-up).
   *  Derived from the `recall` setting. */
  recallAtStart: boolean;
  /** memory_store / memory_delete active, plus the end-of-task nudge. */
  write: boolean;
  /** Include `mempalace wake-up` output in the start reminder. Derived from
   *  `recall`; only ever ran while recallAtStart was on. */
  wakeUp: boolean;
  /** Stored recall level: off | reminder | wake-up (booleans derive from it). */
  recall?: "off" | "reminder" | "wake-up";
  /** How the end-of-task save happens: a background side session, the inline
   *  nextTurn reminder, or nothing. */
  saveMode: "side" | "reminder" | "off";
  /** Start the MemPalace daemon automatically when it isn't running. */
  autoStartDaemon: boolean;
  /** Keep the MemPalace install current via a daily PyPI check + uv upgrade. */
  mempalaceAutoUpdate: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  recallAtStart: true,
  write: true,
  wakeUp: true,
  recall: "wake-up",
  saveMode: "side",
  autoStartDaemon: false,
  mempalaceAutoUpdate: true,
};

registerSettings({
  namespace: "memory",
  label: "Memory",
  defaults: DEFAULT_MEMORY_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "MemPalace",
      fields: [
        {
          key: "recall",
          type: "enum",
          label: "Recall at start",
          description: "What the first turn puts in front of the agent. Search/list tools stay available either way.",
          options: [
            { value: "off", label: "off", description: "no first-turn reminder at all" },
            { value: "reminder", label: "reminder", description: "first-turn memory reminder only" },
            { value: "wake-up", label: "reminder + wake-up", description: "reminder plus the mempalace wake-up summary" },
          ],
        },
        {
          key: "write",
          type: "boolean",
          label: "Write memory",
          description: "Gives the agent the memory_store / memory_delete tools plus the end-of-task save nudge.",
        },
        {
          key: "saveMode",
          type: "enum",
          label: "Save mode",
          description: "How the end-of-task save happens: a background side session, a next-turn reminder, or nothing.",
          options: [
            { value: "side", label: "side agent", description: "a background side session saves after the task" },
            { value: "reminder", label: "reminder", description: "an end-of-task note asks the agent to save" },
            { value: "off", label: "off", description: "no save pass at all" },
          ],
        },
        {
          key: "autoStartDaemon",
          type: "boolean",
          label: "MemPalace daemon",
          description: "Off: use a running daemon or write directly. On: pi starts one; MemPalace servers in other tools turn read-only.",
        },
        {
          key: "mempalaceAutoUpdate",
          type: "boolean",
          label: "MemPalace auto-update",
          description: "Keep the MemPalace install current with a daily PyPI check and uv upgrade.",
        },
      ],
    },
  ],
});

export function readMemoryConfig(cwd = process.cwd()): MemoryConfig {
  try {
    const parsed = getSettings("memory", cwd) as Partial<MemoryConfig>;
    const config = { ...DEFAULT_MEMORY_CONFIG, ...parsed };
    // The defaults-merged object can't distinguish "stored" from "default" —
    // decide `recall` from the stored layers so legacy booleans still count.
    const recall = storedRecallLevel(cwd);
    if (recall !== undefined) config.recall = recall;
    return deriveRecall(config);
  } catch {
    return { ...DEFAULT_MEMORY_CONFIG };
  }
}

type RecallLevel = NonNullable<MemoryConfig["recall"]>;

/** Legacy `recallAtStart`/`wakeUp` booleans → the recall level they describe. */
function deriveRecallFromBooleans(recallAtStart: unknown, wakeUp: unknown): RecallLevel {
  if (recallAtStart === false) return "off";
  if (wakeUp === false) return "reminder";
  return "wake-up";
}

/**
 * The stored `recall` level: first layer (project wins) that carries the new
 * key, else the first with legacy booleans (derived). undefined = nothing
 * stored — defaults apply.
 */
function storedRecallLevel(cwd: string): RecallLevel | undefined {
  for (const scope of ["project", "global"] as const) {
    let layer: Record<string, unknown> | undefined;
    try {
      layer = getSettingsScoped("memory", scope, cwd);
    } catch {
      layer = undefined;
    }
    if (!layer) continue;
    if (typeof layer.recall === "string") return layer.recall as RecallLevel;
    if (layer.recallAtStart !== undefined || layer.wakeUp !== undefined) {
      return deriveRecallFromBooleans(layer.recallAtStart, layer.wakeUp);
    }
  }
  return undefined;
}

/**
 * One-time per layer: stored legacy booleans → an explicit `recall` key, so
 * the hub shows the effective value. Additive — the booleans stay untouched;
 * runs once because the layer then carries `recall`.
 */
export function migrateRecallLevel(cwd: string = process.cwd()): void {
  for (const scope of ["global", "project"] as const) {
    let layer: Record<string, unknown> | undefined;
    try {
      layer = getSettingsScoped("memory", scope, cwd);
    } catch {
      continue;
    }
    if (!layer || typeof layer.recall === "string") continue;
    if (layer.recallAtStart === undefined && layer.wakeUp === undefined) continue;
    try {
      setSettings("memory", { recall: deriveRecallFromBooleans(layer.recallAtStart, layer.wakeUp) }, scope, cwd);
    } catch {
      // Unwritable layer — reads still derive on the fly.
    }
  }
}

/**
 * Derive the internal booleans from the `recall` level. With `recall` unset
 * (nothing stored anywhere), the defaults apply — both on.
 */
function deriveRecall(config: MemoryConfig): MemoryConfig {
  if (config.recall === "off") {
    config.recallAtStart = false;
    config.wakeUp = false;
  } else if (config.recall === "reminder") {
    config.recallAtStart = true;
    config.wakeUp = false;
  } else if (config.recall === "wake-up") {
    config.recallAtStart = true;
    config.wakeUp = true;
  }
  return config;
}

/** ~/.config/mempalace/agent-hooks.json gate — false disables both reminders. */
export function agentHooksEnabled(): boolean {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".config", "mempalace", "agent-hooks.json"),
        "utf-8",
      ),
    ) as { enabled?: boolean };
    return raw.enabled !== false;
  } catch {
    return true;
  }
}
