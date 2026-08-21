/**
 * @pi-unipi/subagents — Output truncation + run/tool timeout defaults
 *
 * truncateOutput ported verbatim from pi-subagents src/shared/types.ts.
 * Timeout resolution follows their precedence: call param > agent frontmatter >
 * config > default (30min foreground; 5min for known-fast tools when
 * toolTimeoutMs is unset). Exemptions use OUR tool names.
 */

import { DEFAULT_MAX_OUTPUT, type MaxOutputConfig } from "./parity-types.js";
import { KNOWN_FAST_TOOLS, FAST_TOOL_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from "./parity-types.js";
import type { AgentConfig } from "./types.js";
import type { SubagentsConfig } from "./types.js";

// ============================================================================
// Output truncation
// ============================================================================

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalBytes?: number;
  originalLines?: number;
  artifactPath?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
  output: string,
  config: Required<MaxOutputConfig>,
  artifactPath?: string,
): TruncationResult {
  const lines = output.split("\n");
  const bytes = Buffer.byteLength(output, "utf-8");

  if (bytes <= config.bytes && lines.length <= config.lines) {
    return { text: output, truncated: false };
  }

  let truncatedLines = lines;
  if (lines.length > config.lines) {
    truncatedLines = lines.slice(0, config.lines);
  }

  let result = truncatedLines.join("\n");
  if (Buffer.byteLength(result, "utf-8") > config.bytes) {
    let low = 0;
    let high = result.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    result = result.slice(0, low);
  }

  const keptLines = result.split("\n").length;
  const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

  return {
    text: marker + result,
    truncated: true,
    originalBytes: bytes,
    originalLines: lines.length,
    artifactPath,
  };
}

export function resolveMaxOutput(
  callMaxOutput: MaxOutputConfig | undefined,
  config: SubagentsConfig | undefined,
): Required<MaxOutputConfig> {
  const fromConfig = config?.maxOutput;
  return {
    bytes: callMaxOutput?.bytes ?? fromConfig?.bytes ?? DEFAULT_MAX_OUTPUT.bytes,
    lines: callMaxOutput?.lines ?? fromConfig?.lines ?? DEFAULT_MAX_OUTPUT.lines,
  };
}

// ============================================================================
// Timeout resolution (reference precedence)
// ============================================================================

/**
 * Run-level deadline: call param > agent frontmatter > config > 30-minute
 * foreground backstop.
 */
export function resolveRunTimeoutMs(
  callTimeoutMs: number | undefined,
  agent: AgentConfig | undefined,
  config: SubagentsConfig | undefined,
): number {
  return (
    callTimeoutMs ??
    agent?.timeoutMs ??
    config?.timeoutMs ??
    DEFAULT_RUN_TIMEOUT_MS
  );
}

/**
 * Per-tool-call hard deadline: call param > agent frontmatter > config >
 * env (UNIPI_SUBAGENT_TOOL_TIMEOUT_MS) > 5-minute default for known-fast
 * tools only (long-running tools get no hard default).
 */
export function resolveToolTimeoutMs(
  callToolTimeoutMs: number | undefined,
  agent: AgentConfig | undefined,
  config: SubagentsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const envRaw = env.UNIPI_SUBAGENT_TOOL_TIMEOUT_MS;
  const envParsed =
    envRaw !== undefined && envRaw.trim() !== "" ? Number(envRaw) : undefined;
  if (envParsed !== undefined && (!Number.isInteger(envParsed) || envParsed <= 0)) {
    throw new Error("UNIPI_SUBAGENT_TOOL_TIMEOUT_MS must be a positive integer number of milliseconds.");
  }
  const configured = callToolTimeoutMs ?? agent?.toolTimeoutMs ?? config?.toolTimeoutMs ?? envParsed;
  if (configured !== undefined) return configured;
  // No configured value: hard timeout only for known-fast built-ins.
  return undefined;
}

/** Whether a tool gets the 5-minute known-fast default when nothing is configured. */
export function isKnownFastTool(toolName: string): boolean {
  return (KNOWN_FAST_TOOLS as readonly string[]).includes(toolName);
}

export function effectiveToolDeadlineMs(toolName: string, configured: number | undefined): number | undefined {
  return configured ?? (isKnownFastTool(toolName) ? FAST_TOOL_TIMEOUT_MS : undefined);
}

/** Tools exempt from hard tool timeouts (their legitimate purpose is waiting). */
export const TOOL_TIMEOUT_EXEMPT = new Set(["contact_supervisor", "intercom", "get_helper_result", "ask_user"]);
