/**
 * @pi-unipi/ask-user — the ask_user tool
 *
 * One call asks 1–4 questions (Devin's shape). Runs sequentially: pi runs a
 * message's tool calls in parallel by default, and several dialogs at once
 * used to hide all but the last — the rest could never be answered and the
 * turn hung. One dialog at a time, every question in one call.
 */

import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { bus, ASK_USER_TOOLS, COMPACTOR_INSTRUCTION, UNIPI_EVENTS, raceRemote, withHerdrBlocked, type Attachment } from "@pi-unipi/core";
import { AskPanel, type PanelResult } from "./ask-ui.js";
import { getAskUserSettings, type AskUserSettings } from "./config.js";
import { queueCompactHandoff, queueDirectHandoff } from "./handoff.js";
import { renderLauncherUI } from "./launcher-ui.js";
import { answerSummary, answersText, clarifyText, HEADER_MAX, prepareArgs, type AskParams, type AskQuestion, type QuestionAnswer } from "./questions.js";
import type { SessionLauncherResult } from "./types.js";

/** Subagent children never talk to the user directly — their lead owns ambiguity. */
/**
 * Turns the phone app's answer into a panel result. Phone shape:
 * `{type:"answered", answers:[{selected, custom_text?, skipped}]}` or
 * `{type:"cancel"}` / null. Unknown option values are dropped; the answer
 * list is padded/trimmed to the question count (missing = skipped).
 */
export function phoneAnswer(value: unknown, questions: readonly AskQuestion[]): PanelResult {
  const v = value as { type?: unknown; answers?: unknown } | null;
  if (!v || v.type !== "answered" || !Array.isArray(v.answers)) return { type: "cancel" };
  const answers: QuestionAnswer[] = questions.map((q, i) => {
    const a = (v.answers as unknown[])[i] as { selected?: unknown; custom_text?: unknown; skipped?: unknown } | undefined;
    if (!a || a.skipped === true) return { selected: [], skipped: true };
    const allowed = new Set(q.options.map((o) => o.value ?? o.label));
    let selected = Array.isArray(a.selected) ? a.selected.filter((s): s is string => typeof s === "string" && allowed.has(s)) : [];
    if (!q.multi_select) selected = selected.slice(0, 1);
    const custom = typeof a.custom_text === "string" && a.custom_text.trim() && q.other !== false ? a.custom_text.trim() : undefined;
    if (!selected.length && !custom) return { selected: [], skipped: true };
    return custom ? { selected, custom_text: custom, skipped: false } : { selected, skipped: false };
  });
  // An option with an action (end turn / new session) acts like it does in the TUI.
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    if (q.multi_select) continue;
    const opt = q.options.find((o) => o.action && (o.value ?? o.label) === answers[i]!.selected[0]);
    if (opt) return { type: "action", question: i, option: opt, answers };
  }
  return { type: "answered", answers, attachments: [] };
}

export function isSubagentChild(env: Record<string, string | undefined> = process.env): boolean {
  return env.UNIPI_SUBAGENT_CHILD === "1";
}

export interface AskDetails {
  questions: AskQuestion[];
  answers?: QuestionAnswer[];
  outcome: "answered" | "clarify" | "cancelled" | "action" | "unavailable";
  reason?: "disabled" | "no-ui";
  /** Legacy single-question fields, kept for older consumers (compactor, notify). */
  question?: string;
  attachments?: Array<Pick<Attachment, "id" | "kind" | "path" | "name">>;
}

/**
 * Adds the ask_user tool to pi's active set when enabled, removes it otherwise,
 * touching ONLY `ask_user`, never another module's tools. Skips `setActiveTools`
 * when nothing would change.
 */
export function syncAskUserTool(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  want: boolean,
): void {
  const current = pi.getActiveTools();
  if (current.includes(ASK_USER_TOOLS.ASK) === want) return;
  const set = new Set(current);
  if (want) set.add(ASK_USER_TOOLS.ASK);
  else set.delete(ASK_USER_TOOLS.ASK);
  pi.setActiveTools([...set]);
}

