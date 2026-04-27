/**
 * @pi-unipi/notify — Agent tool registration
 *
 * Registers the `notify_user` tool for ad-hoc notifications.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { NOTIFY_TOOLS } from "@pi-unipi/core";
import { loadConfig } from "./settings.js";
import { dispatchNotification } from "./events.js";
import type { NotifyDispatchResult } from "./types.js";

/** Schema for notify_user tool parameters */
const NotifyUserSchema = Type.Object({
  message: Type.String({ description: "Notification message body" }),
  title: Type.Optional(
    Type.String({ description: "Notification title (default: Pi Notification)" })
  ),
  priority: Type.Optional(
    Type.String({
      enum: ["low", "normal", "high"],
      default: "normal",
      description: "Priority level",
    })
  ),
  platforms: Type.Optional(
    Type.Array(
      Type.String({ enum: ["native", "gotify", "telegram"] }),
      { description: "Override platforms for this notification" }
    )
  ),
});

/**
 * Register the notify_user tool with pi.
 */
export function registerNotifyTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: NOTIFY_TOOLS.NOTIFY_USER,
    description:
      "Send a notification to the user's configured platforms (native OS, Gotify, Telegram). " +
      "Use for critical errors, completion of long-running tasks, or when the user explicitly asked to be notified.",
    parameters: NotifyUserSchema,
    handler: async (params: {
      message: string;
      title?: string;
      priority?: "low" | "normal" | "high";
      platforms?: Array<"native" | "gotify" | "telegram">;
    }) => {
      const config = loadConfig();

      // Resolve title
      const title = params.title || "Pi Notification";

      // Resolve platforms — use params.platforms or global defaults
      const platforms = params.platforms || config.defaultPlatforms;

      // Dispatch notification
      const result: NotifyDispatchResult = await dispatchNotification(
        pi,
        title,
        params.message,
        platforms,
        "agent_tool",
        config
      );

      // Format result
      const platformResults = result.results.map(
        (r) => `${r.platform}: ${r.success ? "✓ sent" : `✗ ${r.error || "failed"}`}`
      );

      return `Notification sent to ${result.results.length} platform(s):\n${platformResults.join("\n")}`;
    },
  });
}
