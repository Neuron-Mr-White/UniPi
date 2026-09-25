/**
 * @pi-unipi/kanboard — `/unipi:kanboard` (help/open/close/onboard/status/doctor),
 * `/unipi:kanboard-add`, `/unipi:kanboard-do`, `/unipi:kanboard-autowork`.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname, networkInterfaces, tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettings } from "@pi-unipi/core";

import { KanboardCliError, type KanboardCli } from "./bin.js";
import { asProject, asStopResult, asTask, asTaskList, type KanboardTask } from "./shapes.js";
import { applyLimitEnv, readKanboardSettings, type KanboardSettings } from "./settings.js";

export const KANBOARD_COMMAND = "kanboard";
export const SUBCOMMANDS = ["open", "close", "onboard", "status", "doctor", "show"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

/** Custom message types that are display-only and never enter the LLM context. */
export const HELP_CUSTOM_TYPE = "unipi:kanboard-help";
export const DOCTOR_CUSTOM_TYPE = "unipi:kanboard-doctor";
export const SHOW_CUSTOM_TYPE = "unipi:kanboard-show";

export const HELP = `Kanboard commands
  /unipi:kanboard                       this list
  /unipi:kanboard open [--host 127.0.0.1|0.0.0.0|tailscale] [--port N]
                                        start the board and print its link
  /unipi:kanboard close                 shut the board down
  /unipi:kanboard onboard               register this project
  /unipi:kanboard status                board, claims and queue
  /unipi:kanboard show [--all]          the board, in chat (lanes + claim order)
  /unipi:kanboard doctor                check the setup
  /unipi:kanboard-add [-p 1-5] <title>  add a task; lines below the title are the description (paste images there)
  /unipi:kanboard-do <request>          let the agent use the board for this turn
  /unipi:kanboard-autowork start|stop   work ready tasks chain by chain; stop finishes the current one first
Priority -p: 1 none · 2 low · 3 medium · 4 high · 5 urgent`;

export function doText(slug: string, cli: string, request: string, queueMax = 10): string {
  const limit = queueMax === 0 ? "Todo tasks" : `Todo tasks, at most ${queueMax}`;
  return `[kanboard] For this request you may use the kanboard skill on project ${slug} (CLI: \`${cli} --actor agent --project ${slug} …\`). Board writes are allowed until this turn ends. You can add tasks, move them between backlog and todo, link, order, note, and edit tasks you created. To have tasks worked, queue them in order with \`queue <IDs>\` (${limit}); the runner starts them one by one after this turn, so do not start the work yourself. If the request is unclear, ask me instead of guessing.

Request: ${request}`;
}

/**
 * Split a command line into words the way a shell would: whitespace separates,
 * a token may start with a quoted span, and a quote inside a word is literal
 * (so `it's fine` keeps its apostrophe).
 */
export function tokenizeArgs(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
      index += 1;
      continue;
    }
    if ((char === '"' || char === "'") && !started) {
      const quote = char;
      index += 1;
      started = true;
      while (index < text.length && text[index] !== quote) {
        if (quote === '"' && text[index] === "\\" && index + 1 < text.length) {
          index += 1;
          current += text[index]!;
        } else {
          current += text[index]!;
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    current += char;
    started = true;
    index += 1;
  }
  if (started) words.push(current);
  return words;
}

export interface AddArgs {
  title: string;
  /** CLI argv after the title (`--after`, `--priority`, `--status`). */
  flags: string[];
  /** Lines below the first — the task body. */
  description: string;
  /** Existing files detected in the description (passed as --attach). */
  attaches: string[];
  /** Set when the line was malformed, e.g. a flag without its value. */
  error: string | null;
}

const PRIORITY_BY_NUMBER: Record<string, string> = {
  "1": "none",
  "2": "low",
  "3": "medium",
  "4": "high",
  "5": "urgent",
};

/**
 * Parse `/unipi:kanboard-add [-p 1-5 | --priority P] [--after ID]…
 * [--status backlog|todo] <title>`: flags come first on the first line,
 * everything after them is the title, and every later line is the body.
 * Whitespace-free tokens in the body that are absolute or `~/` paths to
 * existing files become `--attach` arguments.
 */
export function parseAddArgs(text: string): AddArgs {
  const lines = (text ?? "").split("\n");
  const words = tokenizeArgs(lines[0] ?? "");
  const flags: string[] = [];
  let index = 0;
  const takeValue = (word: string, inline: string | undefined): string | undefined => {
    if (inline !== undefined) return inline;
    const value = words[index + 1];
    if (value === undefined) return undefined;
    index += 1;
    return value;
  };
  while (index < words.length) {
    const word = words[index]!;
    const eq = word.indexOf("=");
    const name = eq > 0 ? word.slice(0, eq) : word;
    const inline = eq > 0 ? word.slice(eq + 1) : undefined;
    if (name === "-p" || /^-p\d$/.test(word)) {
      const raw = /^-p\d$/.test(word) ? word.slice(2) : takeValue(word, inline);
      const priority = raw !== undefined ? PRIORITY_BY_NUMBER[raw] : undefined;
      if (priority === undefined) return { title: "", flags, description: "", attaches: [], error: "-p takes 1-5 (1 none · 5 urgent)" };
      flags.push("--priority", priority);
      index += 1;
      continue;
    }
    if (name === "--priority" || name === "--status" || name === "--after") {
      const value = takeValue(word, inline);
      if (value === undefined || value === "") return { title: "", flags, description: "", attaches: [], error: `${name} needs a value` };
      flags.push(name, value);
      index += 1;
      continue;
    }
    break;
  }
  const title = words.slice(index).join(" ").trim();
  const description = lines.slice(1).join("\n").trim();
  return { title, flags, description, attaches: detectFilePaths(description), error: null };
}

/**
 * Whitespace-free tokens that are absolute (`/…`) or `~/` paths to files that
 * exist — pasted screenshots and logs the user dropped into the description.
 */
export function detectFilePaths(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split(/\s+/)) {
    let token = raw;
    // Strip markdown/link wrappers so `![](/tmp/x.png)` still matches.
    const wrapped = token.match(/^!?\[[^\]]*\]\((.+)\)[.,;:]?$/) ?? token.match(/^\((.+)\)[.,;:]?$/);
    if (wrapped) token = wrapped[1]!;
    token = token.replace(/[.,;:]+$/, "");
    const expanded = token.startsWith("~/") ? join(homedir(), token.slice(2)) : token;
    if (!(token.startsWith("/") || token.startsWith("~/"))) continue;
    if (!existsSync(expanded)) continue;
    if (!found.includes(expanded)) found.push(expanded);
  }
  return found;
}

