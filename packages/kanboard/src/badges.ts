/**
 * @pi-unipi/kanboard — transcript badges (user-only, never LLM context).
 *
 * A successful lead `start` / `finish` / `move <ID> blocked` appends a custom
 * transcript entry rendered as `▣ UNI-30 started`, `✓ UNI-30 → In Review`,
 * `⊘ UNI-30 blocked: <comment>`. Custom entries persist for the user but are
 * outside the LLM context (same mechanism as core's progress bars).
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { kanboardInvocations } from "./guard.js";

export const BADGE_ENTRY = "unipi:kanboard-badge";

export type BadgeKind = "started" | "finished" | "blocked";

export interface BadgeData {
	kind: BadgeKind;
	id: string;
	/** Short human text (a blocked task carries what is needed). */
	text?: string;
}

/** The badge kind a kanboard CLI call produces, or null. */
export function badgeKindFor(sub: string, args: readonly string[]): BadgeKind | null {
	if (sub === "start") return "started";
	if (sub === "finish") return "finished";
	if (sub === "move" && args.includes("blocked")) return "blocked";
	return null;
}

/** Extract a badge from a successful kanboard bash call, or null. */
export function badgeFromToolCall(toolName: string, input: Record<string, unknown> | undefined, isError: boolean): BadgeData | null {
	if (isError || (toolName !== "bash" && toolName !== "powershell")) return null;
	for (const invocation of kanboardInvocations(String(input?.command ?? ""))) {
		const kind = badgeKindFor(invocation.sub, invocation.args);
		if (!kind) continue;
		const id = invocation.args.find((arg) => !arg.startsWith("-"));
		if (!id) continue;
		let text: string | undefined;
		if (kind === "blocked") {
			const flagIndex = invocation.args.indexOf("--comment");
			text = flagIndex >= 0 ? (invocation.args[flagIndex + 1] ?? "").replace(/^["']|["']$/g, "") : undefined;
		}
		return { kind, id, ...(text !== undefined && text.length > 0 ? { text } : {}) };
	}
	return null;
}

export function badgeText(data: BadgeData): string {
	if (data.kind === "started") return `▣ ${data.id} started`;
	if (data.kind === "finished") return `✓ ${data.id} → In Review`;
	const what = data.text ? `: ${data.text.slice(0, 80)}` : "";
	return `⊘ ${data.id} blocked${what}`;
}

function badgeColor(kind: BadgeKind): ThemeColor {
	if (kind === "started") return "accent";
	if (kind === "finished") return "success";
	return "warning";
}

/** Register the entry renderer (once per extension load; lead only). */
export function registerBadgeRenderer(pi: ExtensionAPI): void {
	try {
		pi.registerEntryRenderer<BadgeData>(BADGE_ENTRY, (entry, _options, theme) => {
			const data = entry.data;
			if (!data || typeof data.id !== "string") return undefined;
			const t = theme as unknown as {
				fg?: (color: ThemeColor, text: string) => string;
				bold?: (text: string) => string;
			};
			const line = t.fg?.(badgeColor(data.kind), badgeText(data)) ?? badgeText(data);
			return new Text(t.bold ? t.bold(line) : line, 0, 0);
		});
	} catch {
		// Renderer registration is UI-dependent; skip where unavailable.
	}
}

/** Emit a badge for a successful tool result (lead tool_result hook body). */
export function maybeBadgeToolResult(pi: ExtensionAPI, toolName: string, input: Record<string, unknown> | undefined, isError: boolean, width = 80): Component | null {
	const badge = badgeFromToolCall(toolName, input, isError);
	if (!badge) return null;
	try {
		pi.appendEntry<BadgeData>(BADGE_ENTRY, badge);
		return new Text(truncateToWidth(badgeText(badge), width), 0, 0);
	} catch {
		return null;
	}
}
