import { describe, expect, it } from "bun:test";
import { WorkflowLifecycle } from "./lifecycle.js";

const EVENT = { command: "work", fullCommand: "/unipi:work", args: "plan:test.md" };

describe("WorkflowLifecycle", () => {
  it("allows one active workflow and emits exactly one completion", () => {
    let now = 100;
    const lifecycle = new WorkflowLifecycle(() => now);

    expect(lifecycle.start(EVENT)).toBe(true);
    expect(lifecycle.start({ ...EVENT, command: "review" })).toBe(false);
    now = 175;

    expect(lifecycle.complete([{ role: "assistant", stopReason: "stop" } as any])).toEqual({
      ...EVENT,
      success: true,
      durationMs: 75,
    });
    expect(lifecycle.complete([])).toBeUndefined();
  });

  it("marks error and aborted assistant endings unsuccessful", () => {
    for (const stopReason of ["error", "aborted"]) {
      const lifecycle = new WorkflowLifecycle(() => 10);
      lifecycle.start(EVENT);
      expect(lifecycle.complete([{ role: "assistant", stopReason } as any])?.success).toBe(false);
    }
  });

  it("does not complete ordinary agent loops and reset clears active state", () => {
    const lifecycle = new WorkflowLifecycle();
    expect(lifecycle.complete([])).toBeUndefined();
    lifecycle.start(EVENT);
    lifecycle.reset();
    expect(lifecycle.complete([])).toBeUndefined();
  });
});
