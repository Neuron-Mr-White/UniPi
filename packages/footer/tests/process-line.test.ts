/**
 * @pi-unipi/footer — Background process one-liner tests
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { countBgProcesses, renderProcessLine, renderWaitingLine } from "../src/process-line.ts";
import {
  setSharedTaskRegistry,
  getSharedTaskRegistry,
  clearSharedTaskRegistry,
} from "../../background-tasks/src/registry-shared.ts";
import { registerWaitSource, resetArbiterForTests } from "@pi-unipi/core";

type FakeStatus = "running" | "completed" | "failed" | "killed";

function fakeRegistry(tasks: Array<{ status: FakeStatus }>) {
  return { allTasks: () => tasks } as unknown as Parameters<typeof setSharedTaskRegistry>[0];
}

describe("process-line", () => {
  beforeEach(() => {
    clearSharedTaskRegistry();
  });

  describe("shared registry accessor", () => {
    it("round-trips set/get/clear", () => {
      assert.equal(getSharedTaskRegistry(), undefined);
      const registry = fakeRegistry([]);
      setSharedTaskRegistry(registry);
      assert.equal(getSharedTaskRegistry(), registry);
      clearSharedTaskRegistry();
      assert.equal(getSharedTaskRegistry(), undefined);
    });
  });

  describe("countBgProcesses", () => {
    it("returns null when no registry is published", () => {
      assert.equal(countBgProcesses(), null);
    });

    it("maps TaskStatus to display buckets", () => {
      setSharedTaskRegistry(
        fakeRegistry([
          { status: "running" },
          { status: "running" },
          { status: "killed" },
          { status: "failed" },
          { status: "completed" },
          { status: "completed" },
          { status: "completed" },
        ]),
      );
      assert.deepEqual(countBgProcesses(), { running: 2, stopped: 1, failed: 1, done: 3 });
    });

    it("returns zeros for an empty registry", () => {
      setSharedTaskRegistry(fakeRegistry([]));
      assert.deepEqual(countBgProcesses(), { running: 0, stopped: 0, failed: 0, done: 0 });
    });
  });

  describe("renderProcessLine", () => {
    it("returns [] when no registry is published", () => {
      assert.deepEqual(renderProcessLine(80), []);
    });

    it("returns [] when all counts are zero", () => {
      setSharedTaskRegistry(fakeRegistry([]));
      assert.deepEqual(renderProcessLine(80), []);
    });

    it("omits zero-count buckets and colors dots per status", () => {
      setSharedTaskRegistry(fakeRegistry([{ status: "running" }, { status: "completed" }]));
      const lines = renderProcessLine(80);
      assert.equal(lines.length, 1);
      const line = lines[0];
      // green running + gray done; no stopped/failed text
      assert.match(line, /\x1b\[38;5;82m/);
      assert.match(line, /1 running/);
      assert.match(line, /\x1b\[38;5;245m/);
      assert.match(line, /1 done/);
      assert.ok(!line.includes("stopped"));
      assert.ok(!line.includes("failed"));
    });

    it("uses yellow for stopped and red for failed", () => {
      setSharedTaskRegistry(fakeRegistry([{ status: "killed" }, { status: "failed" }]));
      const line = renderProcessLine(80)[0];
      assert.match(line, /\x1b\[38;5;220m/);
      assert.match(line, /1 stopped/);
      assert.match(line, /\x1b\[38;5;196m/);
      assert.match(line, /1 failed/);
    });

    it("centers the line within width", () => {
      setSharedTaskRegistry(fakeRegistry([{ status: "running" }]));
      const width = 40;
      const line = renderProcessLine(width)[0];
      assert.ok(!line.includes("\t"));
      assert.equal(line.trimEnd().length, line.length);
      // leading pad + content, never exceeding width
      assert.ok(line.length <= width + 20); // ANSI codes add bytes beyond visible width
      assert.ok(line.trimStart().startsWith("\x1b[38;5;82m"));
    });

    it("handles zero and tiny widths", () => {
      setSharedTaskRegistry(fakeRegistry([{ status: "running" }]));
      assert.deepEqual(renderProcessLine(0), []);
      const tiny = renderProcessLine(4)[0];
      assert.ok(tiny.length > 0); // truncated, but present
    });
  });

  describe("renderWaitingLine (UNI-162)", () => {
    beforeEach(() => {
      resetArbiterForTests();
    });

    it("undefined when pi is busy, even with a pending wait source", () => {
      registerWaitSource("subagents", () => "subagent running");
      assert.equal(renderWaitingLine(80, () => false), undefined);
    });

    it("undefined when idle and nothing is pending", () => {
      assert.equal(renderWaitingLine(80, () => true), undefined);
    });

    it("shows the joined wait reasons when idle and something is pending", () => {
      registerWaitSource("background-tasks", () => "2 bg tasks will resume agent");
      registerWaitSource("subagents", () => "subagent running");
      const line = renderWaitingLine(80, () => true);
      assert.equal(line, " ⠋ Working… · 2 bg tasks will resume agent · subagent running");
    });

    it("a throwing isIdle counts as idle (same contract as the bg wake line)", () => {
      registerWaitSource("subagents", () => "subagent running");
      const line = renderWaitingLine(80, () => {
        throw new Error("boom");
      });
      assert.equal(line, " ⠋ Working… · subagent running");
    });

    it("respects width (never grows past a modest bound, truncation delegated to truncateToWidth)", () => {
      registerWaitSource("subagents", () => "a very long reason that will not fit in a narrow terminal");
      const line = renderWaitingLine(20, () => true);
      assert.ok(line !== undefined);
      // truncateToWidth may append an ellipsis char beyond the raw column
      // count; the important invariant is "much shorter than the full label".
      assert.ok(line.length < 40);
    });

    it("UNI-221: animates pi's spinner frames, shows elapsed time and applies colours", () => {
      registerWaitSource("background-tasks", () => "bg: npm test");
      const line = renderWaitingLine(80, () => true, {
        frame: 3,
        elapsedMs: 72_000,
        spinner: (t) => `<a>${t}</a>`,
        muted: (t) => `<m>${t}</m>`,
      });
      assert.equal(line, " <a>⠸</a> <a>Working…</a><m> · bg: npm test · 1m 12s</m>");
      const short = renderWaitingLine(80, () => true, { elapsedMs: 4_200 });
      assert.equal(short, " ⠋ Working… · bg: npm test · 4s");
    });

    it("undefined at width <= 1", () => {
      registerWaitSource("subagents", () => "subagent running");
      assert.equal(renderWaitingLine(1, () => true), undefined);
      assert.equal(renderWaitingLine(0, () => true), undefined);
    });
  });
});
