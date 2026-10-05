import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMoveHandlers, registerMoveHandler, UTILITY_COMMANDS, type MoveContext, type MoveItem, type MoveLogEntry } from "@pi-unipi/core";
import { piSessionsHandler, piTrustHandler, sessionDir } from "./pi-state.js";
import { gitWorktreesHandler } from "./git.js";

export function newProjectRoot(cwd: string): string {
  try {
    return realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return realpathSync(cwd);
  }
}

export function validateOldRoot(oldRoot: string, newRoot: string): void {
  if (oldRoot === newRoot) throw new Error("Old path and current project root are the same.");
  if (existsSync(oldRoot)) throw new Error(`Old path still exists: ${oldRoot}. This is a copy, not a move; refusing to re-link state.`);
}

export function parseMoveArgs(args: string): { oldPath?: string; dryRun: boolean } {
  const tokens = args.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\S+/g) ?? [];
  const paths: string[] = [];
  let dryRun = false;
  for (const token of tokens) {
    if (token === "--dry-run") dryRun = true;
    else if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    else paths.push(token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : token);
  }
  if (paths.length > 1) throw new Error("Usage: /unipi:move [<old-path>] [--dry-run]");
  return { oldPath: paths[0], dryRun };
}

export function createMoveContext(oldRoot: string, newRoot: string, dryRun: boolean): { context: MoveContext; logFile: string; entries: MoveLogEntry[] } {
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const home = join(homedir(), ".unipi");
  const logFile = join(home, "logs", `move-${timestamp}.log`);
  const backupRoot = join(home, "move-backup", timestamp);
  const entries: MoveLogEntry[] = [];
  const backedUp = new Set<string>();
  const log = (entry: MoveLogEntry) => {
    entries.push(entry);
    if (dryRun) return;
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  };
  const context: MoveContext = {
    oldRoot, newRoot, dryRun, log,
    backup(file) {
      if (dryRun || !existsSync(file) || backedUp.has(file)) return;
      const destination = join(backupRoot, resolve(file).replace(/^[/\\]/, ""));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file, destination);
      backedUp.add(file);
      log({ area: "backup", action: "copy", from: file, to: destination, result: "ok" });
    },
  };
  return { context, logFile, entries };
}

export async function runMove(args: string, ctx: Pick<ExtensionCommandContext, "cwd" | "ui" | "hasUI"> & Partial<Pick<ExtensionCommandContext, "sessionManager">>): Promise<void> {
  try {
    const parsed = parseMoveArgs(args);
    const newRoot = newProjectRoot(ctx.cwd);
    let oldRoot = parsed.oldPath ? resolve(ctx.cwd, parsed.oldPath.startsWith("~/") ? join(homedir(), parsed.oldPath.slice(2)) : parsed.oldPath) : undefined;
    const handlers = getMoveHandlers();
    if (!oldRoot) {
      const roots = new Set<string>();
      for (const handler of handlers) {
        try {
          for (const root of await handler.discoverOrphans?.() ?? []) if (root !== newRoot && !existsSync(root)) roots.add(root);
        } catch (error) {
          ctx.ui.notify(`${handler.label}: orphan discovery failed: ${String(error)}`, "warning");
        }
      }
      const candidates = [...roots].sort((a, b) => Number(basename(b) === basename(ctx.cwd)) - Number(basename(a) === basename(ctx.cwd)) || a.localeCompare(b));
      if (!candidates.length) {
        ctx.ui.notify("No orphaned project state found. Nothing to re-link.", "info");
        return;
      }
      if (!ctx.hasUI) throw new Error("Choosing an old project path requires an interactive UI; pass <old-path>.");
      oldRoot = await ctx.ui.select("Re-link state from which old project path?", candidates);
      if (!oldRoot) return;
    }
    validateOldRoot(oldRoot, newRoot);
    const { context, logFile, entries } = createMoveContext(oldRoot, newRoot, parsed.dryRun);
    const items: MoveItem[] = [];
    const scanErrors: string[] = [];
    for (const handler of handlers) {
      try {
        items.push(...await handler.scan(context));
      } catch (error) {
        scanErrors.push(`${handler.label}: scan failed: ${String(error)}`);
      }
    }
    const groups = new Map<string, string[]>();
    for (const item of items) groups.set(item.area, [...groups.get(item.area) ?? [], item.description]);
    const notices = ["mise.toml", ".mise.toml"].filter((f) => existsSync(join(newRoot, f))).map((f) => `${f}: run mise trust in ${newRoot} (not changed automatically).`);
    const activeSessionDir = ctx.sessionManager?.getSessionDir();
    if (activeSessionDir && resolve(activeSessionDir) !== sessionDir(ctx.cwd)) {
      notices.push(`Custom session storage ${activeSessionDir}: only default path-encoded session directories are migrated; custom session headers are not changed.`);
    }
    const plan = [`Re-link ${oldRoot} → ${newRoot}`, ...[...groups].map(([area, descriptions]) => `\n${area}\n${descriptions.map((d) => `  • ${d}`).join("\n")}`), ...notices, ...scanErrors].join("\n");
    ctx.ui.notify(plan, scanErrors.length ? "warning" : "info");
    if (parsed.dryRun) {
      ctx.ui.notify(`Dry run: ${items.length} item(s); no files written.`, "info");
      return;
    }
    if (!items.length) {
      ctx.ui.notify("Nothing to re-link.", "info");
      return;
    }
    if (!ctx.hasUI) throw new Error("Applying a move requires interactive confirmation; use --dry-run to preview.");
    if (!await ctx.ui.confirm("Apply project state re-link?", plan)) return;
    validateOldRoot(oldRoot, newRoot);
    let applied = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await item.apply();
        applied++;
      } catch (error) {
        failed++;
        context.log({ area: item.area, action: item.description, from: oldRoot, to: newRoot, result: `failed: ${String(error)}` });
      }
    }
    const reports = entries.filter((e) => e.result !== "ok").map((e) => `${e.area}: ${e.result}`);
    ctx.ui.notify(`Re-link complete: ${applied} item(s) processed, ${failed} failed.\n${[...reports, ...scanErrors, ...notices].join("\n")}\nLog: ${logFile}`, failed || reports.length || scanErrors.length ? "warning" : "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export function registerMoveCommand(pi: ExtensionAPI): void {
  registerMoveHandler(piSessionsHandler);
  registerMoveHandler(piTrustHandler);
  registerMoveHandler(gitWorktreesHandler);
  pi.registerCommand(`unipi:${UTILITY_COMMANDS.MOVE}`, {
    description: "Re-link state after moving this project: [<old-path>] [--dry-run] (never moves the project itself)",
    handler: runMove,
  });
}
