#!/usr/bin/env -S npx tsx
// UNI-2 DESIGN MOCKUP — sidekick rail preview (standalone, deterministic).
//
// Shows what the fusion sidekick transcript WOULD look like with the UNI-2
// rail design: ONE outer dark-cyan panel fill (#12363b) plus a bright cyan
// ▏ rail (#22d3ee) on every panel line, instead of today's nested per-card
// backgrounds (the strips + unpainted gaps in the screenshot). This is NOT
// the live renderer and makes no claim about the live renderer's internals:
// no pi session, no LLM, no commands executed, no settings writes. Frozen
// fixtures are rendered through the production functions:
//
//   simple/advanced   styledToolCallLines / styledTextLines (render/styled.ts)
//   regular           nativeToolComponent (pi's real card, raw args);
//                     steps without raw args fall back to styledToolCallLines
//   painting          nested background SGR stripped, then ONE outer fill via
//                     paintLine (render/reply-bg.ts); grouping per spacing.ts
//
//   npx tsx scripts/sidekick-preview.ts                 # static print, all styles+states
//   npx tsx scripts/sidekick-preview.ts --interactive   # TUI browser
//   npx tsx scripts/sidekick-preview.ts --help
import { type Component, matchesKey, ProcessTerminal, TuiMainScreen, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeToolComponent, styledTextLines, styledToolCallLines, type RenderStyle } from "../packages/utility/src/render/styled.ts";
import { dividerLine, paintLine, replyBg, trimEdgeBlankLines } from "../packages/utility/src/render/reply-bg.ts";
import { renderDelegatedStep, type DelegatedStep } from "../packages/utility/src/render/delegated.ts";
import { patchTranscriptSpacing } from "../packages/utility/src/render/spacing.ts";

// ── Pi theme (in-memory cyan variant; no settings touched) ─────────────────
// getMarkdownTheme() and the native regular cards read the global theme, so a
// Theme instance is installed via setThemeInstance — the same hook pi's HTML
// export uses. Every bg key is pinned to the panel colour so any nested
// background that escapes is invisible; they are stripped anyway.
const PI_PANEL = "#12363b";
const PI_RAIL = "#22d3ee";
const PI_TEXT = "#e8f4f4";
const PI_MUTED = "#86b0b5";
const PI_DIM = "#5f8a8f";
const PI_ERROR = "#ff6b6b";

