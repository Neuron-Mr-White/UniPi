/**
 * @pi-unipi/footer — Glance-style input surface
 *
 * Faithful to @zhcsyncer/pi-glance's frame architecture (MIT, © 2026 linys77):
 * subclass CustomEditor, use super.render() ONLY to obtain editor content
 * lines, then compose our own rounded frame. Layout per the v3 design:
 *
 *   ╭─UNIPI │ feat/footer-default-v2 │ ─────────────────────╮
 *   │ Type your prompt here...                              │
 *   ╰─ unipi ────────── 42%/1.0M │ Claude Opus 4.5 │ thinking:high ╯
 *
 * Top border carries the UNIPI brand + git branch. Bottom border right side
 * carries workspace · context%/window · model · thinking level; left filler.
 * All keybindings/autocomplete/history/paste behavior inherited.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getIcon } from "./rendering/icons.js";

/** Live status injected by the footer extension. */
export interface GlanceStatus {
	/** Workspace/project directory name (bottom-left). */
	workspace: string;
	/** Git branch for the top title (null → omitted). */
	branch: string | null;
	/** Context usage percent (null when unknown). */
	contextPct: number | null;
	/** Context window size in tokens (for "42%/1.0M"). */
	contextWindow: number;
	/** Model display name (short). */
	modelName: string;
	/** Current thinking level (already "off"-filtered by the provider). */
	thinkingLevel: string | null;
}

const BORDER = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	vertical: "│",
	horizontal: "─",
} as const;

const SEP = " \u2502 "; // │

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

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}k`;
	return String(n);
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

		// Base render at inner width: harvest content rows only (rules dropped).
		const base = super.render(inner);
		if (base.length < 2) return base;

		const isRule = (line: string): boolean => {
			const plain = stripControls(line).trim();
			return plain.length > 0 && /^─+$/.test(plain);
		};

		let bottomIdx = -1;
		for (let i = base.length - 1; i >= 0; i--) {
			const plain = stripControls(base[i]).trim();
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

		// ── Top frame: ╭─ 󰚩 UNIPI │  feat/... │ ───────────────╮ ──
		// Brand rendered rainbow: one bright ANSI color per letter.
		const RAINBOW = ["\x1b[91m", "\x1b[93m", "\x1b[92m", "\x1b[96m", "\x1b[94m"];
		const brand = "UNIPI"
			.split("")
			.map((ch, i) => `${RAINBOW[i % RAINBOW.length]}${ch}\x1b[39m`)
			.join("");
		const brandIcon = getIcon("model");
		const titleParts = [
			`${brandIcon ? brandIcon + " " : ""}${brand}`,
		];
		if (st.branch) {
			const gitIcon = getIcon("git");
			titleParts.push(`${gitIcon ? gitIcon + " " : ""}${st.branch}`);
		}
		const title = titleParts.join(SEP);
		const leadRule = `${BORDER.horizontal} `;
		const titleText = ` ${title}${SEP}`;
		// Width ledger counts PLAIN text — strip SGR (rainbow codes) first.
		const topFiller = Math.max(
			2,
			safe - 2 - visibleWidth(stripControls(leadRule + titleText)),
		);
		const top =
			border(BORDER.topLeft) +
			border(leadRule + titleText) +
			border(repeat(BORDER.horizontal, topFiller)) +
			border(BORDER.topRight);

		// ── Body rows: │ content │ ──
		const bodyRows = contentLines.map(row =>
			border(BORDER.vertical) + padLine(row, inner) + border(BORDER.vertical),
		);

		// ── Bottom frame: ╰─ unipi ─────── [RIGHT CLUSTER] ─╯ ──
		// Right cluster: workspace · pct%/window │ model │ thinking:level
		const rightParts: string[] = [];
		const ctxPct = st.contextPct !== null ? Math.max(0, Math.min(100, st.contextPct)) : null;
		const pctLabel = ctxPct !== null ? `${Math.round(ctxPct)}%` : "?%";
		const winLabel = st.contextWindow > 0 ? `/${fmtTokens(st.contextWindow)}` : "";
		rightParts.push(`${pctLabel}${winLabel}`);
		if (st.modelName) rightParts.push(st.modelName);
		if (st.thinkingLevel && st.thinkingLevel !== "off") {
			rightParts.push(`thinking:${st.thinkingLevel}`);
		}
		// Workspace gets the folder nerd icon.
		const dirIcon = getIcon("directory");
		const leftTitle = ` ${dirIcon ? dirIcon + " " : ""}${st.workspace} `;
		let cluster = rightParts.join(SEP);

		// Shrink policy for narrow terminals: thinking first, then model tail.
		const maxCluster = inner - visibleWidth(leftTitle) - 8;
		while (visibleWidth(cluster) > Math.max(10, maxCluster)) {
			const parts = cluster.split("│");
			if (parts.length <= 1) break;
			parts.pop();
			cluster = parts.join("\u2502").trimEnd();
		}
		// ╰─ 󰉋 unipi ────...──── ─ cluster ─╯ : leading space separates the rule
		// from the right cluster. Ledger (all plain-width):
		// corner(1)+rule(1)+leftTitle+dashes+space(1)+cluster+space(1)+rule(1)+corner(1)=safe
		const bottomDashes = Math.max(
			2,
			safe - 6 - visibleWidth(stripControls(leftTitle)) - visibleWidth(stripControls(cluster)),
		);

		const bottom =
			border(BORDER.bottomLeft) +
			border(BORDER.horizontal) +
			border(leftTitle) +
			border(repeat(BORDER.horizontal, bottomDashes)) +
			" " + cluster + " " +
			border(BORDER.horizontal) +
			border(BORDER.bottomRight);

		const lines = [
			truncateToWidth(top, safe),
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
