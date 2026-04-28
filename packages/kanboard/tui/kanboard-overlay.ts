/**
 * @pi-unipi/kanboard — Kanboard TUI Overlay
 *
 * Two tabs: Tasks list and Kanban Board.
 * Uses pi-tui overlay API (same pattern as MCP add overlay).
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { ParsedDoc, ParsedItem, ItemStatus } from "../types.js";
import { createDefaultRegistry } from "../parser/index.js";

type Tab = "tasks" | "board";

interface KanboardState {
  tab: Tab;
  tasks: ParsedItem[];
  taskIndex: number;
  taskScroll: number;
  /** Board columns: index into tasks array grouped by status */
  boardColumns: {
    todo: number[];
    inProgress: number[];
    done: number[];
  };
  boardCol: number; // 0=todo, 1=inProgress, 2=done
  boardIndex: number[];
  pendingG: boolean;
  docsRoot: string;
}

/** Status icon */
function statusIcon(status: ItemStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "in-progress":
      return "◐";
    default:
      return "○";
  }
}

/** Pad string to visible width */
function padVisible(content: string, targetWidth: number): string {
  const pad = Math.max(0, targetWidth - visibleWidth(content));
  return content + " ".repeat(pad);
}

/**
 * Render the kanboard overlay.
 */