const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/theme/theme.js")).href)) as {
  Theme: new (
    fgColors: Record<string, string | number>,
    bgColors: Record<string, string | number>,
    mode: "truecolor" | "256color",
    options?: { name?: string },
  ) => ThemeApi;
  setThemeInstance: (t: ThemeApi) => void;
};
interface ThemeApi {
  fg(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi(key: string): string;
}
const theme = new themeMod.Theme(
  {
    accent: PI_RAIL, bashMode: PI_RAIL, border: PI_RAIL, borderAccent: PI_RAIL, borderMuted: PI_DIM,
    customMessageLabel: PI_RAIL, customMessageText: PI_TEXT, dim: PI_DIM, error: PI_ERROR,
    mdCode: PI_TEXT, mdCodeBlock: PI_TEXT, mdCodeBlockBorder: PI_RAIL, mdHeading: PI_RAIL, mdHr: PI_DIM,
    mdLink: PI_RAIL, mdLinkUrl: PI_RAIL, mdListBullet: PI_RAIL, mdQuote: PI_TEXT, mdQuoteBorder: PI_RAIL,
    muted: PI_MUTED, success: PI_RAIL, syntaxComment: PI_DIM, syntaxFunction: PI_TEXT, syntaxKeyword: PI_RAIL,
    syntaxNumber: PI_TEXT, syntaxOperator: PI_TEXT, syntaxPunctuation: PI_MUTED, syntaxString: PI_TEXT, syntaxType: PI_TEXT, syntaxVariable: PI_TEXT,
    text: PI_TEXT, thinkingHigh: PI_MUTED, thinkingLow: PI_DIM, thinkingMinimal: PI_DIM, thinkingOff: PI_DIM,
    thinkingText: PI_MUTED, thinkingXhigh: PI_MUTED, toolDiffAdded: PI_TEXT, toolDiffContext: PI_MUTED, toolDiffRemoved: PI_ERROR,
    toolOutput: PI_TEXT, toolTitle: PI_RAIL, userMessageText: PI_TEXT, warning: "#fbbf24",
  },
  {
    selectedBg: PI_PANEL, userMessageBg: PI_PANEL, customMessageBg: PI_PANEL,
    toolPendingBg: PI_PANEL, toolSuccessBg: PI_PANEL, toolErrorBg: PI_PANEL,
  },
  "truecolor",
  { name: "uni-2-preview" },
);
themeMod.setThemeInstance(theme);

/**
 * Lead-agent theme for the mixed scenario: same cyan fg semantics, but neutral
 * #1f2430 backgrounds so the LEAD's ordinary tool cards (regular style) read
 * like any transcript tool call — native backgrounds kept, not stripped —
 * while the delegated SUBAGENT panel keeps the approved cyan fill. Installed
 * only around synchronous lead renders, then the cyan theme is restored. No
 * settings are touched.
 */
const LEAD_BG = "#1f2430";
const leadTheme = new themeMod.Theme(
  {
    accent: PI_RAIL, bashMode: PI_RAIL, border: PI_RAIL, borderAccent: PI_RAIL, borderMuted: PI_DIM,
    customMessageLabel: PI_RAIL, customMessageText: PI_TEXT, dim: PI_DIM, error: PI_ERROR,
    mdCode: PI_TEXT, mdCodeBlock: PI_TEXT, mdCodeBlockBorder: PI_RAIL, mdHeading: PI_RAIL, mdHr: PI_DIM,
    mdLink: PI_RAIL, mdLinkUrl: PI_RAIL, mdListBullet: PI_RAIL, mdQuote: PI_TEXT, mdQuoteBorder: PI_RAIL,
    muted: PI_MUTED, success: PI_RAIL, syntaxComment: PI_DIM, syntaxFunction: PI_TEXT, syntaxKeyword: PI_RAIL,
    syntaxNumber: PI_TEXT, syntaxOperator: PI_TEXT, syntaxPunctuation: PI_MUTED, syntaxString: PI_TEXT, syntaxType: PI_TEXT, syntaxVariable: PI_TEXT,
    text: PI_TEXT, thinkingHigh: PI_MUTED, thinkingLow: PI_DIM, thinkingMinimal: PI_DIM, thinkingOff: PI_DIM,
    thinkingText: PI_MUTED, thinkingXhigh: PI_MUTED, toolDiffAdded: PI_TEXT, toolDiffContext: PI_MUTED, toolDiffRemoved: PI_ERROR,
    toolOutput: PI_TEXT, toolTitle: PI_RAIL, userMessageText: PI_TEXT, warning: "#fbbf24",
  },
  {
    selectedBg: LEAD_BG, userMessageBg: LEAD_BG, customMessageBg: LEAD_BG,
    toolPendingBg: LEAD_BG, toolSuccessBg: LEAD_BG, toolErrorBg: LEAD_BG,
  },
  "truecolor",
  { name: "uni-2-preview-lead" },
);
function withLeadTheme<T>(fn: () => T): T {
  themeMod.setThemeInstance(leadTheme);
  try {
    return fn();
  } finally {
    themeMod.setThemeInstance(theme);
  }
}

// ── the UNI-2 paint: strip nested bg, then ONE outer fill + cyan rail ──────
const PANEL_BG = "\x1b[48;2;18;54;59m"; // #12363b
const RAIL_FG = "\x1b[38;2;34;211;238m"; // #22d3ee
const RAIL = "▏ ";

/**
 * Drop every background SGR inside a rendered line (truecolor, 256 and
 * 8-colour backgrounds, plus bg resets) so the outer fill is the only
 * background. Extended fg sequences (38;2;r;g;b / 38;5;n) are walked whole so
 * their colour components can't be mistaken for bg params; non-background
 * params in a combined sequence survive.
 */
export function stripNestedBackgrounds(line: string): string {
  return line.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
    if (params === "") return "\x1b[0m";
    const parts = params.split(";");
    const keep: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i] || "0");
      if (n === 38 || n === 48) {
        // extended fg/bg: consume 38/48;2;r;g;b or 38/48;5;n atomically
        const sub = Number(parts[i + 1]);
        const span = sub === 2 ? 5 : sub === 5 ? 3 : 1;
        const seq2 = parts.slice(i, i + span).join(";");
        i += span - 1;
        if (n === 38) keep.push(seq2);
        continue;
      }
      if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) continue;
      keep.push(parts[i]!);
    }
    return keep.length > 0 ? `\x1b[${keep.join(";")}m` : "";
  });
}

/** One rail-painted panel row: cyan ▏ + content on the outer fill, padded. */
export function paintPanelLine(line: string, width: number): string {
  return paintLine(`${RAIL_FG}${RAIL}\x1b[39m${stripNestedBackgrounds(line)}`, width, PANEL_BG);
}

