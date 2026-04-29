/**
 * @pi-unipi/info-screen — TUI Overlay Component (Cache-First Reactive)
 *
 * Opens immediately with cached data.
 * Each group loads independently in the background.
 * Reactive: re-renders as data arrives.
 * Shows humanized "last updated" timestamps.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { getInfoSettings } from "../config.js";
import { infoRegistry } from "../registry.js";
import type { GroupData, InfoGroup } from "../types.js";

/** Tab color palette */
const TAB_FG: Array<"accent" | "success" | "warning" | "error"> = [
	"accent",
	"success",
	"warning",
	"error",
];

/** Humanize a duration in ms to a short string */
function humanizeAge(ms: number): string {
	if (ms <= 0) return "never";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

/**
 * Info overlay component with cache-first reactive model.
 */
export class InfoOverlay implements Component {
	private groups: InfoGroup[] = [];
	private activeTabIndex = 0;
	private groupData = new Map<string, GroupData>();
	private groupLoading = new Map<string, boolean>();
	private scrollOffset = 0;
	private tabScrollOffset = 0;
	private lastGlobalUpdate = 0;
	private unsubscribers: Array<() => void> = [];
	private _destroyed = false;

	onClose?: () => void;
	requestRender?: () => void;

	private theme: Theme | null = null;

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	constructor() {
		// Load groups synchronously (they're already registered)
		this.groups = infoRegistry.getAllGroups();
		this.applyOrder();

		// Seed cache with any existing data (instant display)
		for (const group of this.groups) {
			const cached = infoRegistry.getCachedData(group.id);
			if (cached) {
				this.groupData.set(group.id, cached);
			}
			this.groupLoading.set(group.id, true);
		}

		// Subscribe to per-group updates for reactive rendering
		this.unsubscribers.push(
			infoRegistry.subscribeAll((groupId, data) => {
				if (this._destroyed) return;
				// Skip empty data from registration notifications — syncGroups()
				// will trigger the real fetch.
				if (Object.keys(data).length === 0) {
					this.requestRender?.();
					return;
				}
				this.groupData.set(groupId, data);
				this.groupLoading.set(groupId, false);
				this.lastGlobalUpdate = Date.now();
				this.requestRender?.();
			}),
		);

		// Start background fetch for all groups (non-blocking)
		this.fetchAllBackground();
	}

	/**
	 * Fetch all groups in background. Each resolves independently.
	 */
	private async fetchAllBackground(): Promise<void> {
		for (const group of this.groups) {
			// Fire each fetch independently — don't await sequentially
			infoRegistry
				.getGroupData(group.id)
				.then(() => {
					this.groupLoading.set(group.id, false);
				})
				.catch(() => {
					this.groupLoading.set(group.id, false);
				});
		}
	}

	/**
	 * Handle late-arriving groups (e.g., subagents announces after boot).
	 */
	private syncGroups(): void {
		const allGroups = infoRegistry.getAllGroups();
		const hadNewGroups = allGroups.length !== this.groups.length;
		if (hadNewGroups) {
			this.groups = allGroups;
			this.applyOrder();
		}

		// Ensure every group has real (non-empty) data.
		// Registration notifications inject `{}` to trigger re-sync; we must
		// not treat that as fetched data or the stats render as "—".
		for (const group of this.groups) {
			const existing = this.groupData.get(group.id);
			const hasRealData = existing && Object.keys(existing).length > 0;
			if (!hasRealData) {
				const cached = infoRegistry.getCachedData(group.id);
				if (cached && Object.keys(cached).length > 0) {
					this.groupData.set(group.id, cached);
				} else if (!this.groupLoading.get(group.id)) {
					this.groupLoading.set(group.id, true);
					infoRegistry
						.getGroupData(group.id)
						.then((data) => {
							this.groupData.set(group.id, data);
							this.groupLoading.set(group.id, false);
							this.lastGlobalUpdate = Date.now();
							this.requestRender?.();
						})
						.catch(() => {
							this.groupLoading.set(group.id, false);
						});
				}
			}
		}
	}

	private applyOrder(): void {
		const settings = getInfoSettings();
		if (settings.groupOrder && settings.groupOrder.length > 0) {
			const order = settings.groupOrder;
			this.groups.sort((a, b) => {
				const ai = order.indexOf(a.id);
				const bi = order.indexOf(b.id);
				return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
			});
		}
	}

	/**
	 * Cleanup subscriptions.
	 */
	destroy(): void {
		this._destroyed = true;
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
	}

	invalidate(): void {
		this.syncGroups();
	}

	handleInput(data: string): void {
		// Tab navigation: right arrow / l
		if (matchesKey(data, "right") || data === "l") {
			this.activeTabIndex = (this.activeTabIndex + 1) % this.groups.length;
			this.scrollOffset = 0;
		} else if (matchesKey(data, "left") || data === "h") {
			this.activeTabIndex =
				(this.activeTabIndex - 1 + this.groups.length) % this.groups.length;
			this.scrollOffset = 0;
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset++;
		} else if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (data === "g") {
			this.scrollOffset = 0;
		} else if (data === "G") {
			this.scrollOffset = Infinity;
		} else if (data === "r") {
			// Manual refresh
			this.refreshActiveGroup();
		} else if (data === "R") {
			// Refresh all
			this.refreshAll();
		} else if (data === "q" || matchesKey(data, "escape")) {
			this.destroy();
			this.onClose?.();
		}
	}

	private refreshActiveGroup(): void {
		const group = this.groups[this.activeTabIndex];
		if (!group) return;
		this.groupLoading.set(group.id, true);
		this.requestRender?.();
		infoRegistry.refreshGroup(group.id);
	}

	private refreshAll(): void {
		for (const group of this.groups) {
			this.groupLoading.set(group.id, true);
		}
		this.requestRender?.();
		infoRegistry.refreshAll();
	}

	render(width: number): string[] {
		// Sync groups in case late arrivals
		this.syncGroups();

		if (this.groups.length === 0) {
			return this.renderEmpty(width);
		}

		return this.renderDashboard(width);
	}

	// ─── Theme helpers ───────────────────────────────────────────────────

	private fg(color: string, text: string): string {
		if (this.theme) return this.theme.fg(color as any, text);
		const c: Record<string, string> = {
			accent: "\x1b[36m",
			success: "\x1b[32m",
			warning: "\x1b[33m",
			error: "\x1b[31m",
			dim: "\x1b[2m",
			borderMuted: "\x1b[90m",
		};
		return `${c[color] ?? ""}${text}\x1b[0m`;
	}

	private bold(text: string): string {
		return this.theme ? this.theme.bold(text) : `\x1b[1m${text}\x1b[0m`;
	}

	private bg(color: string, text: string): string {
		return this.theme ? this.theme.bg(color as any, text) : text;
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.fg("borderMuted", "│")}`;
	}

	private ruleLine(innerWidth: number): string {
		return this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private getDialogHeight(): number {
		const terminalRows = process.stdout.rows ?? 30;
		return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
	}

	// ─── State views ─────────────────────────────────────────────────────

	private renderEmpty(width: number): string[] {
		const innerWidth = Math.max(22, width - 2);
		const lines: string[] = [];
		lines.push(this.borderLine(innerWidth, "top"));
		lines.push(
			this.frameLine(
				this.fg("accent", this.bold("📊 UniPi Info Screen")),
				innerWidth,
			),
		);
		lines.push(this.ruleLine(innerWidth));
		lines.push(
			this.frameLine(this.fg("dim", "No groups registered."), innerWidth),
		);
		lines.push(
			this.frameLine(
				this.fg("dim", "Modules will register groups on startup."),
				innerWidth,
			),
		);
		for (let i = 0; i < 4; i++) lines.push(this.frameLine("", innerWidth));
		lines.push(this.ruleLine(innerWidth));
		lines.push(
			this.frameLine(this.fg("dim", "q/Esc close · r refresh"), innerWidth),
		);
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	// ─── Dashboard ───────────────────────────────────────────────────────

	private renderDashboard(width: number): string[] {
		const innerWidth = Math.max(22, width - 2);
		const group = this.groups[this.activeTabIndex];
		const data = this.groupData.get(group.id) ?? {};
		const isLoading = this.groupLoading.get(group.id) ?? false;

		const CONTENT_HEIGHT = 12;
		const lines: string[] = [];

		lines.push(this.borderLine(innerWidth, "top"));

		// Header: group name + loading indicator
		const loadingDot = isLoading
			? ` ${this.fg("warning", "●")}`
			: ` ${this.fg("success", "●")}`;
		const headerText =
			this.fg("accent", this.bold(` ${group.icon} ${group.name} `)) +
			loadingDot;
		lines.push(this.frameLine(headerText, innerWidth));
		lines.push(this.ruleLine(innerWidth));

		// Tab bar
		lines.push(this.frameLine(this.renderTabBar(innerWidth), innerWidth));
		lines.push(this.ruleLine(innerWidth));

		// Content with scrolling
		const contentLines = this.renderGroupContent(innerWidth, group, data);
		const wrapped = this.wrapLines(contentLines, innerWidth);
		const maxScroll = Math.max(0, wrapped.length - CONTENT_HEIGHT);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		const visible = wrapped.slice(
			this.scrollOffset,
			this.scrollOffset + CONTENT_HEIGHT,
		);
		for (let i = 0; i < CONTENT_HEIGHT; i++) {
			lines.push(this.frameLine(visible[i] ?? "", innerWidth));
		}

		// Footer
		lines.push(this.ruleLine(innerWidth));
		lines.push(
			this.frameLine(
				this.renderFooter(innerWidth, wrapped.length, CONTENT_HEIGHT),
				innerWidth,
			),
		);
		lines.push(this.borderLine(innerWidth, "bottom"));

		return lines;
	}

	private renderTabBar(width: number): string {
		if (this.groups.length === 0) return "";

		const tabWidths = this.groups.map((g) =>
			visibleWidth(` ${g.icon} ${g.name} `),
		);
		const sepW = visibleWidth(this.fg("borderMuted", "│"));
		const indicatorSpace = 3;
		let maxTabs = 0;
		let totalW = 0;
		for (let i = 0; i < this.groups.length; i++) {
			const add = (i > 0 ? sepW : 0) + tabWidths[i]!;
			if (totalW + add > width - 2 - indicatorSpace) break;
			totalW += add;
			maxTabs = i + 1;
		}

		if (maxTabs >= this.groups.length) {
			return this.renderAllTabs();
		}

		if (this.activeTabIndex < this.tabScrollOffset) {
			this.tabScrollOffset = this.activeTabIndex;
		} else if (this.activeTabIndex >= this.tabScrollOffset + maxTabs) {
			this.tabScrollOffset = this.activeTabIndex - maxTabs + 1;
		}
		this.tabScrollOffset = Math.max(
			0,
			Math.min(this.tabScrollOffset, this.groups.length - maxTabs),
		);

		const tabs: string[] = [];
		for (
			let i = this.tabScrollOffset;
			i < this.tabScrollOffset + maxTabs && i < this.groups.length;
			i++
		) {
			const g = this.groups[i]!;
			const isActive = i === this.activeTabIndex;
			const color = TAB_FG[i % TAB_FG.length]!;
			// Per-tab loading indicator
			const isLoading = this.groupLoading.get(g.id) ?? false;
			const dot = isLoading ? this.fg("warning", "●") : "";

			if (isActive) {
				tabs.push(this.fg(color, this.bold(` ${g.icon} ${g.name} ${dot}`)));
			} else {
				tabs.push(this.fg("dim", ` ${g.icon} ${g.name} ${dot}`));
			}
		}

		const tabStr = tabs.join(this.fg("borderMuted", "│"));
		if (this.tabScrollOffset > 0) return `${this.fg("dim", "◀")} ${tabStr}`;
		if (this.tabScrollOffset + maxTabs < this.groups.length)
			return `${tabStr} ${this.fg("dim", "▶")}`;
		return tabStr;
	}

	private renderAllTabs(): string {
		const tabs: string[] = [];
		for (let i = 0; i < this.groups.length; i++) {
			const g = this.groups[i]!;
			const isActive = i === this.activeTabIndex;
			const color = TAB_FG[i % TAB_FG.length]!;
			const isLoading = this.groupLoading.get(g.id) ?? false;
			const dot = isLoading ? this.fg("warning", "●") : "";

			if (isActive) {
				tabs.push(this.fg(color, this.bold(` ${g.icon} ${g.name} ${dot}`)));
			} else {
				tabs.push(this.fg("dim", ` ${g.icon} ${g.name} ${dot}`));
			}
		}
		return tabs.join(this.fg("borderMuted", "│"));
	}

	private renderGroupContent(
		width: number,
		group: InfoGroup,
		data: GroupData,
	): string[] {
		const lines: string[] = [];
		const isLoading = this.groupLoading.get(group.id) ?? false;
		const visibleStats = infoRegistry.getVisibleStats(group.id);

		if (visibleStats.length === 0) {
			lines.push(`  ${this.fg("dim", "No stats configured for this group.")}`);
			return lines;
		}

		// If no data yet and loading, show placeholder per stat
		if (Object.keys(data).length === 0 && isLoading) {
			for (const stat of visibleStats) {
				lines.push(
					`  ${this.fg("dim", `${stat.label}:`)} ${this.fg("warning", "···")}`,
				);
			}
			return lines;
		}

		const maxLabelLen = Math.max(...visibleStats.map((s) => s.label.length));

		for (const stat of visibleStats) {
			const statData = data[stat.id];
			const value = statData?.value ?? "—";
			const detail = statData?.detail;

			const label = `${stat.label}:`.padEnd(maxLabelLen + 1);
			let line = `  ${this.fg("dim", label)} ${this.bold(value)}`;

			if (detail) {
				const detailLines = detail.split("\n");
				if (detailLines.length === 1) {
					line += ` ${this.fg("dim", `(${detail})`)}`;
				} else {
					lines.push(line);
					for (const dLine of detailLines) {
						const indent = " ".repeat(maxLabelLen + 4);
						let detailLine = `${indent}${dLine}`;
						if (visibleWidth(detailLine) > width - 2) {
							detailLine = truncateToWidth(detailLine, width - 2);
						}
						lines.push(detailLine);
					}
					continue;
				}
			}

			if (visibleWidth(line) > width - 2) {
				line = truncateToWidth(line, width - 2);
			}

			lines.push(line);
		}

		return lines;
	}

	private renderFooter(
		width: number,
		totalLines: number,
		visibleHeight: number,
	): string {
		const hasScroll = totalLines > visibleHeight;
		let scrollStr = "";
		if (hasScroll) {
			scrollStr = this.fg(
				"dim",
				`${this.scrollOffset + 1}-${Math.min(this.scrollOffset + visibleHeight, totalLines)}/${totalLines}`,
			);
		}

		// Last updated for active group
		const group = this.groups[this.activeTabIndex];
		const lastUp = infoRegistry.getLastUpdated(group?.id ?? "");
		const age = lastUp > 0 ? humanizeAge(Date.now() - lastUp) : "loading…";

		const hints = [
			`${this.fg("accent", "←/→")} tabs`,
			`${this.fg("success", "↑/↓")} scroll`,
			`${this.fg("warning", "r")} refresh`,
			`${this.fg("error", "q/Esc")} close`,
		];

		const hintStr = hints.join(`  ${this.fg("borderMuted", "•")}  `);

		// Build right side: age + hints
		const ageStr = this.fg("dim", `⏱ ${age}`);
		const rightStr = `${ageStr}  ${this.fg("borderMuted", "│")}  ${hintStr}`;

		const scrollW = visibleWidth(scrollStr);
		const rightW = visibleWidth(rightStr);
		const gap = 4;
		const totalW = scrollW + gap + rightW;

		if (totalW >= width - 2) {
			return truncateToWidth(rightStr, width - 2);
		}

		const padding = " ".repeat(Math.max(0, width - 2 - totalW));
		return scrollStr + padding + rightStr;
	}

	private wrapLines(lines: string[], innerWidth: number): string[] {
		const wrapped: string[] = [];
		for (const line of lines) {
			if (!line) {
				wrapped.push("");
				continue;
			}
			wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
		}
		return wrapped;
	}
}
