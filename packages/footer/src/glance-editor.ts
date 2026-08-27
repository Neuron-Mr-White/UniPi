/**
 * @pi-unipi/footer — Glance-style input surface
 *
 * Subclasses pi's CustomEditor so all default behavior (keybindings,
 * autocomplete, history, paste) is preserved, and overrides render() to draw
 * a glance-style bottom border row:
 *
 *   ─────────────────────────────────────────────
 *   prompt text here...
 *    workspace-name ─────────────── 42% · model
 *   ▲ (this row replaces the plain bottom-border rule)
 *
 * Learned from @zhcsyncer/pi-glance (rounded editor + inline status row).
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Live status injected by the footer extension each refresh tick. */
export interface GlanceStatus {
	/** Workspace/project directory name (bottom-left). */
	workspace: string;
	/** Context usage percent (null when unknown — fresh session/compacted). */
	contextPct: number | null;
	/** Model display name (short). */
	modelName: string;
}

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

function truncateToWidth(s: string, width: number): string {
	if (visibleWidth(stripAnsi(s)) <= width) return s;
	let out = "";
	for (const ch of s) {
		if (visibleWidth(stripAnsi(out + ch)) > width) break;
		out += ch;
	}
	return out;
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
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// The base Editor renders its bottom border as a full-width horizontal
		// rule (possibly color-wrapped). Find it from the bottom.
		let borderIdx = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			const plain = stripAnsi(lines[i]);
			if (plain.length > 0 && /^─+$/.test(plain)) {
				borderIdx = i;
				break;
			}
		}
		if (borderIdx === -1) return lines;

		const status = this.glance();
		const left = status.workspace.slice(0, 24);
		let right = status.modelName;
		if (status.contextPct !== null) right = `${Math.round(status.contextPct)}% \u00b7 ${right}`;

		const inner = Math.max(1, width - 2); // room for leading/trailing spaces
		const leftW = visibleWidth(left);
		const rightW = visibleWidth(right);

		let row: string;
		if (leftW + rightW + 4 <= inner) {
			const dashes = inner - leftW - rightW - 2;
			row = ` ${left} ${"\u2500".repeat(dashes)} ${right} `;
		} else if (leftW + 4 <= inner) {
			// drop the model/context side, keep workspace
			const dashes = Math.max(1, inner - leftW - 2);
			row = ` ${left} ${"\u2500".repeat(dashes)} `;
		} else {
			row = truncateToWidth(` ${left}`, inner);
		}

		lines[borderIdx] = this.borderColor(truncateToWidth(row, width));
		return lines;
	}
}