// ── frozen fixtures (identical across every style and state) ───────────────
export type Step =
  | { kind: "tool"; name: string; arg: string; output: string; isError: boolean; durationMs: number; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

const LS_OUT = [
  "CHANGELOG.md", "FOOTER_CUSTOMIZATION.md", "LICENSE", "README.md", "crates", "docs", "mise.toml",
  "node_modules", "package-lock.json", "package.json", "packages", "scripts", "tests", "tsconfig.json", ".gitignore",
].join("\n");
const GIT_LOG_OUT = [
  "cfe5fb1 utility(simple render): fix alpha.18 OOM — pinned duration stays out of rec.meta",
  "9c2661a release 3.0.0-alpha.18",
  "4c7f45b compactor: remove /unipi:compact-jev and the jev compaction method (UNI-13)",
].join("\n");
const PKG_OUT = [
  "{",
  '  "name": "unipi",',
  '  "private": true,',
  '  "version": "3.0.0-alpha.18",',
  '  "type": "module",',
  '  "workspaces": [',
  '    "packages/*",',
  '    "crates/*"',
  "  ],",
  '  "scripts": {',
  '    "build": "npm run build --workspaces --if-present",',
  '    "test": "npx tsx --test tests/*.test.js",',
  '    "tui:gallery": "npx tsx scripts/tui-gallery/index.ts"',
  "  },",
  '  "engines": {',
  '    "node": ">=24"',
  "  },",
  '  "dependencies": {',
  '    "@earendil-works/pi-coding-agent": "*",',
  '    "typescript": "^5"',
  "  }",
  "}",
].join("\n");
const ERROR_OUT = [
  "> unipi@3.0.0-alpha.18 build",
  "> tsc --build tsconfig.json",
  "",
  "src/preview.ts:42:7 - error TS2307: Cannot find module './missing-helper.js'.",
  "Found 1 error in src/preview.ts:42",
].join("\n");
const CJK_OUT = [
  "docs/ja/README.md:1:ユニピ — コーディングエージェント拡張コレクション",
  "docs/ja/README.md:2:サイドキックの提案はリードエージェントだけがユーザーに伝えます。この行は意図的に長くして幅の切り詰み（CJK の文字幅と ANSI エスケープの混在）を確認します。追加の文も続きます。界界界界界界界界界界",
  "docs/ja/README.md:3:see-also: the ascii tail below is 120 columns wide to exercise truncation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────>",
].join("\n");

const HANDOFF_SCAN: Step[] = [
  { kind: "tool", name: "bash", arg: "pwd && ls", output: LS_OUT, isError: false, durationMs: 140, args: { command: "pwd && ls" } },
  { kind: "tool", name: "bash", arg: "git log -3 --oneline", output: GIT_LOG_OUT, isError: false, durationMs: 12, args: { command: "git log -3 --oneline" } },
  { kind: "tool", name: "bash", arg: "git status --short --branch", output: "## main...origin/main\n", isError: false, durationMs: 13, args: { command: "git status --short --branch" } },
  { kind: "tool", name: "read", arg: "package.json", output: PKG_OUT, isError: false, durationMs: 13, args: { path: "package.json" } },
  {
    kind: "text",
    text: "Scanned the fixture repo — tree is clean, no local edits. The mockup repaints the whole sidekick block with one cyan fill and a cyan rail.",
  },
];

const HANDOFF_FIX: Step[] = [
  { kind: "tool", name: "bash", arg: "npm run build", output: ERROR_OUT, isError: true, durationMs: 3200, args: { command: "npm run build" } },
  { kind: "tool", name: "bash", arg: "grep -n サイドキック docs/ja/README.md", output: CJK_OUT, isError: false, durationMs: 41, args: { command: "grep -n サイドキック docs/ja/README.md" } },
  {
    kind: "text",
    text: "Preview uses one cyan fill across every row — mockup only, **no live renderer change** in this task.",
  },
];

export interface Handoff { title: string; steps: Step[] }
export const HANDOFFS: Handoff[] = [
  { title: "handoff #1 · repo scan", steps: HANDOFF_SCAN },
  { title: "handoff #2 · build fix", steps: HANDOFF_FIX },
];

// ── session states ─────────────────────────────────────────────────────────
// onStep appends the sidekick-step entries in BOTH attach modes, so the
// transcript below is the same recorded fixture everywhere; the states differ
// in chrome only. The wake widget exists only when the sidekick is busy AND
// the lead is idle (attached means the lead is waiting, so no wake line).
export type State = "attached" | "background" | "completed" | "legacy" | "failed";
export const STATES: State[] = ["attached", "background", "completed", "legacy", "failed"];
export const STYLES: RenderStyle[] = ["regular", "advanced", "simple"];

const BADGE: Record<State, { label: string; error?: boolean }> = {
  attached: { label: "attached · lead waiting (foreground)" },
  background: { label: "detached · running in background — fixture transcript, not live streaming" },
  completed: { label: "completed · handoff returned" },
  legacy: { label: "resumed legacy · no raw args → regular fallback" },
  failed: { label: "failed · step errored", error: true },
};

const FOOTER: Record<State, { text: string; error?: boolean }> = {
  attached: { text: "└ Running · 12.0s (fixture)" },
  background: { text: "└ Detached · sidekick keeps working (fixture)" },
  completed: { text: "└ Completed · 34.0s" },
  legacy: { text: "└ Replayed from session · raw args missing" },
  failed: { text: "└ Failed · build error", error: true },
};

/** The one-line wake widget (fusion index.ts sidekickWakeText format); frozen. */
export const WAKE_LINE = "sidekick working · 9 tool calls · 12.0s — resumes automatically when done";

// ── rendering one handoff through the production functions ────────────────
function stepLines(step: Step, style: RenderStyle, expanded: boolean, connector: "├" | "└", width: number, legacy: boolean): { lines: string[]; fallback?: boolean } {
  if (step.kind === "text") {
    return { lines: styledTextLines(style, step.text, {}, theme, width) };
  }
  if (style !== "regular" || legacy || step.args === undefined) {
    const lines = styledToolCallLines(style, {
      name: step.name,
      arg: step.arg,
      output: step.output,
      isError: step.isError,
      expanded,
      durationMs: step.durationMs,
      connector: style === "simple" ? connector : undefined,
    }, theme, width);
    return { lines, fallback: style === "regular" };
  }
  const comp = nativeToolComponent({
    name: step.name,
    args: step.args,
    output: step.output,
    isError: step.isError,
    expanded,
  });
  if (comp === undefined) {
    const lines = styledToolCallLines("regular", {
      name: step.name, arg: step.arg, output: step.output, isError: step.isError, expanded, durationMs: step.durationMs,
    }, theme, width);
    return { lines, fallback: true };
  }
  return { lines: trimEdgeBlankLines(comp.render(width)).map(annotateExpandHint) };
}

/**
 * The standalone preview has no keybinding table, so pi's native collapsed
 * card prints an empty key name ("(10 earlier lines,  to expand)"). Reword it
 * for the mockup only — the native renderer itself is untouched.
 */
function annotateExpandHint(line: string): string {
  return line.replace(/,(?:\x1b\[[0-9;]*m| )+to expand(?:\x1b\[[0-9;]*m)*\)/u, "; press e to expand in the browser, or --expand)");
}

/** Connector per spacing.ts group semantics: a tool followed by another tool gets ├. */
function connectorFor(steps: Step[], i: number): "├" | "└" {
  return steps[i + 1]?.kind === "tool" ? "├" : "└";
}

export interface Panel { title: string; lines: string[]; fallbackUsed: boolean }

/** One handoff as a rail-painted panel: header, steps, painted blanks, footer. */
export function renderHandoff(handoff: Handoff, state: State, style: RenderStyle, expanded: boolean, width: number): Panel {
  const inner = Math.max(8, width - visibleWidth(RAIL));
  const badge = BADGE[state];
  const mark = badge.error ? `${theme.fg("error", "✗")}` : `${theme.fg("accent", "◆")}`;
  const lines: string[] = [
    `${mark} ${theme.fg("accent", theme.bold("UNI-2 DESIGN MOCKUP"))} ${theme.fg("dim", `· ${handoff.title}`)} ${theme.fg(badge.error ? "error" : "muted", `· ${badge.label}`)}`,
  ];
  let fallbackUsed = false;
  const tools = handoff.steps;
  for (let i = 0; i < tools.length; i++) {
    const step = tools[i]!;
    if (i > 0 && step.kind === "text") lines.push(""); // one rail-painted blank before prose
    const r = stepLines(step, style, expanded, connectorFor(tools, i), inner, state === "legacy");
    if (r.fallback) fallbackUsed = true;
    lines.push(...r.lines);
  }
  const footer = FOOTER[state];
  lines.push(theme.fg(footer.error ? "error" : "dim", footer.text));
  return { title: handoff.title, lines: lines.map((l) => truncateToWidth(l, inner)), fallbackUsed };
}

export interface RenderedState { panels: Panel[]; wake: string | undefined }

/** Both handoffs for one session state; the wake widget only exists detached. */
export function renderState(state: State, style: RenderStyle, opts: { width: number; expanded?: boolean }): RenderedState {
  const panels = HANDOFFS.map((h) => renderHandoff(h, state, style, opts.expanded === true, opts.width));
  return { panels, wake: state === "background" ? WAKE_LINE : undefined };
}

/** Print one rendered state: panels joined with real (unpainted) gaps. */
export function stateLines(r: RenderedState, width: number): string[] {
  const out: string[] = [];
  r.panels.forEach((p, i) => {
    if (i > 0) out.push("");
    for (const l of p.lines) out.push(paintPanelLine(l, width));
  });
  return out;
}

// ── mixed scenario (UNI-47): lead + delegated sidekick, chronological ─────
// A PROPOSED transcript-layout mockup: a lead doing its own tool calls while a
// delegated sidekick's work streams into the same transcript as one cyan
// panel. Generic subagents today render as cards + dock
// (packages/subagents/src/cards.ts, ui.ts) — this fixture makes no claim that
// they already stream into the main transcript.
export type Scenario = "sidekick" | "mixed";
export const SCENARIOS: Scenario[] = ["sidekick", "mixed"];

const NPM_TEST_OUT = [
  "> unipi@3.0.0-alpha.18 test",
  "> npx tsx --test tests/*.test.js",
  "ℹ tests 15",
  "ℹ pass 15",
  "ℹ fail 0",
].join("\n");

const LEAD_THINKING = "Demo planning text — choose a small preview fixture. (invented placeholder, not recorded reasoning)";
const SUB_THINKING = "Demo sidekick plan — read the fixture, run one check. (invented placeholder, not recorded reasoning)";
const SUB_READ_OUT = [
  "# preview fixtures",
  "",
  "Frozen demo data for the UNI-2 rail mockup. No real commands are run.",
].join("\n");
const SUB_RESULT = "Demo result — fixture verified, no issues. (invented for the mockup)";

interface MixedToolStep extends Extract<Step, { kind: "tool" }> {}
const leadRead: MixedToolStep = { kind: "tool", name: "read", arg: "package.json", output: PKG_OUT, isError: false, durationMs: 13, args: { path: "package.json" } };
const leadGitStatus: MixedToolStep = { kind: "tool", name: "bash", arg: "git status --short --branch", output: "## main...origin/main\n", isError: false, durationMs: 13, args: { command: "git status --short --branch" } };
const leadNpmTest: MixedToolStep = { kind: "tool", name: "bash", arg: "npm test", output: NPM_TEST_OUT, isError: false, durationMs: 2100, args: { command: "npm test" } };
const subRead: MixedToolStep = { kind: "tool", name: "read", arg: "docs/preview-fixtures.md", output: SUB_READ_OUT, isError: false, durationMs: 9, args: { path: "docs/preview-fixtures.md" } };
const subGitStatus: MixedToolStep = { kind: "tool", name: "bash", arg: "git status --short --branch", output: "## main...origin/main\n", isError: false, durationMs: 13, args: { command: "git status --short --branch" } };
const subGitStatusFailed: MixedToolStep = { ...subGitStatus, isError: true, output: "fatal: not a git repository (fixture error)", durationMs: 11 };

const MIXED_FOOTER: Record<State, { text: string; error?: boolean }> = {
  attached: { text: "└ Running · 6.0s (fixture)" },
  background: { text: "└ Pending · queued on the child (fixture)" },
  completed: { text: "└ Completed · 21.0s" },
  legacy: { text: "└ Replayed from session · raw args missing" },
  failed: { text: "└ Failed · subagent step errored (fixture)", error: true },
};

/** A lead tool row (style-specific, NO cyan rail/panel; regular keeps native bg). */
function leadToolLines(step: MixedToolStep, style: RenderStyle, expanded: boolean, connector: "├" | "└", width: number): string[] {
  if (style === "regular" && step.args !== undefined) {
    // Ordinary lead tool call: native card with its own (neutral lead) theme
    // backgrounds kept — the strip+repaint pass is delegated-panel only.
    return withLeadTheme(() => {
      const comp = nativeToolComponent({ name: step.name, args: step.args, output: step.output, isError: step.isError, expanded });
      if (comp === undefined) {
        return styledToolCallLines("regular", { name: step.name, arg: step.arg, output: step.output, isError: step.isError, expanded, durationMs: step.durationMs }, theme, width);
      }
      return trimEdgeBlankLines(comp.render(width)).map(annotateExpandHint);
    });
  }
  return styledToolCallLines(style, {
    name: step.name, arg: step.arg, output: step.output, isError: step.isError, expanded, durationMs: step.durationMs,
    connector: style === "simple" ? connector : undefined,
  }, theme, width);
}

/** The synthetic demo thinking block (clearly invented; never real reasoning). */
function thinkingLines(label: string, text: string, width: number): string[] {
  return [
    `${theme.fg("accent", "◆")} ${theme.fg("dim", `thinking (demo — ${label})`)}`,
    ...text.split("\n").map((l) => truncateToWidth(`${theme.fg("dim", `  ${l}`)}`, width)),
  ];
}

/** Lead-side delegation row (run_subagent via styledToolCallLines; no launch). */
function delegationLines(running: boolean, failed: boolean, legacy: boolean, width: number): string[] {
  return styledToolCallLines("simple", {
    name: "run_subagent",
    arg: legacy ? "" : "Run fixture checks",
    output: "",
    isError: failed,
    running,
    durationMs: running || failed ? undefined : 420,
    connector: "└",
  }, theme, width);
}

/** Final lead summary: simple → orange rule + black reply panel; else markdown. */
export function summaryLines(style: RenderStyle, width: number): string[] {
  const md = "Fixture summary — **all demo checks passed**. Proposed transcript-layout mockup; not a record of real reasoning or real subagent streaming.";
  const body = styledTextLines(style, md, {}, theme, width);
  if (style !== "simple") return body;
  return [
    dividerLine(theme, "summary", width),
    paintLine("", width, replyBg()),
    ...body.map((l) => paintLine(l, width, replyBg())),
    paintLine("", width, replyBg()),
    dividerLine(theme, "", width),
  ];
}

/**
 * The full mixed transcript for one state, in chronological order: user →
 * LEAD (thinking, own tools, prose, delegation) → SUBAGENT cyan panel → lead
 * npm test → summary. State variants keep the chronology coherent: background
 * stops at the pending panel (+wake), attached stops at a running panel,
 * failed ends at the failed subagent step (red), completed/legacy run to the
 * summary. Every returned row is bounded to `width`.
 */
export function mixedLines(state: State, style: RenderStyle, opts: { width: number; expanded?: boolean; thinking?: boolean }): string[] {
  const width = opts.width;
  const expanded = opts.expanded === true;
  const thinking = opts.thinking !== false;
  const out: string[] = [];
  const push = (...ls: string[]) => {
    for (const l of ls) out.push(truncateToWidth(l, width));
  };

  push(`${theme.fg("accent", "❯")} ${theme.fg("userMessageText", theme.bold("Run the fixture checks for the preview"))}`);
  push(`${theme.fg("accent", "■")} ${theme.fg("accent", theme.bold("LEAD"))} ${theme.fg("dim", "· lead agent — normal transcript, no rail")}`);
  if (thinking) push(...thinkingLines("lead planning", LEAD_THINKING, width));
  push(...leadToolLines(leadRead, style, expanded, "├", width));
  if (state !== "background") push(...leadToolLines(leadGitStatus, style, expanded, "└", width));
  push(...styledTextLines(style === "regular" ? "regular" : style, "Delegating fixture checks", {}, theme, width));

  const delegated = state !== "background";
  push(...delegationLines(!delegated, state === "failed", state === "legacy", width));

  // ── SUBAGENT: the one continuous cyan panel (approved UNI-2 paint) ──
  const badge = BADGE[state];
  push(paintPanelLine(`${theme.fg("accent", "◆")} ${theme.fg("accent", theme.bold("SUBAGENT"))} ${theme.fg("dim", "· delegated sidekick panel")} ${theme.fg(badge.error ? "error" : "muted", `· ${badge.label}`)}`, width));
  if (!delegated) {
    push(paintPanelLine(theme.fg("dim", MIXED_FOOTER.background.text), width));
    return out;
  }
  if (thinking) {
    for (const l of thinkingLines("sidekick planning", SUB_THINKING, Math.max(8, width - visibleWidth(RAIL)))) push(paintPanelLine(l, width));
  }
  const failedStep = state === "failed";
  const subSteps: Array<{ step: MixedToolStep; connector: "├" | "└" }> = [
    { step: subRead, connector: "├" },
    { step: failedStep ? subGitStatusFailed : subGitStatus, connector: "└" },
  ];
  for (const { step, connector } of subSteps) {
    const r = stepLines(step, style, expanded, connector, Math.max(8, width - visibleWidth(RAIL)), state === "legacy");
    for (const l of r.lines) push(paintPanelLine(l, width));
  }
  if (state === "completed" || state === "legacy") {
    for (const l of styledTextLines(style, SUB_RESULT, {}, theme, Math.max(8, width - visibleWidth(RAIL)))) push(paintPanelLine(l, width));
  }
  const mf = MIXED_FOOTER[state];
  push(paintPanelLine(theme.fg(mf.error ? "error" : "dim", mf.text), width));

  if (state === "completed" || state === "legacy") {
    push(...leadToolLines(leadNpmTest, style, expanded, "└", width));
    push(...summaryLines(style, width));
  }
  return out;
}

// ── production mode: the REAL renderer path (no mockup painting) ──────────
// Renders the mixed fixture through renderDelegatedStep + pi's actual
// CustomEntryComponent host + the production spacing patch — the same code
// path a live session takes. This is evidence, not the mockup gallery.
const piComponents = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/components/custom-entry.js")).href)) as {
  CustomEntryComponent: new (entry: unknown, renderer: (entry: unknown, opts: { expanded: boolean }, theme: unknown) => unknown) => { render(w: number): string[]; setExpanded(b: boolean): void; invalidate(): void };
};

function delegatedEntry(step: DelegatedStep, group: string, label: string, style: RenderStyle, expanded: boolean) {
  return new piComponents.CustomEntryComponent(
    { customType: "sidekick-step", data: step },
    (entry, opts) => renderDelegatedStep((entry as { data: DelegatedStep }).data, expanded || opts.expanded, theme as never, { group, label, style }),
  );
}

function leadRow(step: Step, style: RenderStyle, expanded: boolean, width: number, connector?: "├" | "└"): string[] {
  if (step.kind === "text") return styledTextLines(style, step.text, {}, theme, width);
  return styledToolCallLines(style, {
    name: step.name, arg: step.arg, output: step.output, isError: step.isError, expanded, durationMs: step.durationMs, connector,
  }, theme, width);
}

/** The full mixed transcript through the production renderer; bounded rows. */
export function productionLines(style: RenderStyle, expanded: boolean, width: number): string[] {
  const truncated = (ls: string[]) => ls.map((l) => truncateToWidth(l, width));
  const lead1: Step = { kind: "tool", name: "read", arg: "package.json", output: PKG_OUT, isError: false, durationMs: 13 };
  const prose: Step = { kind: "text", text: "Delegating fixture checks (demo fixture — no real run)." };
  const lead2: Step = { kind: "tool", name: "bash", arg: "npm test", output: NPM_TEST_OUT, isError: false, durationMs: 2100 };
  const host = {
    children: [
      ...[] as Array<{ render(w: number): string[] }>,
      { render: (w: number) => [`${theme.fg("accent", "■")} ${theme.fg("accent", theme.bold("LEAD"))} ${theme.fg("dim", "· lead agent (demo fixture)")}`, ...leadRow(lead1, style, expanded, w)] },
      { render: (w: number) => leadRow(prose, style, expanded, w) },
      delegatedEntry({ kind: "tool", name: "bash", arg: "pwd && ls", output: LS_OUT, isError: false, durationMs: 140, args: { command: "pwd && ls" } }, "sidekick:h1", "Sidekick", style, expanded),
      delegatedEntry({ kind: "text", text: "Demo result — fixtures verified. (invented placeholder)", thinking: "Demo sidekick thought — check the fixtures first, then report. (synthetic, provider-style stored thinking)" }, "sidekick:h1", "Sidekick", style, expanded),
      delegatedEntry({ kind: "tool", name: "bash", arg: "git status --short --branch", output: "## main...origin/main\n", isError: false, durationMs: 13, args: { command: "git status --short --branch" } }, "subagent:agent-1:1700000000000", "General subagent · demo", style, expanded),
      { render: (w: number) => leadRow(lead2, style, expanded, w) },
    ] as Array<{ render(w: number): string[] }>,
    render(w: number): string[] {
      return this.children.flatMap((c) => c.render(w));
    },
  };
  patchTranscriptSpacing(host as never);
  return truncated(host.render(width));
}

// ── output helpers ─────────────────────────────────────────────────────────
const ANSI_ALL = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

/** Strip all ANSI (SGR + OSC-8 link wrappers), keeping link text. */
export function stripAnsi(line: string): string {
  return line.replace(/\x1b\]8;;[^\x1b]*\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, "$1").replace(ANSI_ALL, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function sectionHeader(style: RenderStyle, state: State): string {
  const t = theme;
  return t.fg("dim", "── ") + t.fg("accent", `style ${style}`) + t.fg("dim", " · ") + t.fg("customMessageLabel", `state ${state}`) + t.fg("dim", " " + "─".repeat(20));
}

const HELP = `UNI-2 DESIGN MOCKUP — sidekick rail preview (NOT the current live renderer)

Usage: npx tsx scripts/sidekick-preview.ts [flags]

  --print          static output of every style × state (default)
  --plain          strip ANSI: plain text for files/diffs
  --production     render through the REAL renderer (renderDelegatedStep +
                   pi's CustomEntryComponent + the spacing patch) — static
                   print only, host-level evidence (not the mockup gallery)
  --interactive    TUI browser (keys: 1/2/3 style · b/arrows state · m scenario ·
                   t thinking · e expand · ↑↓/pgup/pgdn scroll · q/esc quit);
                   --style/--state/--scenario/--expand seed the initial view
  --scenario NAME  sidekick (default, approved UNI-2 rail gallery) | mixed
                   (UNI-47: lead + delegated sidekick in one transcript —
                   proposed layout mockup)
  --style NAME     regular | advanced | simple   (filter for --print)
  --state NAME     attached | background | completed | legacy | failed (filter)
  --width N        panel width, print mode only (default 96, clamped 24–200;
                   --interactive always uses the terminal width)
  --expand         render steps expanded (default collapsed)
  --help           this text

Frozen fixtures only — no pi session, no LLM, no commands executed, no
settings writes. The background state replays the same recorded transcript
plus the wake widget line; it is a fixture, not live tool streaming. In the
mixed scenario all “thinking” text is an invented demo placeholder, never a
record of real reasoning.`;

interface Options { mode: "print" | "interactive"; plain: boolean; styles: RenderStyle[]; states: State[]; scenario: Scenario; production: boolean; width: number; expanded: boolean }

function parseArgs(argv: string[]): Options {
  const opts: Options = { mode: "print", plain: false, styles: STYLES, states: STATES, scenario: "sidekick", production: false, width: 96, expanded: false };
  const bad = (msg: string): never => {
    process.stderr.write(`${msg}\n\n${HELP}\n`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") { process.stdout.write(`${HELP}\n`); process.exit(0); }
    else if (a === "--interactive") opts.mode = "interactive";
    else if (a === "--print") opts.mode = "print";
    else if (a === "--plain") opts.plain = true;
    else if (a === "--expand") opts.expanded = true;
    else if (a === "--style") opts.styles = [argv[++i] as RenderStyle];
    else if (a === "--state") opts.states = [argv[++i] as State];
    else if (a === "--scenario") opts.scenario = argv[++i] as Scenario;
    else if (a === "--production") opts.production = true;
    else if (a === "--width") opts.width = Number(argv[++i]);
    else bad(`unknown flag: ${a}`);
  }
  if (opts.styles.some((s) => !STYLES.includes(s))) bad(`--style must be one of ${STYLES.join(", ")}`);
  if (opts.states.some((s) => !STATES.includes(s))) bad(`--state must be one of ${STATES.join(", ")}`);
  if (!SCENARIOS.includes(opts.scenario)) bad(`--scenario must be one of ${SCENARIOS.join(", ")}`);
  if (opts.production && opts.mode === "interactive") bad("--production is static print only (drop --interactive)");
  if (!Number.isFinite(opts.width)) bad("--width needs a number");
  opts.width = Math.min(200, Math.max(24, Math.trunc(opts.width)));
  return opts;
}

function printAll(opts: Options): void {
  const out: string[] = [];
  if (opts.production) {
    out.push(`${theme.fg("success", theme.bold("PRODUCTION RENDERER"))} ${theme.fg("dim", "— real renderDelegatedStep + CustomEntryComponent + spacing patch (host-level evidence, NOT the mockup painting)")}`);
    out.push(theme.fg("dim", "interleaved lead stand-in rows + delegated sidekick/subagent panels · frozen synthetic fixtures, no LLM, no commands"));
    out.push(theme.fg("dim", "evidence covers the delegated renderer + custom wrappers + spacing; lead rows are stand-ins, not pi's live lead-card path"));
    out.push("");
    for (const style of opts.styles) {
      out.push(sectionHeader(style, "completed"));
      out.push(...productionLines(style, opts.expanded, opts.width));
      out.push("");
    }
  } else {
  out.push(`${theme.fg("accent", theme.bold("UNI-2 DESIGN MOCKUP"))} ${theme.fg("dim", "— sidekick cyan-rail preview · NOT the current live renderer")}`);
  if (opts.scenario === "mixed") {
    out.push(theme.fg("dim", "mixed scenario · fixture gallery of the approved layout (delegated steps now DO stream live — see --production for the real renderer)"));
  }
  out.push(theme.fg("dim", `frozen fixtures · width ${opts.width} · ${opts.expanded ? "expanded" : "collapsed"} · panels: #12363b fill + #22d3ee ▏ rail`));
  out.push("");
  for (const style of opts.styles) {
    for (const state of opts.states) {
      out.push(sectionHeader(style, state));
      if (opts.scenario === "mixed") {
        out.push(...mixedLines(state, style, opts));
        if (state === "background") out.push(theme.fg("muted", `◇ ${WAKE_LINE}  (wake widget — fixture)`));
        out.push("");
        continue;
      }
      const r = renderState(state, style, opts);
      out.push(...stateLines(r, opts.width));
      if (r.wake !== undefined) out.push(theme.fg("muted", `◇ ${r.wake}  (wake widget — fixture)`));
      out.push("");
    }
  }
  }
  const text = opts.plain ? out.map(stripAnsi).map((l) => l.replace(/\s+$/u, "")).join("\n") : out.join("\n");
  process.stdout.write(`${text}\n`);
}

// ── interactive TUI ────────────────────────────────────────────────────────
/** Full-screen browser frame; exported so tests can assert rows per scenario. */
export function browserLines(state: State, style: RenderStyle, expanded: boolean, width: number, rows: number, scroll = 0, scenario: Scenario = "sidekick", thinking = true): string[] {
  const r = renderState(state, style, { width, expanded });
  const body = scenario === "mixed" ? mixedLines(state, style, { width, expanded, thinking }) : stateLines(r, width);
  const head = `${theme.fg("accent", theme.bold("UNI-2 DESIGN MOCKUP"))} ${theme.fg("dim", "(not the live renderer)")}  ${theme.fg("dim", `scenario ${scenario} · style ${style} · state ${state} · ${expanded ? "expanded" : "collapsed"}${scenario === "mixed" ? (thinking ? " · thinking on" : " · thinking off") : ""}`)}`;
  const scrollMax = Math.max(0, body.length - (rows - 4));
  const at = Math.max(0, Math.min(scroll, scrollMax));
  const view = body.slice(at, at + rows - 4);
  while (view.length < rows - 4) view.push("");
  const wakeRow = truncateToWidth(r.wake !== undefined ? theme.fg("muted", `◇ ${r.wake}  (wake widget — fixture)`) : "", width);
  const keys = theme.fg("dim", " 1/2/3 style · b/←→ state · m scenario · t thinking · e expand · ↑↓/pgup/pgdn scroll · q/esc quit");
  return [truncateToWidth(head, width), ...view, wakeRow, truncateToWidth(keys, width)];
}

class Preview implements Component {
  scroll = 0;
  constructor(
    private readonly term: ProcessTerminal,
    private readonly quit: () => void,
    style: RenderStyle,
    state: State,
    private expanded: boolean,
    private scenario: Scenario = "sidekick",
    private thinking = true,
  ) {
    this.style = style;
    this.state = state;
  }
  style: RenderStyle;
  state: State;
  invalidate(): void {}
  render(width: number): string[] {
    return browserLines(this.state, this.style, this.expanded, width, Math.max(10, this.term.rows - 1), this.scroll, this.scenario, this.thinking);
  }
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c") || data === "q" || matchesKey(data, "escape")) return this.quit();
    else if (data === "1") this.style = "regular";
    else if (data === "2") this.style = "advanced";
    else if (data === "3") this.style = "simple";
    else if (data === "b" || matchesKey(data, "right")) this.state = STATES[(STATES.indexOf(this.state) + 1) % STATES.length];
    else if (matchesKey(data, "left")) this.state = STATES[(STATES.indexOf(this.state) - 1 + STATES.length) % STATES.length];
    else if (data === "m") this.scenario = this.scenario === "mixed" ? "sidekick" : "mixed";
    else if (data === "t") this.thinking = !this.thinking;
    else if (data === "e") this.expanded = !this.expanded;
    else if (matchesKey(data, "up")) this.scroll -= 1;
    else if (matchesKey(data, "down")) this.scroll += 1;
    else if (matchesKey(data, "pageUp")) this.scroll -= 10;
    else if (matchesKey(data, "pageDown")) this.scroll += 10;
    else return;
    this.scroll = Math.max(0, this.scroll);
  }
}

function interactive(opts: Options): void {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const quit = () => {
    tui.stop();
    process.stdout.write("\x1b[?1049l");
    process.exit(0);
  };
  tui.addChild(new Preview(terminal, quit, opts.styles[0]!, opts.states[0]!, opts.expanded, opts.scenario, true));
  tui.setFocus(tui.children[0] as never);
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
  tui.start();
}

// ── entry ──────────────────────────────────────────────────────────────────
function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "interactive") interactive(opts);
  else printAll(opts);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) main();
