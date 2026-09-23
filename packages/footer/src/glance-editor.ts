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
import { getIcon, getResolvedIconStyle } from "./rendering/icons.js";
import { lolcatRainbow, paintLolcatGradient } from "./rendering/lolcat.js";

/** Live status injected by the footer extension. */
export interface GlanceStatus {
	/** Workspace/project directory name (bottom-left). */
	workspace: string;
	/** Active long-horizon mode label, beside the brand (null → omitted). */
	lhMode: string | null;
	/** Plan mode is active (top-right PLAN badge). */
	planMode: boolean;
	/** Permission mode (ask | auto | full) shown top-right (null → omitted). */
	permissionMode: string | null;
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
	/**
	 * Active Fusion pair, when selected. When set, the model slot renders
	 * `Fusion · <lead> <effort> ◆ <sidekick>` — lead lit, sidekick muted —
	 * and the plain thinking slot is suppressed (efforts are inline).
	 */
	fusion: { leadName: string; leadEffort: string; sidekickName: string; sidekickEffort: string; savedUsd?: number; busy?: boolean; leadToolCalls?: number; sidekickToolCalls?: number } | null;
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
const RESET = "\x1b[0m";
const LEAD_FG = "\x1b[1m\x1b[38;2;181;189;104m"; // bold accent (matches success tint)
const DIM_FG = "\x1b[38;2;120;124;134m"; // muted grey
const WARN_FG = "\x1b[38;2;214;140;60m"; // warning / full-permission
// PLAN badge: dark text on a warning-coloured block. Targeted-off closes keep
// the surrounding border span intact.
const PLAN_BG = "\x1b[1m\x1b[48;2;214;140;60m\x1b[38;2;26;20;14m";
const PLAN_BG_OFF = "\x1b[49m\x1b[39m\x1b[22m";

/** Top-right permission/plan cluster: ` PLAN  auto ` (plain text returned too). */
export function renderTopRightBadges(planMode: boolean, permissionMode: string | null): string {
	const parts: string[] = [];
	if (planMode) parts.push(`${PLAN_BG} PLAN ${PLAN_BG_OFF}`);
	if (permissionMode) {
		const painted =
			permissionMode === "full"
				? `${WARN_FG}${permissionMode}${RESET}`
				: permissionMode === "ask"
					? `${LEAD_FG}${permissionMode}${RESET}`
					: `${DIM_FG}${permissionMode}${RESET}`;
		parts.push(painted);
	}
	return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/** Same cluster without the permission label (narrow-terminal fallback). */
export function renderTopRightBadgesNoPermission(planMode: boolean): string {
	return planMode ? `${PLAN_BG} PLAN ${PLAN_BG_OFF} ` : "";
}

/**
 * Top-frame layout: the right cluster plus the rule fill, with the narrow-
 * terminal policy applied (drop the permission label first).
 */
export function planTopFrameWidths(
	safe: number,
	plainLeadWidth: number,
	planMode: boolean,
	permissionMode: string | null,
): { cluster: string; filler: number; permissionDropped: boolean } {
	const fits = (cluster: string): number => safe - 2 - plainLeadWidth - visibleWidth(stripControls(cluster));
	let cluster = renderTopRightBadges(planMode, permissionMode);
	let permissionDropped = false;
	if (cluster.length > 0 && fits(cluster) < 2) {
		const withoutPermission = renderTopRightBadgesNoPermission(planMode);
		if (withoutPermission !== cluster) {
			cluster = withoutPermission;
			permissionDropped = true;
		}
	}
	return { cluster, filler: Math.max(2, fits(cluster)), permissionDropped };
}

type FusionDisplay = NonNullable<GlanceStatus["fusion"]>;

export function renderFusionStatus(fusion: FusionDisplay): string {
	const lead = `${fusion.leadName}${fusion.leadEffort ? ` ${fusion.leadEffort}` : ""}`;
	const side = `${fusion.sidekickName}${fusion.sidekickEffort ? ` ${fusion.sidekickEffort}` : ""}`;
	const busy = fusion.busy === true;
	const leadCalls = fusion.leadToolCalls ?? 0;
	const sidekickCalls = fusion.sidekickToolCalls ?? 0;
	const totalCalls = leadCalls + sidekickCalls;
	const saved = fusion.savedUsd !== undefined && fusion.savedUsd > 0.005
		? ` · saved $${fusion.savedUsd.toFixed(2)}`
		: "";
	const split = totalCalls > 0 ? ` · ${String(sidekickCalls)}/${String(totalCalls)} calls` : "";
	const core = busy
		? `${DIM_FG}Fusion · ${lead}${RESET} ${LEAD_FG}◆ ${side} · working${RESET}`
		: `${LEAD_FG}Fusion · ${lead}${RESET} ${DIM_FG}◆ ${side}${RESET}`;
	const tail = `${split}${saved}`;
	return tail ? `${core}${DIM_FG}${tail}${RESET}` : core;
}

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
// Rendered per glyph as truecolor SGR — see rendering/lolcat.ts (issue #34:
// painting iterates code points so emoji surrogate pairs survive).

/**
 * Compose the glance frame titles for the active icon style.
 *
 * - emoji/nerd: glyph prefix before brand, branch and workspace.
 * - text: no robot glyph (brand word only); literal labels —
 *   `branch:main` on the top title, `workspace:unipi` bottom-left.
 */
export function composeGlanceTitles(
	brand: string,
	branch: string | null,
	workspace: string,
	lhMode: string | null = null,
): { titleParts: string[]; leftTitle: string } {
	const titleParts: string[] = [];
	if (getResolvedIconStyle() === "text") {
		titleParts.push(brand);
		if (lhMode) titleParts.push(`mode:${lhMode}`);
		if (branch) titleParts.push(`branch:${branch}`);
		return { titleParts, leftTitle: ` workspace:${workspace} ` };
	}
	const brandIcon = getIcon("model");
	titleParts.push(`${brandIcon ? brandIcon + " " : ""}${brand}`);
	if (lhMode) titleParts.push(lhMode);
	if (branch) {
		const gitIcon = getIcon("git");
		titleParts.push(`${gitIcon ? gitIcon + " " : ""}${branch}`);
	}
	const dirIcon = getIcon("directory");
	return { titleParts, leftTitle: ` ${dirIcon ? dirIcon + " " : ""}${workspace} ` };
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
	 * Kept as a protected hook for subclasses; painting itself lives in
	 * rendering/lolcat.ts (code-point-safe — issue #34).
	 */
	protected paintLolcatLine(line: string, phaseBase: number): string {
		return paintLolcatGradient(line, phaseBase);
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
		const { titleParts, leftTitle } = composeGlanceTitles(brand, st.branch, st.workspace, st.lhMode);
		const title = titleParts.join(SEP);
		const leadRule = `${BORDER.horizontal} `;
		const titleText = ` ${title}${SEP}`;
		// Right-aligned PLAN/permission cluster. Narrow terminals drop the
		// permission label first; the final truncateToWidth trims the rest.
		const plainLead = visibleWidth(stripControls(leadRule + titleText));
		const { cluster: topCluster, filler: topFiller } = planTopFrameWidths(
			safe,
			plainLead,
			st.planMode,
			st.permissionMode,
		);
		const top =
			border(BORDER.topLeft) +
			border(leadRule + titleText) +
			border(repeat(BORDER.horizontal, topFiller)) +
			topCluster +
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
		if (st.fusion) {
			rightParts.push(renderFusionStatus(st.fusion));
		} else {
			if (st.modelName) rightParts.push(st.modelName);
			if (st.thinkingLevel && st.thinkingLevel !== "off") {
				rightParts.push(`thinking:${st.thinkingLevel}`);
			}
		}
		// Workspace label per icon style (glyph prefix, or workspace: in text mode).
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
