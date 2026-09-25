/**
 * @pi-unipi/kanboard — settings (hub section "Kanboard").
 */

import { getSettings, registerCommandRunner, registerSettings, setSettings } from "@pi-unipi/core";

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
  /** Tasks one session may queue (0 = unlimited). */
  queueMax: number;
  /** Distinct sessions running tasks per project (min 1). */
  maxSessions: number;
  /** `add` calls allowed per -do/runner window (0 = unlimited). */
  turnAddLimit: number;
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
  queueMax: 10,
  maxSessions: 2,
  turnAddLimit: 20,
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
          { key: "idleMin", type: "number", label: "Daemon idle minutes", min: 1, description: "Shut the daemon down after this long with no board open" },
          {
            key: "host",
            type: "string",
            label: "Bind address",
            emptyLabel: "127.0.0.1 (local only)",
            hint: "127.0.0.1 · 0.0.0.0 (LAN, token-gated) · tailscale (tailnet IP)",
            description: "Anything but a loopback address requires an access token",
          },
          { key: "port", type: "number", label: "Daemon port", min: 0, max: 65535, zeroLabel: "auto", description: "0 lets the OS pick a free port" },
          { key: "archiveAfterDays", type: "number", label: "Archive after (days)", min: 0, zeroLabel: "off", description: "Auto-archive done/cancelled tasks on session start" },
          { key: "retentionDays", type: "number", label: "Cold storage after (days)", min: 0, zeroLabel: "off", description: "Move archived/cancelled tasks to cold storage — files stay readable, the board drops them" },
          { key: "openBrowser", type: "boolean", label: "Open the browser", description: "Open the board in a browser when /unipi:kanboard opens it" },
          {
            key: "requireAuth",
            type: "boolean",
            label: "Require the access token on localhost too",
            description: "Remote binds always need the token; this adds it for 127.0.0.1. Applies on the next daemon start.",
          },
          {
            key: "keepToken",
            type: "boolean",
            label: "Keep the access token across restarts",
            description: "Reuse one token so board links stay valid; rotate it below.",
          },
          { key: "queueMax", type: "number", label: "-do queue limit", min: 0, zeroLabel: "unlimited", description: "Tasks a session may queue for the runner" },
          { key: "maxSessions", type: "number", label: "Sessions working at once (per project)", min: 1, description: "Distinct sessions holding in_progress tasks" },
          { key: "turnAddLimit", type: "number", label: "New tasks per turn", min: 0, zeroLabel: "unlimited", description: "`add` calls allowed per -do turn or runner task" },
          { key: "open", type: "action", label: "Open board…", description: "Start the daemon and print the URL", command: ACTION_OPEN },
          { key: "stopDaemon", type: "action", label: "Stop daemon", description: "Terminate the running kanboard daemon", command: ACTION_STOP_DAEMON },
          { key: "rotateToken", type: "action", label: "Rotate access token", description: "Drop the persistent token; a fresh one mints on the next daemon start", command: ACTION_ROTATE_TOKEN },
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
    queueMax: typeof raw.queueMax === "number" && raw.queueMax >= 0 ? raw.queueMax : DEFAULT_SETTINGS.queueMax,
    maxSessions: typeof raw.maxSessions === "number" && raw.maxSessions >= 1 ? raw.maxSessions : DEFAULT_SETTINGS.maxSessions,
    turnAddLimit: typeof raw.turnAddLimit === "number" && raw.turnAddLimit >= 0 ? raw.turnAddLimit : DEFAULT_SETTINGS.turnAddLimit,
  };
}

export function writeKanboardSettings(patch: Partial<KanboardSettings>, cwd: string): void {
  setSettings(KANBOARD_NAMESPACE, patch as unknown as Record<string, unknown>, "global", cwd);
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
 * values so the agent's bash calls and the runner's CLI calls both see them.
 */
export function applyLimitEnv(settings: KanboardSettings): void {
  process.env.UNIPI_KANBOARD_QUEUE_MAX = String(settings.queueMax);
  process.env.UNIPI_KANBOARD_MAX_SESSIONS = String(settings.maxSessions);
}
