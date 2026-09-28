/**
 * @pi-unipi/utility — "simple" render style: MiniMax Code (mcode) transcript.
 *
 * mcode collapses every tool call to ONE line — `• Ran  git log … · 10 output lines`,
 * `• Read (package.json)` — with a dim `└ ` tree gutter and a bold verb. This module
 * wraps ANY tool definition so its collapsed view matches that look while Ctrl+O
 * (expanded) falls back to the tool's own renderer.
 *
 * mcode reference: minimax-code packages/tui/src/tui/transcript/{view,tool-definitions}.ts
 * (verbs, `├`/`└` connectors, `(target)` parentheticals, `· N output lines`).
 */

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";


import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

type AnyTool = ToolDefinition<any, any, any>;

/** [running, completed, failed] verb triple per tool name (mcode tool-definitions.ts). */
const VERBS: Record<string, [string, string, string]> = {
  bash: ["Running", "Ran", "Command failed"],
  powershell: ["Running", "Ran", "Command failed"],
  read: ["Reading", "Read", "Read failed"],
  edit: ["Editing", "Edited", "Edit failed"],
  write: ["Writing", "Wrote", "Write failed"],
  grep: ["Searching", "Searched", "Search failed"],
  find: ["Listing", "Listed", "List failed"],
  glob: ["Listing", "Listed", "List failed"],
  ls: ["Listing", "Listed", "List failed"],
  list: ["Listing", "Listed", "List failed"],
  web_search: ["Using WebSearch", "Used WebSearch", "WebSearch failed"],
  web_fetch: ["Using WebFetch", "Used WebFetch", "WebFetch failed"],
  task: ["Delegating", "Delegated", "Delegation failed"],
  delegate: ["Delegating", "Delegated", "Delegation failed"],
  spawn_agent: ["Delegating", "Delegated", "Delegation failed"],
};

/** mcode's fallback for unknown tools: `get_goal` → `Get Goal`. */
export function titleCaseTool(name: string): string {
  return (name || "tool")
    .trim()
    .toLowerCase()
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function verbsFor(name: string): [string, string, string] {
  return VERBS[name.trim().toLowerCase()] ?? [titleCaseTool(name), titleCaseTool(name), `${titleCaseTool(name)} failed`];
}

function shortPath(p: string, cwd: string): string {
  if (!p) return "";
  const abs = isAbsolute(p) ? p : `${cwd}/${p}`;
  const rel = relative(cwd, abs);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return `./${rel}`;
  const home = homedir();
  return abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
}

/** Args keys whose string value is a filesystem path (gets ~ / ./ shortening). */
const PATH_KEYS = ["path", "file_path", "file", "cwd", "dir", "directory", "notebook_path"];

/** The single argument mcode would show in the parenthetical. */
export function targetArg(name: string, args: Record<string, unknown>, cwd: string): string {
  if (name === "bash" || name === "powershell") return String(args.command ?? args.script ?? "");
  if (name === "grep") {
    const pattern = String(args.pattern ?? args.query ?? "");
    const path = args.path ? ` in ${shortPath(String(args.path), cwd)}` : "";
    return `${pattern}${path}`;
  }
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v) return shortPath(v, cwd);
  }
  for (const key of ["query", "pattern", "url", "skill", "command", "name", "id", "title", "question"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v) return v;
    if (v !== undefined && v !== null && typeof v !== "object") return String(v);
  }
  return "";
}

function textOfResult(result: AgentToolResult<any> | undefined): string {
  return (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function outputMeta(result: AgentToolResult<any> | undefined): string {
  const text = textOfResult(result);
  if (!text) return "";
  const n = text.split("\n").length;
  return ` · ${n} output line${n === 1 ? "" : "s"}`;
}

/** One mcode tool row: dim `└ • ` + bold verb + muted `(target)` + meta. */
export function simpleToolLine(
  theme: Theme,
  name: string,
  args: Record<string, unknown>,
  opts: { running: boolean; failed?: boolean; result?: AgentToolResult<any>; cwd: string; width: number },
): string {
  const [runningVerb, doneVerb, failedVerb] = verbsFor(name);
  const verb = opts.failed ? failedVerb : opts.running ? runningVerb : doneVerb;
  const marker = theme.fg(
    opts.failed ? "error" : opts.running ? "accent" : "success",
    opts.failed ? "×" : "•",
  );
  const target = targetArg(name, args, opts.cwd);
  const isShell = name === "bash" || name === "powershell";
  const tail = opts.running
    ? theme.fg("muted", " …")
    : opts.result
      ? theme.fg(opts.failed ? "error" : "muted", outputMeta(opts.result))
      : "";
  let line: string;
  if (!target) line = `${marker} ${theme.bold(verb)}`;
  else if (isShell) line = `${marker} ${theme.bold(verb)}  ${target}`;
  else line = `${marker} ${theme.bold(verb)} ${theme.fg("muted", `(${target})`)}`;
  return truncateToWidth(`${theme.fg("borderMuted", "└ ")}${line}${tail}`, Math.max(0, opts.width), theme.fg("muted", "…"));
}

/** Definitions already wearing the mcode wrapper (double-wrap guard). */
export const simpleWrapped = new WeakSet<object>();

/**
 * Re-wrap a tool definition so the collapsed view is the mcode one-liner and
 * Ctrl+O falls back to the tool's own renderer. Execute/schema are untouched —
 * the model sees exactly the same tool.
 */
export function simpleWrapTool(def: AnyTool): AnyTool {
  // pi renders call + result rows stacked (tool-execution.js updateDisplay),
  // so exactly ONE of them draws the mcode row: the call row while running,
  // the call row again once state.result exists (read lazily at render time),
  // and the result row is empty. state is shared across both renderers.
  const renderCall = (args: any, theme: Theme, ctx: any) => {
    if (ctx.expanded && def.renderCall) return def.renderCall(args, theme, ctx);
    return new SimpleLine((width: number) => {
      const st = ctx.state as { result?: AgentToolResult<any>; partial?: boolean };
      if (!st.result || st.partial) {
        return [simpleToolLine(theme, def.name, args ?? {}, { running: true, cwd: ctx.cwd, width })];
      }
      return [simpleToolLine(theme, def.name, args ?? {}, { running: false, failed: ctx.isError, result: st.result, cwd: ctx.cwd, width })];
    });
  };
  const renderResult = (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    ctx: any,
  ) => {
    try {
      if (options.expanded && def.renderResult) return def.renderResult(result, options, theme, ctx);
      (ctx.state as { result?: AgentToolResult<any>; partial?: boolean }).result = result;
      (ctx.state as { partial?: boolean }).partial = options.isPartial;
      if (!options.isPartial) ctx.invalidate();
      return new SimpleLine(() => []);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[unipi-simple] renderResult threw: ${e}`);
      throw e;
    }
  };
  const wrapped = { ...def, renderShell: "self" as const, renderCall, renderResult };
  simpleWrapped.add(wrapped);
  return wrapped;
}

/** One-line component (mcode rows never wrap; they truncate). */
class SimpleLine implements Component {
  constructor(private readonly build: (width: number) => string[]) {}
  render(width: number): string[] {
    return this.build(width).map((l) => truncateToWidth(l, Math.max(0, width), "…"));
  }
  invalidate(): void {}
}
