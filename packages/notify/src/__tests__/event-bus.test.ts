/**
 * Test: Notify — event bus registration
 *
 * Verifies the notify routing convention: pi lifecycle events via pi.on(),
 * internal unipi:* events via the central bus (bus.on), and foreign
 * cross-extension events via pi.events.on().
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../../");

function readSource(relativePath: string): string {
  const fullPath = join(ROOT, relativePath);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
  return readFileSync(fullPath, "utf-8");
}

// ─── Known lifecycle events (mirrors LIFECYCLE_EVENTS in events.ts) ──

const LIFECYCLE_EVENTS = new Set([
  "agent_end",
  "agent_settled",
  "session_shutdown",
]);

// ─── Test: events.ts correctly uses pi.events.on() for custom events ──

describe("notify — event bus registration", () => {
  it("events.ts defines LIFECYCLE_EVENTS with correct lifecycle events", () => {
    const src = readSource("packages/notify/events.ts");

    const lifecycleMatch = src.match(
      /const LIFECYCLE_EVENTS\s*=\s*new Set\((\[.*?\])\)/s,
    );
    assert.ok(lifecycleMatch, "LIFECYCLE_EVENTS should be defined");

    const parsed = [...lifecycleMatch[1].matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepStrictEqual(
      parsed.sort(),
      [...LIFECYCLE_EVENTS].sort(),
      "LIFECYCLE_EVENTS should contain exactly agent_end, agent_settled, and session_shutdown",
    );
  });

  it("unipi:* events ride the central bus (bus.on), NOT pi.on() or pi.events.on()", () => {
    const src = readSource("packages/notify/events.ts");

    assert.match(
      src,
      /isUnipiEventName\(hook\)\)\s*\{\s*\/\/ Internal unipi events ride the central bus\.\s*unsubs\.push\(bus\.on\(pi, hook, handler\)\)/,
      "Internal unipi events should route through bus.on(pi, hook, handler)",
    );

    assert.doesNotMatch(
      src,
      /(?:\(pi\s+as\s+any\)|pi)\.on\s*\(\s*UNIPI_EVENTS\./,
      "Should NOT use pi.on() for custom unipi events",
    );
    assert.doesNotMatch(
      src,
      /pi\.events\.on\(UNIPI_EVENTS\./,
      "Should NOT use pi.events.on() for unipi:* events",
    );
  });

  it("lifecycle events (agent_end, agent_settled, session_shutdown) still use pi.on()", () => {
    const src = readSource("packages/notify/events.ts");

    assert.ok(
      src.includes("LIFECYCLE_EVENTS.has(eventKey)") &&
        src.includes("(pi as any).on(hook, handler)"),
      "Lifecycle events should be routed through pi.on() in the registration loop",
    );
  });
});

// ─── Test: index.ts only uses pi.on() for lifecycle events ──────────

describe("notify — index.ts event registration", () => {
  it("all pi.on() calls in index.ts use lifecycle events only", () => {
    const src = readSource("packages/notify/index.ts");

    const validLifecycleEvents = [
      "resources_discover",
      "session_start",
      "session_shutdown",
    ];

    const piOnPattern = /pi\.on\("([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = piOnPattern.exec(src)) !== null) {
      assert.ok(
        validLifecycleEvents.includes(match[1]),
        `index.ts: pi.on("${match[1]}") should be a lifecycle event`,
      );
    }
  });
});
