/**
 * @pi-unipi/footer — Glance-style input surface
 *
 * Faithful to @zhcsyncer/pi-glance's frame architecture (MIT, © 2026 linys77):
 * subclass CustomEditor, use super.render() ONLY to obtain editor content
 * lines, then compose our own rounded frame:
 *
 *   ╭ workspace ─────────────────────────────── status · model ╮
 *   │ prompt text here...                                      │
 *   ╰ ━━━━━━━━░░░░░ 42% · gpt-5.5 ──────────────────────────── ╯
 *
 * All keybindings/autocomplete/history/paste behavior is inherited from
 * CustomEditor; only paint differs.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Live status injected by the footer extension. */
export interface GlanceStatus {
	/** Workspace/project directory name (top-left title). */
	workspace: string;
	/** Context usage percent (null when unknown). */
	contextPct: number | null;
	/** Model display name (short). */
	modelName: string;
}

const BORDER = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	vertical: "│",
	horizontal: "─",
} as const;

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripControls(text: string): string {
	return text.replace(ANSI_RE, "").replace(/[\r\n\t]/g, " ");
}

function repeat(s: string, n: number): string {
	return s.repeat(Math.max(0, n));
}

function padLine(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	if (w < width) return line + " ".repeat(width - w);
	return truncateToWidth(line, width, "");
}

export class GlanceEditor extends CustomEditor {
	private glance: () => GlanceStatus;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getStatus: () => GlanceStatus,
		options?: EditorOptions,
	) {
		super(tui, theme, keybindings, options);
		this.glance = getStatus;
	}

	override render(width: number): string[] {
		const safe = Math.max(8, width);
		const inner = Math.max(0, safe - 2);

		// Base render at inner width: yields [topBorder?, ...content..., bottomBorder?] +
		// possible autocomplete lines after the bottom border. We keep only body-ish
		// rows between horizontal rules.
		const base = super.render(inner);
		if (base.length < 2) return base;

		// Classify rows: pure-horizontal-rule rows delimit content.
		const isRule = (line: string): boolean => {
			const plain = stripControls(line).trim();
			return plain.length > 0 && /^─+$/.test(plain);
		};

		let bottomIdx = -1;
		for (let i = base.length - 1; i >= 0; i--) {
			const plain = stripControls(base[i]).trim();
			// Bottom border row may include a scroll indicator like "↑ 2 more"
			if (/^─*(↑|↓)?/.test(plain) && (isRule(base[i]) || /^[^─]*─+[^─]*$/.test(plain))) {
				bottomIdx = i;
				break;
			}
		}
		if (bottomIdx < 1) return base;

		const contentLines = base.slice(0, bottomIdx).filter(l => !isRule(l));
		const autocomplete = base.slice(bottomIdx + 1);

		const st = this.glance();
		const border = this.borderColor.bind(this);
		const dim = (s: string) => this.borderColor(`\x1b[2m${s}\x1b[22m`);

		// ── Top frame: ╭─ workspace ──── ... ────╮ ──
		let left = st.workspace.slice(0, 48);
		const topTitle = visibleWidth(left) > 0 ? `${left} ` : "";
		// total = corner(1) + lead rule(1) + title + filler + corner(1) = safe
		const topFiller = Math.max(0, inner - visibleWidth(topTitle) - 1);
		const top =
			border(BORDER.topLeft) +
			border(BORDER.horizontal) +
			this.borderColor(topTitle) +
			border(repeat(BORDER.horizontal, topFiller)) +
			border(BORDER.topRight);

		// ── Body rows: │ content │ ──
		const bodyRows = contentLines.map(row =>
			border(BORDER.vertical) + padLine(row, inner) + border(BORDER.vertical),
		);

		// ── Bottom frame: ╰ [progress] pct% · model ────╯ ──
		const ctxPct = st.contextPct !== null ? Math.max(0, Math.min(100, Math.round(st.contextPct))) : null;

		// Progress bar occupies up to 1/3 of inner width when we know the percent.
		let mid: string;
		if (ctxPct !== null) {
			const barMax = Math.max(6, Math.floor(inner / 3));
			const filled = Math.round((barMax * ctxPct) / 100);
			const riskColor = ctxPct >= 85 ? "\x1b[31m" : ctxPct >= 70 ? "\x1b[33m" : "\x1b[36m";
			mid =
				`\x1b[39m${border(BORDER.horizontal)}\x1b[22m` +
				`${riskColor}${repeat("━", filled)}\x1b[39m` +
				dim(repeat("━", barMax - filled)) +
				` ${ctxPct}% · ${st.modelName} `;
		} else {
			mid = ` ${st.modelName} `;
		}
		let bottomMid = mid;
		// Shrink on narrow terminals: drop model first, then percent label.
		if (visibleWidth(stripControls(bottomMid)) > inner - 4) {
			bottomMid = ctxPct !== null ? ` ${ctxPct}% ` : "";
		}
		const bottomFiller = Math.max(0, inner - visibleWidth(stripControls(bottomMid)));
		const bottom =
			border(BORDER.bottomLeft) +
			bottomMid +
			border(repeat(BORDER.horizontal, bottomFiller)) +
			border(BORDER.bottomRight);

		const lines = [
			top,
			...bodyRows,
			truncateToWidth(bottom, safe),
		];

		// Autocomplete list indents by 1 col and sits below the frame (like base).
		for (const line of autocomplete) {
			lines.push(padLine(` ${line}`, safe));
		}
		return lines;
	}
}
