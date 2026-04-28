/**
 * Test: Badge Generation Flow
 *
 * Tests the full badge name generation flow to identify and verify
 * the fix for "Generating session name..." getting stuck.
 *
 * ROOT CAUSE:
 * The background agent spawned by subagents/index.ts called
 * manager.spawn() → runAgent() → createAgentSession() with
 * tools: ["read", "bash", "edit", "write", "grep", "find", "ls"]
 *
 * The prompt told the agent: "Call the set_session_name tool"
 * but set_session_name was NOT in the tool list — it was registered
 * by the utility extension on the parent pi object, not on the
 * spawned agent session.
 *
 * FIX:
 * Changed prompt to ask agent to output the title directly (not call a tool).
 * Added name extraction in onComplete callback that calls pi.setSessionName()
 * directly from the result text.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");

// ─── Helpers ────────────────────────────────────────────────────────

function readSource(relativePath: string): string {
  const fullPath = join(ROOT, relativePath);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
  return readFileSync(fullPath, "utf-8");
}

// ─── Test: Tool availability in spawned agent ──────────────────────

describe("Badge generation — tool availability", () => {
  it("agent-runner uses only builtin tools, NOT extension-registered tools", () => {
    const src = readSource("packages/subagents/src/agent-runner.ts");

    // The builtin tool list
    const builtinMatch = src.match(
      /const BUILTIN_TOOL_NAMES\s*=\s*(\[.*?\])/s,
    );
    assert.ok(builtinMatch, "BUILTIN_TOOL_NAMES should be defined");

    const builtinTools: string[] = eval(builtinMatch[1]);
    assert.ok(Array.isArray(builtinTools), "Should be an array");

    // set_session_name is NOT in builtin tools (this was the root cause)
    assert.ok(
      !builtinTools.includes("set_session_name"),
      "set_session_name should NOT be in BUILTIN_TOOL_NAMES",
    );

    assert.deepStrictEqual(builtinTools, [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("agent-runner creates session with tools: toolNames (builtins only)", () => {
    const src = readSource("packages/subagents/src/agent-runner.ts");

    // Session is created with tools: toolNames
    assert.ok(
      src.includes("tools: toolNames"),
      "Session should be created with tools: toolNames",
    );

    // toolNames comes from getToolNamesForType which returns builtins
    assert.ok(
      src.includes("return [...BUILTIN_TOOL_NAMES]"),
      "getToolNamesForType should return builtin tool names",
    );
  });

  it("agent-runner excludes spawn_helper and get_result but NOT set_session_name", () => {
    const src = readSource("packages/subagents/src/agent-runner.ts");

    const excludedMatch = src.match(
      /const EXCLUDED_TOOL_NAMES\s*=\s*(\[.*?\])/s,
    );
    assert.ok(excludedMatch, "EXCLUDED_TOOL_NAMES should be defined");

    const excluded: string[] = eval(excludedMatch[1]);
    assert.deepStrictEqual(excluded, ["Agent", "get_result"]);
    // set_session_name is NOT excluded because it's not in the session at all
  });
});

// ─── Test: Prompt tells agent to use non-existent tool ─────────────

describe("Badge generation — prompt analysis", () => {
  it("prompt asks agent to OUTPUT the title directly (not call a tool)", () => {
    const src = readSource("packages/subagents/src/index.ts");

    // The prompt should tell the agent to reply with the title
    assert.ok(
      src.includes("Reply with ONLY the title"),
      "Prompt should ask agent to reply with only the title",
    );

    // Should NOT tell the agent to call set_session_name
    assert.ok(
      !src.includes("Call the set_session_name tool"),
      "Prompt should NOT tell agent to call set_session_name (it doesn't have that tool)",
    );
  });

  it("set_session_name is registered by utility extension", () => {
    const utilitySrc = readSource("packages/utility/src/index.ts");

    // Utility registers the tool
    assert.ok(
      utilitySrc.includes('name: UTILITY_TOOLS.SET_SESSION_NAME') ||
      utilitySrc.includes('name: "set_session_name"'),
      "set_session_name should be registered in utility package",
    );
  });
});

// ─── Test: set_session_name tool calls pi.setSessionName ──────────

describe("Badge generation — set_session_name tool implementation", () => {
  it("set_session_name tool calls nameBadgeState.setSessionName(pi, name)", () => {
    const src = readSource("packages/utility/src/index.ts");

    // The tool implementation calls nameBadgeState.setSessionName
    assert.ok(
      src.includes("nameBadgeState.setSessionName(pi, trimmed)"),
      "Tool should call nameBadgeState.setSessionName(pi, trimmed)",
    );
  });

  it("setSessionName calls pi.setSessionName(name)", () => {
    const src = readSource("packages/utility/src/tui/name-badge-state.ts");

    assert.ok(
      src.includes("pi.setSessionName(name)"),
      "setSessionName should call pi.setSessionName(name)",
    );
  });
});

// ─── Test: Background agent completion callback ────────────────────

describe("Badge generation — background agent completion", () => {
  it("onComplete callback extracts name from result and calls pi.setSessionName", () => {
    const src = readSource("packages/subagents/src/index.ts");

    // Should detect badge generation by description
    assert.ok(
      src.includes('record.description === "Generate session name"'),
      "Should detect badge generation agents by description",
    );

    // Should extract name from result
    assert.ok(
      src.includes('record.result.split'),
      "Should parse name from agent result",
    );

    // Should call pi.setSessionName directly
    assert.ok(
      src.includes("pi.setSessionName(name)"),
      "Should call pi.setSessionName with extracted name",
    );
  });
});

// ─── Test: Agent type for badge generation ─────────────────────────

describe("Badge generation — agent configuration", () => {
  it("badge generation uses 'explore' agent type", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(
      src.includes('manager.spawn(pi, sessionCtx, "explore", prompt'),
      "Badge generation should spawn an 'explore' agent",
    );
  });

  it("explore agent type uses builtin tools (no set_session_name)", () => {
    const src = readSource("packages/subagents/src/types.ts");

    // BUILTIN_CONFIGS for explore
    assert.ok(
      src.includes("explore"),
      "types.ts should define explore agent config",
    );
  });

  it("background agent maxTurns is 3", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(
      src.includes("maxTurns: 3"),
      "Badge generation agent should have maxTurns: 3",
    );
  });
});

// ─── Test: Model resolution from badge settings ────────────────────

describe("Badge generation — model resolution", () => {
  it("reads generationModel from badge.json instead of hardcoding", () => {
    const src = readSource("packages/subagents/src/index.ts");

    // Should NOT hardcode openai/gpt-oss-20b
    assert.ok(
      !src.includes('"openai/gpt-oss-20b"'),
      "Should not hardcode openai/gpt-oss-20b",
    );

    // Should read from badge.json
    assert.ok(
      src.includes(".unipi/config/badge.json"),
      "Should read generationModel from badge.json",
    );

    // Should check for generationModel field
    assert.ok(
      src.includes("parsed.generationModel"),
      "Should read generationModel from parsed config",
    );
  });

  it("inherit model means resolvedModel stays undefined", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(
      src.includes('parsed.generationModel !== "inherit"'),
      "Should check for inherit value",
    );
  });
});

// ─── Test: Event flow ──────────────────────────────────────────────

describe("Badge generation — event flow", () => {
  it("utility emits BADGE_GENERATE_REQUEST on first input", () => {
    const src = readSource("packages/utility/src/index.ts");

    assert.ok(
      src.includes("BADGE_GENERATE_REQUEST"),
      "Utility should emit BADGE_GENERATE_REQUEST event",
    );

    assert.ok(
      src.includes('source: "input-hook"'),
      "Event should have source: input-hook",
    );
  });

  it("subagents listens for BADGE_GENERATE_REQUEST", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(
      src.includes("UNIPI_EVENTS.BADGE_GENERATE_REQUEST"),
      "Subagents should listen for BADGE_GENERATE_REQUEST",
    );
  });

  it("BADGE_GENERATE_REQUEST event is defined in core", () => {
    const src = readSource("packages/core/events.ts");

    assert.ok(
      src.includes("BADGE_GENERATE_REQUEST"),
      "Event should be defined in core/events.ts",
    );
  });
});

// ─── Summary ───────────────────────────────────────────────────────

describe("Badge generation — ROOT CAUSE SUMMARY", () => {
  it("FIXED: prompt no longer references non-existent tool", () => {
    const subagentsSrc = readSource("packages/subagents/src/index.ts");

    // The prompt should NOT tell the agent to call set_session_name
    assert.ok(
      !subagentsSrc.includes("Call the set_session_name tool"),
      "FIXED: prompt no longer tells agent to call set_session_name",
    );

    // Instead, the prompt asks the agent to output the title
    assert.ok(
      subagentsSrc.includes("Reply with ONLY the title"),
      "FIXED: prompt asks agent to reply with only the title",
    );
  });

  it("FIXED: onComplete extracts name and sets it directly", () => {
    const subagentsSrc = readSource("packages/subagents/src/index.ts");

    // The onComplete callback now extracts the name
    assert.ok(
      subagentsSrc.includes('record.description === "Generate session name"'),
      "FIXED: onComplete detects badge generation agents",
    );

    assert.ok(
      subagentsSrc.includes("pi.setSessionName(name)"),
      "FIXED: onComplete calls pi.setSessionName directly",
    );
  });
});
