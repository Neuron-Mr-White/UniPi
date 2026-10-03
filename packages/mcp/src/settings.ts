/**
 * @pi-unipi/mcp — settings hub namespace ("mcp").
 *
 * The MCP module keeps no key/value settings of its own; its hub rows are
 * action entry points into the server-management overlays. Registered at
 * import (like most modules) so the hub and metadata tests see it without
 * activating the whole extension.
 */

import { MCP_COMMANDS, registerSettings } from "@pi-unipi/core";

registerSettings({
  namespace: "mcp",
  label: "MCP",
  defaults: {},
  schema: [
    {
      title: "Servers",
      description: "Server registry lives in its own overlay (catalog, jira, …)",
      fields: [
        {
          key: "configure",
          type: "action",
          label: "Configure MCP servers…",
          command: `unipi:${MCP_COMMANDS.SETTINGS}`,
          description: "Open the server registry: add, edit and enable servers.",
        },
        {
          key: "add",
          type: "action",
          label: "Add server…",
          command: `unipi:${MCP_COMMANDS.ADD}`,
          description: "Browse the catalog or paste a custom config.",
        },
        {
          key: "sync",
          type: "action",
          label: "Sync catalog…",
          description: "Refresh the server catalog from GitHub.",
          command: `unipi:${MCP_COMMANDS.SYNC}`,
        },
        {
          key: "reload",
          type: "action",
          label: "Reload servers…",
          description: "Restart pi to apply tool-schema changes safely.",
          command: `unipi:${MCP_COMMANDS.RELOAD}`,
        },
      ],
    },
  ],
});
