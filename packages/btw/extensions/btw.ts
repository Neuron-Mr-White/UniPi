/**
 * @pi-unipi/btw — /unipi:btw inline side-question panel.
 *
 * `/unipi:btw [question]` swaps the main input area for an inline panel
 * (ctx.ui.custom without `overlay` — pi restores the editor and the draft
 * when it closes). Every question runs in a NEW read-only in-memory session
 * seeded from the main session's current branch via SessionManager.inMemory
 * — the pi 0.87-supported seeding path (the old code assigned
 * session.agent.state.messages, which 0.87 ignores). Nothing reaches the
 * main session: no entries, no messages, and earlier btw answers are never
 * fed back. Page history lives in process memory for this pi session only.
 *
 * The btw-note renderer + context filter stay so old sessions keep
 * displaying (and hiding from the model) legacy `btw-note` notes.
 */

import {
  createAgentSession,
  createExtensionRuntime,
  getMarkdownTheme,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type FileEntry,
  type ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import {
  Box,
  Input,
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";


// ─── Constants ──────────────────────────────────────────────────────────────

const BTW_MESSAGE_TYPE = "btw-note";

const BTW_SYSTEM_PROMPT = [
  "You are having a one-shot aside conversation with the user, separate from their main working session.",
  "Main session messages are provided for context only — that work is being handled by another agent.",
  "Answer the question directly; there is no follow-up thread and nothing you say reaches the main session.",
  "This aside is read-only: you can read and search files but cannot run commands or modify anything. Never claim to have edited, written, or executed something. If the user wants changes or commands run, tell them to ask in the main conversation.",
].join(" ");

// ─── Legacy btw-note compatibility (renderer + context filter only) ─────────

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

// ─── Shared helpers (unchanged from the previous implementation) ────────────

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

/** The extension-facing ModelRegistry wrapper's `runtime` is the same
 *  ModelRuntime the parent session uses. */
function sessionModelRuntime(ctx: ExtensionCommandContext): ModelRuntime {
  return (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
}

function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (type === "text" && part.type === "text") chunks.push(part.text);
    else if (type === "thinking" && part.type === "thinking") chunks.push(part.thinking);
  }
  return chunks.join("\n").trim();
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") return message as AssistantMessage;
  }
  return null;
}

function notify(ctx: { ui: { notify: (m: string, t: "info" | "warning" | "error") => void } }, message: string, type: "info" | "warning" | "error" = "info"): void {
  try { ctx.ui.notify(message, type); } catch { /* no UI */ }
}

// ─── Seeding (the 0.87-supported path) ─────────────────────────────────────

/**
 * Build FileEntry[] for a fresh in-memory btw session: the main session's
 * header + its CURRENT branch, minus legacy `btw-note` custom_message
 * entries. Tool results, compaction entries and in-progress tool calls all
 * come along because they are branch entries — mid-run questions see the
 * main agent's latest state.
 */
export function buildSeedEntries(ctx: {
  sessionManager: {
    getHeader(): { type: string } | null;
    getBranch(): Array<{ type: string; customType?: string }>;
  };
}): FileEntry[] {
  const header = ctx.sessionManager.getHeader();
  const branch = ctx.sessionManager.getBranch().filter(
    (entry) => !(entry.type === "custom_message" && entry.customType === BTW_MESSAGE_TYPE),
  );
  return header
    ? [header as FileEntry, ...(branch as FileEntry[])]
    : (branch as FileEntry[]);
}

// ─── Page history (session-memory only, never persisted) ───────────────────

export interface BtwPage {
  question: string;
  /** One line per tool call: "… Reading <p>" while running → "✓ <desc>" */
  toolLines: string[];
  answer: string;
  error?: string;
  aborted?: boolean;
  done: boolean;
  /** Token usage for the one assistant response (bridge forwards it in `btw_end`). */
  usage?: { input: number; output: number; totalTokens: number };
}

const pages: BtwPage[] = [];

/** Read-only snapshot of recent pages (question, answer, error) for a
 *  `btw_list{}` reply — never mutate the result. */
export function listPages(): Array<{ question: string; answer: string; error?: string }> {
  return pages.map((p) => ({ question: p.question, answer: p.answer, error: p.error }));
}

/** ↑/↓ paging reducer — clamp the target index into [0, count-1]. */
export function pageIndexAfter(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, current + delta));
}