const OPTION = Type.Object({
  label: Type.String({ description: "Display text (1–5 words)" }),
  description: Type.Optional(Type.String({ description: "What this option means or its trade-offs" })),
  value: Type.Optional(Type.String({ description: "Returned instead of the label when set" })),
  action: Type.Optional(Type.Union([Type.Literal("end_turn"), Type.Literal("new_session")], {
    description: "end_turn: stop the turn when picked · new_session: hand off to `prefill` (compact & run / run directly)",
  })),
  prefill: Type.Optional(Type.String({ description: "Message or /command queued by a new_session option" })),
});

const QUESTION = Type.Object({
  question: Type.String({ description: "The full question" }),
  header: Type.String({ description: `Short chip label, e.g. "Database" (≤${HEADER_MAX} chars)` }),
  options: Type.Array(OPTION, { description: "2–4 choices. An \"Other\" free-text choice is added automatically." }),
  multi_select: Type.Optional(Type.Boolean({ description: "Let the user pick several (default false)" })),
  other: Type.Optional(Type.Boolean({ description: "Offer \"Other (type your own)\" (default true)" })),
});

function unavailable(questions: AskQuestion[], text: string, reason?: "disabled" | "no-ui") {
  return { content: [{ type: "text" as const, text }], details: { questions, outcome: "unavailable", reason } as AskDetails };
}

function imageParts(attachments: readonly Attachment[]) {
  const parts: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const a of attachments) {
    if (a.kind !== "image") continue;
    try {
      parts.push({ type: "image", data: readFileSync(a.path).toString("base64"), mimeType: a.mimeType ?? "image/png" });
    } catch {
      // unreadable: the token stays in the text
    }
  }
  return parts;
}

/** "[File #2]" → "[File #2: /path]" so the agent can open documents. */
function expandFileTokens(answers: QuestionAnswer[], attachments: readonly Attachment[]): QuestionAnswer[] {
  const files = attachments.filter((a) => a.kind === "file");
  if (!files.length) return answers;
  return answers.map((a) => (a.custom_text ? { ...a, custom_text: files.reduce((t, f) => t.split(`[File #${f.id}]`).join(`[File #${f.id}: ${f.path}]`), a.custom_text) } : a));
}

/** The user's settings win over what the agent asked for. */
export function applySettings(questions: AskQuestion[], settings: AskUserSettings): AskQuestion[] {
  return questions.slice(0, settings.maxQuestions).map((q) => {
    if (settings.other === "always" || q.options.length === 0) {
      const { other: _drop, ...rest } = q;
      return rest;
    }
    return settings.other === "never" ? { ...q, other: false } : q;
  });
}

