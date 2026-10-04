/**
 * Plan review overlay: the plan (rendered markdown, scrollable) with the three
 * decisions underneath. When the plan has both `## Summary` and `## Implementation`
 * and the overlay is wide enough (inner width ≥ 120), the two sections render
 * side by side — Summary left (~40%), Implementation right (~60%), Tab switches
 * the focused pane. On a narrower overlay they stack behind one scroll; without
 * both sections a single pane renders exactly as before.
 *
 * Keys: ↑/↓ or j/k scroll the focused pane · PgUp/PgDn/Space page · g/G top/bottom ·
 *       Tab switch pane (side-by-side) · ←/→ or 1/2/3 choose · Enter confirm ·
 *       Esc keep planning.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type ReviewChoice = "approve" | "keep" | "discard";

export const REVIEW_CHOICES: Array<{ id: ReviewChoice; label: string }> = [
  { id: "approve", label: "Approve & implement" },
  { id: "keep", label: "Keep planning…" },
  { id: "discard", label: "Discard plan" },
];

export interface ReviewParams {
  plan: string;
  path: string;
}

/** Inner overlay width at which the two sections fit side by side. */
const SIDE_BY_SIDE_MIN_WIDTH = 120;

export interface PlanSections {
  summary: string;
  implementation: string;
}

/**
 * Split the plan at its two top-level headings; anything before `## Summary`
 * (e.g. a `#` title) stays with the summary. Null when either heading is
 * missing (or in the wrong order). The headings themselves are stripped — the
 * layouts render their own section titles.
 */
export function splitPlan(plan: string): PlanSections | null {
  const lines = plan.split("\n");
  let summaryIndex = -1;
  let implementationIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^##[ \t]+Summary[ \t]*$/.test(lines[index]!)) summaryIndex = index;
    if (/^##[ \t]+Implementation[ \t]*$/.test(lines[index]!)) implementationIndex = index;
  }
  if (summaryIndex === -1 || implementationIndex === -1 || implementationIndex <= summaryIndex) {
    return null;
  }
  const trim = (text: string): string => text.replace(/^\n+/, "").replace(/\s+$/, "");
  const summary = trim([...lines.slice(0, summaryIndex), ...lines.slice(summaryIndex + 1, implementationIndex)].join("\n"));
  const implementation = trim(lines.slice(implementationIndex + 1).join("\n"));
  return { summary, implementation };
}

function pad(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : truncateToWidth(text, width);
}

