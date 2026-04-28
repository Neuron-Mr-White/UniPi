/**
 * Test: Badge Generation Flow
 *
 * Tests the full badge name generation flow to identify and verify
 * fixes for "Generating session name..." getting stuck.
 *
 * BUG 1 — Tool mismatch:
 * Background agent was told to "Call the set_session_name tool" but the tool
 * doesn't exist in the agent's session (only builtin tools available).
 * FIX: Changed prompt to output title directly, parse in onComplete callback.
 *
 * BUG 2 — Wrong event bus:
 * Cross-module events emitted via pi.events.emit() but listeners used pi.on()
 * (extension lifecycle events) — completely different event bus.
 * FIX: Changed all cross-module listeners to pi.events.on().
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

    const builtinMatch = src.match(
      /const BUILTIN_TOOL_NAMES\s*=\s*(\[.*?\])/s,
    );
    assert.ok(builtinMatch, "BUILTIN_TOOL_NAMES should be defined");

    const builtinTools: string[] = eval(builtinMatch[1]);
    assert.deepStrictEqual(builtinTools, [
      "read", "bash", "edit", "write", "grep", "find", "ls",
    ]);
  });

  it("set_session_name is NOT in the agent's tool list", () => {
    const src = readSource("packages/subagents/src/agent-runner.ts");
    const builtinMatch = src.match(
      /const BUILTIN_TOOL_NAMES\s*=\s*(\[.*?\])/s,
    );
    const tools: string[] = eval(builtinMatch![1]);
    assert.ok(!tools.includes("set_session_name"));
  });
});

// ─── Test: Prompt no longer references non-existent tool ───────────

describe("Badge generation — prompt fix", () => {
  it("prompt asks agent to OUTPUT the title directly (not call a tool)", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(
      src.includes("Reply with ONLY the title"),
      "Prompt should ask agent to reply with only the title",
    );

    assert.ok(
      !src.includes("Call the set_session_name tool"),
      "Prompt should NOT tell agent to call set_session_name",
    );
  });
});

// ─── Test: onComplete extracts name from result ────────────────────

describe("Badge generation — onComplete callback", () => {
  it("onComplete extracts name from agent result and calls pi.setSessionName", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(
      src.includes('record.description === "Generate session name"'),
      "Should detect badge generation agents by description",
    );

    assert.ok(
      src.includes("pi.setSessionName(name)"),
      "Should call pi.setSessionName with extracted name",
    );
  });
});

// ─── Test: Cross-module event bus — the critical fix ───────────────

describe("Badge generation — event bus (CRITICAL FIX)", () => {
  it("emitEvent uses pi.events.emit (not pi.on)", () => {
    const src = readSource("packages/core/utils.ts");

    assert.ok(
      src.includes("pi.events.emit(eventName, payload)"),
      "emitEvent should use pi.events.emit()",
    );
  });

  it("subagents listens via pi.events.on (NOT pi.on)", () => {
    const src = readSource("packages/subagents/src/index.ts");

    // Must use pi.events.on for cross-module events
    assert.ok(
      src.includes("pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST"),
      "Subagents should listen via pi.events.on",
    );

    // Should NOT use pi.on for custom events
    const piOnMatch = src.match(/pi\.on\(UNIPI_EVENTS\.BADGE_GENERATE_REQUEST/g);
    assert.ok(!piOnMatch, "Should NOT use pi.on() for cross-module events");
  });

  it("utility BADGE_GENERATE_REQUEST listener is removed (input handler already shows overlay)", () => {
    const src = readSource("packages/utility/src/index.ts");

    // Should NOT have a separate BADGE_GENERATE_REQUEST listener
    // The input handler already shows the overlay and emits the event
    assert.ok(
      !src.includes("pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST"),
      "Utility should NOT have a separate BADGE_GENERATE_REQUEST listener",
    );
  });

  it("workflow listens for MODULE_READY via pi.events.on (NOT pi.on)", () => {
    const src = readSource("packages/workflow/index.ts");

    assert.ok(
      src.includes("pi.events.on(UNIPI_EVENTS.MODULE_READY"),
      "Workflow should listen via pi.events.on",
    );

    const piOnMatch = src.match(/pi\.on\(UNIPI_EVENTS\.MODULE_READY/g);
    assert.ok(!piOnMatch, "Should NOT use pi.on() for cross-module events");
  });

  it("pi.on() is ONLY used for known lifecycle events", () => {
    const subagentsSrc = readSource("packages/subagents/src/index.ts");
    const utilitySrc = readSource("packages/utility/src/index.ts");

    // These are valid lifecycle events that should use pi.on()
    const validLifecycleEvents = [
      "session_start", "session_shutdown", "input",
      "tool_call", "tool_execution_start",
    ];

    // Check that pi.on() is only used with lifecycle events
    const piOnPattern = /pi\.on\("([^"]+)"/g;
    let match;
    while ((match = piOnPattern.exec(subagentsSrc)) !== null) {
      assert.ok(
        validLifecycleEvents.includes(match[1]),
        `subagents: pi.on("${match[1]}") should be a lifecycle event, use pi.events.on() for custom events`,
      );
    }
    while ((match = piOnPattern.exec(utilitySrc)) !== null) {
      assert.ok(
        validLifecycleEvents.includes(match[1]),
        `utility: pi.on("${match[1]}") should be a lifecycle event`,
      );
    }
  });
});

// ─── Test: Event flow ──────────────────────────────────────────────

describe("Badge generation — event flow", () => {
  it("utility emits BADGE_GENERATE_REQUEST on first input", () => {
    const src = readSource("packages/utility/src/index.ts");

    assert.ok(src.includes("BADGE_GENERATE_REQUEST"));
    assert.ok(src.includes('source: "input-hook"'));
  });

  it("BADGE_GENERATE_REQUEST event is defined in core", () => {
    const src = readSource("packages/core/events.ts");
    assert.ok(src.includes("BADGE_GENERATE_REQUEST"));
  });
});

// ─── Test: Model resolution ────────────────────────────────────────

describe("Badge generation — model resolution", () => {
  it("reads generationModel from badge.json instead of hardcoding", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(!src.includes('"openai/gpt-oss-20b"'));
    assert.ok(src.includes(".unipi/config/badge.json"));
    assert.ok(src.includes("parsed.generationModel"));
  });
});

// ─── Summary ───────────────────────────────────────────────────────

describe("Badge generation — ROOT CAUSE SUMMARY", () => {
  it("BUG 1 FIXED: prompt no longer references non-existent tool", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(!src.includes("Call the set_session_name tool"),
      "FIXED: prompt no longer tells agent to call set_session_name");
    assert.ok(src.includes("Reply with ONLY the title"),
      "FIXED: prompt asks agent to reply with only the title");
  });

  it("BUG 1 FIXED: onComplete extracts name and sets it directly", () => {
    const src = readSource("packages/subagents/src/index.ts");

    assert.ok(src.includes('record.description === "Generate session name"'),
      "FIXED: onComplete detects badge generation agents");
    assert.ok(src.includes("pi.setSessionName(name)"),
      "FIXED: onComplete calls pi.setSessionName directly");
  });

  it("BUG 2 FIXED: cross-module events use pi.events.on, not pi.on", () => {
    const subagentsSrc = readSource("packages/subagents/src/index.ts");
    const utilitySrc = readSource("packages/utility/src/index.ts");
    const workflowSrc = readSource("packages/workflow/index.ts");

    // Subagents: correct event bus
    assert.ok(
      subagentsSrc.includes("pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST"),
      "subagents: must use pi.events.on for BADGE_GENERATE_REQUEST",
    );

    // Utility: no duplicate listener (input handler already handles it)
    assert.ok(
      !utilitySrc.includes("pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST"),
      "utility: no duplicate BADGE_GENERATE_REQUEST listener",    );

    // Workflow: correct event bus
    assert.ok(
      workflowSrc.includes("pi.events.on(UNIPI_EVENTS.MODULE_READY"),
      "workflow: must use pi.events.on for MODULE_READY",
    );
  });
});