function clearPages(): void {
  pages.length = 0;
}

// ─── The one-shot ask ───────────────────────────────────────────────────────

export interface BtwRun {
  /** Abort the in-flight answer (Ctrl+C path). */
  abort(): void;
  /** Promise resolves when the page is finalized (answer, error, or abort). */
  finished: Promise<void>;
}

const TOOL_VERBS: Record<string, { run: string; done: string; arg: string }> = {
  read: { run: "Reading", done: "Read", arg: "path" },
  grep: { run: "Searching", done: "Searched", arg: "pattern" },
  find: { run: "Finding", done: "Found", arg: "pattern" },
  ls: { run: "Listing", done: "Listed", arg: "path" },
};

function relPath(p: string, cwd: string): string {
  if (p === cwd) return ".";
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/** Devin-style tool line: `… Reading <p>` running, `✓ Read <p>` done,
 *  `✗ …` on error. Paths are rendered relative to cwd. */
export function formatToolLine(
  toolName: string,
  args: Record<string, unknown> | undefined,
  cwd: string,
  state: "running" | "done" | "error",
): string {
  const verbs = TOOL_VERBS[toolName];
  const verb = state === "running" ? (verbs?.run ?? "Running") : (verbs?.done ?? "Done");
  const argKey = verbs?.arg;
  let arg = args && argKey ? args[argKey] : undefined;
  arg ??= args?.path ?? args?.pattern ?? args?.command ?? args?.query;
  const detail = typeof arg === "string" && arg
    ? ` ${arg === args?.path ? relPath(arg, cwd) : arg}`
    : "";
  const mark = state === "running" ? "…" : state === "error" ? "✗" : "✓";
  const label = verbs ? verb : `${verb} ${toolName}`;
  return `${mark} ${label}${detail}`;
}

/** Delta kinds forwarded to `onDelta` (the bridge's UI-free API streams these
 *  to the phone as `btw_delta`; the TUI panel ignores it — it re-renders
 *  `page.answer`/`toolLines` from `onUpdate` instead). */
export type BtwDeltaKind = "text" | "thinking" | "tool";

function runQuestion(
  ctx: ExtensionCommandContext,
  question: string,
  page: BtwPage,
  thinkingLevel: AiThinkingLevel,
  onUpdate: () => void,
  onDelta?: (kind: BtwDeltaKind, text: string) => void,
): BtwRun {
  let session: AgentSession | null = null;
  let unsubscribe: (() => void) | null = null;

  const finished = (async () => {
    const model = ctx.model;
    if (!model) {
      page.error = "No active model selected.";
      page.done = true;
      onUpdate();
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      page.error = auth.ok ? `No credentials for ${model.provider}/${model.id}.` : (auth.error ?? "No credentials.");
      page.done = true;
      onUpdate();
      return;
    }

    try {
      const seeded = await createAgentSession({
        sessionManager: SessionManager.inMemory(ctx.cwd, undefined, buildSeedEntries(ctx)),
        model,
        modelRuntime: sessionModelRuntime(ctx),
        thinkingLevel,
        tools: ["read", "grep", "find", "ls"],
        resourceLoader: createBtwResourceLoader(ctx),
      });
      session = seeded.session;
      const lineIndex = new Map<string, number>(); // toolCallId → toolLines index
      const pendingStarts = new Map<string, { args?: Record<string, unknown> }>();
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") {
          const e = event as { toolCallId: string; toolName: string; args?: Record<string, unknown> };
          pendingStarts.set(e.toolCallId, { args: e.args });
          lineIndex.set(e.toolCallId, page.toolLines.length);
          const line = formatToolLine(e.toolName, e.args, ctx.cwd, "running");
          page.toolLines.push(line);
          onUpdate();
          onDelta?.("tool", line);
        } else if (event.type === "tool_execution_end") {
          const e = event as { toolCallId: string; toolName: string; isError: boolean };
          const start = pendingStarts.get(e.toolCallId);
          const idx = lineIndex.get(e.toolCallId);
          const line = formatToolLine(e.toolName, start?.args, ctx.cwd, e.isError ? "error" : "done");
          if (idx !== undefined) page.toolLines[idx] = line;
          else page.toolLines.push(line);
          pendingStarts.delete(e.toolCallId);
          onUpdate();
          onDelta?.("tool", line);
        } else if (event.type === "message_update") {
          const e = event as { assistantMessageEvent?: { type?: string; delta?: string } };
          if (e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) onDelta?.("text", e.assistantMessageEvent.delta);
          else if (e.assistantMessageEvent?.type === "thinking_delta" && e.assistantMessageEvent.delta) onDelta?.("thinking", e.assistantMessageEvent.delta);
        }
      });

      await session.prompt(question, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        page.error = "No response.";
      } else if (response.stopReason === "aborted") {
        page.aborted = true;
        page.error = "cancelled";
      } else if (response.stopReason === "error") {
        page.error = response.errorMessage || "request failed";
      } else {
        page.answer = extractText(response.content, "text") || "(no text)";
        if (response.usage) page.usage = { input: response.usage.input, output: response.usage.output, totalTokens: response.usage.totalTokens };
      }
    } catch (err) {
      page.error = err instanceof Error ? err.message : String(err);
    } finally {
      page.done = true;
      try { unsubscribe?.(); } catch { /* */ }
      try { session?.dispose(); } catch { /* */ }
      session = null;
      unsubscribe = null;
      onUpdate();
    }
  })();

  return {
    abort() {
      void session?.abort().catch(() => {});
    },
    finished,
  };
}

