/**
 * @pi-unipi/utility — /unipi:answer
 *
 * Answer the questions in the agent's last reply without scrolling:
 *   editor — pi's editor pre-filled with a Q/A template (Ctrl+G → $EDITOR)
 *   web    — a local form with the full reply beside the answer boxes
 * `/unipi:answer editor|web` overrides the configured default. Over SSH the
 * web form prints a port-forward command instead of opening a browser.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { ExtensionEditorComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { boxInnerWidth, frameOverlay, HUB_OVERLAY_OPTIONS, hubBoldText as bold, hubDimText as dim, hubExactRow, hubTheme, sendHarnessUserMessage, setHubTheme, UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";
import { readUtilSettings } from "../settings.js";
import { ReplyPanel, type ReplyPanelResult } from "./reply.js";
import { buildTemplate, composeAnswers, extractQuestions, messageText, parseTemplate } from "./extract.js";
import { startWebForm, type WebAnswer } from "./web.js";

/** Fixed port tried first over SSH, so one `ssh -L` keeps working. */
export const SSH_DEFAULT_PORT = 47321;

export function isSsh(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

function lastAssistantText(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as unknown as { getBranch?: () => unknown[]; getEntries: () => unknown[] };
  const entries = (sm.getBranch?.() ?? sm.getEntries()) as Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]!.message;
    if (entries[i]!.type === "message" && m?.role === "assistant") {
      const text = messageText(m.content).trim();
      if (text) return text;
    }
  }
  return "";
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // no browser — the URL is on screen
  }
}

/**
 * pi's own editor dialog (Enter submits, Ctrl+G opens $EDITOR), hosted here so
 * the cursor can start on the first answer line instead of the end.
 */
function answerEditor(ctx: ExtensionContext, title: string, template: string): Promise<string | undefined> {
  const target = template.split("\n").findIndex((l) => l.startsWith("A1:"));
  return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
    const component = new ExtensionEditorComponent(tui, keybindings, title, template, (text: string) => done(text), () => done(undefined));
    const editor = (component as unknown as { editor: { getCursor(): { line: number }; getText(): string; handleInput(d: string): void } }).editor;
    const goTo = (line: number) => {
      for (let i = 0; i < 500 && editor.getCursor().line > line; i++) editor.handleInput("\x1b[A");
      for (let i = 0; i < 500 && editor.getCursor().line < line; i++) editor.handleInput("\x1b[B");
      editor.handleInput("\x1b[F");
    };
    if (target >= 0) goTo(target);
    // Tab / Shift+Tab jump between answer lines (wrapping around).
    const inner = component.handleInput.bind(component);
    component.handleInput = (data: string) => {
      if (data !== "\t" && data !== "\x1b[Z") return inner(data);
      const answers = editor.getText().split("\n").map((l, i) => (/^A\d+:/.test(l) ? i : -1)).filter((i) => i >= 0);
      if (answers.length === 0) return;
      const at = editor.getCursor().line;
      const next = data === "\t"
        ? answers.find((i) => i > at) ?? answers[0]!
        : [...answers].reverse().find((i) => i < at) ?? answers.at(-1)!;
      goTo(next);
      tui.requestRender();
    };
    return component;
  });
}

/** Small capturing overlay while the browser form is open; Esc cancels. */
function waitForWeb(ctx: ExtensionContext, lines: string[], result: Promise<WebAnswer | null>, cancel: () => void): Promise<WebAnswer | null> {
  return ctx.ui.custom<WebAnswer | null>((tui, theme, _kb, done) => {
    setHubTheme(theme);
    void result.then((r) => done(r));
    return {
      focused: true,
      render: (width: number) => {
        const inner = boxInnerWidth(width);
        return frameOverlay([...lines.map((l) => hubExactRow(`  ${l}`, inner)), hubExactRow(dim("  Waiting for your answers… esc cancels"), inner)], width, {
          title: bold(" answer — web form "),
          borderFg: (t) => hubTheme.fg("borderMuted", t),
        });
      },
      invalidate: () => tui.requestRender(),
      handleInput: (data: string) => {
        // matchesKey: kitty-protocol terminals send Esc as a CSI sequence, not a bare \x1b.
        if (matchesKey(data, Key.escape) || data === "\x1b" || data === "\x03") {
          cancel();
          done(null);
        }
      },
    };
  }, HUB_OVERLAY_OPTIONS);
}

