/**
 * @pi-unipi/kanboard — settings (hub section "Kanboard").
 */

import { getSettings, registerCommandRunner, registerSettings, setSettings } from "@pi-unipi/core";

export type ChainGate = "in_review" | "done";

export interface KanboardSettings {
  /** Which dependency status counts as "the chain reached this task". */
  chainGate: ChainGate;
  /** Keep claiming the next ready task after each run. */
  continue: boolean;
  /** Passed to `serve --idle-min`. */
  idleMin: number;
  /** Passed to `serve --port` (0 = OS-assigned). */
  port: number;
  /** Auto-archive done/cancelled tasks after N days (0 = off). */
  archiveAfterDays: number;
  /** Open the board in a browser on `open` (default off). */
  openBrowser: boolean;
}

export const DEFAULT_SETTINGS: KanboardSettings = {
  chainGate: "in_review",
  continue: true,
  idleMin: 10,
  port: 0,
  archiveAfterDays: 0,
  openBrowser: false,
};

export const KANBOARD_NAMESPACE = "kanboard";

/** Runners the hub's action rows call (registered by index.ts). */
export const ACTION_OPEN = "unipi:kanboard-open";
export const ACTION_STOP_DAEMON = "unipi:kanboard-stop-daemon";

export function registerKanboardSettings(): void {
  registerSettings({
    namespace: KANBOARD_NAMESPACE,
    label: "Kanboard",
    defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    schema: [
      {
        title: "Kanboard",
        description: "Deferred-work board: task runner, daemon and skill",
        fields: [
          {
            key: "chainGate",
            type: "enum",
            label: "Chain gate",
            options: [
              { value: "in_review", label: "in_review (next task starts when this one is reviewed)" },
              { value: "done", label: "done (next task waits for a completed dependency)" },
            ],
            description: "When a dependency counts as satisfied for the next task",
          },
          { key: "continue", type: "boolean", label: "Continue to the next task", description: "After a task finishes, claim the next ready one" },
          { key: "idleMin", type: "number", label: "Daemon idle minutes", min: 1, description: "Shut the daemon down after this long with no board open" },
          { key: "port", type: "number", label: "Daemon port", min: 0, max: 65535, zeroLabel: "auto", description: "0 lets the OS pick a free port" },
          { key: "archiveAfterDays", type: "number", label: "Archive after (days)", min: 0, zeroLabel: "off", description: "Auto-archive done/cancelled tasks on session start" },
          { key: "openBrowser", type: "boolean", label: "Open the browser", description: "Open the board in a browser when /unipi:kanboard opens it" },
          { key: "open", type: "action", label: "Open board…", description: "Start the daemon and print the URL", command: ACTION_OPEN },
          { key: "stopDaemon", type: "action", label: "Stop daemon", description: "Terminate the running kanboard daemon", command: ACTION_STOP_DAEMON },
        ],
      },
    ],
  });
}

export function readKanboardSettings(cwd: string = process.cwd()): KanboardSettings {
  const raw = getSettings(KANBOARD_NAMESPACE, cwd);
  return {
    chainGate: raw.chainGate === "done" ? "done" : "in_review",
    continue: raw.continue !== false,
    idleMin: typeof raw.idleMin === "number" && raw.idleMin >= 1 ? raw.idleMin : DEFAULT_SETTINGS.idleMin,
    port: typeof raw.port === "number" && raw.port >= 0 && raw.port <= 65535 ? raw.port : 0,
    archiveAfterDays:
      typeof raw.archiveAfterDays === "number" && raw.archiveAfterDays > 0 ? raw.archiveAfterDays : 0,
    openBrowser: raw.openBrowser === true,
  };
}

export function writeKanboardSettings(patch: Partial<KanboardSettings>, cwd: string): void {
  setSettings(KANBOARD_NAMESPACE, patch as unknown as Record<string, unknown>, "global", cwd);
}

/** Re-exported so index.ts and tests share one registration path. */
export function registerKanboardRunners(runners: {
  open: (ctx: unknown) => void | Promise<void>;
  stopDaemon: (ctx: unknown) => void | Promise<void>;
}): void {
  registerCommandRunner(ACTION_OPEN, runners.open);
  registerCommandRunner(ACTION_STOP_DAEMON, runners.stopDaemon);
}
