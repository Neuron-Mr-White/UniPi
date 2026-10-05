/**
 * @pi-unipi/utility — response formatting: renderers for pi's built-in tools
 *
 * The built-in read/bash/edit/write tools are re-registered with pi's own
 * definitions (same name, description, schema and execute — the model sees
 * exactly the same tools) and only their rendering changes:
 *
 *   simple   — one collapsed line per tool (`▪ Ran  npm test · 56 output lines`);
 *              Ctrl+O expands the output
 *   advanced — `◆ Ran command` with the command syntax-highlighted (embedded
 *              python/js/sql in heredocs and -c/-e highlighted as that language),
 *              the output tail, test-run summaries, pretty JSON and an exit line;
 *              edits as a syntax-highlighted diff with line numbers and tinted
 *              added/removed lines; writes and reads highlighted by file type
 */

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getLanguageFromPath,
  highlightCode,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { createDetachableBashOperations, withDetachableBash } from "@pi-unipi/core";
import { asJson, diffStats, exitCode, parseDiff, splitCommand, stripStatus, testSummary } from "./parse.js";
import { simpleWrapTool } from "./simple.js";
import { withHarnessToolAnnotations } from "./harness.js";
import { readPiToolOptions, type PiToolOptions } from "./pi-settings.js";

export type RenderStyle = "simple" | "regular" | "advanced";

const COMMAND_LINES = 14;
const OUTPUT_TAIL = 10;
const DIFF_ROWS = 28;
const WRITE_LINES = 12;
const READ_LINES = 200;

type State = { t0?: number; t1?: number; meta?: string; bad?: boolean };

class Lines implements Component {
  constructor(private readonly build: (width: number) => string[], private readonly wrap = false) {}
  render(width: number): string[] {
    const out: string[] = [];
    for (const line of this.build(width)) {
      if (this.wrap && visibleWidth(line) > width) out.push(...wrapTextWithAnsi(line, width));
      else out.push(truncateToWidth(line, width, "…"));
    }
    return out;
  }
  invalidate(): void {}
}