export function registerAskUserTools(pi: ExtensionAPI): void {
  const max = getAskUserSettings().maxQuestions;
  pi.registerTool({
    name: ASK_USER_TOOLS.ASK,
    label: "Ask User",
    description:
      `Ask the user 1–${max} multiple-choice question${max === 1 ? "" : "s"} in one dialog and wait for the answers. ` +
      "Each question has a short header, 2–4 options (label + description) and optional multi-select; " +
      "an \"Other\" free-text choice is always added. The user may skip questions.",
    promptSnippet: "Ask the user multiple-choice questions and wait for the answers.",
    promptGuidelines: [
      "Use ask_user when a decision, preference or clarification needs the user before you continue.",
      `Put every question you need right now in ONE call (1–${max} question${max === 1 ? "" : "s"}) — never several ask_user calls at once.`,
      "Give each question a short header (≤16 chars) and 2–4 options with a clear description; don't add an 'Other' option yourself.",
      "Use multi_select when several answers can apply.",
      "Skipped questions come back as skipped: respect that, don't ask them again unless you must.",
      "If the user says they're not ready, ask what they want to clarify instead of re-asking.",
      "Options can carry action: 'end_turn' or action: 'new_session' with a prefill for workflow handoffs.",
    ],
    parameters: Type.Object({
      questions: Type.Array(QUESTION, { description: `1–${max} question${max === 1 ? "" : "s"}` }),
    }),
    // Older calls ({ question, context, options, allowMultiple, allowFreeform, timeout }) still work.
    prepareArguments: (args: unknown) => prepareArgs(args) as never,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const settings = getAskUserSettings(ctx.cwd);
      const questions = applySettings((prepareArgs(params) as AskParams).questions, settings);
      if (isSubagentChild()) {
        throw new Error(
          "ask_user is not available inside a subagent. You cannot talk to the user directly — only your lead can. Do not guess an answer: state the question, the options you considered and your recommendation in your report.",
        );
      }
      if (!settings.enabled) return unavailable(questions, "ask_user is turned off in settings — ask in your reply instead.", "disabled");
      if (!ctx.hasUI) return unavailable(questions, "No interactive UI (non-interactive mode) — ask in your reply instead.", "no-ui");
      if (questions.length === 0) throw new Error("ask_user needs at least one question with a question text.");

      if (settings.notifyOnAsk) {
        bus.emit(UNIPI_EVENTS.ASK_USER_PROMPT, {
          question: questions.map((q) => q.question).join(" · "),
          optionCount: questions.reduce((n, q) => n + q.options.length, 0),
          allowMultiple: questions.some((q) => q.multi_select),
          allowFreeform: questions.some((q) => q.other !== false),
        });
      }

      // The UniPi phone app (app bridge) can answer too: first answer wins,
      // and a phone answer closes the TUI panel through `signal`.
      const result = await withHerdrBlocked(pi, "ask_user", () =>
        raceRemote<PanelResult | undefined>(
          { kind: "ask_user", title: questions.map((q) => q.header || q.question).join(" · "), questions },
          (signal) =>
            ctx.ui.custom<PanelResult>((tui, theme, _kb, done) => {
              signal.addEventListener("abort", () => done({ type: "cancel" }), { once: true });
              return new AskPanel(tui, theme, questions, done, undefined, { escape: settings.escape, digitAdvance: settings.digitAdvance, helpLine: settings.helpLine });
            }),
          (value) => phoneAnswer(value, questions),
        ),
      );
      const legacy = questions.length === 1 ? { question: questions[0]!.question } : {};

      if (!result || result.type === "cancel") {
        // Esc stops the turn, like Devin's "Canceled due to user interrupt" —
        // `terminate` ends it after this call, cleanly (no abort error line).
        return { content: [{ type: "text" as const, text: "The user cancelled the questions and stopped the turn. Wait for their next message." }], details: { questions, outcome: "cancelled", ...legacy } as AskDetails, terminate: true };
      }
      if (result.type === "clarify") {
        return { content: [{ type: "text" as const, text: clarifyText(questions, result.answers) }], details: { questions, answers: result.answers, outcome: "clarify", ...legacy } as AskDetails };
      }
      if (result.type === "action") {
        return runAction(pi, ctx, questions, result, legacy);
      }

      const answers = expandFileTokens(result.answers, result.attachments);
      const images = imageParts(result.attachments);
      const names = result.attachments.map((a) => (a.kind === "image" ? `[Image #${a.id}]` : `[File #${a.id}]`));
      return {
        content: [{ type: "text" as const, text: answersText(questions, answers, images.length ? names : []) }, ...images],
        details: {
          questions,
          answers,
          outcome: "answered",
          ...legacy,
          ...(result.attachments.length ? { attachments: result.attachments.map(({ id, kind, path, name }) => ({ id, kind, path, name })) } : {}),
        } as AskDetails,
      };
    },

    renderCall: () => new Text("", 0, 0),
    renderResult: (result, _options, theme, _context) => renderAskResult(result.details as AskDetails | undefined, theme as Theme),
    renderShell: "self",
    // The simple render style collapses every tool to one row — the Q→A is
    // the whole point of ask_user, so keep compact `header: answer` rows
    // under the `Asked user` line (utility's simpleResult hook), and hide the
    // `· N output lines` meta (the answers are the output).
    ...( {
      simpleMeta: () => "",
      simpleResult: (result: { details?: AskDetails }, theme: Theme) => askRows(result.details, theme),
    } as object),
  });
}

