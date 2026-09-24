/**
 * Plan review overlay: the plan itself (rendered markdown, scrollable) with the
 * three decisions underneath. Replaces a bare "Plan ready — what next?" select,
 * which asked for approval without showing what was being approved.
 *
 * Keys: ↑/↓ or j/k scroll · PgUp/PgDn/Space page · g/G top/bottom ·
 *       ←/→ or Tab choose · 1/2/3 pick directly · Enter confirm · Esc keep planning.
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

function pad(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : truncateToWidth(text, width);
}

export function renderPlanReview(params: ReviewParams) {
  return (tui: TUI, theme: Theme, _kb: unknown, done: (choice: ReviewChoice | null) => void) => {
    const markdown = new Markdown(params.plan, 0, 0, getMarkdownTheme());
    let scroll = 0;
    let choice = 0;
    let lastBodyHeight = 10;
    let lastTotal = 0;

    const border = (text: string) => theme.fg("accent", text);
    const viewportRows = (): number => {
      const rows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
      // Overlay chrome: top/title/sep + sep/choices/sep/footer/bottom = 8 rows, plus margin.
      return Math.max(6, rows - 12);
    };

    const render = (width: number): string[] => {
      const inner = Math.max(20, width - 2);
      const contentWidth = inner - 2;
      const body = markdown.render(contentWidth);
      lastTotal = body.length;
      const height = Math.min(viewportRows(), Math.max(body.length, 3));
      lastBodyHeight = height;
      const maxScroll = Math.max(0, body.length - height);
      scroll = Math.min(Math.max(0, scroll), maxScroll);

      const lines: string[] = [];
      lines.push(border(`╭${"─".repeat(inner)}╮`));
      const where = body.length > height ? theme.fg("dim", ` ${scroll + 1}–${Math.min(scroll + height, body.length)} of ${body.length} `) : "";
      const title = ` ${theme.bold("Review plan")}  ${theme.fg("muted", params.path)}`;
      const titleWidth = inner - visibleWidth(where);
      lines.push(border("│") + pad(truncateToWidth(title, titleWidth), titleWidth) + where + border("│"));
      lines.push(border(`├${"─".repeat(inner)}┤`));

      for (const line of body.slice(scroll, scroll + height)) {
        lines.push(border("│") + " " + pad(line, contentWidth) + " " + border("│"));
      }
      for (let filler = body.slice(scroll, scroll + height).length; filler < height; filler += 1) {
        lines.push(border("│") + " ".repeat(inner) + border("│"));
      }

      // scroll hint row
      const more = body.length - (scroll + height);
      const hint = more > 0 ? theme.fg("dim", ` ↓ ${more} more line${more === 1 ? "" : "s"}`) : theme.fg("dim", " — end of plan —");
      lines.push(border("├") + pad(hint, inner) + border("┤"));

      const buttons = REVIEW_CHOICES.map((option, index) => {
        const label = ` ${index + 1} ${option.label} `;
        if (index !== choice) return theme.fg("muted", label);
        return option.id === "discard" ? theme.bg("selectedBg", theme.fg("error", theme.bold(label))) : theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
      }).join("  ");
      lines.push(border("│") + " " + pad(buttons, inner - 1) + border("│"));
      lines.push(border(`├${"─".repeat(inner)}┤`));
      const footer = theme.fg("dim", " ↑↓ scroll · space/pgdn page · ←→ choose · enter confirm · esc keep planning");
      lines.push(border("│") + pad(truncateToWidth(footer, inner), inner) + border("│"));
      lines.push(border(`╰${"─".repeat(inner)}╯`));
      return lines;
    };

    const page = (): number => Math.max(1, lastBodyHeight - 2);

    const handleInput = (data: string): void => {
      if (matchesKey(data, Key.escape) || data === "q") return done(null);
      if (matchesKey(data, Key.enter)) return done(REVIEW_CHOICES[choice]!.id);
      if (data === "1" || data === "2" || data === "3") return done(REVIEW_CHOICES[Number(data) - 1]!.id);
      if (matchesKey(data, Key.up) || data === "k") scroll -= 1;
      else if (matchesKey(data, Key.down) || data === "j") scroll += 1;
      else if (matchesKey(data, Key.pageUp) || data === "b") scroll -= page();
      else if (matchesKey(data, Key.pageDown) || data === " ") scroll += page();
      else if (data === "g" || matchesKey(data, Key.home)) scroll = 0;
      else if (data === "G" || matchesKey(data, Key.end)) scroll = lastTotal;
      else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) choice = (choice + REVIEW_CHOICES.length - 1) % REVIEW_CHOICES.length;
      else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) choice = (choice + 1) % REVIEW_CHOICES.length;
      else return;
      tui.requestRender();
    };

    return {
      render,
      handleInput,
      invalidate: () => markdown.invalidate(),
      focused: true,
    };
  };
}
