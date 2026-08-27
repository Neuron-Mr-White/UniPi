/**
 * @pi-unipi/footer — Background process one-liner tests
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { countBgProcesses, renderProcessLine } from "../src/process-line.ts";
import {
  setSharedTaskRegistry,
  getSharedTaskRegistry,
  clearSharedTaskRegistry,
} from "../../background-tasks/src/registry-shared.ts";

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
});