export interface CommandDeps {
  /** null when no binary was found (then `unavailable` explains why). */
  cli: KanboardCli | null;
  unavailable: string | null;
  /** Command runner for `tailscale ip -4` / `command -v` (injectable in tests). */
  exec?: (cmd: string, args: string[]) => Promise<string>;
  settings: () => KanboardSettings;
  /** Reveal the kanboard skill for this session (append-only). */
  revealSkill: (ctx: ExtensionContext | ExtensionCommandContext) => void;
  /** Autowork: claim-and-run loop (queue first, then claim-next). */
  work: (ctx: ExtensionContext) => Promise<void>;
  /** Finish the current task, then stop the loop. */
  stop: (ctx: ExtensionContext) => void;
  /** Drain this session's queue after a -do turn (no-op when empty/running). */
  drainQueue: (ctx: ExtensionContext) => Promise<void>;
  status: () => { taskId: string | null; mode: string | null; phase: string };
  /** The write window opened by -do (read by the tool_call gate). */
  guard: import("./guard.js").WriteGuard;
  /** This session's id (UNIPI_KANBOARD_SESSION / pi-<pid>). */
  session: () => string;
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
    if (sameBinding) {
      // Same binding but different auth wishes: reusing would silently ignore
      // the settings — say so instead of restarting unprompted.
      const wantsToken = settings.requireAuth || !isLoopbackHost(host);
      const hasToken = typeof existing.token === "string" && existing.token.length > 0;
      if (wantsToken !== hasToken) {
        const mode = hasToken ? "token-gated" : "open (no token)";
        ctx.ui.notify(
          `kanboard: the board is running ${mode} on ${existing.host}:${existing.port} — /unipi:kanboard close then open to apply`,
          "warning",
        );
      }
      return existing.port;
    }
    deps.debug(`rebinding: running ${existing.host}:${existing.port} → ${host}:${port}`);
    await client.run(["stop"], {}).catch(() => undefined);
    onRestart?.({ host, port });
  }

  const args = ["serve", "--host", host, "--port", String(port), "--idle-min", String(settings.idleMin)];
  if (settings.requireAuth) args.push("--require-auth");
  if (settings.keepToken) args.push("--keep-token");
  try {
    // Fire and forget: the daemon detaches itself (single instance via flock).
    const child = spawn(client.binary.path, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        UNIPI_KANBOARD_ACTOR: "user",
        UNIPI_KANBOARD_CHAIN_GATE: settings.chainGate,
        UNIPI_KANBOARD_QUEUE_MAX: String(settings.queueMax),
        UNIPI_KANBOARD_MAX_SESSIONS: String(settings.maxSessions),
      },
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

  await syncPiRuntime(deps, ctx);
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
    ctx.ui.notify(
      [
        `kanboard: ${project.name} (${project.slug}) registered`,
        `  /unipi:kanboard-add <title>     — capture a task into Backlog`,
        `  /unipi:kanboard-do <request>    — let the agent use the board for a turn`,
        `  /unipi:kanboard-autowork start  — work ready tasks one by one`,
        `  /unipi:kanboard open            — open the board in a browser`,
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

/** Ensure this folder maps to a board project, offering to onboard if not. */
async function ensureOnboarded(deps: CommandDeps, ctx: ExtensionCommandContext): Promise<boolean> {
  if (currentSlug()) return true;
  const proceed = await ctx.ui.confirm(
    "Kanboard is not set up here",
    "Register this project on the board first?",
  );
  if (!proceed) return false;
  return (await runOnboard(deps, ctx)) !== null;
}

/**
 * `/unipi:kanboard-add` — the first line is flags + title, the rest is the
 * body. File paths in the body are attached; the body goes via --body-file so
 * nothing is re-escaped through argv.
 */
export async function runAdd(deps: CommandDeps, ctx: ExtensionCommandContext, text: string): Promise<void> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return;
  }
  const parsed = parseAddArgs(text);
  if (parsed.error) {
    ctx.ui.notify(`kanboard: ${parsed.error} — /unipi:kanboard-add [-p 1-5] [--after ID] [--status backlog|todo] <title>`, "warning");
    return;
  }
  if (!parsed.title) {
    ctx.ui.notify("kanboard: add needs a title — /unipi:kanboard-add <title>", "warning");
    return;
  }
  if (!(await ensureOnboarded(deps, ctx))) return;

  let bodyFile: string | null = null;
  try {
    const argv = ["add", parsed.title, ...parsed.flags];
    if (parsed.description) {
      bodyFile = join(mkdtempSync(join(tmpdir(), "kb-add-")), "body.md");
      writeFileSync(bodyFile, parsed.description);
      argv.push("--body-file", bodyFile);
    }
    for (const file of parsed.attaches) argv.push("--attach", file);
    const task = asTask("add", await client.run<unknown>(argv, { cwd: ctx.cwd }));
    const lane = task.status === "todo" ? "Todo" : "Backlog";
    const attachments = parsed.attaches.length > 0 ? ` (${parsed.attaches.length} attachment${parsed.attaches.length === 1 ? "" : "s"})` : "";
    ctx.ui.notify(`✓ ${task.id} added to ${lane}${attachments}`, "info");
    deps.debug(`add ${task.id} [${task.status}]: ${parsed.title} (${parsed.attaches.length} attachments)`);
  } catch (error) {
    ctx.ui.notify(
      `kanboard: could not add the task — ${error instanceof KanboardCliError ? error.message : String(error)}`,
      "error",
    );
  } finally {
    if (bodyFile) rmSync(join(bodyFile, ".."), { recursive: true, force: true });
  }
}

export async function runStatus(deps: CommandDeps, ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
  const client = deps.cli;
  const lines: string[] = [];
  const info = readDaemonInfo();
  if (info && (await healthy(info.port))) {
    lines.push(`daemon: pid ${info.pid} · http://${info.host ?? "127.0.0.1"}:${info.port} · v${info.version}`);
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
      // Active claims and this session's queue.
      const running = tasks.filter((task) => task.status === "in_progress");
      if (running.length > 0) {
        lines.push("claims:");
        for (const task of running) {
          const run = (task as KanboardTask & { run?: { session?: string; pid?: number; host?: string } }).run;
          const staleness = (task as KanboardTask & { staleness?: string }).staleness ?? "?";
          lines.push(
            `  ${task.id} — session ${run?.session ?? "?"} pid ${run?.pid ?? "?"} on ${run?.host ?? "?"} (${staleness})`,
          );
        }
      }
      try {
        const queue = (await client!.run<unknown>(["queue", "--list"], {
          extraEnv: { UNIPI_KANBOARD_SESSION: deps.session() },
        })) as { queue?: string[] };
        lines.push(`queue (${deps.session()}): ${(queue.queue ?? []).join(" ") || "empty"}`);
      } catch {
        lines.push("queue: (unreadable)");
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

/**
 * After a -do window closed (the first real agent_end), start draining this
 * session's queue when it is non-empty. Returns true when draining started.
 */
export async function drainQueueAfterDo(deps: CommandDeps, ctx: ExtensionContext): Promise<boolean> {
  const client = deps.cli;
  const slug = currentSlug();
  if (!client || !slug) return false;
  const queued = await client
    .run<{ queue?: string[] }>(["queue", "--list"], {
      extraEnv: { UNIPI_KANBOARD_PROJECT: slug, UNIPI_KANBOARD_SESSION: deps.session() },
    })
    .then((payload) => payload.queue ?? [])
    .catch(() => [] as string[]);
  if (queued.length === 0) return false;
  await deps.drainQueue(ctx);
  return true;
}


/** `doctor`: ✓/✗ lines for the whole setup, posted as a display-only message. */
export async function runDoctor(deps: CommandDeps, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const check = (ok: boolean | null, label: string): string => `${ok === null ? "–" : ok ? "✓" : "✗"} ${label}`;
  const lines: string[] = ["kanboard doctor"];
  const client = deps.cli;
  lines.push(check(client !== null, client ? `binary: ${client.binary.path} (${client.binary.source})` : `binary: ${deps.unavailable}`));

  const info = readDaemonInfo();
  const alive = info ? await healthy(info.port, 700, info.token) : false;
  lines.push(check(alive, info ? `daemon: http://${info.host ?? "127.0.0.1"}:${info.port} alive (pid ${info.pid})` : "daemon: not running"));
  if (info) {
    const loopback = isLoopbackHost(info.host ?? "127.0.0.1");
    const url = `http://${loopback ? "127.0.0.1" : osHostname()}:${info.port}`;
    lines.push(check(true, `bind: ${info.host ?? "127.0.0.1"}:${info.port} ${loopback ? "(loopback — local only)" : `(remote — token-gated, e.g. ${url}?t=…)`}`));
  }

  const slug = currentSlug();
  if (!slug) {
    lines.push(check(false, "project: not registered for this folder — /unipi:kanboard onboard"));
  } else if (client) {
    try {
      const shown = (await client.run<unknown>(["project", "show"], {})) as { project?: { name?: string }; total?: number };
      lines.push(check(true, `project: ${shown.project?.name ?? slug} (${slug}) · ${shown.total ?? "?"} tasks`));
    } catch (error) {
      lines.push(check(false, `project: ${slug} unreadable — ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  // Summarize runs pi itself: piCommand argv (written on session start /
  // open) must exist and its executable must resolve; summaryModel must be one
  // of the reported models when set.
  try {
    const settingsPath = join(kanboardHome(), "settings.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      piCommand?: string[];
      models?: string[];
      summaryModel?: string;
    };
    const argv = Array.isArray(raw.piCommand) ? raw.piCommand : [];
    if (argv.length === 0) {
      lines.push(check(null, "summarize via pi: not configured (open the board from pi once)"));
    } else {
      const exe = argv[0]!;
      const exists = existsSync(exe);
      lines.push(
        check(exists, `summarize via pi: ${argv.join(" ")}${exists ? "" : ` — ${exe} not found`}`),
      );
      const model = (raw.summaryModel ?? "").trim();
      if (model) {
        const listed = (raw.models ?? []).includes(model);
        lines.push(check(listed, `summary model: ${model}${listed ? "" : " — not in the reported model list"}`));
      } else {
        lines.push(check(true, "summary model: pi default"));
      }
    }
  } catch {
    lines.push(check(null, "summarize via pi: not configured (open the board from pi once)"));
  }

  // The workflow permission mode lives in the "permission" settings namespace.
  try {
    const raw = getSettings("permission", ctx.cwd) as { mode?: string };
    lines.push(check(true, `permission mode: ${raw.mode ?? "auto"}`));
  } catch {
    // not trivially available — skipped
  }

  if (slug && client) {
    try {
      const dry = (await client.run<unknown>(["reap", "--dry-run"], {
        extraEnv: { UNIPI_KANBOARD_PROJECT: slug },
      })) as { released?: string[]; unknown?: string[] };
      for (const id of dry.released ?? []) lines.push(check(false, `claim: ${id} — dead session, will return to Todo on next claim`));
      for (const id of dry.unknown ?? []) lines.push(check(null, `claim: ${id} — running on another host`));
      if ((dry.released ?? []).length === 0 && (dry.unknown ?? []).length === 0) lines.push(check(true, "claims: none stale"));
    } catch {
      lines.push(check(null, "claims: could not probe (reap --dry-run failed)"));
    }
  }

  pi.sendMessage({ customType: DOCTOR_CUSTOM_TYPE, content: lines.join("\n"), display: true }, { triggerTurn: false });
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

/**
 * Tell the daemon how to run pi for summaries: `piCommand` (this process's
 * argv minus flags). The daemon owns the model catalog itself now — it runs
 * `piCommand --list-models` with the same ambient runtime as the summarizer.
 * Runs on session start and on `open`; skipped inside kanboard's own child
 * sessions (UNIPI_KANBOARD_CHILD) so the summarizer never rewrites the file.
 */
export async function syncPiRuntime(
  deps: CommandDeps,
  ctx: ExtensionCommandContext | ExtensionContext,
): Promise<void> {
  const client = deps.cli;
  if (!client || process.env.UNIPI_KANBOARD_CHILD) return;
  // argv[1] is the pi script when node runs it; a compiled binary has none.
  // Keep it when it exists on disk (the coffee bin/pi shim has no extension).
  const script = process.argv[1];
  const argv = [process.execPath, ...(script && existsSync(script) ? [script] : [])];
  try {
    await client.run<unknown>(["settings", "set", "pi-command", JSON.stringify(argv)], {});
  } catch (error) {
    deps.debug(`pi runtime sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Hub action "Rotate access token": the CLI drops <home>/token. */
export async function runRotateTokenAction(
  deps: CommandDeps,
  ctx: ExtensionCommandContext | ExtensionContext,
): Promise<void> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return;
  }
  try {
    await client.run<unknown>(["rotate-token"], {});
    ctx.ui.notify("kanboard: new token on the next daemon start — /unipi:kanboard close, then open", "info");
  } catch (error) {
    ctx.ui.notify(
      `kanboard: rotate-token failed — ${error instanceof KanboardCliError ? error.message : String(error)}`,
      "error",
    );
  }
}


// ─── show: the board as a themed chat message ──────────────────────────────

interface ShowTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  order?: number;
  deps?: string[];
  ready?: boolean;
  waitingFor?: string[];
  run?: { session?: string } | null;
  blockedReason?: { text?: string } | null;
}

const SHOW_LANES: Array<{ id: string; label: string }> = [
  { id: "in_progress", label: "In Progress" },
  { id: "blocked", label: "Blocked" },
  { id: "todo", label: "Todo" },
  { id: "in_review", label: "In Review" },
  { id: "backlog", label: "Backlog" },
  { id: "done", label: "Done" },
];
const SHOW_EXTRA_LANES: Array<{ id: string; label: string }> = [
  { id: "cancelled", label: "Cancelled" },
  { id: "archived", label: "Archived" },
];
const PRIO_GLYPH: Record<string, string> = { urgent: "⇈", high: "↑", medium: "·", low: "↓", none: " " };
const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Same ordering as the CLI's claim_sort: priority, then lane order, then id. */
export function claimOrder(tasks: ShowTask[]): ShowTask[] {
  return [...tasks].sort(
    (a, b) =>
      (PRIO_RANK[a.priority ?? "none"] ?? 4) - (PRIO_RANK[b.priority ?? "none"] ?? 4) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** One renderable line's parts, before theming. */
interface ShowRow {
  /** tree prefix: "", "├ " or "└ " (children sit under their dep) */
  branch: "" | "├ " | "└ ";
  number?: string;
  id: string;
  prio: string;
  title: string;
  /** e.g. "after KBL-3", "· pi-123", the blocked reason */
  extra?: string;
  tone?: "dim" | "error";
}

function laneRows(tasks: ShowTask[], lane: string): ShowRow[] {
  const rows: ShowRow[] = [];
  if (lane === "todo") {
    const ordered = claimOrder(tasks);
    const byId = new Map(ordered.map((task) => [task.id, task]));
    // children share a dep with a later sibling → ├, otherwise └
    const kids = new Map<string, ShowTask[]>();
    for (const task of ordered) {
      for (const dep of task.deps ?? []) {
        if (byId.has(dep)) kids.set(dep, [...(kids.get(dep) ?? []), task]);
      }
    }
    const emitted = new Set<string>();
    const emit = (task: ShowTask, branch: "" | "├ " | "└ ", number: number): void => {
      emitted.add(task.id);
      const waits = (task.waitingFor ?? []).filter((id) => id !== "");
      rows.push({
        branch,
        number: `${number}.`,
        id: task.id,
        prio: PRIO_GLYPH[task.priority ?? "none"] ?? " ",
        title: task.title,
        extra:
          task.ready === false || waits.length > 0
            ? `waits for ${waits.join(", ")}`
            : "ready",
        tone: task.ready === false || waits.length > 0 ? "dim" : undefined,
      });
      const children = kids.get(task.id) ?? [];
      children.forEach((child, index) => emit(child, index === children.length - 1 ? "└ " : "├ ", number));
    };
    let n = 0;
    for (const task of ordered) {
      if (emitted.has(task.id)) continue;
      n += 1;
      emit(task, "", n);
    }
    return rows;
  }
  for (const task of tasks) {
    rows.push({
      branch: "",
      id: task.id,
      prio: PRIO_GLYPH[task.priority ?? "none"] ?? " ",
      title: task.title,
      extra:
        lane === "in_progress" && task.run?.session
          ? `· ${task.run.session}`
          : lane === "blocked" && task.blockedReason?.text
            ? task.blockedReason.text
            : (task.deps ?? []).length > 0
              ? `after ${(task.deps ?? []).join(", ")}`
              : undefined,
      tone: lane === "blocked" && task.blockedReason?.text ? "error" : undefined,
    });
  }
  return rows;
}

/** Plain-text fallback (also what the message stores as content). */
export function renderShowPlain(project: string, tasks: ShowTask[], all: boolean): string {
  const lanes = all ? [...SHOW_LANES, ...SHOW_EXTRA_LANES] : SHOW_LANES;
  const lines = [`${project} · ${tasks.length} tasks`];
  for (const lane of lanes) {
    const inLane = tasks.filter((task) => task.status === lane.id);
    if (inLane.length === 0) {
      lines.push(`${lane.label} — empty`);
      continue;
    }
    lines.push(lane.label);
    for (const row of laneRows(inLane, lane.id)) {
      lines.push(`  ${row.branch}${row.number ? `${row.number} ` : ""}${row.id} ${row.prio} ${row.title}${row.extra ? `  ${row.extra}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** The themed renderer registered for SHOW_CUSTOM_TYPE. */
export function showRenderer(
  message: { content: unknown; details?: { project?: string; tasks?: ShowTask[]; all?: boolean } },
  _options: unknown,
  theme: Theme,
): { render: (width: number) => string[]; invalidate: () => void } {
  return {
    render(width: number): string[] {
      const details = message.details;
      if (!details?.tasks) return [typeof message.content === "string" ? message.content : ""];
      const lanes = details.all ? [...SHOW_LANES, ...SHOW_EXTRA_LANES] : SHOW_LANES;
      const lines: string[] = [theme.bold(`${details.project ?? "board"} · ${details.tasks.length} tasks`)];
      for (const lane of lanes) {
        const inLane = details.tasks.filter((task) => task.status === lane.id);
        if (inLane.length === 0) {
          lines.push(`  ${theme.fg("dim", `${lane.label} — empty`)}`);
          continue;
        }
        lines.push(theme.fg("accent", lane.label));
        for (const row of laneRows(inLane, lane.id)) {
          const head = `  ${row.branch}${row.number ? `${row.number} ` : ""}${theme.fg("muted", row.id)} ${row.prio} `;
          // visible length so far, then truncate the title to fit.
          const prefixLen = 2 + row.branch.length + (row.number ? row.number.length + 1 : 0) + row.id.length + 2;
          const budget = Math.max(10, width - prefixLen - (row.extra ? row.extra.length + 2 : 0));
          const title = row.title.length > budget ? `${row.title.slice(0, Math.max(1, budget - 1))}…` : row.title;
          const extra = row.extra ? `  ${row.tone === "error" ? theme.fg("error", row.extra) : theme.fg("dim", row.extra)}` : "";
          lines.push(`${head}${title}${extra}`);
        }
      }
      return lines;
    },
    invalidate: () => undefined,
  };
}

async function runShow(deps: CommandDeps, ctx: ExtensionCommandContext, pi: ExtensionAPI, all: boolean): Promise<void> {
  const client = deps.cli;
  if (!client) {
    ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
    return;
  }
  if (!(await ensureOnboarded(deps, ctx))) return;
  const slug = currentSlug()!;
  let tasks: ShowTask[] = [];
  try {
    const payload = (await client.run(["list", "--json"], { cwd: ctx.cwd })) as { tasks?: ShowTask[] };
    tasks = payload.tasks ?? [];
  } catch (error) {
    ctx.ui.notify(`kanboard: show failed — ${error instanceof KanboardCliError ? error.message : String(error)}`, "error");
    return;
  }
  pi.sendMessage(
    {
      customType: SHOW_CUSTOM_TYPE,
      content: renderShowPlain(slug, tasks, all),
      display: true,
      details: { project: slug, tasks, all },
    },
    { triggerTurn: false },
  );
}


// ─── autocomplete ───────────────────────────────────────────────────────────

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * pi-tui's applyCompletion replaces the WHOLE argument prefix with the item's
 * `value` — so every value must be the full argument text, earlier tokens
 * included, or accepting a completion would silently delete them.
 */
function fullArgs(before: string, token: string): string {
  return before + token;
}

const SUB_DESCRIPTIONS: Record<Subcommand, string> = {
  open: "Start the daemon and print the board URL (--host 0.0.0.0|tailscale, --port N)",
  close: "Shut down the board daemon (the web UI goes offline)",
  onboard: "Register this project on the board",
  status: "Daemon, project counts, claims, queue and the runner state",
  doctor: "Check the whole setup (binary, daemon, project, agent, claims)",
  show: "The board in chat: lanes + claim order (--all adds cancelled/archived)",
};

/** /unipi:kanboard … */
export function kanboardCompletions(prefix: string): CompletionItem[] | null {
  const raw = prefix.replace(/^\s+/, "");
  // `open --host <TAB>` → bind addresses (value keeps "open --host ").
  const hostMatch = /^(open\s+--host\s+)(\S*)$/.exec(raw);
  if (hostMatch) {
    const [, before, partial] = hostMatch;
    return [
      { value: "127.0.0.1", label: "127.0.0.1", description: "local only (default)" },
      { value: "0.0.0.0", label: "0.0.0.0", description: "every interface, token-gated" },
      { value: "tailscale", label: "tailscale", description: "the tailnet IPv4" },
    ]
      .filter((item) => item.value.startsWith(partial))
      .map((item) => ({ ...item, value: fullArgs(before!, item.value) }));
  }
  // `open --<TAB>` → the flags.
  const openFlags = /^(open\s+)(\S*)$/.exec(raw) ?? /^(open\s+.*\s)(\S*)$/.exec(raw);
  if (openFlags && openFlags[2]!.startsWith("--")) {
    const [, before, partial] = openFlags;
    return [
      { value: "--host", label: "--host", description: "Bind address: 127.0.0.1 · 0.0.0.0 · tailscale" },
      { value: "--port", label: "--port", description: "Port to bind (0 = auto)" },
    ]
      .filter((item) => item.value.startsWith(partial))
      .map((item) => ({ ...item, value: fullArgs(before!, item.value) }));
  }
  // `show --<TAB>` → --all.
  const showFlags = /^(show\s+)(\S*)$/.exec(raw);
  if (showFlags) {
    const [, before, partial] = showFlags;
    return [{ value: "--all", label: "--all", description: "Include cancelled and archived lanes" }]
      .filter((item) => item.value.startsWith(partial))
      .map((item) => ({ ...item, value: fullArgs(before!, item.value) }));
  }
  const needle = raw.toLowerCase();
  const items = SUBCOMMANDS.map((sub) => ({ value: sub, label: sub, description: SUB_DESCRIPTIONS[sub] })).filter((item) =>
    item.value.startsWith(needle),
  );
  return items.length > 0 ? items : null;
}

/** Live task list for `--after` / `-do` completions, cached ~5s per client. */
const taskCache = new WeakMap<KanboardCli, { at: number; tasks: ShowTask[] }>();

export async function taskCompletions(deps: CommandDeps, prefix: string, before: string): Promise<CompletionItem[] | null> {
  const client = deps.cli;
  if (!client) return null;
  let cache = taskCache.get(client);
  if (!cache || Date.now() - cache.at > 5_000) {
    try {
      const payload = (await client.run(["list", "--json"], { cwd: process.cwd() })) as { tasks?: ShowTask[] };
      cache = { at: Date.now(), tasks: payload.tasks ?? [] };
      taskCache.set(client, cache);
    } catch {
      return null;
    }
  }
  const needle = prefix.toLowerCase();
  const items = cache.tasks
    .filter((task) => !["cancelled", "archived"].includes(task.status))
    .filter((task) => task.id.toLowerCase().startsWith(needle) || task.title.toLowerCase().includes(needle))
    .slice(0, 12)
    .map((task) => ({
      value: fullArgs(before, task.id),
      label: task.id,
      description: `${task.status} — ${task.title}`,
    }));
  return items.length > 0 ? items : null;
}

const PRIORITY_FLAGS: Array<[string, string]> = [
  ["1", "none"],
  ["2", "low"],
  ["3", "medium"],
  ["4", "high"],
  ["5", "urgent"],
];

/** /unipi:kanboard-add … */
export async function kanboardAddCompletions(deps: CommandDeps, prefix: string): Promise<CompletionItem[] | null> {
  const raw = prefix ?? "";
  // The last whitespace-separated token is being completed; keep the rest.
  const match = /^(.*?)(\S*)$/.exec(raw.replace(/\s+$/, " "))!;
  const before = match[1]!;
  const token = match[2]!;

  // `--after <ID>` → live tasks.
  if (/(^|\s)--after\s+$/.test(`${before} `) || /(^|\s)--after\s+\S*$/.test(raw)) {
    const m = /^(.*?--after\s+)(\S*)$/.exec(raw);
    if (m) return taskCompletions(deps, m[2]!, m[1]!);
    if (raw.endsWith("--after ") || raw.endsWith("--after")) {
      return taskCompletions(deps, "", raw.endsWith(" ") ? raw : `${raw} `);
    }
  }
  // `-p <n>` → 1..5 with labels.
  const pMatch = /^(.*?-p\s+)(\S*)$/.exec(raw) ?? /^(.*?)(-p)$/.exec(raw);
  if (pMatch && !token.startsWith("--")) {
    const [, pbefore, ptoken] = pMatch;
    const digits = ptoken === "-p" ? "" : ptoken;
    return PRIORITY_FLAGS.filter(([n]) => n.startsWith(digits)).map(([n, name]) => ({
      value: fullArgs(pbefore!, n),
      label: `-p ${n}`,
      description: name,
    }));
  }
  // `--priority <name>`.
  const priMatch = /^(.*?--priority\s+)(\S*)$/.exec(raw) ?? /^(.*?)(--priority)$/.exec(raw);
  if (priMatch) {
    const [, pbefore, ptoken] = priMatch;
    const part = ptoken === "--priority" ? "" : ptoken;
    return PRIORITY_FLAGS.map(([, name]) => name)
      .filter((name) => name.startsWith(part))
      .map((name) => ({ value: fullArgs(pbefore!, name), label: name, description: "priority" }));
  }
  // `--status backlog|todo`.
  const stMatch = /^(.*?--status\s+)(\S*)$/.exec(raw) ?? /^(.*?)(--status)$/.exec(raw);
  if (stMatch) {
    const [, sbefore, stoken] = stMatch;
    const part = stoken === "--status" ? "" : stoken;
    return ["backlog", "todo"]
      .filter((name) => name.startsWith(part))
      .map((name) => ({ value: fullArgs(sbefore!, name), label: name, description: "lane" }));
  }
  // Bare token → the flags themselves.
  if (token.startsWith("-")) {
    const flags = ["-p", "--priority", "--status", "--after"];
    return flags
      .filter((flag) => flag.startsWith(token))
      .map((flag) => ({
        value: fullArgs(before, flag),
        label: flag,
        description:
          flag === "-p" || flag === "--priority"
            ? "Priority: none · low · medium · high · urgent"
            : flag === "--status"
              ? "Lane: backlog|todo"
              : "Runs after <task id>",
      }));
  }
  return null;
}

/** /unipi:kanboard-do … — complete a trailing task-id prefix. */
export async function kanboardDoCompletions(deps: CommandDeps, prefix: string): Promise<CompletionItem[] | null> {
  const raw = prefix ?? "";
  const match = /^(.*?)(\S*)$/.exec(raw)!;
  const before = match[1]!;
  const token = match[2]!;
  // Only when the last token looks like a task id prefix (ABC-…).
  if (!/^[A-Za-z]{2,6}-?[0-9]*$/.test(token) || token.length < 2) return null;
  return taskCompletions(deps, token, before);
}

export function registerKanboardCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  // Help and doctor output is display-only: it must never enter the LLM's
  // context, so a `context` hook drops these custom types every turn.
  // The board view renders itself (theme + terminal width); the stored content
  // stays plain text as a fallback and the context filter drops it.
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(SHOW_CUSTOM_TYPE, (message, options, theme) =>
      showRenderer(message as { content: unknown; details?: { project?: string; tasks?: ShowTask[]; all?: boolean } }, options, theme),
    );
  }

  pi.on("context", (event) => {
    const hidden = new Set([HELP_CUSTOM_TYPE, DOCTOR_CUSTOM_TYPE, SHOW_CUSTOM_TYPE]);
    const filtered = event.messages.filter(
      (message) => !hidden.has((message as { customType?: string }).customType ?? ""),
    );
    if (filtered.length !== event.messages.length) return { messages: filtered };
    return undefined;
  });

  // Board writes through bash are gated by the write window: read-only
  // subcommands always pass, everything else needs a -do turn or a running task.
  pi.on("tool_call", async (event) => {
    const toolName = (event as { toolName?: string }).toolName;
    if (toolName !== "bash" && toolName !== "powershell") return undefined;
    const command = String((event as { input?: { command?: unknown } }).input?.command ?? "");
    // Limits live in the environment; refresh so this bash call inherits the
    // current settings (the spawned CLI reads them).
    applyLimitEnv(deps.settings());
    const reason = deps.guard.check(command);
    return reason ? { block: true, reason } : undefined;
  });

  pi.registerCommand("unipi:kanboard", {
    description: "Kanboard — the board: open, onboard, status, doctor (bare = help)",
    getArgumentCompletions: (prefix: string) => kanboardCompletions(prefix ?? ""),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      const rest = args?.trim().slice(parts[0]?.length ?? 0).trim() ?? "";

      // Bare `/unipi:kanboard` lists the commands (display-only, never LLM context).
      if (sub === "") {
        pi.sendMessage({ customType: HELP_CUSTOM_TYPE, content: HELP, display: true }, { triggerTurn: false });
        return;
      }

      // Old entry points now just point at the new commands.
      if (sub === "add") {
        ctx.ui.notify("kanboard: use /unipi:kanboard-add <title> — lines below the title become the description", "info");
        return;
      }
      if (sub === "work") {
        ctx.ui.notify("kanboard: use /unipi:kanboard-autowork start to work the queue", "info");
        return;
      }
      if (sub === "stop") {
        ctx.ui.notify("kanboard: use /unipi:kanboard-autowork stop to finish the current task and stop", "info");
        return;
      }

      if (!SUBCOMMANDS.includes(sub as Subcommand)) {
        ctx.ui.notify(`kanboard: unknown subcommand "${sub}" — /unipi:kanboard lists the commands`, "warning");
        return;
      }
      if (!deps.cli && sub !== "open") {
        ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
        return;
      }

      switch (sub as Subcommand) {
        case "onboard":
          await runOnboard(deps, ctx);
          return;
        case "close":
          await runStopDaemon(deps, ctx);
          return;
        case "status":
          await runStatus(deps, ctx);
          return;
        case "doctor":
          await runDoctor(deps, ctx, pi);
          return;
        case "show":
          await runShow(deps, ctx, pi, parts.includes("--all"));
          return;
        case "open":
          if (!deps.cli) {
            ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
            return;
          }
          await runOpen(deps, ctx, rest);
          return;
      }
    },
  });

  pi.registerCommand("unipi:kanboard-add", {
    description: "Add a board task — [-p 1-5] [--after ID] [--status backlog|todo] <title>; lines below are the description (paste file paths to attach)",
    getArgumentCompletions: (prefix: string) => kanboardAddCompletions(deps, prefix ?? ""),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runAdd(deps, ctx, args ?? "");
    },
  });

  pi.registerCommand("unipi:kanboard-do", {
    description: "Let the agent use the kanboard for this turn — writes are allowed until the turn ends",
    getArgumentCompletions: (prefix: string) => kanboardDoCompletions(deps, prefix ?? ""),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const request = (args ?? "").trim();
      if (!request) {
        ctx.ui.notify("kanboard: -do needs a request — /unipi:kanboard-do <what the agent may do on the board>", "warning");
        return;
      }
      const client = deps.cli;
      if (!client) {
        ctx.ui.notify(`kanboard: ${deps.unavailable}`, "warning");
        return;
      }
      if (!(await ensureOnboarded(deps, ctx))) return;
      const slug = currentSlug()!;
      deps.revealSkill(ctx);
      deps.guard.open();
      const busy = typeof (ctx as unknown as { isIdle?: () => boolean }).isIdle === "function"
        ? !(ctx as unknown as { isIdle: () => boolean }).isIdle!()
        : false;
      pi.sendUserMessage(doText(slug, client.binary.path, request, deps.settings().queueMax), busy ? { deliverAs: "followUp" } : undefined);
      deps.guard.noteSent();
      deps.debug(`do window open (${slug})`);
    },
  });

  pi.registerCommand("unipi:kanboard-autowork", {
    description: "Work ready board tasks one by one — start | stop (stop finishes the current task first)",
    getArgumentCompletions: (prefix: string) =>
      (["start", "stop"] as const)
        .filter((word) => word.startsWith((prefix ?? "").trim().toLowerCase()))
        .map((word) => ({
          value: word,
          label: word,
          description: word === "start" ? "Work ready tasks one by one" : "Finish the current task, then stop",
        })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "start") {
        if (!(await ensureOnboarded(deps, ctx))) return;
        await deps.work(ctx as unknown as ExtensionContext);
        return;
      }
      if (sub === "stop") {
        deps.stop(ctx as unknown as ExtensionContext);
        return;
      }
      ctx.ui.notify("kanboard: /unipi:kanboard-autowork start|stop", "warning");
    },
  });
}

/** Back-compat name for the single-command registration. */
export const registerKanboardCommand = registerKanboardCommands;

/** CLI presence probe used at session start (cheap, no spawn). */
export function binaryLooksReady(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
