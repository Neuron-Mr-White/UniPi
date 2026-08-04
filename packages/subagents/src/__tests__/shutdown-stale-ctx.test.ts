/**
 * Test: background agents must not touch a stale extension runtime
 *
 * BUG — Pi crashed on exit with:
 *   "This extension ctx is stale after session replacement or reload."
 *   at pi.sendMessage (loader.js:240)
 *   at onComplete (packages/subagents/src/index.ts)
 *
 * Sequence:
 *  1. A background agent (e.g. the session-name generator) is still running.
 *  2. The user quits. Pi emits `session_shutdown`, then immediately calls
 *     `AgentSession.dispose()`, which invalidates the extension runtime.
 *  3. Our handler calls `abortAll()`, but aborting only *signals* the
 *     AbortController — the in-flight promise still settles on a later
 *     microtask and invokes the completion callback.
 *  4. That callback called `pi.sendMessage()`, which is `assertActive`-gated,
 *     so it threw from an async continuation with no catch → process crash.
 *
 * FIX — a `sessionEnded` flag set at the top of the `session_shutdown` handler
 * (before `abortAll()`), checked at the top of the completion callback, plus a
 * try/catch around `sendMessage` for the session-replacement race.
 *
 * The flag is scoped to the extension factory, not the module: `/new`,
 * `/fork` and `/resume` also emit `session_shutdown` and pi re-invokes the
 * factory for the replacement session, so a fresh closure resets it.
 * (Verified against pi 0.80.2: `/new` emits `shutdown reason=new`, then the
 * factory runs again with `ended=false`.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");

function readSource(relativePath: string): string {
  const fullPath = join(ROOT, relativePath);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
  return readFileSync(fullPath, "utf-8");
}

// ─── Behavioural: reproduce the race ────────────────────────────────

/**
 * Minimal stand-in for pi's runtime: every `assertActive`-gated method throws
 * once the session has been disposed.
 */
function createFakeRuntime() {
  let stale = false;
  return {
    invalidate() {
      stale = true;
    },
    sendMessage() {
      if (stale) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        );
      }
      return { delivered: true };
    },
    setSessionName() {
      if (stale) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        );
      }
    },
    // pi.events is NOT assertActive-gated — it keeps working.
    events: { emit() {} },
  };
}

/**
 * Reproduces the extension's shutdown wiring.
 *
 * @param guard - whether to apply the `sessionEnded` fix
 */
function simulateShutdownRace(guard: boolean) {
  const pi = createFakeRuntime();
  let sessionEnded = false;
  const errors: Error[] = [];

  // The completion callback registered with AgentManager.
  const onComplete = () => {
    if (guard && sessionEnded) return;
    pi.sendMessage();
  };

  // A background agent whose promise is still pending at shutdown.
  let settle!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    settle = resolve;
  }).then(() => {
    try {
      onComplete();
    } catch (error) {
      // In production this is an unhandled rejection that kills the process.
      errors.push(error as Error);
    }
  });

  // --- session_shutdown handler ---
  if (guard) sessionEnded = true; // must be set BEFORE abortAll()
  settle(); // abortAll(): signals abort; the promise settles a tick later
  // --- pi disposes the session right after handlers resolve ---
  pi.invalidate();

  return { done: inFlight, errors };
}

describe("shutdown race — background agent completing after dispose", () => {
  it("reproduces the stale-ctx crash without the guard", async () => {
    const { done, errors } = simulateShutdownRace(false);
    await done;

    assert.equal(errors.length, 1, "expected the unguarded path to throw");
    assert.match(errors[0].message, /stale after session replacement/);
  });

  it("does not touch the stale runtime with the guard", async () => {
    const { done, errors } = simulateShutdownRace(true);
    await done;

    assert.deepEqual(errors, [], "guarded path must not throw");
  });
});

// ─── Source contract: the wiring must stay correct ──────────────────

describe("subagents shutdown wiring", () => {
  const src = readSource("packages/subagents/src/index.ts");

  it("declares the sessionEnded guard", () => {
    assert.match(
      src,
      /let sessionEnded = false;/,
      "expected a `sessionEnded` guard flag",
    );
  });

  it("sets the guard before aborting, inside session_shutdown", () => {
    const handler = src.match(
      /pi\.on\(\s*"session_shutdown"[\s\S]*?\}\s*\);/,
    )?.[0];
    assert.ok(handler, "session_shutdown handler not found");

    const guardIdx = handler.indexOf("sessionEnded = true");
    const abortIdx = handler.indexOf("abortAll()");

    assert.notEqual(guardIdx, -1, "handler must set sessionEnded = true");
    assert.notEqual(abortIdx, -1, "handler must still call abortAll()");
    assert.ok(
      guardIdx < abortIdx,
      "sessionEnded must be set BEFORE abortAll(), which settles in-flight promises",
    );
  });

  it("checks the guard before any pi call in the completion callback", () => {
    const guardIdx = src.indexOf("if (sessionEnded) return;");
    assert.notEqual(guardIdx, -1, "completion callback must bail when sessionEnded");

    const sendIdx = src.indexOf("pi.sendMessage");
    assert.notEqual(sendIdx, -1, "expected a pi.sendMessage call");
    assert.ok(
      guardIdx < sendIdx,
      "the guard must be checked before pi.sendMessage is reached",
    );
  });

  it("wraps sendMessage in try/catch for the session-replacement race", () => {
    const block = src.match(/try\s*\{\s*pi\.sendMessage[\s\S]*?\}\s*catch\s*\{[\s\S]*?\}/);
    assert.ok(
      block,
      "pi.sendMessage must be wrapped in try/catch — a notification is best-effort",
    );
  });

  it("keeps setSessionName defensively wrapped", () => {
    // Badge generation also runs on a background agent.
    const block = src.match(/try\s*\{\s*pi\.setSessionName[\s\S]*?\}\s*catch/);
    assert.ok(block, "pi.setSessionName must stay wrapped in try/catch");
  });
});
