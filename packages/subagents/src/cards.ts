/**
 * @pi-unipi/subagents — chat cards (tools use renderShell: "self", no tinted box).
 *
 * Foreground (Devin-like): one layout from start to finish; only the glyph and
 * the `└` line change.
 *   ⢎⡱ General subagent Run root scripts report      ← crafted spinner
 *     ● bash npm run report
 *     └ Running · 7s · 2 tool calls · ctrl+b background · esc cancel
 *   ✓  General subagent Run root scripts report      ← same line, settled
 *     └ Completed · 10s · 3 tool calls
 *
 * Background (badge): one dotted line per event.
 *    BG   Explore Map auth flow ·························· started · ↓ to watch
 *    DONE Explore Map auth flow ·························· 50s · 2 tool calls
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { badge, leader, settledGlyph, SPINNER_MS, stateGlyph, STATE_COLOR } from "@pi-unipi/core";
import type { SubagentStatus } from "./manager.js";
import { elapsed, plural, profileLabel, STATUS_LABEL, type ThemeLike } from "./ui.js";

export type Phase = "started" | "moved" | "done";

export interface CardDetails {
  owner: "subagents";
  id?: string;
  title?: string;
  profile?: string;
  status?: SubagentStatus;
  phase?: Phase;
  toolCalls?: number;
  durationMs?: number;
  error?: string;
  cancelledBy?: string;
  startedAt?: number;
}

/** Shared renderer state for one run_subagent row (call + result renderers). */
export interface CardState {
  /** Settled state; undefined while running. */
  settled?: SubagentStatus | "moved";
  /** Right side of the background badge line. */
  bgRight?: string;
  bgStatus?: SubagentStatus;
  timer?: ReturnType<typeof setInterval>;
}

export interface CardContext {
  state: CardState;
  invalidate(): void;
}

export interface RunArgs {
  title?: string;
  profile?: string;
  resume?: string;
  is_background?: boolean;
}

const lines = (render: (w: number) => string[]): Component => ({ invalidate() {}, render });

export function meta(durationMs: number | undefined, toolCalls: number | undefined): string {
  return [durationMs !== undefined ? elapsed(durationMs) : undefined, toolCalls !== undefined ? plural(toolCalls, "tool call") : undefined].filter(Boolean).join(" · ");
}

/** `└ …` line under a finished foreground card. */
export function cardOutcome(d: CardDetails | undefined, theme: ThemeLike): string {
  const m = meta(d?.durationMs, d?.toolCalls);
  const tail = m ? theme.fg("dim", ` · ${m}`) : "";
  if (d?.phase === "started") return theme.fg("dim", "└ Background subagent started.");
  if (d?.phase === "moved") return theme.fg("dim", "└ Moved to background · keeps working");
  const status = d?.status ?? "completed";
  if (status === "running") return theme.fg("dim", "└ Still running in the background.");
  const label = status === "cancelled" && d?.cancelledBy === "user" ? "Cancelled by you" : STATUS_LABEL[status];
  const err = status === "failed" && d?.error ? theme.fg("error", `: ${d.error}`) : "";
  return `${theme.fg("dim", "└ ")}${theme.fg(STATE_COLOR[status], label)}${err}${tail}`;
}

function isBackground(args: RunArgs): boolean {
  return args.is_background === true && !args.resume;
}

function stopTimer(state: CardState): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
}

