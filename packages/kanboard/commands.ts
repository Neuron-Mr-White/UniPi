/**
 * @pi-unipi/kanboard — Command Registration
 *
 * Registers kanboard and kanboard-doctor commands.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { KANBOARD_COMMANDS, UNIPI_PREFIX } from "@pi-unipi/core";
import { renderKanboardOverlay } from "./tui/kanboard-overlay.js";

/** Register kanboard commands */
export function registerCommands(pi: ExtensionAPI): void {
	// kanboard — Show kanban board TUI overlay
	pi.registerCommand(`${UNIPI_PREFIX}${KANBOARD_COMMANDS.KANBOARD}`, {
		description: "Show kanban board with tasks and status columns",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.custom(
				renderKanboardOverlay({
					docsRoot: ".unipi/docs",
					onComplete: () => {},
				}),
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 60,
						anchor: "center",
						margin: 2,
					},
				},
			);
		},
	});

	// kanboard-doctor — Load doctor skill
	pi.registerCommand(`${UNIPI_PREFIX}${KANBOARD_COMMANDS.KANBOARD_DOCTOR}`, {
		description: "Diagnose and fix kanboard parser issues",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify("Loading kanboard-doctor skill...", "info");
			// The skill will be loaded by the skill system via resources_discover
		},
	});
}
