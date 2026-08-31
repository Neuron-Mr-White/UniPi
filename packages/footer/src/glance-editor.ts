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

/**
 * Every invisible sequence pi-tui embeds in editor lines: CSI SGR, OSC 133
 * prompt-zone markers (`\x1b]133;A\x07`), and CURSOR_MARKER (`\x1b_pi:c\x07`,
 * an APC sequence for IME cursor placement). All are zero-width — they must
 * be skipped by BOTH painting and width math or the ledger drifts.
 */
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripControls(text: string): string {
	return text.replace(ANSI_RE, "").replace(/[\r\n\t]/g, " ");
}

function repeat(s: string, n: number): string {
	return s.repeat(Math.max(0, n));
}

/**
 * Frame width for a terminal of `terminalWidth` columns: one column SHORT of
 * the terminal (legacy 8-column floor preserved below 9 columns).
 *
 * Issue #31 invariant — the frame is repainted every second and pi-tui joins
 * the rewritten lines with "\r\n". A line at EXACTLY the terminal width hits
 * the auto-wrap threshold: on terminals that wrap immediately (and whenever
 * a glyph renders wider than visibleWidth() assumed) the cursor silently
 * advances one extra row per line, desyncing the differential renderer —
 * every refresh then paints a fresh frame copy one block lower until the
 * screen fills. Never writing the last column keeps every frame line below
 * the wrap threshold on every terminal.
 */
export function glanceFrameWidth(terminalWidth: number): number {
	if (!Number.isFinite(terminalWidth)) return 8;
	return Math.max(8, terminalWidth - 1);
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

// ─── Lolcat rainbow gradient (classic sine algorithm, animated) ─────────
//
// red   = sin(freq·i + phase)       · 127 + 128
// green = sin(freq·i + 2π/3 + phase) · 127 + 128
// blue  = sin(freq·i + 4π/3 + phase) · 127 + 128
// i = character position; phase advances with wall time so the gradient
// drifts across the word (lolcat -a behavior). Rendered as truecolor SGR.

const LOLCAT_FREQ = 0.9; // radians per char — short word → tight sweep

function lolcatRainbow(text: string, phase: number): string {
	return text
		.split("")
		.map((ch, i) => {
			const t = LOLCAT_FREQ * i + phase;
			const r = Math.round(Math.sin(t) * 127 + 128);
			const g = Math.round(Math.sin(t + (2 * Math.PI) / 3) * 127 + 128);
			const b = Math.round(Math.sin(t + (4 * Math.PI) / 3) * 127 + 128);
			return `\x1b[38;2;${r};${g};${b}m${ch}`;
		})
		.join("") + "\x1b[39m";
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

	/**
	 * Apply a flowing lolcat gradient to an already-composed frame line.
	 * Printable characters get per-position truecolor from the sine palette;
	 * existing SGR sequences pass through untouched (they mostly come from
		 * the brand itself, which already carries its own colors).
	 */
	protected paintLolcatLine(line: string, phaseBase: number): string {
		let out = "";
		let pos = 0;
		let i = 0;
		while (i < line.length) {
			const ch = line[i];
			if (ch === "\x1b") {
				const rest = line.slice(i);
				// Copy the whole escape sequence verbatim.
				const m = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(i));
				if (m) {
					out += m[0];
					i += m[0].length;
					continue;
				}
				// Zero-width string sequences: OSC 133 zone markers (\x1b]133;A
				// BEL) and the APC CURSOR_MARKER (\x1b_pi:c BEL). Painting their
				// bytes is what produced the "_pi:c" garbage in rainbow mode.
				const strSeq = /^\x1b[\]_][^\x07]*(?:\x07|\x1b\\)/.exec(rest);
				if (strSeq) {
					out += strSeq[0];
					i += strSeq[0].length;
					continue;
				}
			}
			const t = LOLCAT_FREQ * 0.35 * pos + phaseBase;
			const r = Math.round(Math.sin(t) * 127 + 128);
			const g = Math.round(Math.sin(t + (2 * Math.PI) / 3) * 127 + 128);
			const b = Math.round(Math.sin(t + (4 * Math.PI) / 3) * 127 + 128);
			out += `\u001b[38;2;${r};${g};${b}m${ch}`;
			pos++;
			i++;
		}
		return out + "\u001b[39m";
	}

	private static isThinkingHot(level: string | null | undefined): boolean {
		return level === "max" || level === "xhigh";
	}

	override render(width: number): string[] {
		// One column short of the terminal — see glanceFrameWidth() / issue #31.
		const safe = glanceFrameWidth(width);
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
		// Brand rendered as an animated lolcat gradient (phase from wall time;
		// the footer's 1s refresh timer re-renders, so it shimmers each tick).
		const brand = lolcatRainbow("UNIPI", Date.now() / 1000);
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

		// Thinking max/xhigh: the whole frame flows with an animated lolcat
		// gradient (phase from wall time; 1s refresh ticks drive the motion;
		// row offset makes the rainbow flow diagonally like full-screen lolcat).
		if (GlanceEditor.isThinkingHot(st.thinkingLevel)) {
			const phase = Date.now() / 700;
			for (let i = 0; i < lines.length; i++) {
				lines[i] = truncateToWidth(this.paintLolcatLine(lines[i], phase + i * 0.5), safe);
			}
		}

		// Autocomplete list indents by 1 col and sits below the frame (like base).
		for (const line of autocomplete) {
			lines.push(padLine(` ${line}`, safe));
		}
		return lines;
	}
}