export function renderPlanReview(params: ReviewParams) {
  return (tui: TUI, theme: Theme, _kb: unknown, done: (choice: ReviewChoice | null) => void) => {
    const sections = splitPlan(params.plan);
    const markdown = new Markdown(params.plan, 0, 0, getMarkdownTheme());
    const summaryMarkdown = sections ? new Markdown(sections.summary, 0, 0, getMarkdownTheme()) : null;
    const implementationMarkdown = sections ? new Markdown(sections.implementation, 0, 0, getMarkdownTheme()) : null;

    let focus: "summary" | "implementation" = "summary";
    let choice = 0;
    let scroll = 0;
    let scrollSummary = 0;
    let scrollImplementation = 0;
    let lastBodyHeight = 10;
    let lastSideBySide = false;

    const border = (text: string) => theme.fg("accent", text);
    const divider = () => theme.fg("dim", "│");
    const viewportRows = (extra: number): number => {
      const rows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
      // Overlay chrome: top/title/sep + sep/choices/sep/footer/bottom = 8 rows, plus margin.
      return Math.max(6, rows - 12 - extra);
    };
    const clampScroll = (value: number, maxScroll: number): number => Math.min(Math.max(0, value), Math.max(0, maxScroll));

    const chrome = (lines: string[], inner: number, bodyLength: number, height: number, scrollValue: number, hintLabel: string): void => {
      const more = bodyLength - (scrollValue + height);
      const hint = more > 0
        ? theme.fg("dim", ` ${hintLabel} ↓ ${more} more line${more === 1 ? "" : "s"}`)
        : theme.fg("dim", ` ${hintLabel} — end of plan —`);
      lines.push(border("├") + pad(hint, inner) + border("┤"));

      const buttons = REVIEW_CHOICES.map((option, index) => {
        const label = ` ${index + 1} ${option.label} `;
        if (index !== choice) return theme.fg("muted", label);
        return option.id === "discard" ? theme.bg("selectedBg", theme.fg("error", theme.bold(label))) : theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
      }).join("  ");
      lines.push(border("│") + " " + pad(buttons, inner - 1) + border("│"));
      lines.push(border(`├${"─".repeat(inner)}┤`));
      const footer = theme.fg("dim", " ↑↓ scroll · tab pane · ←→ choose · enter confirm · esc keep planning");
      lines.push(border("│") + pad(truncateToWidth(footer, inner), inner) + border("│"));
      lines.push(border(`╰${"─".repeat(inner)}╯`));
    };

    const headerRow = (lines: string[], inner: number, bodyLength: number, height: number, scrollValue: number): void => {
      const where = bodyLength > height ? theme.fg("dim", ` ${scrollValue + 1}–${Math.min(scrollValue + height, bodyLength)} of ${bodyLength} `) : "";
      const title = ` ${theme.bold("Review plan")}  ${theme.fg("muted", params.path)}`;
      const titleWidth = inner - visibleWidth(where);
      lines.push(border("│") + pad(truncateToWidth(title, titleWidth), titleWidth) + where + border("│"));
      lines.push(border(`├${"─".repeat(inner)}┤`));
    };

    /** Single pane (no split) and the narrow stacked layout share one scroll. */
    const stackedBody = (contentWidth: number): string[] => {
      if (!sections || !summaryMarkdown || !implementationMarkdown) return markdown.render(contentWidth);
      return [
        theme.bold("Summary"),
        "",
        ...summaryMarkdown.render(contentWidth),
        "",
        theme.fg("dim", "─".repeat(contentWidth)),
        "",
        theme.bold("Implementation"),
        "",
        ...implementationMarkdown.render(contentWidth),
      ];
    };

    const render = (width: number): string[] => {
      const inner = Math.max(20, width - 2);
      const contentWidth = inner - 2;

      if (sections && inner >= SIDE_BY_SIDE_MIN_WIDTH) {
        lastSideBySide = true;
        return renderSideBySide(inner, contentWidth);
      }
      lastSideBySide = false;
      return renderStacked(inner, contentWidth);
    };

    const renderStacked = (inner: number, contentWidth: number): string[] => {
      const body = stackedBody(contentWidth);
      const height = Math.min(viewportRows(0), Math.max(body.length, 3));
      lastBodyHeight = height;
      scroll = clampScroll(scroll, body.length - height);

      const lines: string[] = [];
      lines.push(border(`╭${"─".repeat(inner)}╮`));
      headerRow(lines, inner, body.length, height, scroll);
      for (const line of body.slice(scroll, scroll + height)) {
        lines.push(border("│") + " " + pad(line, contentWidth) + " " + border("│"));
      }
      for (let filler = body.slice(scroll, scroll + height).length; filler < height; filler += 1) {
        lines.push(border("│") + " ".repeat(inner) + border("│"));
      }
      chrome(lines, inner, body.length, height, scroll, "");
      return lines;
    };

    const renderSideBySide = (inner: number, contentWidth: number): string[] => {
      const gutter = 3; // " " + divider + " "
      const leftWidth = Math.floor((contentWidth - gutter) * 0.4);
      const rightWidth = contentWidth - gutter - leftWidth;

      const leftBody = summaryMarkdown!.render(leftWidth);
      const rightBody = implementationMarkdown!.render(rightWidth);
      const height = Math.min(viewportRows(1), Math.max(leftBody.length, rightBody.length, 3));
      lastBodyHeight = height;
      scrollSummary = clampScroll(scrollSummary, leftBody.length - height);
      scrollImplementation = clampScroll(scrollImplementation, rightBody.length - height);

      const paneRow = (left: string, right: string): string =>
        border("│") + " " + pad(left, leftWidth) + " " + divider() + " " + pad(right, rightWidth) + " " + border("│");
      const paneTitle = (name: string, active: boolean): string =>
        active ? theme.bg("selectedBg", theme.fg("accent", theme.bold(` ${name} `))) : theme.fg("muted", ` ${name} `);

      const activeBody = focus === "summary" ? leftBody : rightBody;
      const activeScroll = focus === "summary" ? scrollSummary : scrollImplementation;

      const lines: string[] = [];
      lines.push(border(`╭${"─".repeat(inner)}╮`));
      headerRow(lines, inner, activeBody.length, height, activeScroll);
      lines.push(paneRow(paneTitle("Summary", focus === "summary"), paneTitle("Implementation", focus === "implementation")));
      for (let row = 0; row < height; row += 1) {
        lines.push(paneRow(leftBody[scrollSummary + row] ?? "", rightBody[scrollImplementation + row] ?? ""));
      }
      chrome(lines, inner, activeBody.length, height, activeScroll, focus === "summary" ? "Summary" : "Implementation");
      return lines;
    };

    const page = (): number => Math.max(1, lastBodyHeight - 2);

    const scrollFocused = (delta: number): void => {
      if (lastSideBySide) {
        if (focus === "summary") scrollSummary += delta;
        else scrollImplementation += delta;
      } else {
        scroll += delta;
      }
    };

    const handleInput = (data: string): void => {
      if (matchesKey(data, Key.escape) || data === "q") return done(null);
      if (matchesKey(data, Key.enter)) return done(REVIEW_CHOICES[choice]!.id);
      if (data === "1" || data === "2" || data === "3") return done(REVIEW_CHOICES[Number(data) - 1]!.id);
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        if (sections) focus = focus === "summary" ? "implementation" : "summary";
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") scrollFocused(-1);
      else if (matchesKey(data, Key.down) || data === "j") scrollFocused(1);
      else if (matchesKey(data, Key.pageUp) || data === "b") scrollFocused(-page());
      else if (matchesKey(data, Key.pageDown) || data === " ") scrollFocused(page());
      else if (data === "g" || matchesKey(data, Key.home)) scrollFocused(-Number.MAX_SAFE_INTEGER);
      else if (data === "G" || matchesKey(data, Key.end)) scrollFocused(Number.MAX_SAFE_INTEGER);
      else if (matchesKey(data, Key.left)) choice = (choice + REVIEW_CHOICES.length - 1) % REVIEW_CHOICES.length;
      else if (matchesKey(data, Key.right)) choice = (choice + 1) % REVIEW_CHOICES.length;
      else return;
      tui.requestRender();
    };

    return {
      render,
      handleInput,
      invalidate: () => {
        markdown.invalidate();
        summaryMarkdown?.invalidate();
        implementationMarkdown?.invalidate();
      },
      focused: true,
    };
  };
}