export function renderKanboardOverlay(params?: {
  docsRoot?: string;
  onComplete?: () => void;
}) {
  return (
    tui: any,
    theme: any,
    _kb: any,
    done: (result: { viewed: boolean } | null) => void,
  ) => {
    const state: KanboardState = {
      tab: "tasks",
      tasks: [],
      taskIndex: 0,
      taskScroll: 0,
      boardColumns: { todo: [], inProgress: [], done: [] },
      boardCol: 0,
      boardIndex: [0, 0, 0],
      pendingG: false,
      docsRoot: params?.docsRoot ?? ".unipi/docs",
    };

    // Load data
    let loaded = false;
    const ensureLoaded = async () => {
      if (loaded) return;
      const registry = await createDefaultRegistry();
      const docs = registry.parseAll(state.docsRoot);
      state.tasks = docs.flatMap((d) => d.items);

      // Build board columns
      state.boardColumns = { todo: [], inProgress: [], done: [] };
      state.tasks.forEach((item, idx) => {
        if (item.status === "done") state.boardColumns.done.push(idx);
        else if (item.status === "in-progress") state.boardColumns.inProgress.push(idx);
        else state.boardColumns.todo.push(idx);
      });

      // Init board indices
      state.boardIndex = [
        0,
        0,
        0,
      ];

      loaded = true;
    };

    const render = async () => {
      await ensureLoaded();

      const width = tui.width;
      const height = tui.height;
      const lines: string[] = [];

      // Header
      const header = " 📋 Kanboard ";
      const tabLine =
        "  [T]asks  |  [B]oard  ".replace(
          state.tab === "tasks" ? "[T]" : "T",
          state.tab === "tasks" ? "▸T" : " T",
        ).replace(
          state.tab === "board" ? "[B]" : "B",
          state.tab === "board" ? "▸B" : " B",
        );
      lines.push(truncateToWidth(header, width));
      lines.push(truncateToWidth(tabLine, width));
      lines.push("─".repeat(width));

      if (state.tab === "tasks") {
        renderTasksTab(lines, width, height - 5);
      } else {
        renderBoardTab(lines, width, height - 5);
      }

      // Footer
      lines.push("─".repeat(width));
      const footer = " j/k: navigate  Tab: switch tab  q/Esc: close ";
      lines.push(truncateToWidth(footer, width));

      tui.setContent(lines);
    };

    const renderTasksTab = (lines: string[], width: number, maxLines: number) => {
      if (state.tasks.length === 0) {
        lines.push(truncateToWidth("  No tasks found.", width));
        return;
      }

      // Ensure index in range
      state.taskIndex = Math.min(state.taskIndex, state.tasks.length - 1);
      state.taskIndex = Math.max(0, state.taskIndex);

      // Scroll to keep selected visible
      if (state.taskIndex < state.taskScroll) state.taskScroll = state.taskIndex;
      if (state.taskIndex >= state.taskScroll + maxLines) {
        state.taskScroll = state.taskIndex - maxLines + 1;
      }

      const visible = state.tasks.slice(
        state.taskScroll,
        state.taskScroll + maxLines,
      );

      for (let i = 0; i < visible.length; i++) {
        const item = visible[i];
        const globalIdx = state.taskScroll + i;
        const selected = globalIdx === state.taskIndex;
        const prefix = selected ? " ▸ " : "   ";
        const icon = statusIcon(item.status);
        const source = `[${item.sourceFile}]`;
        const line = `${prefix}${icon} ${item.text}  ${source}`;
        lines.push(
          truncateToWidth(
            selected ? `\x1b[7m${padVisible(line, width)}\x1b[0m` : line,
            width,
          ),
        );
      }
    };

    const renderBoardTab = (lines: string[], width: number, maxLines: number) => {
      const colWidth = Math.floor(width / 3);
      const cols: Array<{ title: string; indices: number[]; colIdx: number }> = [
        { title: "To Do", indices: state.boardColumns.todo, colIdx: 0 },
        { title: "In Progress", indices: state.boardColumns.inProgress, colIdx: 1 },
        { title: "Done", indices: state.boardColumns.done, colIdx: 2 },
      ];

      // Column headers
      let headerLine = "";
      for (const col of cols) {
        const isActive = col.colIdx === state.boardCol;
        const title = isActive ? `▸ ${col.title}` : `  ${col.title}`;
        headerLine += padVisible(` ${title} (${col.indices.length})`, colWidth);
      }
      lines.push(truncateToWidth(headerLine, width));
      lines.push("─".repeat(width));

      // Column items
      const maxItems = Math.max(
        ...cols.map((c) => c.indices.length),
        maxLines - 2,
      );
      for (let row = 0; row < Math.min(maxItems, maxLines - 2); row++) {
        let rowLine = "";
        for (const col of cols) {
          const active = col.colIdx === state.boardCol;
          const boardIdx = state.boardIndex[col.colIdx] ?? 0;
          if (row < col.indices.length) {
            const item = state.tasks[col.indices[row]];
            const selected = active && row === boardIdx;
            const icon = statusIcon(item.status);
            const text = truncateToWidth(` ${icon} ${item.text}`, colWidth - 1);
            if (selected) {
              rowLine += `\x1b[7m${padVisible(text, colWidth)}\x1b[0m`;
            } else {
              rowLine += padVisible(text, colWidth);
            }
          } else {
            rowLine += padVisible("", colWidth);
          }
        }
        lines.push(truncateToWidth(rowLine, width));
      }
    };

    const handleKey = async (key: any) => {
      await ensureLoaded();

      // Close
      if (matchesKey(key, "q") || matchesKey(key, "escape")) {
        done({ viewed: true });
        return;
      }

      // Tab switching
      if (matchesKey(key, "tab") || matchesKey(key, "b")) {
        state.tab = state.tab === "tasks" ? "board" : "tasks";
        render();
        return;
      }

      if (matchesKey(key, "t")) {
        state.tab = "tasks";
        render();
        return;
      }

      // Navigation
      if (state.tab === "tasks") {
        if (matchesKey(key, "j") || matchesKey(key, "down")) {
          state.taskIndex = Math.min(state.taskIndex + 1, state.tasks.length - 1);
        } else if (matchesKey(key, "k") || matchesKey(key, "up")) {
          state.taskIndex = Math.max(state.taskIndex - 1, 0);
        } else if (matchesKey(key, "g")) {
          if (state.pendingG) {
            state.taskIndex = 0;
            state.pendingG = false;
          } else {
            state.pendingG = true;
            setTimeout(() => {
              state.pendingG = false;
            }, 500);
          }
        } else if (matchesKey(key, "shift+g")) {
          state.taskIndex = state.tasks.length - 1;
        }
      } else {
        // Board navigation
        const cols = [
          state.boardColumns.todo,
          state.boardColumns.inProgress,
          state.boardColumns.done,
        ];

        if (matchesKey(key, "h") || matchesKey(key, "left")) {
          state.boardCol = Math.max(0, state.boardCol - 1);
        } else if (matchesKey(key, "l") || matchesKey(key, "right")) {
          state.boardCol = Math.min(2, state.boardCol + 1);
        } else if (matchesKey(key, "j") || matchesKey(key, "down")) {
          const col = cols[state.boardCol];
          state.boardIndex[state.boardCol] = Math.min(
            state.boardIndex[state.boardCol] + 1,
            col.length - 1,
          );
        } else if (matchesKey(key, "k") || matchesKey(key, "up")) {
          state.boardIndex[state.boardCol] = Math.max(
            state.boardIndex[state.boardCol] - 1,
            0,
          );
        }
      }

      render();
    };

    // Start
    render();
    tui.on("key", handleKey);
  };
}
