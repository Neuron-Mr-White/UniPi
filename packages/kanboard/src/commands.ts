/**
 * @pi-unipi/kanboard — `/unipi:kanboard [open|onboard|add|work|stop|status]`.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname as osHostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "@pi-unipi/core";

import { KanboardCliError, type KanboardCli } from "./bin.js";
import { asProject, asStopResult, asTask, asTaskList, type KanboardTask } from "./shapes.js";
import { readKanboardSettings, type KanboardSettings } from "./settings.js";

export const KANBOARD_COMMAND = "kanboard";
export const SUBCOMMANDS = ["open", "onboard", "add", "work", "stop", "status"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface CommandDeps {
  /** null when no binary was found (then `unavailable` explains why). */
  cli: KanboardCli | null;
  unavailable: string | null;
  /** Command runner for `tailscale ip -4` (injectable in tests). */
  exec?: (cmd: string, args: string[]) => Promise<string>;
  settings: () => KanboardSettings;
  /** Reveal the kanboard skill for this session (append-only). */
  revealSkill: (ctx: ExtensionContext | ExtensionCommandContext) => void;
  work: (ctx: ExtensionContext) => Promise<void>;
  stop: (ctx: ExtensionContext) => void;
  status: () => { taskId: string | null; mode: string | null; phase: string };
  debug: (line: string) => void;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  host?: string;
  token?: string;
}

const run = promisify(execFile);

/** `open` flags: override the settings for this invocation only. */
export interface OpenFlags {
  host?: string;
  port?: number;
}

/** Split `open`'s arguments; unknown words are reported so the user can fix them. */
export function parseOpenArgs(
  args: string,
  settings: { host: string; port: number },
): { host: string; port: number; unknown: string[] } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const unknown: string[] = [];
  let host = settings.host;
  let port = settings.port;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const value = (inline?: string): string | undefined => inline ?? parts[++index];
    if (part === "--host" || part.startsWith("--host=")) {
      const given = value(part.includes("=") ? part.slice("--host=".length) : undefined);
      if (given) host = given;
      else unknown.push(part);
      continue;
    }
    if (part === "--port" || part.startsWith("--port=")) {
      const given = value(part.includes("=") ? part.slice("--port=".length) : undefined);
      const parsed = Number(given);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) port = parsed;
      else unknown.push(`${part} ${given ?? ""}`.trim());
      continue;
    }
    unknown.push(part);
  }
  return { host, port, unknown };
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127\./.test(bare) || bare === "0:0:0:0:0:0:0:1";
}

/** Local IPv4s that other machines can reach (non-internal). */
export function reachableAddresses(): string[] {
  const out: string[] = [];
  const interfaces = networkInterfaces() as Record<string, NetworkInterfaceInfo[] | undefined>;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/** `tailscale` → the machine's tailnet IPv4 (first line of `tailscale ip -4`). */
export async function resolveHost(
  host: string,
  exec: (cmd: string, args: string[]) => Promise<string> = async (cmd, args) =>
    (await run(cmd, args)).stdout,
): Promise<{ host: string; error?: string }> {
  if (host.trim() !== "tailscale") return { host: host.trim() };
  try {
    const output = await exec("tailscale", ["ip", "-4"]);
    const first = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    if (!first) return { host, error: "tailscale ip -4 returned nothing — is this machine on a tailnet?" };
    return { host: first };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { host, error: `tailscale is not available (${detail}) — install it or pass --host <addr>` };
  }
}

/**
 * Every URL to hand the user: the bound host plus, for a wildcard bind, the
 * hostname, each reachable IPv4 and the tailnet address.
 */
export function formatBoardUrls(options: {
  host: string;
  port: number;
  slug: string | null;
  token?: string | null;
  hostname?: string;
  addresses?: string[];
  tailscale?: string | null;
}): { urls: string[]; warnings: string[] } {
  const { host, port, slug, token } = options;
  const path = slug ? `/p/${slug}` : "/";
  const suffix = token ? `?t=${token}` : "";
  const local = `http://127.0.0.1:${port}${path}${suffix}`;

  if (isLoopbackHost(host)) {
    return {
      urls: [local],
      warnings: [`from another machine, tunnel it: ssh -N -L ${port}:127.0.0.1:${port} ${options.hostname ?? "$(hostname)"}`],
    };
  }

  const hosts: string[] = [];
  const wildcard = host === "0.0.0.0" || host === "::";
  if (wildcard) {
    if (options.hostname) hosts.push(options.hostname);
    for (const address of options.addresses ?? []) hosts.push(address);
    if (options.tailscale) hosts.push(options.tailscale);
  } else {
    hosts.push(host);
  }

  // A wildcard bind with no known address still reports the binding itself
  // rather than pretending the board is local.
  const candidates = hosts.length > 0 ? hosts : [host];
  const urls = candidates.map((candidate) => `http://${candidate}:${port}${path}${suffix}`);
  return {
    urls,
    warnings: ["board is reachable from the network; anyone with the link can edit it"],
  };
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

export async function healthy(port: number, timeoutMs = 700, token?: string | null): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal, headers });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure the daemon runs on the requested binding. A running daemon on a
 * different host/port is restarted (the daemon runs no jobs, so this is safe).
 */
