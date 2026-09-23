/**
 * @pi-unipi/kanboard — `/unipi:kanboard [open|onboard|add|work|stop|status]`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "@pi-unipi/core";

import { KanboardCliError, type KanboardCli } from "./bin.js";
import type { KanboardTask } from "./runner.js";
import { readKanboardSettings, type KanboardSettings } from "./settings.js";

export const KANBOARD_COMMAND = "kanboard";
export const SUBCOMMANDS = ["open", "onboard", "add", "work", "stop", "status"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface CommandDeps {
  /** null when no binary was found (then `unavailable` explains why). */
  cli: KanboardCli | null;
  unavailable: string | null;
  settings: () => KanboardSettings;
  /** Reveal the kanboard skill for this session (append-only). */
  revealSkill: (ctx: ExtensionContext | ExtensionCommandContext) => void;
  work: (ctx: ExtensionContext) => Promise<void>;
  stop: (ctx: ExtensionContext) => void;
  status: () => { taskId: string | null; mode: string | null; phase: string };
  debug: (line: string) => void;
}

interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export function kanboardHome(): string {
  return process.env.UNIPI_KANBOARD_HOME?.trim() || join(homedir(), ".unipi", "kanboard");
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const raw = readFileSync(join(kanboardHome(), "daemon.json"), "utf-8");
    const parsed = JSON.parse(raw) as DaemonInfo;
    return typeof parsed?.port === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export async function healthy(port: number, timeoutMs = 700): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure the daemon runs; returns its port (null when it could not start). */
export async function ensureDaemon(deps: CommandDeps, ctx: ExtensionCommandContext | ExtensionContext): Promise<number | null> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return null;
  }
  const settings = deps.settings();
  const existing = readDaemonInfo();
  if (existing && (await healthy(existing.port))) return existing.port;

  const args = ["serve", "--port", String(settings.port), "--idle-min", String(settings.idleMin)];
  try {
    // Fire and forget: the daemon detaches itself (single instance via flock).
    const child = spawn(client.binary.path, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, UNIPI_KANBOARD_ACTOR: "user" },
    });
    child.unref();
  } catch (error) {
    ctx.ui.notify(`kanboard: could not start the daemon — ${error instanceof Error ? error.message : String(error)}`, "error");
    return null;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = readDaemonInfo();
    if (info && (await healthy(info.port))) return info.port;
  }
  ctx.ui.notify("kanboard: the daemon did not answer within 3s", "warning");
  return null;
}

export function currentSlug(): string | null {
  const fromEnv = process.env.UNIPI_KANBOARD_PROJECT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const settings = getSettings("kanboard", process.cwd()) as { slug?: string };
    return typeof settings.slug === "string" && settings.slug.length > 0 ? settings.slug : null;
  } catch {
    return null;
  }
}

/** `open`: ensure the daemon and print the URL. */
export async function runOpen(deps: CommandDeps, ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
  const port = await ensureDaemon(deps, ctx);
  if (port === null) return;
  const slug = currentSlug();
  const url = slug ? `http://127.0.0.1:${port}/p/${slug}` : `http://127.0.0.1:${port}/`;
  ctx.ui.notify(`kanboard: ${url}`, "info");
  if (deps.settings().openBrowser) openBrowser(url);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening a browser is a convenience; the URL is already on screen.
  }
}

export async function runOnboard(deps: CommandDeps, ctx: ExtensionCommandContext | ExtensionContext): Promise<string | null> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return null;
  }
  const before = currentSlug();
  try {
    const project = await client.run<{ slug: string; name: string }>(["project", "add"], {
      cwd: ctx.cwd,
    });
    // Remember which project this workspace maps to, so later commands resolve
    // it without a git-root lookup. Best-effort: the board works regardless.
    try {
      const { setSettings } = await import("@pi-unipi/core");
      setSettings("kanboard", { slug: project.slug, root: ctx.cwd }, "project", ctx.cwd);
    } catch (error) {
      deps.debug(`could not cache the slug: ${error instanceof Error ? error.message : String(error)}`);
    }
    deps.revealSkill(ctx);
    ctx.ui.notify(
      [
        `kanboard: ${project.name} (${project.slug}) registered`,
        `  /unipi:kanboard add <text>  — capture a task into Backlog`,
        `  /unipi:kanboard work        — let the agent pick up the next ready task`,
        `  /unipi:kanboard open        — open the board in a browser`,
      ].join("\n"),
      "info",
    );
    deps.debug(`onboard ${project.slug} (was ${before ?? "none"})`);
    return project.slug;
  } catch (error) {
    ctx.ui.notify(
      `kanboard: onboarding failed — ${error instanceof KanboardCliError ? error.message : String(error)}`,
      "error",
    );
    return null;
  }
}

