/**
 * @pi-unipi/kanboard — settings (hub section "Kanboard").
 */

import { existsSync, readFileSync } from "node:fs";
import { getSettings, globalSettingsPath, projectSettingsPath, registerCommandRunner, registerSettings, setSettings } from "@pi-unipi/core";

export type ChainGate = "in_review" | "done";

export interface KanboardSettings {
  /** Which dependency status counts as "the chain reached this task". */
  chainGate: ChainGate;
  /** Passed to `serve --idle-min`. */
  idleMin: number;
  /** Passed to `serve --host` (127.0.0.1 = local only). */
  host: string;
  /** Passed to `serve --port` (0 = OS-assigned). */
  port: number;
  /** Auto-archive done/cancelled tasks after N days (0 = off). */
  archiveAfterDays: number;
  /** Move archived/cancelled tasks to cold storage after N days (0 = off). */
  retentionDays: number;
  /** Open the board in a browser on `open` (default off). */
  openBrowser: boolean;
  /** Token-gate loopback binds too (remote always needs it). */
  requireAuth: boolean;
  /** Reuse <home>/token so board links survive daemon restarts. */
  keepToken: boolean;
  /** Distinct sessions running tasks per project (min 1). */
  maxSessions: number;
  /** `add` calls allowed per turn (0 = unlimited). */
  turnAddLimit: number;
  /** Task slots a /unipi:kanboard-do grants (each `start` uses one). */
  doTasks: number;
  /** Board writes a /unipi:kanboard-do grants. */
  doWrites: number;
  /** Progress reminders when the agent works board tasks by hand: `start`
   *  before the first edit, `finish` (or block) before the turn ends. */
  reminders: boolean;
}

export const DEFAULT_SETTINGS: KanboardSettings = {
  chainGate: "in_review",
  idleMin: 10,
  host: "127.0.0.1",
  port: 0,
  archiveAfterDays: 0,
  retentionDays: 90,
  openBrowser: false,
  requireAuth: false,
  keepToken: false,
  maxSessions: 2,
  turnAddLimit: 20,
  doTasks: 5,
  doWrites: 10,
  reminders: true,
};

export const KANBOARD_NAMESPACE = "kanboard";

/** Runners the hub's action rows call (registered by index.ts). */
export const ACTION_OPEN = "unipi:kanboard-open";
export const ACTION_STOP_DAEMON = "unipi:kanboard-stop-daemon";
export const ACTION_ROTATE_TOKEN = "unipi:kanboard-rotate-token";

