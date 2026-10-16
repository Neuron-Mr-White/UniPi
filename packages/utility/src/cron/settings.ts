/**
 * @pi-unipi/utility — Cron settings (namespace `cron`, /unipi:settings →
 * Cron, UNI-318). The host's `cron` config block (concurrency,
 * missed_window_s, retention_runs, retention_days, default_time_limit_s,
 * paused, ntfy_topic, notify_default_events) is the source of truth —
 * `unipi-host cron settings --json` reads it, `unipi-host cron settings
 * --key value --json` writes one field. This namespace mirrors that block
 * into the hub (global scope only: one PC, one host) so the usual field
 * widgets work; `onSet` pushes every write straight through to the host,
 * and `refreshCronSettingsMirror()` pulls the host's current values in
 * before the hub is opened, so edits made via the CLI or the app show up
 * here too.
 *
 * The group only appears while `unipi-host` is installed (same gate as
 * skill:cron — `hostInstalled`), checked by the caller before registering
 * (actually: the schema array is simply empty until then, since
 * `listSettingsDefinitions` only shows namespaces with non-empty schema).
 */

import { execFile } from "node:child_process";
import { getSettingsScoped, registerSettings, setSettings } from "@pi-unipi/core";
import { hostDir, hostInstalled } from "../browser/state.js";

export interface CronSettingsData {
  concurrency: number;
  missed_window_s: number;
  retention_runs: number;
  retention_days: number;
  default_time_limit_s: number;
  paused: boolean;
  ntfy_topic?: string;
  notify_default_events: string[];
}

export const DEFAULT_CRON_SETTINGS: CronSettingsData = {
  concurrency: 1,
  missed_window_s: 300,
  retention_runs: 50,
  retention_days: 30,
  default_time_limit_s: 1800,
  paused: false,
  notify_default_events: [],
};

const CRON_SETTINGS_TIMEOUT_MS = 5_000;

export interface CronSettingsExec {
  (args: string[]): Promise<{ stdout: string } | { error: string }>;
}

/** Runs `unipi-host cron settings <args> --json`; never throws. */
export const runCronSettings: CronSettingsExec = (args: string[]) =>
  new Promise((resolve) => {
    try {
      execFile("unipi-host", ["cron", "settings", ...args, "--json"], { timeout: CRON_SETTINGS_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          resolve({ error: stderr?.trim() || err.message });
          return;
        }
        resolve({ stdout });
      });
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : String(e) });
    }
  });

function parseLast(stdout: string): unknown {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Pure mapping of a `unipi-host cron settings --json` payload onto our shape; never throws. */
export function normalizeCronSettings(data: unknown): CronSettingsData {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    concurrency: num(d.concurrency, DEFAULT_CRON_SETTINGS.concurrency),
    missed_window_s: num(d.missed_window_s, DEFAULT_CRON_SETTINGS.missed_window_s),
    retention_runs: num(d.retention_runs, DEFAULT_CRON_SETTINGS.retention_runs),
    retention_days: num(d.retention_days, DEFAULT_CRON_SETTINGS.retention_days),
    default_time_limit_s: num(d.default_time_limit_s, DEFAULT_CRON_SETTINGS.default_time_limit_s),
    paused: d.paused === true,
    ntfy_topic: typeof d.ntfy_topic === "string" && d.ntfy_topic.length > 0 ? d.ntfy_topic : undefined,
    notify_default_events: Array.isArray(d.notify_default_events) ? d.notify_default_events.filter((v): v is string => typeof v === "string") : [],
  };
}

