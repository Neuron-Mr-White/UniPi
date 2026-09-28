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
import { boxInnerWidth, frameOverlay, HUB_OVERLAY_OPTIONS, hubBoldText as bold, hubDimText as dim, hubExactRow, hubTheme, setHubTheme, UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";
import { readUtilSettings } from "../settings.js";
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
      render: (width: number) => {
        const inner = boxInnerWidth(width);
        return frameOverlay([...lines.map((l) => hubExactRow(`  ${l}`, inner)), hubExactRow(dim("  Waiting for your answers… esc cancels"), inner)], width, {
          title: bold(" answer — web form "),
          borderFg: (t) => hubTheme.fg("borderMuted", t),
        });
      },
      invalidate: () => tui.requestRender(),
      handleInput: (data: string) => {
        if (data === "\x1b") {
          cancel();
          done(null);
        }
      },
    };
  }, HUB_OVERLAY_OPTIONS);
}

export function registerAnswerCommand(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.ANSWER}`, {
    description: "Answer the questions in the last reply — editor template or web form (/unipi:answer editor|web)",
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
      const method = arg === "web" || arg === "editor" ? arg : settings.method;

      let message: string | undefined;
      if (method === "editor") {
        const title = questions.length
          ? `Answer ${questions.length} question${questions.length === 1 ? "" : "s"} — Tab next answer · Ctrl+G your editor`
          : "No questions found — write your reply (Ctrl+G opens your editor)";
        const text = await answerEditor(ctx, title, buildTemplate(questions));
        if (text === undefined) return;
        message = composeAnswers(questions, parseTemplate(text, questions.length));
      } else {
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
      pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
}
