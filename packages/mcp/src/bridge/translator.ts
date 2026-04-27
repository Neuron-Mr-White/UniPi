/**
 * @pi-unipi/mcp — Tool translator
 *
 * Converts MCP tool schemas to pi-compatible ExternalTool format.
 * Naming convention: {serverName}__{toolName}
 */

import { MCP_DEFAULTS } from "@pi-unipi/core";
import type { McpTool, McpToolResult } from "../types.js";
import type { McpClient } from "./client.js";

/** Pi-compatible tool parameter schema */
interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** Pi-compatible external tool */
export interface PiExternalTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: string) => void,
  ) => Promise<string>;
}

/**
 * Translate an MCP tool definition to a pi-compatible external tool.
 *
 * @param mcpTool - The MCP tool schema from tools/list
 * @param serverName - Name of the MCP server this tool belongs to
 * @param client - The connected McpClient for executing calls
 * @returns A pi-compatible ExternalTool
 */
export function translateMcpTool(
  mcpTool: McpTool,
  serverName: string,
  client: McpClient,
): PiExternalTool {
  const separator = MCP_DEFAULTS.TOOL_NAME_SEPARATOR;
  const toolName = `${serverName}${separator}${mcpTool.name}`;

  // Ensure inputSchema is a valid JSON Schema object
  const inputSchema = mcpTool.inputSchema ?? {};
  const parameters: ToolParameters = {
    type: "object",
    properties:
      (inputSchema.properties as Record<string, unknown>) ?? {},
    required: inputSchema.required as string[] | undefined,
  };

  const description = [
    mcpTool.description || `MCP tool: ${mcpTool.name}`,
    `[Server: ${serverName}]`,
  ].join(" ");

  const execute = async (
    toolCallId: string,
    params: Record<string, unknown>,
    _signal?: AbortSignal,
    _onUpdate?: (update: string) => void,
  ): Promise<string> => {
    try {
      const result: McpToolResult = await client.callTool(
        mcpTool.name,
        params,
      );

      // Join all text content blocks
      const textParts: string[] = [];
      for (const block of result.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "image" && block.data) {
          textParts.push(`[Image: ${block.mimeType ?? "unknown"}]`);
        } else if (block.type === "resource") {
          textParts.push(`[Resource: ${block.text ?? block.mimeType ?? "unknown"}]`);
        }
      }

      if (result.isError) {
        const joined = textParts.join("\n") || "Unknown error";
        throw new Error(`MCP tool error from ${serverName}: ${joined}`);
      }

      return textParts.join("\n") || "(no output)";
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `MCP tool "${mcpTool.name}" on server "${serverName}" failed: ${message}\n` +
          `Check server status via /unipi:mcp-settings`,
      );
    }
  };

  return {
    name: toolName,
    description,
    parameters,
    execute,
  };
}