// ─── Panel component ────────────────────────────────────────────────────────

const HINT_IDLE = "↵ ask · ↑↓ scroll/history · esc back to chat";
const HINT_STREAMING = "ctrl+c cancel answer · ↑↓ scroll/history · esc back to chat";

class BtwPanel implements Component {
  invalidate(): void {
    this.tui.requestRender();
  }
  private input: Input;
  private scrollOffset = 0;
  private follow = true;


  constructor(
    private tui: TUI,
    private theme: Theme,
    _keybindings: KeybindingsManager,
    private done: () => void,
    private onSubmit: (question: string) => void,
    private initialIndex: number,
    /** Extension-level "a run is in flight" check — pages can be viewed
     *  while another page's run streams. */
    private isRunActive: () => boolean,
  ) {
    this.input = new Input({ prompt: "❭ ", placeholder: "Ask a /btw…", placeholderStyle: (t) => this.theme.fg("dim", t) });
  }

  get isStreaming(): boolean {
    return this.isRunActive();
  }

  private rule(width: number): string {
    const label = ` /btw ${Math.min(this.initialIndex + 1, pages.length)}/${pages.length} ──`;
    const rule = "─".repeat(Math.max(0, width - visibleWidth(label)));
    return this.theme.fg("borderMuted", rule) + this.theme.fg("dim", label);
  }

  private pageLines(width: number): string[] {
    const page = pages[this.initialIndex];
    if (!page) return [];
    const out: string[] = [this.theme.fg("accent", `❭ ${page.question}`)];
    for (const line of page.toolLines) {
      out.push(this.theme.fg("dim", line.startsWith("…") ? line : `  ${line}`));
    }
    if (!page.done) {
      out.push(this.theme.fg("dim", "Thinking.."));
    } else if (page.error) {
      out.push(this.theme.fg("error", `✗ ${page.error}`));
    }
    if (page.answer) {
      const md = new Markdown(page.answer, 0, 0, getMarkdownTheme());
      out.push(...md.render(width));
    }
    return out;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const rows = process.stdout.rows ?? 30;
    const viewport = Math.max(4, rows - 10);

    const body = this.pageLines(w).flatMap((l) => wrapTextWithAnsi(l, Math.max(1, w - 1)));
    const maxScroll = Math.max(0, body.length - viewport);
    if (this.follow) this.scrollOffset = maxScroll;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    if (this.scrollOffset >= maxScroll) this.follow = true;
    const visible = body.slice(this.scrollOffset, this.scrollOffset + viewport);

    const inputLine = this.isStreaming
      ? this.theme.fg("dim", "❭ Waiting for the answer…")
      : this.input.render(w - 2)[0] ?? "❭ ";

    // Devin layout: top rule · body · input · bottom rule · hint.
    return [
      this.rule(w),
      ...visible.map((l) => truncateToWidth(l, w, "")),
      inputLine,
      this.theme.fg("borderMuted", "─".repeat(w)),
      this.theme.fg("dim", this.isStreaming ? HINT_STREAMING : HINT_IDLE),
    ];
  }