/** Head line — also animates the spinner while the run is live. */
export function renderRunCall(args: RunArgs, theme: ThemeLike, context: CardContext): Component {
  const state = context.state;
  const what = args.resume ? "Resume subagent" : `${profileLabel(args.profile ?? "subagent")} subagent`;
  const title = args.title ?? "";
  if (isBackground(args)) {
    return lines((w) => {
      const status = state.bgStatus ?? "running";
      const chip = status === "running" ? badge(theme, "accent", "BG  ") : badge(theme, STATE_COLOR[status], "FAIL");
      return [leader(theme, `${chip} ${theme.bold(profileLabel(args.profile ?? "subagent"))} ${title}`, theme.fg("dim", state.bgRight ?? "starting…"), w)];
    });
  }
  if (state.settled === undefined && state.timer === undefined) {
    state.timer = setInterval(() => context.invalidate(), SPINNER_MS);
    state.timer.unref?.();
  }
  return lines((w) => {
    const s = state.settled;
    const glyph = s === undefined ? stateGlyph(theme, "running") : s === "moved" ? theme.fg("accent", settledGlyph("↗")) : stateGlyph(theme, s);
    return [truncateToWidth(`${glyph} ${theme.bold(what)} ${title}`, w)];
  });
}

export interface RunResultHooks {
  /** Live tail lines for a running id (foreground). */
  tail(id: string, width: number): string[];
  toolCalls(id: string): number;
  startedAt(id: string): number | undefined;
}

export function renderRunResult(
  result: { details?: CardDetails; content?: Array<{ text?: string }> },
  opts: { isPartial: boolean; expanded: boolean },
  theme: ThemeLike,
  context: CardContext,
  args: RunArgs,
  hooks: RunResultHooks,
): Component {
  const state = context.state;
  const d = result.details;
  if (isBackground(args)) {
    if (d?.status === "failed") {
      state.bgStatus = "failed";
      state.bgRight = d.error ?? "could not start";
    } else {
      state.bgRight = "started · ↓ to watch";
    }
    return lines(() => []);
  }
  if (opts.isPartial && d?.id !== undefined) {
    const id = d.id;
    return lines((w) => {
      const started = hooks.startedAt(id) ?? Date.now();
      const status = theme.fg("dim", `└ Running · ${elapsed(Date.now() - started)} · ${plural(hooks.toolCalls(id), "tool call")} · ctrl+b background · esc cancel`);
      return [...hooks.tail(id, w), truncateToWidth(`  ${status}`, w)];
    });
  }
  stopTimer(state);
  state.settled = d?.phase === "moved" || (d?.status === "running" && d.phase !== "done") ? "moved" : d?.status ?? "completed";
  const outcome = `  ${cardOutcome(d, theme)}`;
  if (!opts.expanded || d?.phase !== "done") return lines((w) => [truncateToWidth(outcome, w)]);
  const text = (result.content?.[0]?.text ?? "").replace(/\n\n--- subagent [\s\S]*$/u, "");
  return lines((w) => [truncateToWidth(outcome, w), ...new Markdown(text, 2, 0, getMarkdownTheme()).render(w)]);
}

/** Background completion notice: `DONE Explore title ········ 50s · 2 tool calls`. */
export function renderCompletion(
  d: (CardDetails & { report?: string }) | undefined,
  expanded: boolean,
  theme: ThemeLike,
): Component {
  const raw = d?.status as string | undefined;
  const status: SubagentStatus = raw === "aborted" || raw === "interrupted" ? "cancelled" : d?.status ?? "completed";
  const chip = badge(theme, STATE_COLOR[status], { running: "RUN ", completed: "DONE", failed: "FAIL", cancelled: "STOP" }[status]);
  const who = d?.profile ? `${theme.bold(profileLabel(d.profile))} ` : "";
  const m = meta(d?.durationMs, d?.toolCalls);
  const note = status === "cancelled" && d?.cancelledBy === "user" ? "cancelled by you" : status === "failed" ? "failed" : "";
  const right = [note ? theme.fg(STATE_COLOR[status], note) : "", m ? theme.fg("dim", m) : ""].filter(Boolean).join(theme.fg("dim", " · "));
  const report = expanded ? d?.report : undefined;
  return lines((w) => {
    const head = leader(theme, `${chip} ${who}${d?.title ?? ""}`, right, w);
    return report ? [head, ...new Markdown(report, 2, 0, getMarkdownTheme()).render(w)] : [head];
  });
}
