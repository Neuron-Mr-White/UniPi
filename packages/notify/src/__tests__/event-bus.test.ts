/**
 * Test: Notify — event bus registration
 *
 * Verifies that the notify plugin correctly uses pi.events.on() for custom
 * unipi events and pi.on() for pi lifecycle events — same pattern enforced
 * by subagents/badge-generation.test.ts.
 *
 * BUG 2 (Wrong event bus):
 * Cross-module events emitted via pi.events.emit() must be listened via
 * pi.events.on(), NOT pi.on() (which only dispatches lifecycle events).
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
      "LIFECYCLE_EVENTS should contain exactly agent_end and session_shutdown",
    );
  });

  it("unipi:* events use pi.events.on(), NOT pi.on()", () => {
    const src = readSource("packages/notify/events.ts");

    assert.match(
      src,
      /pi\.events\.on\(def\.hook,\s*handler\)/,
      "Custom unipi events should use pi.events.on(def.hook, handler)",
    );

    assert.doesNotMatch(
      src,
      /(?:\(pi\s+as\s+any\)|pi)\.on\s*\(\s*UNIPI_EVENTS\./,
      "Should NOT use pi.on() for custom unipi events",
    );
  });

  it("lifecycle events (agent_end, session_shutdown) still use pi.on()", () => {
    const src = readSource("packages/notify/events.ts");

    assert.ok(
      src.includes("LIFECYCLE_EVENTS.has(eventKey)") &&
        src.includes("(pi as any).on(def.hook, handler)"),
      "Lifecycle events should be routed through pi.on() in the registration loop",
    );
  });

  it("MODULE_READY listener uses pi.events.on()", () => {
    const src = readSource("packages/notify/events.ts");

    assert.match(
      src,
      /pi\.events\s*\.\s*on\s*\(\s*UNIPI_EVENTS\.MODULE_READY/,
      "MODULE_READY should use pi.events.on()",
    );

    assert.doesNotMatch(
      src,
      /(?:\(pi\s+as\s+any\)|pi)\.on\s*\(\s*UNIPI_EVENTS\.MODULE_READY/,
      "MODULE_READY should NOT use pi.on()",
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