  /** Re-render while an answer streams (called from the run's onUpdate). */
  tick(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    // Esc — always closable. A streaming answer keeps running into history.
    if (data === "\x1b" || matchesKey(data, Key.escape)) {
      // Esc while streaming: close, the answer keeps going into history.
      this.done();
      return;
    }
    // Ctrl+C cancels the in-flight answer (idle panel: close like Esc).
    if (data === "\x03") {
      if (this.isStreaming) this.abortRun();
      else this.done();
      return;
    }
    // PgUp/PgDn scroll the answer viewport.
    if (matchesKey(data, Key.pageUp)) {
      this.follow = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, (process.stdout.rows ?? 30) - 11));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += Math.max(1, (process.stdout.rows ?? 30) - 11);
      this.follow = false;
      this.tui.requestRender();
      return;
    }
    // ↑/↓ on an EMPTY input pages through earlier Q&As.
    if ((matchesKey(data, Key.up) || matchesKey(data, Key.down)) && this.input.getValue() === "") {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      const next = pageIndexAfter(this.initialIndex, delta, pages.length);
      if (next !== this.initialIndex) {
        this.initialIndex = next;
        this.follow = true;
        this.scrollOffset = 0;
      }
      this.tui.requestRender();
      return;
    }
    // Enter submits — but never while an answer is streaming.
    if (data === "\r" || matchesKey(data, Key.enter)) {
      if (this.isStreaming) return;
      const value = this.input.getValue().trim();
      if (!value) return;
      this.input.setValue("");
      this.onSubmit(value);
      return;
    }
    if (this.isStreaming) return; // input locked while waiting
    this.input.handleInput(data);
  }

  /** Wire Ctrl+C to the extension-level active run (attached on reopen). */
  bindAbort(fn: () => void): void {
    this.abortRun = fn;
  }
  private abortRun: () => void = () => {};

  goToPage(index: number): void {
    this.initialIndex = Math.max(0, Math.min(pages.length - 1, index));
    this.follow = true;
    this.scrollOffset = 0;
    this.tui.requestRender();
  }

  dispose(): void {}
}

// ─── UI-free API (the app bridge, no TUI needed) ───────────────────

/** One streamed update from `BtwApi.ask` (mirrors the bridge's `btw_delta`/`btw_end`). */
export type BtwEvent =
  | { type: "delta"; kind: BtwDeltaKind; text: string }
  | { type: "end"; answer: string; error?: string; usage?: { input: number; output: number; totalTokens: number } };

export interface BtwApi {
  /** Starts a question, streaming `onEvent` until it ends (also resolved by `finished`).
   *  Only one question runs at a time (shared with the TUI panel): a second call while
   *  one is in flight ends immediately with an error. */
  ask(cctx: ExtensionCommandContext, question: string, onEvent: (event: BtwEvent) => void): { id: string; finished: Promise<void> };
  /** Recent pages (question, answer, error) for this pi session — shared with the TUI panel. */
  list(): Array<{ question: string; answer: string; error?: string }>;
}

const BTW_API_KEY = Symbol.for("unipi.btw.api");

/** Publishes the UI-free API on globalThis so the app bridge (a sibling
 *  extension, no shared module instance guaranteed) can ask a side question
 *  without a TUI: `(globalThis as any)[Symbol.for("unipi.btw.api")]`. */
function publishUiFreeApi(pi: ExtensionAPI, getActiveRun: () => BtwRun | null, setActiveRun: (run: BtwRun | null) => void): void {
  let idSeq = 0;
  const api: BtwApi = {
    ask(cctx, question, onEvent) {
      const id = `api-${process.pid}-${++idSeq}`;
      if (getActiveRun()) {
        const finished = Promise.resolve().then(() => onEvent({ type: "end", answer: "", error: "btw is already answering another question" }));
        return { id, finished };
      }
      const page: BtwPage = { question, toolLines: [], answer: "", done: false };
      pages.push(page);
      const run = runQuestion(
        cctx,
        question,
        page,
        pi.getThinkingLevel() as AiThinkingLevel,
        () => {},
        (kind, text) => onEvent({ type: "delta", kind, text }),
      );
      setActiveRun(run);
      const finished = run.finished.then(() => {
        setActiveRun(null);
        onEvent({ type: "end", answer: page.answer, error: page.error, usage: page.usage });
      });
      return { id, finished };
    },
    list: () => listPages(),
  };
  (globalThis as unknown as Record<symbol, unknown>)[BTW_API_KEY] = api;
}

