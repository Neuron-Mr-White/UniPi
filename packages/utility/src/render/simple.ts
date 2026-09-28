/**
 * @pi-unipi/utility — "simple" render style: MiniMax Code (mcode) transcript.
 *
 * mcode collapses tool calls into tight one-line rows with a dim `├`/`└` tree
 * gutter, and re-renders runs of read-like calls into a single summary row
 * ("Read 3 files", "Explored 4 operations"). This module reproduces that:
 *
 *   - every tool is wrapped so its collapsed view is an mcode row (Ctrl+O
 *     falls back to the tool's own renderer; execute/schema untouched);
 *   - consecutive read-like calls between two pieces of assistant text form a
 *     group that collapses to the mcode summary while/after it runs;
 *   - the latest live call is the only row that shows running state.
 *
 * mcode reference: minimax-code packages/tui/src/tui/transcript/{view,tool-definitions}.ts
 * (verbs, connectors, read-group rules at view.ts:1171-1223, "· N output lines").
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

// ─── verbs (mcode tool-definitions.ts) ────────────────────────────────────

/** [running, completed, failed] verb triple per tool name. */
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

// ─── target / meta (pure) ─────────────────────────────────────────────────

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

/** The raw argument mcode would show in the parenthetical. */
function rawTargetArg(name: string, args: Record<string, unknown>, cwd: string): string {
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
  for (const key of ["query", "pattern", "url", "skill", "command", "title", "name", "id", "question"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v) return v;
    if (v !== undefined && v !== null && typeof v !== "object") return String(v);
  }
  return "";
}

/** The single argument mcode would show in the parenthetical (always one line). */
export function targetArg(name: string, args: Record<string, unknown>, cwd: string): string {
  const raw = rawTargetArg(name, args, cwd);
  const first = raw.split("\n").find((l) => l.trim()) ?? "";
  return first.trim() + (raw.trim().includes("\n") ? " …" : "");
}

export function outputMeta(result: AgentToolResult<any> | undefined): string {
  const text = (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
  if (!text) return "";
  const n = text.split("\n").length;
  return ` · ${n} output line${n === 1 ? "" : "s"}`;
}

// ─── group registry (module-level shared state) ───────────────────────────

interface CallRec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  running: boolean;
  done: boolean;
  failed: boolean;
  meta: string;
  group: CallRec[];
  invalidate?: () => void;
  invalidating?: boolean;
}

const byId = new Map<string, CallRec>();
let currentGroup: CallRec[] = [];
let textBreakPending = false;

/** Assistant text (or a new user turn) breaks the current tool group (mcode rule). */
export function noteGroupBreak(): void {
  textBreakPending = true;
}

/**
 * Wire the group-break signal to pi events: assistant text between tool calls
 * and new user turns both start a fresh group (mcode groups consecutive tool
 * cells; any text row breaks the run).
 */
export function installSimpleGroupEvents(pi: {
  on: (event: any, handler: (event: any, ctx?: any) => void) => void;
  registerMarkdownTransformer?: (fn: (markdown: string, context: { messageType: string }) => string) => void;
}): void {
  try {
    // Break the group the moment visible assistant text streams in — message_end
    // fires only after that message's tool rows rendered (one group too late).
    // Thinking deltas and tool-call-only messages never break a group.
    pi.on("message_update", (event: any) => {
      const e = event?.assistantMessageEvent;
      if (e?.type === "text_delta" && typeof e.delta === "string" && e.delta.trim()) noteGroupBreak();
    });
    pi.on("message_start", (event: any) => {
      if (event?.message?.role === "user") noteGroupBreak();
    });
  } catch {
    // grouping is cosmetic; never block load
  }
  hideThinking(pi);
}

/**
 * mcode anchors assistant prose with `● ` (view.ts:736 anchorAssistantLines).
 * Through the markdown transformer we can only prefix the first line, and only
 * when it's a plain paragraph — a heading/list/quote/table/fence would stop
 * being markdown if we prefixed it, so those are left alone.
 */
