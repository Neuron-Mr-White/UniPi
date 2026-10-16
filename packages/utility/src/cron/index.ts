/**
 * @pi-unipi/utility — `/unipi:cron`: a thin TUI window onto `unipi-host
 * cron` (UNI-315). Every subcommand shells out to `unipi-host cron …
 * --json` and renders the result as plain text via `ctx.ui.notify`, so it
 * works the same in the TUI and in the app (no TUI-only overlay — see
 * `withCommandEcho`, which already records `ctx.ui.notify` output for the
 * app bridge).
 *
 * Bare `/unipi:cron` = `status`-ish: every job with its next fire and its
 * most recent run. Subcommands: `list`, `show <id>`, `runs <id>`, `run
 * <id>`, `stop <id>`, `enable <id>`, `disable <id>`, `pause`, `resume`,
 * `status`. Argument completions offer job ids (cached briefly, same
 * pattern as kanboard's task-id completions).
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const CRON_SUBCOMMANDS = ["list", "show", "runs", "run", "stop", "enable", "disable", "pause", "resume", "status"] as const;
export type CronSubcommand = (typeof CRON_SUBCOMMANDS)[number];

const SUB_DESCRIPTIONS: Record<CronSubcommand, string> = {
  list: "Every job: schedule, enabled/disabled, name",
  show: "show <id> — one job's fields and recent runs",
  runs: "runs <id> [N] — a job's run history, newest first",
  run: "run <id> — fire it now, bypassing the schedule",
  stop: "stop <id> — kill a running run",
  enable: "enable <id>",
  disable: "disable <id>",
  pause: "Pause every job host-wide; running ones finish",
  resume: "Resume after a pause",
  status: "Next fire per job, what's running, paused or not",
};

const CRON_TIMEOUT_MS = 5_000;

export interface CronExec {
  (args: string[]): Promise<{ stdout: string } | { error: string }>;
}

/** Runs `unipi-host cron <args> --json`; never throws. */
export const runCron: CronExec = (args: string[]) =>
  new Promise((resolve) => {
    try {
      execFile("unipi-host", ["cron", ...args, "--json"], { timeout: CRON_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          resolve({ error: msg });
          return;
        }
        resolve({ stdout });
      });
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : String(e) });
    }
  });