export function registerKanboardSettings(): void {
  registerSettings({
    namespace: KANBOARD_NAMESPACE,
    label: "Kanboard",
    defaults: { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>,
    schema: [
      {
        title: "Agent",
        description: "Task flow and budgets for sessions working the board",
        fields: [
          {
            key: "chainGate",
            type: "enum",
            label: "Chain gate",
            description: "When a dependency counts as satisfied and the next task may start.",
            options: [
              { value: "in_review", label: "in review", description: "next task may start once this one is in review" },
              { value: "done", label: "done", description: "next task waits for a completed dependency" },
            ],
          },
          { key: "maxSessions", type: "number", label: "Max sessions", min: 1, description: "Distinct sessions that may hold in_progress tasks, per project." },
          { key: "turnAddLimit", type: "number", label: "Adds per turn", min: 0, zeroLabel: "unlimited", description: "`add` calls one turn may make." },
          { key: "reminders", type: "boolean", label: "Progress reminders", description: "Remind the agent to `start` a mentioned task before editing; text only, off in child sessions." },
          { key: "doTasks", type: "number", label: "-do task slots", min: 0, zeroLabel: "off", description: "Task slots a /unipi:kanboard-do grants; each `start` uses one." },
          { key: "doWrites", type: "number", label: "-do write budget", min: 0, zeroLabel: "off", description: "Board writes a /unipi:kanboard-do grants (add, edit, link, order, move, notes)." },
        ],
      },
      {
        title: "Housekeeping",
        description: "What happens to finished and cancelled tasks",
        fields: [
          { key: "archiveAfterDays", type: "number", label: "Archive after", unit: "days", min: 0, zeroLabel: "off", description: "Auto-archive done/cancelled tasks on session start." },
          { key: "retentionDays", type: "number", label: "Cold storage after", unit: "days", min: 0, zeroLabel: "off", description: "Move archived tasks to cold storage — readable files, gone from the board." },
        ],
      },
      {
        title: "Board server",
        description: "Daemon binding, lifetime and access token",
        advanced: true,
        fields: [
          {
            key: "host",
            type: "string",
            label: "Bind address",
            emptyLabel: "127.0.0.1 (local only)",
            hint: "127.0.0.1 · 0.0.0.0 (LAN, token-gated) · tailscale (tailnet IP)",
            description: "Address the board server binds; anything but a loopback requires the access token.",
          },
          { key: "port", type: "number", label: "Daemon port", min: 0, max: 65535, zeroLabel: "auto", description: "Port the board server listens on; 0 lets the OS pick a free one." },
          { key: "idleMin", type: "number", label: "Daemon idle", unit: "min", min: 1, description: "Shut the daemon down after this long with no board open." },
          { key: "openBrowser", type: "boolean", label: "Open browser", description: "Open the board in a browser when /unipi:kanboard opens it." },
          {
            key: "requireAuth",
            type: "boolean",
            label: "Token on localhost",
            description: "Require the access token on 127.0.0.1 too; remote binds always need it. Next daemon start.",
          },
          {
            key: "keepToken",
            type: "boolean",
            label: "Keep token",
            description: "Reuse <home>/token across restarts so board links stay valid; rotate below.",
          },
          { key: "open", type: "action", label: "Open board…", description: "Start the daemon and open the board.", command: ACTION_OPEN },
          { key: "stopDaemon", type: "action", label: "Stop daemon…", description: "Shut the board server down now.", command: ACTION_STOP_DAEMON },
          { key: "rotateToken", type: "action", label: "Rotate access token…", description: "Issue a new token; old board links stop working.", command: ACTION_ROTATE_TOKEN },
        ],
      },
    ],
  });
}

export function readKanboardSettings(cwd: string = process.cwd()): KanboardSettings {
  const raw = getSettings(KANBOARD_NAMESPACE, cwd);
  return {
    chainGate: raw.chainGate === "done" ? "done" : "in_review",
    idleMin: typeof raw.idleMin === "number" && raw.idleMin >= 1 ? raw.idleMin : DEFAULT_SETTINGS.idleMin,
    host:
      typeof raw.host === "string" && raw.host.trim().length > 0 ? raw.host.trim() : DEFAULT_SETTINGS.host,
    port: typeof raw.port === "number" && raw.port >= 0 && raw.port <= 65535 ? raw.port : 0,
    archiveAfterDays:
      typeof raw.archiveAfterDays === "number" && raw.archiveAfterDays > 0 ? raw.archiveAfterDays : 0,
    retentionDays:
      typeof raw.retentionDays === "number" && raw.retentionDays >= 0 ? raw.retentionDays : DEFAULT_SETTINGS.retentionDays,
    openBrowser: raw.openBrowser === true,
    requireAuth: raw.requireAuth === true,
    keepToken: raw.keepToken === true,
    maxSessions: typeof raw.maxSessions === "number" && raw.maxSessions >= 1 ? raw.maxSessions : DEFAULT_SETTINGS.maxSessions,
    turnAddLimit: typeof raw.turnAddLimit === "number" && raw.turnAddLimit >= 0 ? raw.turnAddLimit : DEFAULT_SETTINGS.turnAddLimit,
    // Migration: getSettings merges defaults, so a stored doCredits hides
    // behind the doWrites default. Look at the stored layer for the legacy key
    // (project first, then global) — the next settings write persists doWrites.
    doTasks: typeof raw.doTasks === "number" && raw.doTasks >= 0 ? raw.doTasks : DEFAULT_SETTINGS.doTasks,
    doWrites:
      typeof raw.doWrites === "number" && raw.doWrites >= 0 && storedDoWritesSet(cwd)
        ? raw.doWrites
        : (storedLegacyDoCredits(cwd) ?? DEFAULT_SETTINGS.doWrites),
    reminders: raw.reminders !== false,
  };
}

export function writeKanboardSettings(patch: Partial<KanboardSettings>, cwd: string): void {
  setSettings(KANBOARD_NAMESPACE, patch as unknown as Record<string, unknown>, "global", cwd);
}

/** Whether any stored layer carries an explicit doWrites (defaults don't count). */
function storedDoWritesSet(cwd: string): boolean {
  for (const file of [projectSettingsPath(cwd, KANBOARD_NAMESPACE), globalSettingsPath(KANBOARD_NAMESPACE)]) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      if (typeof parsed.doWrites === "number") return true;
    } catch {
      // A corrupt file has no legacy value either.
    }
  }
  return false;
}

/** The pre-slot doCredits value from the stored layers, if any. */
function storedLegacyDoCredits(cwd: string): number | undefined {
  for (const file of [projectSettingsPath(cwd, KANBOARD_NAMESPACE), globalSettingsPath(KANBOARD_NAMESPACE)]) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      const value = parsed.doCredits;
      if (typeof value === "number" && value >= 0) return value;
    } catch {
      // A corrupt file has no legacy value either.
    }
  }
  return undefined;
}

/** Re-exported so index.ts and tests share one registration path. */
export function registerKanboardRunners(runners: {
  open: (ctx: unknown) => void | Promise<void>;
  stopDaemon: (ctx: unknown) => void | Promise<void>;
  rotateToken?: (ctx: unknown) => void | Promise<void>;
}): void {
  registerCommandRunner(ACTION_OPEN, runners.open);
  registerCommandRunner(ACTION_STOP_DAEMON, runners.stopDaemon);
  if (runners.rotateToken) registerCommandRunner(ACTION_ROTATE_TOKEN, runners.rotateToken);
}

/**
 * Limits reach the Rust CLI through the environment — refresh the process-wide
 * values so the agent's bash calls and spawned CLI calls both see them.
 * (queueMax died with the runner; the binary's queue limit is untouched.)
 */
export function applyLimitEnv(settings: KanboardSettings): void {
  process.env.UNIPI_KANBOARD_MAX_SESSIONS = String(settings.maxSessions);
}
