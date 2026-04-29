/**
 * @pi-unipi/kanboard — Kanboard TUI Overlay
 *
 * Two tabs: Tasks list and Kanban Board.
 * Implements pi-tui Component interface for ctx.ui.custom() integration.
 */

import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { createDefaultRegistry } from "../parser/index.js";
import type { ItemStatus, ParsedItem } from "../types.js";

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
 * Kanboard overlay Component for ctx.ui.custom().
 */
export class KanboardOverlay {
	private state: KanboardState;
	private loaded = false;
	private _destroyed = false;

	onClose?: () => void;
	requestRender?: () => void;

	constructor(params?: { docsRoot?: string; onComplete?: () => void }) {
		this.state = {
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
		this.onClose = params?.onComplete;

		// Start loading data in background
		this.ensureLoaded();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const registry = await createDefaultRegistry();
		const docs = registry.parseAll(this.state.docsRoot);
		this.state.tasks = docs.flatMap((d) => d.items);

		// Build board columns
		this.state.boardColumns = { todo: [], inProgress: [], done: [] };
		this.state.tasks.forEach((item, idx) => {
			if (item.status === "done") this.state.boardColumns.done.push(idx);
			else if (item.status === "in-progress")
				this.state.boardColumns.inProgress.push(idx);
			else this.state.boardColumns.todo.push(idx);
		});

		this.state.boardIndex = [0, 0, 0];
		this.loaded = true;
		this.requestRender?.();
	}

	destroy(): void {
		this._destroyed = true;
	}

	invalidate(): void {
		// No cached state to clear
	}

	handleInput(data: string): void {
		if (this._destroyed) return;

		// Close
		if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.destroy();
			this.onClose?.();
			return;
		}

		// Tab switching
		if (matchesKey(data, "tab") || data === "b") {
			this.state.tab = this.state.tab === "tasks" ? "board" : "tasks";
			this.requestRender?.();
			return;
		}

		if (data === "t") {
			this.state.tab = "tasks";
			this.requestRender?.();
			return;
		}

		// Navigation
		if (this.state.tab === "tasks") {
			if (matchesKey(data, "down") || data === "j") {
				this.state.taskIndex = Math.min(
					this.state.taskIndex + 1,
					this.state.tasks.length - 1,
				);
			} else if (matchesKey(data, "up") || data === "k") {
				this.state.taskIndex = Math.max(this.state.taskIndex - 1, 0);
			} else if (data === "g") {
				if (this.state.pendingG) {
					this.state.taskIndex = 0;
					this.state.pendingG = false;
				} else {
					this.state.pendingG = true;
					setTimeout(() => {
						this.state.pendingG = false;
					}, 500);
				}
			} else if (data === "G") {
				this.state.taskIndex = this.state.tasks.length - 1;
			}
		} else {
			// Board navigation
			const cols = [
				this.state.boardColumns.todo,
				this.state.boardColumns.inProgress,
				this.state.boardColumns.done,
			];

			if (matchesKey(data, "left") || data === "h") {
				this.state.boardCol = Math.max(0, this.state.boardCol - 1);
			} else if (matchesKey(data, "right") || data === "l") {
				this.state.boardCol = Math.min(2, this.state.boardCol + 1);
			} else if (matchesKey(data, "down") || data === "j") {
				const col = cols[this.state.boardCol];
				this.state.boardIndex[this.state.boardCol] = Math.min(
					this.state.boardIndex[this.state.boardCol] + 1,
					col.length - 1,
				);
			} else if (matchesKey(data, "up") || data === "k") {
				this.state.boardIndex[this.state.boardCol] = Math.max(
					this.state.boardIndex[this.state.boardCol] - 1,
					0,
				);
			}
		}

		this.requestRender?.();
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Header
		const header = " 📋 Kanboard ";
		const tabLine = "  [T]asks  |  [B]oard  "
			.replace(
				this.state.tab === "tasks" ? "[T]" : "T",
				this.state.tab === "tasks" ? "▸T" : " T",
			)
			.replace(
				this.state.tab === "board" ? "[B]" : "B",
				this.state.tab === "board" ? "▸B" : " B",
			);
		lines.push(truncateToWidth(header, width));
		lines.push(truncateToWidth(tabLine, width));
		lines.push("─".repeat(width));

		const contentHeight = 12;
		if (this.state.tab === "tasks") {
			this.renderTasksTab(lines, width, contentHeight);
		} else {
			this.renderBoardTab(lines, width, contentHeight);
		}

		// Footer
		lines.push("─".repeat(width));
		const footer = " j/k: navigate  Tab: switch tab  q/Esc: close ";
		lines.push(truncateToWidth(footer, width));

		return lines;
	}

	private renderTasksTab(
		lines: string[],
		width: number,
		maxLines: number,
	): void {
		if (this.state.tasks.length === 0) {
			lines.push(truncateToWidth("  No tasks found.", width));
			return;
		}

		// Ensure index in range
		this.state.taskIndex = Math.min(
			this.state.taskIndex,
			this.state.tasks.length - 1,
		);
		this.state.taskIndex = Math.max(0, this.state.taskIndex);

		// Scroll to keep selected visible
		if (this.state.taskIndex < this.state.taskScroll)
			this.state.taskScroll = this.state.taskIndex;
		if (this.state.taskIndex >= this.state.taskScroll + maxLines) {
			this.state.taskScroll = this.state.taskIndex - maxLines + 1;
		}

		const visible = this.state.tasks.slice(
			this.state.taskScroll,
			this.state.taskScroll + maxLines,
		);

		for (let i = 0; i < visible.length; i++) {
			const item = visible[i];
			const globalIdx = this.state.taskScroll + i;
			const selected = globalIdx === this.state.taskIndex;
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
	}

	private renderBoardTab(
		lines: string[],
		width: number,
		maxLines: number,
	): void {
		const colWidth = Math.floor(width / 3);
		const cols: Array<{ title: string; indices: number[]; colIdx: number }> = [
			{ title: "To Do", indices: this.state.boardColumns.todo, colIdx: 0 },
			{
				title: "In Progress",
				indices: this.state.boardColumns.inProgress,
				colIdx: 1,
			},
			{ title: "Done", indices: this.state.boardColumns.done, colIdx: 2 },
		];

		// Column headers
		let headerLine = "";
		for (const col of cols) {
			const isActive = col.colIdx === this.state.boardCol;
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
				const active = col.colIdx === this.state.boardCol;
				const boardIdx = this.state.boardIndex[col.colIdx] ?? 0;
				if (row < col.indices.length) {
					const item = this.state.tasks[col.indices[row]];
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
	}
}

/**
 * Factory function for ctx.ui.custom() integration.
 * Returns a render function compatible with pi-tui's custom overlay API.
 */
export function renderKanboardOverlay(params?: {
	docsRoot?: string;
	onComplete?: () => void;
}) {
	return (tui: any, _theme: any, _kb: any, done: () => void) => {
		const overlay = new KanboardOverlay({
			docsRoot: params?.docsRoot,
			onComplete: () => {
				done();
				params?.onComplete?.();
			},
		});
		overlay.requestRender = () => tui.requestRender();
		return {
			render: (w: number) => overlay.render(w),
			invalidate: () => overlay.invalidate(),
			handleInput: (data: string) => {
				overlay.handleInput(data);
			},
		};
	};
}