export async function ensureDaemon(
  deps: CommandDeps,
  ctx: ExtensionCommandContext | ExtensionContext,
  binding?: { host: string; port: number },
  onRestart?: (info: { host: string; port: number }) => void,
): Promise<number | null> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return null;
  }
  const settings = deps.settings();
  const host = binding?.host ?? settings.host;
  const port = binding?.port ?? settings.port;
  const existing = readDaemonInfo();
  if (existing && (await healthy(existing.port, 700, existing.token))) {
    const sameBinding = (existing.host ?? "127.0.0.1") === host && (port === 0 || existing.port === port);
    if (sameBinding) return existing.port;
    deps.debug(`rebinding: running ${existing.host}:${existing.port} → ${host}:${port}`);
    await client.run(["stop"], {}).catch(() => undefined);
    onRestart?.({ host, port });
  }

  const args = ["serve", "--host", host, "--port", String(port), "--idle-min", String(settings.idleMin)];
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
    if (info && (await healthy(info.port, 700, info.token))) return info.port;
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

/** `open [--host H] [--port N]`: ensure the daemon and print every usable URL. */
export async function runOpen(
  deps: CommandDeps,
  ctx: ExtensionCommandContext | ExtensionContext,
  args = "",
): Promise<string[]> {
  const settings = deps.settings();
  const flags = parseOpenArgs(args, {
    host: settings.host ?? "127.0.0.1",
    port: settings.port ?? 0,
  });
  if (flags.unknown.length > 0) {
    ctx.ui.notify(`kanboard: ignoring unknown option(s) ${flags.unknown.join(" ")}`, "warning");
  }
  const resolved = await resolveHost(flags.host, deps.exec);
  if (resolved.error) {
    ctx.ui.notify(`kanboard: ${resolved.error}`, "error");
    return [];
  }

  let restarted = false;
  const port = await ensureDaemon(deps, ctx, { host: resolved.host, port: flags.port }, () => {
    restarted = true;
  });
  if (port === null) return [];
  if (restarted) {
    ctx.ui.notify(`kanboard: restarted kanboard on ${resolved.host}:${port}`, "info");
  }

  const info = readDaemonInfo();
  const tailscale = resolved.host === "0.0.0.0" ? await tailscaleAddress(deps) : undefined;
  const { urls, warnings } = formatBoardUrls({
    host: resolved.host,
    port,
    slug: currentSlug(),
    token: info?.token ?? null,
    hostname: osHostname(),
    addresses: reachableAddresses(),
    tailscale,
  });

  for (const url of urls) ctx.ui.notify(`kanboard: ${url}`, "info");
  for (const warning of warnings) ctx.ui.notify(`kanboard: ⚠ ${warning}`, "warning");
  if (settings.openBrowser) openBrowser(urls[0]!);
  return urls;
}

/** The tailnet address, when tailscale is installed (wildcard binds list it). */
async function tailscaleAddress(deps: CommandDeps): Promise<string | undefined> {
  try {
    const resolved = await resolveHost("tailscale", deps.exec);
    return resolved.error ? undefined : resolved.host;
  } catch {
    return undefined;
  }
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
    const project = asProject("project add", await client.run<unknown>(["project", "add"], {
      cwd: ctx.cwd,
    }));
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
    const task = asTask("add", await client.run<unknown>(["add", title], { cwd: ctx.cwd }));
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
      const { tasks, problems } = asTaskList(await client!.run<unknown>(["list"], {}));
      const counts = tasks.reduce<Record<string, number>>((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1;
        return acc;
      }, {});
      lines.push(
        `project: ${slug} · ${tasks.length} tasks (${Object.entries(counts)
          .map(([status, count]) => `${status} ${count}`)
          .join(", ") || "empty"})`,
      );
      if (problems && problems.length > 0) {
        lines.push(`⚠ ${problems.length} task file(s) need repair — unipi-kanboard validate --fix`);
      }
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
    const payload = asStopResult(await client.run<unknown>(["stop"]));
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
      const raw = (prefix ?? "").trimStart();
      const needle = raw.toLowerCase();
      // `open --host <TAB>` offers the usual bind addresses.
      if (/^open\s+--host(\s+\S*)?$/.test(raw)) {
        const partial = raw.split(/\s+/).pop() ?? "";
        return [
          { value: "127.0.0.1", label: "127.0.0.1", description: "local only (default); another machine needs an SSH tunnel" },
          { value: "0.0.0.0", label: "0.0.0.0", description: "every interface, token-gated (prints every reachable URL)" },
          { value: "tailscale", label: "tailscale", description: "the machine's tailnet IPv4 (tailscale ip -4)" },
        ].filter((item) => item.value.startsWith(partial));
      }
      if (/^open(\s|$)/.test(raw)) {
        const partial = raw.split(/\s+/).pop() ?? "";
        if (partial.startsWith("--")) {
          return [
            { value: "--host", label: "--host", description: "Bind address: 127.0.0.1 · 0.0.0.0 · tailscale" },
            { value: "--port", label: "--port", description: "Port to bind (0 = auto)" },
          ].filter((item) => item.value.startsWith(partial));
        }
      }
      const items = SUBCOMMANDS.map((sub) => ({
        value: sub,
        label: sub,
        description:
          sub === "open"
            ? "Start the daemon and print the board URL (--host 0.0.0.0|tailscale, --port N)"
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
      // `open` carries flags; `open --host …` is still `open`.
      if (sub === "open" && rest.length > 0) {
        if (!deps.cli) {
          ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
          return;
        }
        await runOpen(deps, ctx, rest);
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
