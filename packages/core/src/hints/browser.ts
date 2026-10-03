/**
 * /unipi:hint overlay browser built with hub-kit.
 *
 * Displays hints grouped by category with a header per category.
 * Each row shows the hint text and seen/unseen/learned status.
 * Type to filter live. Enter shows the hint above the editor and closes. Esc closes.
 */

import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { frameOverlay } from "../../tui-overlay.js";
import {
  hubExactRow,
  hubFrameTitle,
  hubHeaderBand,
  hubHintLine,
  hubKey,
  hubMaxRows,
  hubMoreAbove,
  hubMoreBelow,
  hubRowColumns,
  hubTheme,
  setHubTheme,
} from "../tui/hub-kit.js";
import type { Hint, HintCategory } from "./index.js";
import { loadHintStore } from "./store.js";

const CATEGORIES: readonly HintCategory[] = [
  "command",
  "shortcut",
  "setting",
  "capability",
  "explain",
  "trouble",
  "whatsnew",
  "workflow",
  "lore",
];

interface HintRow {
  readonly kind: "hint";
  readonly hint: Hint;
  readonly status: "learned" | "seen" | "unseen";
}

interface HeaderRow {
  readonly kind: "header";
  readonly category: HintCategory;
  readonly count: number;
}

type BrowserRow = HintRow | HeaderRow;

export function renderHintBrowser(
  hints: readonly Hint[],
  onSelect: (hint: Hint) => void,
  terminalRows = 30,
) {
  return (
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    done: (result: Hint | null) => void,
  ) => {
    setHubTheme(theme);
    const store = loadHintStore();

    let filter = "";
    let cursor = 0; // index into selectable HintRows
    let scroll = 0;

    function getSelectableRows(rows: readonly BrowserRow[]): HintRow[] {
      return rows.filter((r): r is HintRow => r.kind === "hint");
    }

    function buildRows(): BrowserRow[] {
      const q = filter.trim().toLowerCase();
      const rows: BrowserRow[] = [];

      for (const cat of CATEGORIES) {
        const matching = hints.filter((h) => {
          if (h.category !== cat) return false;
          if (!q) return true;
          return (
            h.text.toLowerCase().includes(q) ||
            h.id.toLowerCase().includes(q) ||
            h.category.toLowerCase().includes(q) ||
            (h.teaches && h.teaches.toLowerCase().includes(q))
          );
        });

        if (matching.length === 0) continue;

        rows.push({ kind: "header", category: cat, count: matching.length });
        for (const hint of matching) {
          const isLearned = store.learned.includes(hint.id);
          const count = store.counts[hint.id]?.count ?? 0;
          const status = isLearned ? "learned" : count > 0 ? "seen" : "unseen";
          rows.push({ kind: "hint", hint, status });
        }
      }
      return rows;
    }

    return {
      render(width: number): string[] {
        const rows = buildRows();
        const selectables = getSelectableRows(rows);
        const inner = Math.max(1, width - 2);
        const maxRows = hubMaxRows(terminalRows, filter ? 3 : 2);

        // Clamp cursor
        if (selectables.length === 0) {
          cursor = 0;
        } else if (cursor >= selectables.length) {
          cursor = selectables.length - 1;
        } else if (cursor < 0) {
          cursor = 0;
        }

        // Map selectable cursor to row index in rows
        const selectedHint = selectables[cursor];
        const selectedRowIdx = selectedHint ? rows.indexOf(selectedHint) : 0;

        // Viewport scrolling
        const kinds = rows.map((r) => r.kind);
        scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - maxRows)));
        if (selectedRowIdx < scroll) {
          scroll = selectedRowIdx;
        } else if (selectedRowIdx >= scroll + maxRows) {
          scroll = selectedRowIdx - maxRows + 1;
        }

        const visibleRows = rows.slice(scroll, scroll + maxRows);
        const body: string[] = [];

        // Filter line if typing
        if (filter) {
          body.push(hubExactRow(hubTheme.fg("textMuted", "  Filter: ") + hubTheme.bold(filter), inner));
        }

        // Top scroll indicator
        if (scroll > 0) {
          body.push(hubMoreAbove(scroll, inner));
        }

        for (const row of visibleRows) {
          if (row.kind === "header") {
            body.push(
              hubHeaderBand({
                inner,
                text: `${row.category.toUpperCase()} (${row.count})`,
                namespace: "hints",
              }),
            );
          } else {
            const isSelected = row === selectedHint;
            let statusTag = "unseen";
            if (row.status === "learned") statusTag = "learned";
            else if (row.status === "seen") {
              const c = store.counts[row.hint.id]?.count ?? 1;
              statusTag = c > 1 ? `seen ${c}x` : "seen";
            }
            body.push(
              hubRowColumns({
                inner,
                selected: isSelected,
                label: row.hint.text,
                value: statusTag,
                markNamespace: "hints",
              }),
            );
          }
        }

        // Bottom scroll indicator
        const hiddenBelow = rows.length - (scroll + visibleRows.length);
        if (hiddenBelow > 0) {
          body.push(hubMoreBelow(hiddenBelow, inner));
        }

        body.push(
          hubHintLine("Type to filter · ↑↓/jk move · Enter show · Esc close", inner),
        );

        return frameOverlay(body, width, {
          title: hubFrameTitle("unipi hints", filter ? [filter] : []),
        });
      },

      handleInput(data: string): void {
        const rows = buildRows();
        const selectables = getSelectableRows(rows);

        // Escape: clear filter or close
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          if (filter.length > 0) {
            filter = "";
            cursor = 0;
            scroll = 0;
          } else {
            done(null);
          }
          return;
        }

        // Enter: select hint and close
        if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
          const selected = selectables[cursor];
          if (selected) {
            onSelect(selected.hint);
            done(selected.hint);
          } else {
            done(null);
          }
          return;
        }

        // Navigation
        const key = hubKey(data);
        if (matchesKey(data, Key.up) || (filter === "" && data === "k")) {
          if (cursor > 0) cursor -= 1;
          return;
        }
        if (matchesKey(data, Key.down) || (filter === "" && data === "j")) {
          if (cursor < selectables.length - 1) cursor += 1;
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          cursor = Math.max(0, cursor - 10);
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          cursor = Math.min(selectables.length - 1, cursor + 10);
          return;
        }
        if (matchesKey(data, Key.home)) {
          cursor = 0;
          return;
        }
        if (matchesKey(data, Key.end)) {
          cursor = Math.max(0, selectables.length - 1);
          return;
        }

        // Backspace
        if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
          if (filter.length > 0) {
            filter = filter.slice(0, -1);
            cursor = 0;
            scroll = 0;
          }
          return;
        }

        // Printable text filtering
        if (typeof key === "object" && key.char !== undefined) {
          filter += key.char;
          cursor = 0;
          scroll = 0;
          return;
        }
        if (data.length === 1 && data >= " ") {
          filter += data;
          cursor = 0;
          scroll = 0;
        }
      },

      invalidate(): void {},
    };
  };
}