export function anchorAssistant(markdown: string): string {
  const lead = markdown.match(/^\s*/)?.[0] ?? "";
  const body = markdown.slice(lead.length);
  if (!body || body.startsWith("● ")) return markdown;
  if (/^(#{1,6}\s|[-*+]\s|>|\||```|~~~|\d+[.)]\s|<|---|\*\*\*|___)/.test(body)) return markdown;
  return `${lead}● ${body}`;
}

/** Visible assistant text (whitespace-only text blocks don't count). */
export function messageHasText(msg: { content?: unknown }): boolean {
  return Array.isArray(msg.content) && msg.content.some((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim());
}

/**
 * Simple mode shows no thinking at all, via public API only:
 *  - collapsed thinking (pi `hideThinkingBlock`, Ctrl+T) renders its label as a
 *    Text — an empty label renders zero lines (pi-tui Text.render);
 *  - expanded thinking goes through the "assistant-thinking" markdown
 *    transform — returning "" makes the Markdown render zero lines.
 */
function hideThinking(pi: {
  on: (event: any, handler: (event: any, ctx?: any) => void) => void;
  registerMarkdownTransformer?: (fn: (markdown: string, context: { messageType: string }) => string) => void;
}): void {
  try {
    pi.registerMarkdownTransformer?.((markdown, context) => {
      if (context?.messageType === "assistant-thinking") return "";
      if (context?.messageType === "assistant") return anchorAssistant(markdown);
      return markdown;
    });
  } catch {}
  try {
    pi.on("session_start", (_event: any, ctx: any) => {
      try {
        ctx?.ui?.setHiddenThinkingLabel?.("");
      } catch {}
    });
  } catch {}
}

function touch(rec: CallRec): void {
  if (rec.invalidating) return;
  rec.invalidating = true;
  // Async: invalidate() synchronously re-enters updateDisplay → renderers;
  // doing that from inside a renderer recurses to stack overflow.
  queueMicrotask(() => {
    rec.invalidating = false;
    try {
      rec.invalidate?.();
    } catch {}
  });
}

// ─── pure group planner (mcode view.ts:373-497, 1171-1223) ────────────────

export interface GroupCall {
  id: string;
  name: string;
  target: string;
  meta: string;
  failed: boolean;
  running: boolean;
}

type Category = "read" | "search" | "list";

function categoryOf(name: string): Category {
  const n = name.trim().toLowerCase();
  if (n === "grep" || n === "search") return "search";
  if (n === "glob" || n === "list" || n === "list_files" || n === "ls" || n === "find") return "list";
  return "read";
}

/** mcode's read-like tools (view.ts:1171 isReadToolCell), plus our ls/find aliases. */
export function isReadLike(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "read" || n === "read_file" || n === "readfile" || n === "grep" || n === "search" ||
    n === "glob" || n === "list" || n === "list_files" || n === "ls" || n === "find";
}

export interface RowFnArgs {
  connector: "├" | "└";
  running: boolean;
  failed: boolean;
}
export type RowFn = (call: GroupCall, opts: RowFnArgs) => string;
export type SummaryFn = (args: {
  connector: "├" | "└";
  running: boolean;
  failedCount: number;
  total: number;
  opCount: number;
  actionRunning: string;
  actionDone: string;
  noun: string;
}) => string;

/**
 * mcode collapse rules (view.ts renderReadGroup/groupNoun/renderGroupAction):
 *  - consecutive read-like calls (≥2) collapse to one summary row:
 *    "Read N files" / "Searched N searches" / "Listed N paths"; mixed
 *    categories → "Explored N operations"; ` · N failed` on partial failure;
 *  - while the group is running, the summary shows finished calls so far and
 *    the live latest call keeps its own row below it;
 *  - every other call (bash, edits, failures of non-read tools…) is its own row;
 *  - connectors: `├` for every row except the group's last, which gets `└`.
 * Returns one entry per call; `row: null` = render nothing (hidden inside the summary).
 */
export function planGroupRows(calls: GroupCall[], row: RowFn, summary: SummaryFn): Array<{ id: string; row: string | null }> {
  const units: GroupCall[][] = [];
  let run: GroupCall[] = [];
  for (const c of calls) {
    if (isReadLike(c.name)) {
      run.push(c);
      continue;
    }
    if (run.length >= 2) units.push(run);
    else if (run.length === 1) units.push([run[0]!]);
    run = [];
    units.push([c]);
  }
  if (run.length >= 2) units.push(run);
  else if (run.length === 1) units.push([run[0]!]);

  const out: Array<{ id: string; row: string | null }> = [];
  units.forEach((unit, i) => {
    const anyRunning = unit.some((c) => c.running);
    const isLast = i === units.length - 1;
    const collapsed = unit.length >= 2;
    // a running group appends the live row after its summary, so the summary
    // is never the visually-last row while the group is active
    const connector: "├" | "└" = isLast && !(collapsed && anyRunning) ? "└" : "├";
    if (unit.length < 2) {
      out.push({ id: unit[0]!.id, row: row(unit[0]!, { connector, running: unit[0]!.running, failed: unit[0]!.failed }) });
      return;
    }
    const failedCount = unit.filter((c) => c.failed).length;
    const cats = new Set(unit.map((c) => categoryOf(c.name)));
    const opKeys = new Set(unit.map((c) => `${c.name}\u0000${c.target}`));
    const opCount = opKeys.size;
    const noun = cats.size > 1 ? "operations" : cats.has("search") ? "searches" : cats.has("list") ? "paths" : "files";
    const actionRunning = cats.size > 1 ? "Exploring" : cats.has("search") ? "Searching" : cats.has("list") ? "Listing" : "Reading";
    const actionDone = cats.size > 1 ? "Explored" : cats.has("search") ? "Searched" : cats.has("list") ? "Listed" : "Read";
    out.push({
      id: unit[0]!.id,
      row: summary({
        connector,
        running: anyRunning,
        failedCount,
        total: unit.length,
        opCount,
        actionRunning,
        actionDone,
        noun,
      }),
    });
    const hiddenCount = anyRunning ? unit.length - 1 : unit.length - 1;
    for (const hidden of unit.slice(1, anyRunning ? -1 : undefined)) out.push({ id: hidden.id, row: null });
    void hiddenCount;
    if (anyRunning) {
      const live = unit[unit.length - 1]!;
      out.push({ id: live.id, row: row(live, { connector: "└", running: true, failed: false }) });
    }
  });
  return out;
}

// ─── row painters ─────────────────────────────────────────────────────────

function marker(theme: Theme, running: boolean, failed: boolean): string {
  return theme.fg(failed ? "error" : running ? "accent" : "success", failed ? "×" : "•");
}

export function simpleToolLine(
  theme: Theme,
  name: string,
  target: string,
  opts: { running: boolean; failed?: boolean; meta?: string; connector?: "├" | "└"; width: number },
): string {
  const [runningVerb, doneVerb, failedVerb] = verbsFor(name);
  const verb = opts.failed ? failedVerb : opts.running ? runningVerb : doneVerb;
  const connector = theme.fg("borderMuted", `${opts.connector ?? "└"} `);
  const isShell = name === "bash" || name === "powershell";
  const tail = opts.running ? theme.fg("muted", " …") : opts.meta ? theme.fg(opts.failed ? "error" : "muted", opts.meta) : "";
  let line: string;
  if (!target) line = `${marker(theme, opts.running, !!opts.failed)} ${theme.bold(verb)}`;
  else if (isShell) line = `${marker(theme, opts.running, !!opts.failed)} ${theme.bold(verb)}  ${target}`;
  else line = `${marker(theme, opts.running, !!opts.failed)} ${theme.bold(verb)} ${theme.fg("muted", `(${target})`)}`;
  return truncateToWidth(`${connector}${line}${tail}`, Math.max(0, opts.width), theme.fg("muted", "…"));
}

/** One-line component (mcode rows never wrap; they truncate). */
class SimpleLine implements Component {
  constructor(private readonly build: (width: number) => string[]) {}
  render(width: number): string[] {
    return this.build(width).map((l) => truncateToWidth(l, Math.max(0, width), "…"));
  }
  invalidate(): void {}
}

/** Definitions already wearing the mcode wrapper (double-wrap guard). */
export const simpleWrapped = new WeakSet<object>();

/** Test hook: clear the module-level group registry. */
export function resetSimpleGroups(): void {
  byId.clear();
  currentGroup = [];
  textBreakPending = false;
}

// ─── the wrapper ──────────────────────────────────────────────────────────

function toGroupCall(rec: CallRec): GroupCall {
  return { id: rec.id, name: rec.name, target: targetArg(rec.name, rec.args, rec.cwd), meta: rec.meta, failed: rec.failed, running: rec.running };
}

export function simpleWrapTool(def: AnyTool): AnyTool {
  const renderCall = (args: any, theme: Theme, ctx: any) => {
    if (ctx.expanded && def.renderCall) return def.renderCall(args, theme, ctx);
    let rec = byId.get(ctx.toolCallId);
    if (!rec) {
      if (textBreakPending) {
        currentGroup = [];
        textBreakPending = false;
      }
      rec = { id: ctx.toolCallId, name: def.name, args: args ?? {}, cwd: ctx.cwd, running: true, done: false, failed: false, meta: "", group: currentGroup };
      byId.set(ctx.toolCallId, rec);
      currentGroup.push(rec);
      rec.invalidate = () => ctx.invalidate();
      for (const r of currentGroup) touch(r);
    }
    rec.args = args ?? rec.args;
    const group = rec.group;
    const paint = (width: number): string[] => {
      const rows = planGroupRows(
        group.map(toGroupCall),
        (call, o) =>
          simpleToolLine(theme, call.name, call.target, { running: o.running, failed: o.failed, meta: call.meta, connector: o.connector, width }),
        (s) => {
          const label = theme.bold(`${s.running ? s.actionRunning : s.actionDone} ${s.opCount} ${s.noun}`);
          const failure = s.failedCount === s.total ? theme.fg("error", " · failed") : s.failedCount > 0 ? theme.fg("error", ` · ${s.failedCount} failed`) : "";
          const attempts = s.total > s.opCount ? theme.fg("muted", ` · ${s.total} calls`) : "";
          return `${theme.fg("borderMuted", `${s.connector} `)}${marker(theme, s.running, s.failedCount === s.total)} ${label}${failure}${attempts}`;
        },
      );
      const mine = rows.find((r) => r.id === rec!.id);
      return mine?.row ? [mine.row] : [];
    };
    return new SimpleLine(paint);
  };

  const renderResult = (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    ctx: any,
  ) => {
    try {
      if (options.expanded && def.renderResult) return def.renderResult(result, options, theme, ctx);
      const rec = byId.get(ctx.toolCallId);
      if (rec) {
        rec.invalidate = () => ctx.invalidate();
        const meta = outputMeta(result);
        const changed = !rec.done || rec.meta !== meta || rec.failed !== ctx.isError;
        rec.meta = meta;
        rec.failed = !!ctx.isError;
        rec.running = !!options.isPartial;
        if (!options.isPartial) rec.done = true;
        if (changed && !options.isPartial) for (const r of rec.group) touch(r);
      }
      return new SimpleLine(() => []);
    } catch {
      // fall through to pi's generic result rendering rather than crash the row
      return new SimpleLine(() => []);
    }
  };

  const wrapped = { ...def, renderShell: "self" as const, renderCall, renderResult };
  simpleWrapped.add(wrapped);
  return wrapped;
}