export async function runAdd(deps: CommandDeps, ctx: ExtensionCommandContext, text: string): Promise<void> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return;
  }
  const title = text.trim();
  if (!title) {
    ctx.ui.notify("kanboard: add needs some text — /unipi:kanboard add <task>", "warning");
    return;
  }
  if (!currentSlug()) {
    await runOnboard(deps, ctx);
  }
  try {
    const task = await client.run<KanboardTask>(["add", title], { cwd: ctx.cwd });
    ctx.ui.notify(`${task.id} added to Backlog`, "info");
    deps.debug(`add ${task.id}: ${title}`);
  } catch (error) {
    ctx.ui.notify(
      `kanboard: could not add the task — ${error instanceof KanboardCliError ? error.message : String(error)}`,
      "error",
    );
  }
}

export async function runStatus(deps: CommandDeps, ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
  const client = deps.cli;
  const lines: string[] = [];
  const info = readDaemonInfo();
  if (info && (await healthy(info.port))) {
    lines.push(`daemon: pid ${info.pid} · http://127.0.0.1:${info.port} · v${info.version}`);
  } else {
    lines.push("daemon: not running");
  }
  const slug = currentSlug();
  if (slug) {
    try {
      const tasks = await client!.run<KanboardTask[]>(["list"], {});
      const counts = tasks.reduce<Record<string, number>>((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1;
        return acc;
      }, {});
      lines.push(
        `project: ${slug} · ${tasks.length} tasks (${Object.entries(counts)
          .map(([status, count]) => `${status} ${count}`)
          .join(", ") || "empty"})`,
      );
    } catch {
      lines.push(`project: ${slug} (unreadable board)`);
    }
  } else {
    lines.push("project: not registered here — /unipi:kanboard onboard");
  }
  const run = deps.status();
  lines.push(run.taskId ? `runner: ${run.taskId} · ${run.mode} · ${run.phase}` : "runner: idle");
  ctx.ui.notify(lines.join("\n"), "info");
}

export async function runStopDaemon(deps: CommandDeps, ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return;
  }
  try {
    const payload = await client.run<{ stopped: boolean; reason?: string; pid?: number }>(["stop"]);
    ctx.ui.notify(
      payload.stopped ? `kanboard daemon stopped (pid ${payload.pid})` : `kanboard: ${payload.reason ?? "not running"}`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`kanboard: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export function registerKanboardCommand(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("unipi:kanboard", {
    description: "Kanboard — capture tasks, run them with an agent, open the board",
    getArgumentCompletions: (prefix: string) => {
      const needle = (prefix ?? "").trim().toLowerCase();
      const items = SUBCOMMANDS.map((sub) => ({
        value: sub,
        label: sub,
        description:
          sub === "open"
            ? "Start the daemon and print the board URL"
            : sub === "onboard"
              ? "Register this project on the board"
              : sub === "add"
                ? "Quick capture into Backlog (no agent turn)"
                : sub === "work"
                  ? "Claim the next ready task and let the agent do it"
                  : sub === "stop"
                    ? "Finish the current task, then stop"
                    : "Daemon, project counts and the runner state",
      })).filter((item) => item.value.startsWith(needle));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!deps.cli) {
        ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1).join(" ");

      // `add` takes free text; every other word is a subcommand.
      if (sub === "add" && rest.length > 0) {
        await runAdd(deps, ctx, rest);
        return;
      }
      const command: Subcommand = (SUBCOMMANDS as readonly string[]).includes(sub) ? (sub as Subcommand) : "open";
      if (sub.length > 0 && command === "open" && sub !== "open") {
        // Unknown word: treat the whole line as a quick capture.
        await runAdd(deps, ctx, [sub, rest].filter(Boolean).join(" "));
        return;
      }

      switch (command) {
        case "onboard":
          await runOnboard(deps, ctx);
          return;
        case "add":
          await runAdd(deps, ctx, rest);
          return;
        case "work":
          if (!currentSlug()) {
            const proceed = await ctx.ui.confirm(
              "Kanboard is not set up here",
              "Register this project on the board and start working?",
            );
            if (!proceed) return;
            if (!(await runOnboard(deps, ctx))) return;
          }
          await deps.work(ctx as unknown as ExtensionContext);
          return;
        case "stop":
          deps.stop(ctx as unknown as ExtensionContext);
          return;
        case "status":
          await runStatus(deps, ctx);
          return;
        case "open":
        default:
          await runOpen(deps, ctx);
          return;
      }
    },
  });
}

/** CLI presence probe used at session start (cheap, no spawn). */
export function binaryLooksReady(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
