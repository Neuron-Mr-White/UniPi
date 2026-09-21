/**
 * FleetView tests — collapsed/active rendering, key navigation, entry
 * collection across both transports (in-process + async process runs).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../agent-manager.js";
import { collectFleetEntries, FleetView } from "../fleet-view.js";
import type { AgentActivity } from "../types.js";

let asyncDir: string;
let manager: AgentManager;
const activity = new Map<string, AgentActivity>();

beforeEach(() => {
  asyncDir = mkdtempSync(join(tmpdir(), "unipi-fleet-"));
  manager = new AgentManager(undefined, 4, undefined, {}, "/tmp", { user: {}, project: {} });
});

afterEach(() => {
  manager.dispose();
  rmSync(asyncDir, { recursive: true, force: true });
});

function writeRun(runId: string, status: Record<string, unknown>): void {
  const runDir = join(asyncDir, runId);
  mkdirSync(runDir, { recursive: true });
  // Default to a live same-process owner so "running" fixtures look active;
  // individual tests override ownerPid/sessionId to exercise scoping + heal.
  writeFileSync(
    join(runDir, "status.json"),
    JSON.stringify({ updatedAt: Date.now(), ownerPid: process.pid, ...status }),
  );
}

describe("collectFleetEntries", () => {
  it("merges in-process agents and async runs; active only; sorted by start", () => {
    writeRun("async-run-1", { status: "running", agent: "scout", startedAt: Date.now() - 5000 });
    writeRun("async-done", { status: "completed", agent: "worker" });

    const entries = collectFleetEntries(manager, activity, asyncDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source, "async");
    assert.equal(entries[0]!.agent, "scout");
    assert.ok(entries[0]!.runDir!.endsWith("async-run-1"));
  });

  it("drops crash orphans: a 'running' run whose owner pid is dead", () => {
    // A never-assigned pid on this host; process.kill(pid, 0) throws ESRCH.
    writeRun("crash-orphan", { status: "running", agent: "scout", ownerPid: 2_147_480_000 });
    writeRun("pid-pending", { status: "running", agent: "scout", ownerPid: "pending" });
    const entries = collectFleetEntries(manager, activity, asyncDir);
    assert.equal(entries.length, 0, "dead-owner runs must not haunt the dock");
  });

  it("session-scopes async runs when a sessionId is given", () => {
    writeRun("mine", { status: "running", agent: "scout", sessionId: "unipi-100" });
    writeRun("theirs", { status: "running", agent: "worker", sessionId: "unipi-999" });
    writeRun("legacy", { status: "running", agent: "reviewer" }); // no sessionId
    const scoped = collectFleetEntries(manager, activity, asyncDir, "unipi-100");
    assert.equal(scoped.length, 1);
    assert.ok(scoped[0]!.runDir!.endsWith("mine"));
    // Without scoping, all live runs are visible (back-compat path).
    const unscoped = collectFleetEntries(manager, activity, asyncDir);
    assert.equal(unscoped.length, 3);
  });
});

describe("FleetView", () => {
  const fakeUiCtx = () => {
    const widgets = new Map<string, unknown>();
    return {
      setWidget: (key: string, value: unknown) => {
        if (value === undefined) widgets.delete(key);
        else widgets.set(key, value);
      },
      getEditorText: () => "",
      widgets,
    };
  };

  it("no active work → no widget registered", () => {
    const view = new FleetView(manager, activity, asyncDir);
    const ui = fakeUiCtx();
    // @ts-expect-error structural mock
    view.setUICtx(ui);
    assert.equal(ui.widgets.size, 0);
    view.dispose();
  });

  it("active work registers the widget with a collapsed summary row", async () => {
    writeRun("proc-run", { status: "running", agent: "scout", startedAt: Date.now() });
    const view = new FleetView(manager, activity, asyncDir);
    const ui = fakeUiCtx();
    // @ts-expect-error structural mock
    view.setUICtx(ui);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(ui.widgets.has("unipi-fleet-status"));
      const renderFn = (ui.widgets.get("unipi-fleet-status") as (tui: unknown) => { render(w: number): string[] })(undefined);
      const lines = renderFn.render(80);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /1 active agent .*running/);
      assert.match(lines[0]!, /↓ to inspect/);
    } finally {
      view.dispose();
    }
  });

  it("↓ activates selection; j/k navigate; esc deactivates", async () => {
    writeRun("run-a", { status: "running", agent: "scout", startedAt: Date.now() });
    writeRun("run-b", { status: "running", agent: "worker", startedAt: Date.now() + 1 });
    const view = new FleetView(manager, activity, asyncDir);
    const ui = fakeUiCtx();
    // @ts-expect-error structural mock
    view.setUICtx(ui);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const consume = view.handleKey("\x1b[B", () => true); // down arrow
      assert.ok(consume?.consume);

      // j moves down through the roster
      view.handleKey("j", () => true);
      view.handleKey("k", () => true);

      // esc deactivates
      view.handleKey("\x1b", () => true);
      const renderFn = (ui.widgets.get("unipi-fleet-status") as (tui: unknown) => { render(w: number): string[] })(undefined);
      const lines = renderFn.render(80);
      assert.equal(lines.length, 1); // back to collapsed
    } finally {
      view.dispose();
    }
  });

  it("enter opens the inspector for the selected entry", async () => {
    writeRun("inspect-me", { status: "running", agent: "reviewer", startedAt: Date.now() });
    let inspected: string | undefined;
    const view = new FleetView(manager, activity, asyncDir, {
      openInspector: async (entry) => {
        inspected = entry.key;
      },
    });
    const ui = fakeUiCtx();
    // @ts-expect-error structural mock
    view.setUICtx(ui);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      view.handleKey("\x1b[B", () => true); // activate
      // move to first entry (index 1 in roster)
      view.handleKey("j", () => true);
      view.handleKey("\r", () => true); // enter
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(inspected, "async:inspect-me");
    } finally {
      view.dispose();
    }
  });

  it("placement follows config (aboveEditor)", async () => {
    writeRun("placed-run", { status: "running", agent: "scout", startedAt: Date.now() });
    const view = new FleetView(manager, activity, asyncDir, { placement: "aboveEditor" });
    const ui = fakeUiCtx();
    // @ts-expect-error structural mock
    view.setUICtx(ui);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(ui.widgets.has("unipi-fleet-status"));
    } finally {
      view.dispose();
    }
  });
});