/** Compact Q→A rows for the simple render style's collapsed view. */
export function askRows(details: AskDetails | undefined, theme: Theme): string[] {
  const questions = details?.questions ?? [];
  if (details === undefined || questions.length === 0) return [];
  if (details.outcome === "cancelled") return [`   ${theme.fg("error", "Canceled by the user")}`];
  if (details.outcome === "clarify") return [`   ${theme.fg("warning", "Not ready to answer — wants to clarify first")}`];
  if (details.outcome === "unavailable") {
    const text =
      details.reason === "disabled"
        ? "not shown — ask_user is turned off in settings"
        : details.reason === "no-ui"
          ? "not shown — no interactive UI"
          : "not shown (no interactive UI or turned off)";
    return [`   ${theme.fg("dim", text)}`];
  }
  if (details.outcome === "action") return [`   ${theme.fg("muted", "picked an action")}`];
  return questions.map((q, i) => `   ${theme.fg("muted", `${q.header}: ${answerSummary(q, details.answers?.[i])}`)}`);
}

/** end_turn / new_session options (workflow handoffs). */
async function runAction(pi: ExtensionAPI, ctx: ExtensionContext, questions: AskQuestion[], result: Extract<PanelResult, { type: "action" }>, legacy: Record<string, unknown>) {
  const opt = result.option;
  const details = { questions, answers: result.answers, outcome: "action", ...legacy } as AskDetails;
  if (opt.action === "end_turn") {
    return { content: [{ type: "text" as const, text: `User chose "${opt.label}" and ended the turn.` }], details, terminate: true };
  }
  const prefill = opt.prefill ?? "";
  const launch = await withHerdrBlocked(pi, "ask_user: launch", () => ctx.ui.custom<SessionLauncherResult | null>(renderLauncherUI({ prefill })));
  if (!launch || launch.action === "cancel") {
    return { content: [{ type: "text" as const, text: `User picked "${opt.label}" but cancelled the handoff.` }], details };
  }
  const handoff = launch.action === "compact"
    ? queueCompactHandoff({ pi, ctx, prefill, customInstructions: `${COMPACTOR_INSTRUCTION}\nPreparing for new task. Summarize previous work concisely, preserving only what's essential for: ${prefill}` })
    : queueDirectHandoff(pi, ctx, prefill);
  if (handoff.status !== "failed" && handoff.status !== "cancelled") ctx.abort();
  const text = handoff.status === "failed" ? `Failed to queue the ${launch.action} handoff: ${prefill}` : `Queued ${launch.action} handoff: ${handoff.prefill ?? prefill}`;
  return { content: [{ type: "text" as const, text }], details };
}

/**
 *   ● Asked user 3 questions          ● Asked user Coffee or tea?
 *   │ Planet: Jupiter moon            └ Tea
 *   └ Last book: Dune
 */
export function renderAskResult(details: AskDetails | undefined, theme: Theme): Text {
  const t = theme;
  const questions = details?.questions ?? [];
  if (!questions.length) return new Text("", 0, 0);
  const single = questions.length === 1;
  const title = single ? questions[0]!.question.replace(/\s+/g, " ") : `${t.fg("dim", String(questions.length))} questions`;
  const failed = details!.outcome === "cancelled" || details!.outcome === "clarify" || details!.outcome === "unavailable";
  const bullet = failed ? t.fg("error", "●") : t.fg("success", "●");
  const lines = [` ${bullet} Asked user ${title}`];
  const rows: string[] = [];
  if (details!.outcome === "cancelled") rows.push(t.fg("error", "Canceled by the user"));
  else if (details!.outcome === "clarify") rows.push(t.fg("warning", "Not ready to answer — wants to clarify first"));
  else if (details!.outcome === "unavailable") {
    const text =
      details!.reason === "disabled"
        ? "not shown — ask_user is turned off in settings"
        : details!.reason === "no-ui"
          ? "not shown — no interactive UI"
          : "not shown (no interactive UI or turned off)";
    rows.push(t.fg("dim", text));
  }
  else {
    questions.forEach((q, i) => {
      const a = details!.answers?.[i];
      const text = answerSummary(q, a);
      rows.push(single ? t.fg("muted", text) : t.fg("muted", `${q.header}: ${text}`));
    });
  }
  rows.forEach((r, i) => lines.push(` ${t.fg("borderMuted", i === rows.length - 1 ? "└" : "│")} ${r}`));
  return new Text(lines.join("\n"), 0, 0);
}