/** Reads the published API, or undefined when @pi-unipi/btw is not loaded. */
export function getBtwApi(): BtwApi | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[BTW_API_KEY] as BtwApi | undefined;
}

// ─── Extension ─────────────────────────────────────────────────────────────────────

export default function btwExtension(pi: ExtensionAPI): void {
  let panelRef: BtwPanel | null = null;
  /** One in-flight answer at a time, tracked here (not per page or panel):
   *  Enter is blocked while it streams, Esc leaves it running into history,
   *  reopening re-attaches abort. */
  let activeRun: BtwRun | null = null;

  function startRun(ctx: ExtensionCommandContext, question: string): void {
    if (activeRun) return; // never two answers at once
    const page: BtwPage = { question, toolLines: [], answer: "", done: false };
    const index = pages.length;
    pages.push(page);
    const run = runQuestion(ctx, question, page, pi.getThinkingLevel() as AiThinkingLevel, () => panelRef?.tick());
    activeRun = run;
    panelRef?.bindAbort(() => activeRun?.abort());
    void run.finished.finally(() => {
      if (activeRun === run) activeRun = null;
      panelRef?.tick();
    });
    panelRef?.goToPage(index);
  }

  function abortActiveRun(): void {
    activeRun?.abort();
  }

  async function openPanel(ctx: ExtensionCommandContext, question?: string): Promise<void> {
    try {
      await ctx.ui.custom<void>(
        async (tui, theme, keybindings, done) => {
          const panel = new BtwPanel(
            tui,
            theme,
            keybindings,
            () => { panelRef = null; done(); },
            (value) => startRun(ctx, value),
            Math.max(0, pages.length - 1),
            () => activeRun !== null,
          );
          panelRef = panel;
          if (activeRun) panel.bindAbort(() => activeRun?.abort());
          if (question) startRun(ctx, question);
          return panel;
        },
        // No `overlay`: pi swaps the editor container for our component and
        // restores the editor + draft when done() is called.
      );
    } catch (err) {
      notify(ctx, err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function headlessAsk(ctx: ExtensionCommandContext, question: string): Promise<void> {
    const page: BtwPage = { question, toolLines: [], answer: "", done: false };
    pages.push(page);
    notify(ctx, `btw: ${question}`, "info");
    const run = runQuestion(ctx, question, page, pi.getThinkingLevel() as AiThinkingLevel, () => {});
    activeRun = run;
    await run.finished;
    activeRun = null;
    notify(ctx, page.error ? `btw failed: ${page.error}` : `btw: ${page.answer}`, page.error ? "error" : "info");
  }

  publishUiFreeApi(pi, () => activeRun, (run) => (activeRun = run));

  pi.on("session_start", () => {
    abortActiveRun();
    clearPages();
  });
  pi.on("session_tree", () => {
    abortActiveRun();
    clearPages();
  });
  pi.on("session_shutdown", async () => {
    abortActiveRun();
    clearPages();
    panelRef = null;
  });

  // Legacy compatibility: keep hiding btw-note messages from the model and
  // keep rendering them for old sessions.
  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as { provider?: string; model?: string; thinkingLevel?: string; usage?: { input: number; output: number; totalTokens: number } } | undefined;
    const content = typeof message.content === "string" ? message.content : "[non-text btw message]";
    const lines = [theme.fg("accent", theme.bold("[BTW]")), content];
    if (expanded && details) {
      lines.push(theme.fg("dim", `model: ${details.provider}/${details.model} · thinking: ${details.thinkingLevel}`));
      if (details.usage) {
        lines.push(theme.fg("dim", `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`));
      }
    }
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.registerCommand("unipi:btw", {
    description: "Ask a side question in an inline panel — read-only, never reaches the main agent.",
    getArgumentCompletions: () => [],
    handler: async (args, ctx) => {
      const question = (args ?? "").trim();
      if (!ctx.hasUI) {
        if (!question) {
          notify(ctx, "usage: /unipi:btw <question>", "warning");
          return;
        }
        await headlessAsk(ctx, question);
        return;
      }
      await openPanel(ctx, question || undefined);
    },
  });
}
