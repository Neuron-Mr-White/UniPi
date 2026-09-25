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
import { registerSettings, getSettings } from "@pi-unipi/core";

export interface MemoryConfig {
  /** Put memory in front of the agent at session start (reminder + wake-up). */
  recallAtStart: boolean;
  /** memory_store / memory_delete active, plus the end-of-task nudge. */
  write: boolean;
  /** Include `mempalace wake-up` output in the start reminder. */
  wakeUp: boolean;
  /** Start the MemPalace daemon automatically when it isn't running. */
  autoStartDaemon: boolean;
  /** Keep the MemPalace install current via a daily PyPI check + uv upgrade. */
  mempalaceAutoUpdate: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  recallAtStart: true,
  write: true,
  wakeUp: true,
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
          key: "recallAtStart",
          type: "boolean",
          label: "Recall memory at start",
          description: "First-turn memory reminder + wake-up summary. Search/list tools stay available either way.",
        },
        {
          key: "write",
          type: "boolean",
          label: "Write memory",
          description: "memory_store / memory_delete tools and the end-of-task save nudge.",
        },
        {
          key: "wakeUp",
          type: "boolean",
          label: "Wake-up summary at start",
          description: "Include `mempalace wake-up --wing <project>` output in the start reminder.",
        },
        {
          key: "autoStartDaemon",
          type: "boolean",
          label: "Start a MemPalace daemon for pi",
          description:
            "Off: use a daemon when one is running, otherwise write directly — safe next to MemPalace in other tools. " +
            "On: pi starts one so parallel pi sessions never collide, but MemPalace MCP servers in other tools become read-only while it runs.",
        },
        {
          key: "mempalaceAutoUpdate",
          type: "boolean",
          label: "MemPalace auto-update",
          description: "Daily PyPI check + uv upgrade",
        },
      ],
    },
  ],
});

export function readMemoryConfig(cwd = process.cwd()): MemoryConfig {
  try {
    const parsed = getSettings("memory", cwd) as Partial<MemoryConfig>;
    return { ...DEFAULT_MEMORY_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_MEMORY_CONFIG };
  }
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
