/**
 * @pi-unipi/mcp — Tool translator
 *
 * Converts MCP tool schemas to pi-compatible ExternalTool format.
 * Naming convention: {serverName}__{toolName}
 */

import { MCP_DEFAULTS, boundModelOutput } from "@pi-unipi/core";
import type { McpTool, McpToolResult } from "../types.js";
import type { McpClient } from "./client.js";

/** Client operation needed by translated tools. */
export type ToolCallClient = Pick<McpClient, "callTool">;

/** JSON object used as a Pi-compatible tool parameter schema. */
interface ToolParameters {
  [key: string]: unknown;
  type: "object";
  properties: Record<string, unknown>;
  required: unknown;
}

/** Content block returned by a pi tool */
interface PiContentBlock {
  type: "text";
  text: string;
}

/** Pi tool execution result shape */
interface PiToolResult {
  content: PiContentBlock[];
  details?: Record<string, unknown>;
}

/** Pi-compatible external tool */
export interface PiExternalTool {
  name: string;
  label: string;
  description: string;
  parameters: ToolParameters;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: string) => void,
  ) => Promise<PiToolResult>;
}

/**
 * Compare strings by JavaScript/Unicode UTF-16 code units.
 *
 * Unlike localeCompare(), this ordering does not depend on the host locale.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LITERAL_VALUE_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

function canonicalizeValue(
  value: unknown,
  key?: string,
  normalizeSchemaKeywords = true,
): unknown {
  if (Array.isArray(value)) {
    if (
      normalizeSchemaKeywords &&
      key === "required" &&
      value.every((item) => typeof item === "string")
    ) {
      return [...new Set(value as string[])].sort(compareCodeUnits);
    }
    return value.map((item) => canonicalizeValue(item, undefined, normalizeSchemaKeywords));
  }

  if (!isObject(value)) return value;

  const canonical: Record<string, unknown> = {};
  for (const objectKey of Object.keys(value).sort(compareCodeUnits)) {
    // Values under these JSON Schema keywords are literal application data,
    // not nested schemas. A property named `required` inside that data must
    // retain array order (for example under `const`).
    const childNormalizesSchemaKeywords =
      normalizeSchemaKeywords && !LITERAL_VALUE_KEYWORDS.has(objectKey);
    canonical[objectKey] = canonicalizeValue(
      value[objectKey],
      objectKey,
      childNormalizesSchemaKeywords,
    );
  }
  return canonical;
}

/**
 * Recursively clone and canonicalize a JSON Schema value.
 *
 * Object keys use locale-independent code-unit order. Arrays retain their
 * original order, except valid `required` arrays (arrays containing only
 * strings), which are sorted and deduplicated.
 */
export function canonicalizeJsonSchema(schema: unknown): unknown {
  return canonicalizeValue(schema);
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
  client: ToolCallClient,
): PiExternalTool {
  const separator = MCP_DEFAULTS.TOOL_NAME_SEPARATOR;
  const toolName = `${serverName}${separator}${mcpTool.name}`;

  // Preserve the existing Pi-facing top-level shape while cloning and
  // canonicalizing all nested property schemas. Forwarding additional MCP
  // top-level keywords is a separate provider-compatibility decision.
  const inputSchema = isObject(mcpTool.inputSchema) ? mcpTool.inputSchema : {};
  const normalizedSchema: Record<string, unknown> = {
    type: "object",
    properties: isObject(inputSchema.properties) ? inputSchema.properties : {},
    required: Array.isArray(inputSchema.required) ? inputSchema.required : [],
  };
  const parameters = canonicalizeJsonSchema(normalizedSchema) as ToolParameters;

  const description = [
    mcpTool.description || `MCP tool: ${mcpTool.name}`,
    `[Server: ${serverName}]`,
  ].join(" ");

  const execute = async (
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal?: AbortSignal,
    _onUpdate?: (update: string) => void,
  ): Promise<PiToolResult> => {
    try {
      const result: McpToolResult = await client.callTool(
        mcpTool.name,
        params,
      );

      // Defensive: some MCP servers return malformed results without content
      const contentBlocks = result.content ?? [];
      const blocks: PiContentBlock[] = [];

      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.data) {
          blocks.push({
            type: "text",
            text: `[Image: ${block.mimeType ?? "unknown"}]`,
          });
        } else if (block.type === "resource") {
          blocks.push({
            type: "text",
            text: `[Resource: ${block.text ?? block.mimeType ?? "unknown"}]`,
          });
        }
      }

      if (blocks.length === 0) {
        blocks.push({ type: "text", text: result.isError ? "Unknown error" : "(no output)" });
      }

      const rawText = blocks.map((block) => block.text).join("\n");
      const wrapper = result.isError ? `MCP tool error from ${serverName}: ` : "";
      const output = boundModelOutput(rawText, {
        maxBytes: Math.max(1024, MCP_DEFAULTS.MAX_MODEL_OUTPUT_BYTES - Buffer.byteLength(wrapper, "utf8")),
        artifactPrefix: `mcp-${serverName}-${mcpTool.name}`,
      });
      const visibleText = `${wrapper}${output.text}`;

      return {
        content: [{ type: "text", text: visibleText }],
        details: {
          error: result.isError || undefined,
          server: serverName,
          tool: mcpTool.name,
          truncated: output.truncated,
          originalBytes: output.originalBytes,
          artifactPath: output.artifactPath,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text:
              `MCP tool "${mcpTool.name}" on server "${serverName}" failed: ${message}\n` +
              `Check server status via /unipi:mcp-settings`,
          },
        ],
        details: { error: true, server: serverName, tool: mcpTool.name },
      };
    }
  };

  return {
    name: toolName,
    label: toolName,
    description,
    parameters,
    execute,
  };
}