/** Parses one `--json` line; null on anything unexpected (never throws). */
export function parseCronJson(stdout: string): unknown {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function bool(v: unknown): boolean {
  return v === true;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** `unipi-host cron list --json` rendered as a table-ish text block. */
export function renderList(data: unknown): string {
  const jobs = arr(obj(data).jobs);
  if (jobs.length === 0) {
    return 'No cron jobs yet. Add one: unipi-host cron add --name "daily digest" --prompt "Summarize today\'s inbox" --schedule "every day at 9:00"';
  }
  return jobs
    .map((j) => {
      const job = obj(j);
      return `${str(job.id).padEnd(20)} ${(bool(job.enabled) ? "enabled" : "disabled").padEnd(8)} ${str(job.schedule)}  ${str(job.tz)}  ${str(job.name)}`;
    })
    .join("\n");
}

/** `unipi-host cron show <id> --json` rendered with job fields + recent runs. */
export function renderShow(data: unknown): string {
  const d = obj(data);
  const job = obj(d.job);
  const lines: string[] = [
    `${str(job.id)} — ${str(job.name)}`,
    `  ${bool(job.enabled) ? "enabled" : "disabled"}`,
    `  prompt: ${str(job.prompt)}`,
    `  cwd: ${str(job.cwd)}`,
    `  schedule: ${str(job.schedule)} (${str(job.tz, "UTC")})`,
  ];
  if (typeof job.model === "string") lines.push(`  model: ${job.model}`);
  const cap = num(job.cost_cap_usd);
  if (cap !== undefined) lines.push(`  cost cap: $${cap.toFixed(2)}`);
  lines.push("", "runs:");
  const runs = arr(d.runs);
  if (runs.length === 0) lines.push("  none yet");
  for (const r of runs.slice(0, 10)) {
    const run = obj(r);
    lines.push(`  ${str(run.id).padEnd(8)} ${str(run.status).padEnd(8)} ${str(run.summary, str(run.reason))}`);
  }
  return lines.join("\n");
}

/** `unipi-host cron runs [<id>] --json` rendered newest-first. */
export function renderRuns(data: unknown): string {
  const runs = arr(obj(data).runs);
  if (runs.length === 0) return "No runs yet.";
  return runs
    .map((r) => {
      const run = obj(r);
      return `${str(run.job_id).padEnd(10)} ${str(run.id).padEnd(8)} ${str(run.status).padEnd(8)} ${str(run.summary, str(run.reason))}`;
    })
    .join("\n");
}

/** `unipi-host cron status --json` rendered: paused/running + per-job next fire. */
export function renderStatus(data: unknown): string {
  const d = obj(data);
  const lines = [`${bool(d.paused) ? "paused" : "running"}  concurrency ${num(d.concurrency) ?? 0}`];
  for (const j of arr(d.jobs)) {
    const job = obj(j);
    lines.push(`  ${str(job.id).padEnd(20)} ${bool(job.enabled) ? "enabled " : "disabled"}  next ${str(job.next_fire, "-")}  ${bool(job.running) ? "(running)" : ""}`.trimEnd());
  }
  return lines.join("\n");
}

/** Bare `/unipi:cron`: every job + its next fire and most recent run, built from `status` + `list`. */
export function renderOverview(statusData: unknown, listData: unknown): string {
  const status = obj(statusData);
  const jobsById = new Map(arr(obj(listData).jobs).map((j) => [str(obj(j).id), obj(j)]));
  const lines = [`${bool(status.paused) ? "paused" : "running"}  concurrency ${num(status.concurrency) ?? 0}`];
  const statusJobs = arr(status.jobs);
  if (statusJobs.length === 0) {
    lines.push('No cron jobs yet. Add one: unipi-host cron add --name "daily digest" --prompt "Summarize today\'s inbox" --schedule "every day at 9:00"');
    return lines.join("\n");
  }
  for (const j of statusJobs) {
    const sj = obj(j);
    const id = str(sj.id);
    const job = jobsById.get(id) ?? {};
    lines.push(
      `${id.padEnd(20)} ${bool(sj.enabled) ? "enabled " : "disabled"}  next ${str(sj.next_fire, "-")}  ${bool(sj.running) ? "(running)" : ""}  ${str(job.name)}`.replace(/\s+$/, ""),
    );
  }
  return lines.join("\n");
}

/** Error text shown when `unipi-host` can't be reached at all. */
export function cronUnavailableText(error: string): string {
  return `cron: couldn't reach unipi-host (${error}) — check the UniPi app is open`;
}

export const CRON_HELP = `Cron commands (scheduled, unattended pi runs — see skill:cron)
  /unipi:cron                    every job: next fire + status
  /unipi:cron list               every job
  /unipi:cron show <id>          one job + its recent runs
  /unipi:cron runs <id> [N]      a job's run history
  /unipi:cron run <id>           fire it now
  /unipi:cron stop <id>          kill a running run
  /unipi:cron enable|disable <id>
  /unipi:cron pause / resume     pause every job host-wide / resume
  /unipi:cron status             next fire per job, what's running`;

interface CronJobIdsCache {
  at: number;
  ids: string[];
}
let idsCache: CronJobIdsCache | undefined;
const IDS_CACHE_MS = 5_000;

async function cachedJobIds(exec: CronExec, now = Date.now()): Promise<string[]> {
  if (idsCache && now - idsCache.at < IDS_CACHE_MS) return idsCache.ids;
  const result = await exec(["list"]);
  if ("error" in result) return idsCache?.ids ?? [];
  const data = parseCronJson(result.stdout);
  const ids = arr(obj(data).jobs).map((j) => str(obj(j).id)).filter(Boolean);
  idsCache = { at: now, ids };
  return ids;
}

/** Test hook. */
export function resetCronIdsCacheForTests(): void {
  idsCache = undefined;
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

function fullArgs(before: string, token: string): string {
  return before + token;
}

/** `/unipi:cron <TAB>` completions: subcommands, then a job id for the ones that take one. */
export function cronCompletions(exec: CronExec, prefix: string): Promise<CompletionItem[] | null> {
  const raw = prefix.replace(/^\s+/, "");
  const idArgSub = /^(list|show|runs|run|stop|enable|disable)$/;
  const match = /^(\S+)(\s+)(\S*)$/.exec(raw);
  if (match && idArgSub.test(match[1]!)) {
    const [, sub, , partial] = match;
    const before = `${sub} `;
    return cachedJobIds(exec).then((ids) =>
      ids.length === 0
        ? null
        : ids
            .filter((id) => id.startsWith(partial ?? ""))
            .map((id) => ({ value: fullArgs(before, id), label: id })),
    );
  }
  const needle = raw.toLowerCase();
  const items = CRON_SUBCOMMANDS.map((sub) => ({ value: sub, label: sub, description: SUB_DESCRIPTIONS[sub] })).filter((item) =>
    item.value.startsWith(needle),
  );
  return Promise.resolve(items.length > 0 ? items : null);
}

/** Parses `/unipi:cron <sub> <rest>` into the subcommand + remaining args. */
export function splitCronArgs(args: string): { sub: string; rest: string[] } {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  return { sub, rest: tokens.slice(1) };
}

export function registerCronCommand(pi: ExtensionAPI, exec: CronExec = runCron): void {
  pi.registerCommand("unipi:cron", {
    description: "Scheduled, unattended pi runs — list/show/run/stop jobs, pause/resume, status (see skill:cron)",
    getArgumentCompletions: (prefix: string) => cronCompletions(exec, prefix ?? "") as unknown as never,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { sub, rest } = splitCronArgs(args);

      if (sub === "") {
        const [statusResult, listResult] = await Promise.all([exec(["status"]), exec(["list"])]);
        if ("error" in statusResult) {
          ctx.ui.notify(cronUnavailableText(statusResult.error), "warning");
          return;
        }
        const statusData = parseCronJson(statusResult.stdout);
        const listData = "error" in listResult ? { jobs: [] } : parseCronJson(listResult.stdout);
        ctx.ui.notify(renderOverview(statusData, listData), "info");
        return;
      }

      if (!(CRON_SUBCOMMANDS as readonly string[]).includes(sub)) {
        ctx.ui.notify(CRON_HELP, "info");
        return;
      }

      const needsId = ["show", "runs", "run", "stop", "enable", "disable"].includes(sub);
      const id = rest[0];
      if (needsId && !id) {
        ctx.ui.notify(`cron ${sub} needs a job id — /unipi:cron list to see them`, "warning");
        return;
      }

      const cliArgs =
        sub === "runs" ? ["runs", ...(id ? [id] : []), ...(rest[1] ? ["--limit", rest[1]] : [])] : needsId ? [sub, id!] : [sub];
      const result = await exec(cliArgs);
      if ("error" in result) {
        ctx.ui.notify(cronUnavailableText(result.error), "warning");
        return;
      }
      const data = parseCronJson(result.stdout);
      if (data === null) {
        ctx.ui.notify(result.stdout.trim() || "cron: empty reply", "info");
        return;
      }
      switch (sub) {
        case "list":
          ctx.ui.notify(renderList(data), "info");
          break;
        case "show":
          ctx.ui.notify(renderShow(data), "info");
          break;
        case "runs":
          ctx.ui.notify(renderRuns(data), "info");
          break;
        case "run":
          ctx.ui.notify(`Started run ${str(obj(data).run_id)}`, "info");
          break;
        case "stop":
          ctx.ui.notify(bool(obj(data).stopped) ? "Stopped." : "Nothing was running.", "info");
          break;
        case "enable":
          ctx.ui.notify(`Enabled ${id}`, "info");
          break;
        case "disable":
          ctx.ui.notify(`Disabled ${id}`, "info");
          break;
        case "pause":
          ctx.ui.notify("Paused: no new runs will start. Running ones finish.", "info");
          break;
        case "resume":
          ctx.ui.notify("Resumed.", "info");
          break;
        case "status":
          ctx.ui.notify(renderStatus(data), "info");
          break;
        default:
          ctx.ui.notify(CRON_HELP, "info");
      }
    },
  });
}