/** Maps one hub field write to the matching `unipi-host cron settings` flag + value. */
function cliArgsFor(key: string, value: unknown): string[] | null {
  switch (key) {
    case "concurrency":
      return ["--concurrency", String(value)];
    case "missed_window_s":
      return ["--missed-window-s", String(value)];
    case "retention_runs":
      return ["--retention-runs", String(value)];
    case "retention_days":
      return ["--retention-days", String(value)];
    case "default_time_limit_s":
      return ["--default-time-limit-s", String(value)];
    case "paused":
      return ["--paused", value ? "true" : "false"];
    case "ntfy_topic":
      return ["--ntfy-topic", typeof value === "string" ? value : ""];
    case "notify_default_events":
      return ["--notify-default-events", Array.isArray(value) ? value.join(",") : ""];
    default:
      return null;
  }
}

/** Pulls the host's current cron settings into the hub's global layer, so the
 *  panel shows what the CLI/app last set. Best-effort: a host that can't be
 *  reached just leaves the previous mirror in place. */
export async function refreshCronSettingsMirror(cwd: string, exec: CronSettingsExec = runCronSettings): Promise<void> {
  if (!hostInstalled(hostDir())) return;
  const result = await exec([]);
  if ("error" in result) return;
  const data = parseLast(result.stdout);
  if (data === null) return;
  setSettings("cron", normalizeCronSettings(data) as unknown as Record<string, unknown>, "global", cwd);
}

/** Current mirror, without talking to the host (what the hub shows right now). */
export function cronSettingsMirror(cwd: string): CronSettingsData {
  return normalizeCronSettings(getSettingsScoped("cron", "global", cwd));
}

registerSettings({
  namespace: "cron",
  label: "Cron",
  defaults: DEFAULT_CRON_SETTINGS as unknown as Record<string, unknown>,
  projectOverrides: false,
  onSet: (layer: Record<string, unknown>, scope: "global" | "project") => {
    if (scope !== "global") return;
    // The engine already deep-merged the patch into `layer`; find which
    // single key changed is unnecessary — we only get here from one field
    // write at a time (the hub patches one key per call), so re-send every
    // field is simplest and always consistent. Fire-and-forget: a failure
    // here means the host didn't get the change, but the hub's own layer
    // still shows the user's intent. Next open re-mirrors from the host.
    for (const [key, value] of Object.entries(layer)) {
      const args = cliArgsFor(key, value);
      if (args) void runCronSettings(args);
    }
  },
  get schema() {
    if (!hostInstalled(hostDir())) return [];
    return [
      {
        title: "Scheduled runs",
        description: "unipi-host cron settings — this PC's scheduler",
        fields: [
          { key: "concurrency", type: "number", label: "Concurrency", min: 0, description: "How many runs at once; 0 = unlimited.", scopes: ["global"] },
          { key: "missed_window_s", type: "number", label: "Missed window", min: 0, unit: "s", description: "Seconds a missed fire is still run late within.", scopes: ["global"] },
          { key: "retention_runs", type: "number", label: "Keep runs", min: 0, description: "How many past runs to keep per job.", scopes: ["global"] },
          { key: "retention_days", type: "number", label: "Keep days", min: 0, unit: "days", description: "How many days of past runs to keep.", scopes: ["global"] },
          { key: "default_time_limit_s", type: "number", label: "Default time limit", min: 0, unit: "s", description: "Seconds a run gets when a job doesn't set its own.", scopes: ["global"] },
          { key: "paused", type: "boolean", label: "Paused", description: "Pause every job host-wide; running ones finish.", scopes: ["global"] },
        ],
      },
      {
        title: "Notifications",
        description: "C3 — ntfy run notifications",
        fields: [
          { key: "ntfy_topic", type: "string", label: "ntfy topic", emptyLabel: "none", description: "The ntfy.sh topic run notifications are posted to, if any.", scopes: ["global"] },
          {
            key: "notify_default_events",
            type: "multiselect",
            label: "Notify on",
            options: ["ok", "failed", "timeout"],
            plainOptions: true,
            emptyLabel: "none",
            description: "Which run outcomes are notified about by default.",
            scopes: ["global"],
          },
        ],
      },
    ];
  },
} as unknown as Parameters<typeof registerSettings>[0]);