const METHODS = [
  { value: "reply", label: "reply", description: "The reply above a fixed input box — scroll it while you type" },
  { value: "questions", label: "questions", description: "One answer per detected question (Q/A template)" },
  { value: "web", label: "web", description: "Answer the questions in a browser form (works over SSH)" },
];

/** Reply panel in place of the input area (no overlay: pi restores the editor). */
function replyPanel(ctx: ExtensionContext, reply: string, questions: number): Promise<ReplyPanelResult> {
  return ctx.ui.custom<ReplyPanelResult>((tui, theme, _kb, done) => new ReplyPanel(tui, theme, reply, questions, done));
}

const HINT_WIDGET = "unipi-answer-hint";

export function registerAnswerCommand(pi: ExtensionAPI): void {
  // "N questions detected" hint above the editor after a reply that asks some;
  // cleared as soon as the user sends anything.
  let hinted = false;
  pi.on("agent_end", (_event, ctx) => {
    try {
      if (!ctx.hasUI || !readUtilSettings(ctx.cwd).answer.hint) return;
      const n = extractQuestions(lastAssistantText(ctx)).length;
      if (n === 0) return;
      ctx.ui.setWidget(HINT_WIDGET, [dim(`  ${n} question${n === 1 ? "" : "s"} in the reply — /unipi:answer questions to answer them one by one`)], { placement: "aboveEditor" });
      hinted = true;
    } catch {
      // hint is cosmetic
    }
  });
  const clearHint = (ctx: ExtensionContext) => {
    if (!hinted) return;
    hinted = false;
    try {
      ctx.ui.setWidget(HINT_WIDGET, undefined);
    } catch {
      // ignore
    }
  };
  // Any new turn (typed, /unipi:answer, or an extension message) clears it.
  pi.on("input", (_event, ctx) => clearHint(ctx));
  pi.on("before_agent_start", (_event, ctx) => clearHint(ctx));

  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.ANSWER}`, {
    description: "Answer the last reply — a fixed input box under the scrollable reply (reply), per question (questions), or a browser form (web)",
    getArgumentCompletions: (prefix: string) => {
      const needle = (prefix ?? "").trim().toLowerCase();
      const matches = METHODS.filter((m) => m.value.startsWith(needle));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify?.("/unipi:answer needs the interactive TUI", "warning");
        return;
      }
      const reply = lastAssistantText(ctx);
      if (!reply) {
        ctx.ui.notify("No agent reply to answer yet.", "info");
        return;
      }
      const questions = extractQuestions(reply);
      const settings = readUtilSettings(ctx.cwd).answer;
      const arg = args.trim().toLowerCase();
      let method: "reply" | "questions" | "web" =
        arg === "web" ? "web" : arg === "questions" || arg === "editor" ? "questions" : arg === "reply" ? "reply" : settings.method;
      if (method !== "reply" && questions.length === 0 && method === "web") method = "reply";

      let message: string | undefined;
      if (method === "reply") {
        const result = await replyPanel(ctx, reply, questions.length);
        if (result.type === "cancel") return;
        if (result.type === "send") message = result.text;
        else method = "questions";
      }
      if (method === "questions") {
        const title = questions.length
          ? `Answer ${questions.length} question${questions.length === 1 ? "" : "s"} — Tab next answer · Ctrl+G your editor`
          : "Reply to the last message (no questions found) — Ctrl+G your editor";
        const text = await answerEditor(ctx, title, buildTemplate(questions));
        if (text === undefined) return;
        message = composeAnswers(questions, parseTemplate(text, questions.length));
      } else if (method === "web") {
        const ssh = isSsh();
        const port = settings.port > 0 ? settings.port : ssh ? SSH_DEFAULT_PORT : 0;
        const form = await startWebForm(reply, questions, port).catch(() => startWebForm(reply, questions, 0));
        const lines = ssh
          ? [
              bold("Open on your own machine:"),
              form.url,
              dim("First forward the port from that machine:"),
              `ssh -L ${form.port}:127.0.0.1:${form.port} ${hostname()}`,
            ]
          : [bold("Opened in your browser:"), form.url];
        if (!ssh) openBrowser(form.url);
        const answer = await waitForWeb(ctx, lines, form.result, form.close);
        form.close();
        if (!answer) return;
        message = composeAnswers(questions, answer.answers, answer.note);
      }
      if (!message) {
        ctx.ui.notify("Nothing answered — nothing sent.", "info");
        return;
      }
      sendHarnessUserMessage(
        pi,
        message,
        { source: "Answer", title: "Your answers", synopsis: `${questions.length} question(s) answered` },
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    },
  });
}