function shortPath(p: string, cwd: string): string {
  if (!p) return "";
  const abs = isAbsolute(p) ? p : `${cwd}/${p}`;
  const rel = relative(cwd, abs);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return `./${rel}`;
  const home = homedir();
  return abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function highlight(code: string, lang: string | undefined): string[] {
  if (!lang || lang === "text") return code.split("\n");
  try {
    return highlightCode(code, lang);
  } catch {
    return code.split("\n");
  }
}

/** Command → highlighted lines, embedded code in its own language. */
export function highlightCommand(command: string): string[] {
  let joined = "";
  for (const seg of splitCommand(command)) {
    const lines = highlight(seg.text, seg.kind === "code" ? seg.lang : "bash");
    joined += lines.join("\n");
  }
  return joined.replace(/\n$/, "").split("\n");
}

function elapsed(state: State): string {
  if (!state.t0) return "";
  const ms = (state.t1 ?? Date.now()) - state.t0;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function track(state: State, started: boolean): void {
  if (started && !state.t0) state.t0 = Date.now();
}

// ─── simple ───────────────────────────────────────────────────────────────

function simpleLine(theme: Theme, verb: string, arg: string, state: State, running: boolean): string {
  const mark = running ? theme.fg("muted", "▪") : state.bad ? theme.fg("error", "▪") : theme.fg("accent", "▪");
  const meta = state.meta ? theme.fg(state.bad ? "error" : "muted", ` · ${state.meta}`) : running ? theme.fg("muted", " …") : "";
  return `${mark} ${theme.bold(verb.padEnd(6))} ${arg}${meta}`;
}

function outputBlock(theme: Theme, text: string): string[] {
  return text.split("\n").map((l) => `  ${theme.fg("borderMuted", "│")} ${theme.fg("toolOutput", l)}`);
}

// ─── advanced ─────────────────────────────────────────────────────────────

function header(theme: Theme, title: string, detail: string, running: boolean, bad: boolean): string {
  const glyph = theme.fg(running ? "muted" : bad ? "error" : "accent", "◆");
  return `${glyph} ${theme.bold(title)}${detail ? ` ${theme.fg("accent", detail)}` : ""}`;
}

function gutter(theme: Theme, line: string): string {
  return `${theme.fg("borderMuted", "│")} ${line}`;
}

/**
 * Full-width background that survives the highlighter's own resets: the bg
 * code is re-applied after every SGR reset inside the line.
 */
export function tint(theme: Theme, bg: "toolSuccessBg" | "toolErrorBg", line: string, width: number): string {
  const probe = theme.bg(bg, "\u0000");
  const [open = "", close = ""] = probe.split("\u0000");
  const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
  return `${open}${line.replace(/\x1b\[0?m/g, (m) => `${m}${open}`)}${pad}${close}`;
}

function diffLines(theme: Theme, diff: string, path: string, expanded: boolean, width: number): string[] {
  const rows = parseDiff(diff);
  const lang = getLanguageFromPath(path);
  const numW = Math.max(3, ...rows.map((r) => String(r.line ?? "").length));
  const shown = expanded ? rows : rows.slice(0, DIFF_ROWS);
  const out = shown.map((r) => {
    if (r.kind === "gap") return theme.fg("borderMuted", `${" ".repeat(numW)} ┆`);
    const code = highlight(r.text, lang)[0] ?? r.text;
    const num = theme.fg("muted", String(r.line ?? "").padStart(numW));
    const sign = r.kind === "add" ? theme.fg("toolDiffAdded", "+") : r.kind === "del" ? theme.fg("toolDiffRemoved", "-") : " ";
    const line = `${num} ${sign} ${code}`;
    if (r.kind === "ctx") return line;
    return tint(theme, r.kind === "add" ? "toolSuccessBg" : "toolErrorBg", line, width);
  });
  if (shown.length < rows.length) out.push(theme.fg("muted", `${" ".repeat(numW)}   … ${rows.length - shown.length} more lines (ctrl+o)`));
  return out;
}

function numbered(theme: Theme, lines: readonly string[], start = 1): string[] {
  const w = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${theme.fg("muted", String(start + i).padStart(w))}  ${l}`);
}

// ─── the overrides ────────────────────────────────────────────────────────

type AnyDef = ToolDefinition<any, any, any>;

/**
 * `opts.bash` merged with detachable-bash operations: the watchdog (if
 * present) can move a stuck command to the background without unipi owning
 * or depending on it — `operations` is the only field it ever needs to add.
 * commandPrefix/shellPath/spawnHook (and any other BashToolOptions field)
 * pass through unchanged.
 */
function detachableBashOpts(bash: PiToolOptions["bash"]): PiToolOptions["bash"] & { operations: ReturnType<typeof createDetachableBashOperations> } {
  return { ...bash, operations: createDetachableBashOperations(bash) };
}

/** `createBashToolDefinition` + detachable-bash operations/execute wrapping, in one call. */
function createDetachableBashToolDefinition(cwd: string, bash: PiToolOptions["bash"]): AnyDef {
  const definition = withDetachableBash(createBashToolDefinition(cwd, detachableBashOpts(bash)) as AnyDef);
  const original = definition.renderResult;
  return { ...definition, renderResult: (res, options, theme, context) => {
    const id = (res.details as { detachedToTask?: string } | undefined)?.detachedToTask;
    if (!id) return original?.(res, options, theme, context);
    return new Lines((width) => [...outputBlock(theme, textOf(res as never)), theme.fg("accent", `→ background task ${id}`)]
      .map(line => truncateToWidth(line, width, "…")));
  } } as AnyDef;
}

function withDefinition(name: string, make: (cwd: string) => AnyDef, style: RenderStyle): AnyDef {
  const cache = new Map<string, AnyDef>();
  const def = (cwd: string) => {
    let d = cache.get(cwd);
    if (!d) {
      d = make(cwd);
      cache.set(cwd, d);
    }
    return d;
  };
  const base = def(process.cwd());
  const r = renderers(name, style, def);
  const built = {
    name: base.name,
    label: base.label,
    description: base.description,
    ...(base.promptSnippet ? { promptSnippet: base.promptSnippet } : {}),
    ...(base.promptGuidelines ? { promptGuidelines: base.promptGuidelines } : {}),
    parameters: base.parameters,
    ...(base.prepareArguments ? { prepareArguments: base.prepareArguments } : {}),
    ...(base.executionMode ? { executionMode: base.executionMode } : {}),
    renderShell: "self",
    execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) =>
      def(ctx !== null && typeof ctx === "object" && "cwd" in ctx ? (ctx as { cwd?: string }).cwd ?? process.cwd() : process.cwd())
        .execute(id, params as never, signal, onUpdate as never, ctx as never),
    renderCall: r.call,
    renderResult: r.result,
  } as AnyDef;
  return withHarnessToolAnnotations(built) as unknown as AnyDef;
}

function renderers(name: string, style: RenderStyle, def: (cwd: string) => AnyDef) {
  const simple = style === "simple";
  const call: AnyDef["renderCall"] = (args, theme, context) => {
    const state = context.state as State;
    track(state, context.executionStarted);
    const running = () => !state.t1;
    const cwd = context.cwd ?? process.cwd();
    const a = args as Record<string, unknown>;
    if (name === "bash") {
      const command = String(a.command ?? "");
      if (simple) {
        return new Lines(() => [simpleLine(theme, "Ran", highlightCommand(command.split("\n")[0] ?? "")[0] ?? "", state, running())]);
      }
      return new Lines(() => {
        const lines = highlightCommand(command);
        const shown = context.expanded ? lines : lines.slice(0, COMMAND_LINES);
        const out = [header(theme, running() ? "Running command" : "Ran command", "", running(), !!state.bad)];
        shown.forEach((l, i) => out.push(gutter(theme, `${i === 0 ? theme.fg("muted", "$ ") : "  "}${l}`)));
        if (shown.length < lines.length) out.push(gutter(theme, theme.fg("muted", `  … ${lines.length - shown.length} more lines (ctrl+o)`)));
        return out;
      }, true);
    }
    const path = shortPath(String(a.path ?? a.file_path ?? ""), cwd);
    const verb = () => ({ read: "Read", edit: running() ? "Editing" : "Edited", write: running() ? "Writing" : "Wrote" })[name] ?? name;
    const range = name === "read" && (a.offset || a.limit)
      ? ` (L${Number(a.offset ?? 1)}${a.limit ? `–${Number(a.offset ?? 1) + Number(a.limit) - 1}` : "+"})`
      : "";
    if (simple) return new Lines(() => [simpleLine(theme, name === "read" ? "Read" : name === "edit" ? "Edited" : "Wrote", `${theme.fg("accent", path)}${theme.fg("muted", range)}`, state, running())]);
    return new Lines(() => [header(theme, verb(), `${path}${range}`, running(), !!state.bad) + (state.meta ? theme.fg(state.bad ? "error" : "muted", ` · ${state.meta}`) : "")]);
  };

  const result: AnyDef["renderResult"] = (res, options, theme, context) => {
    const state = context.state as State;
    const partial = options.isPartial;
    if (!partial && !state.t1) state.t1 = Date.now();
    const bad = context.isError;
    state.bad = bad;
    const text = textOf(res as never);
    const a = context.args as Record<string, unknown>;
    const cwd = context.cwd ?? process.cwd();

    // Anything we don't format (read images, unexpected shapes) → pi's own.
    const hasImage = (res as { content?: Array<{ type: string }> }).content?.some((c) => c.type === "image");
    if (hasImage) {
      const original = def(cwd).renderResult;
      if (original) return original(res, options, theme, context);
    }

    if (name === "bash") {
      const detached = (res.details as { detachedToTask?: string } | undefined)?.detachedToTask;
      const output = stripStatus(text);
      const code = partial ? undefined : exitCode(text, bad);
      const count = output ? output.split("\n").length : 0;
      const tests = partial ? undefined : testSummary(output);
      if (simple) {
        state.meta = detached ? `→ background task ${detached}` : partial ? "" : [
          code && code !== 0 ? `exit ${code}` : code === undefined && !partial ? "stopped" : "",
          `${count} output line${count === 1 ? "" : "s"}`,
          tests ? `${tests.passed} passed${tests.failed ? `, ${tests.failed} failed` : ""}` : "",
        ].filter(Boolean).join(" · ");
        return new Lines(() => (options.expanded && output ? outputBlock(theme, output) : []));
      }
      return new Lines((width) => {
        const json = asJson(output);
        const lines = json ? highlight(json, "json") : output ? output.split("\n").map((l) => theme.fg("toolOutput", l)) : [];
        const shown = options.expanded ? lines : lines.slice(-OUTPUT_TAIL);
        const out: string[] = [];
        if (shown.length < lines.length) out.push(gutter(theme, theme.fg("muted", `… ${lines.length - shown.length} earlier lines (ctrl+o)`)));
        out.push(...shown.map((l) => gutter(theme, l)));
        if (tests) out.push(gutter(theme, theme.fg(tests.failed ? "error" : "success", `${tests.failed ? "✗" : "✓"} ${tests.passed} passed · ${tests.failed} failed`)));
        if (!partial) {
          const status = detached ? `→ background task ${detached}` : code === undefined ? "Stopped" : `Exited with code ${code}`;
          out.push(`${theme.fg("borderMuted", "└")} ${theme.fg(detached ? "accent" : code === 0 ? "success" : "error", status)}${detached ? "" : theme.fg("muted", ` · ${elapsed(state)}`)}`);
        }
        return out.map((l) => truncateToWidth(l, width, "…"));
      }, true);
    }

    const path = String(a.path ?? a.file_path ?? "");
    if (bad) {
      state.meta = "failed";
      return new Lines(() => (simple && !options.expanded ? [] : text.split("\n").map((l) => `  ${theme.fg("error", l)}`)), true);
    }

    if (name === "edit") {
      const diff = String((res as { details?: { diff?: string } }).details?.diff ?? "");
      const stats = diffStats(parseDiff(diff));
      state.meta = `+${stats.added} -${stats.removed}`;
      if (simple) return new Lines((w) => (options.expanded ? diffLines(theme, diff, path, true, w - 2).map((l) => `  ${l}`) : []));
      return new Lines((w) => diffLines(theme, diff, path, options.expanded, w));
    }

    if (name === "write") {
      const content = String(a.content ?? "");
      const lines = content.split("\n");
      state.meta = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
      if (simple && !options.expanded) return new Lines(() => []);
      return new Lines(() => {
        const hl = highlight(content, getLanguageFromPath(path));
        const shown = options.expanded ? hl : hl.slice(0, WRITE_LINES);
        const out = numbered(theme, shown).map((l) => gutter(theme, l));
        if (shown.length < hl.length) out.push(gutter(theme, theme.fg("muted", `… ${hl.length - shown.length} more lines (ctrl+o)`)));
        return out;
      });
    }

    // read
    const lines = text.split("\n");
    state.meta = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
    if (!options.expanded) return new Lines(() => []);
    return new Lines(() => {
      const hl = highlight(lines.slice(0, READ_LINES).join("\n"), getLanguageFromPath(shortPath(path, cwd)));
      const out = numbered(theme, hl, Number(a.offset ?? 1)).map((l) => gutter(theme, l));
      if (lines.length > READ_LINES) out.push(gutter(theme, theme.fg("muted", `… ${lines.length - READ_LINES} more lines`)));
      return out;
    });
  };

  return { call, result };
}

/** Re-register the built-in tools with styled renderers ("regular" = pi's own, untouched). */
export function registerToolRenderers(pi: ExtensionAPI, style: RenderStyle): void {
  const opts = readPiToolOptions(process.cwd());
  if (style === "regular") {
    // REGULAR style: native factories (renderCall/renderResult/renderShell kept
    // as-is), wrapped for harness annotations. NOT the advanced withDefinition
    // renderer — regular keeps pi's native tool cards.
    const cwd = process.cwd();
    for (const make of [createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]) {
      pi.registerTool(withHarnessToolAnnotations(make(cwd) as AnyDef));
    }
    pi.registerTool(withHarnessToolAnnotations(createReadToolDefinition(cwd, opts.read) as AnyDef));
    pi.registerTool(withHarnessToolAnnotations(createDetachableBashToolDefinition(cwd, opts.bash)));
    pi.registerTool(withHarnessToolAnnotations(createEditToolDefinition(cwd) as AnyDef));
    pi.registerTool(withHarnessToolAnnotations(createWriteToolDefinition(cwd) as AnyDef));
    return;
  }
  if (style === "simple") {
    // mcode look: every tool is wrapped to a collapsed one-liner by the unipi
    // entry (see simple.ts); register the core search/list tools unipi does
    // not already own here. read/bash/edit/write are handled there too.
    const cwd = process.cwd();
    for (const make of [createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]) {
      pi.registerTool(simpleWrapTool(make(cwd) as AnyDef));
    }
    // read/edit/write keep their (advanced) expanded renderers via withDefinition;
    // the collapsed row is overridden by the mcode wrapper in the unipi entry.
    pi.registerTool(simpleWrapTool(withDefinition("read", (c) => createReadToolDefinition(c, opts.read) as AnyDef, "advanced")));
    pi.registerTool(simpleWrapTool(withDefinition("bash", (c) => createDetachableBashToolDefinition(c, opts.bash), "advanced")));
    pi.registerTool(simpleWrapTool(withDefinition("edit", (c) => createEditToolDefinition(c) as AnyDef, "advanced")));
    pi.registerTool(simpleWrapTool(withDefinition("write", (c) => createWriteToolDefinition(c) as AnyDef, "advanced")));
    return;
  }
  pi.registerTool(withDefinition("read", (cwd) => createReadToolDefinition(cwd, opts.read) as AnyDef, style));
  pi.registerTool(withDefinition("bash", (cwd) => createDetachableBashToolDefinition(cwd, opts.bash), style));
  pi.registerTool(withDefinition("edit", (cwd) => createEditToolDefinition(cwd) as AnyDef, style));
  pi.registerTool(withDefinition("write", (cwd) => createWriteToolDefinition(cwd) as AnyDef, style));
}
