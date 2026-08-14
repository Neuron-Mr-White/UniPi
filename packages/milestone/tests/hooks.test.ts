import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  MILESTONE_SNAPSHOT_TYPE,
  registerSessionEndHook,
  registerSessionStartHook,
} from "../hooks.js";

const tempDirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-milestone-hooks-"));
  tempDirs.push(dir);
  return dir;
}

function writeMilestones(cwd: string, checked = false): void {
  const file = path.join(cwd, ".unipi/docs/MILESTONES.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Project Milestones\n\n## Phase 1: Foundation\n\n- [${checked ? "x" : " "}] Ship stable prefix\n`);
}

function customEntry(
  id: string,
  parentId: string | null,
  content: string,
  active = true,
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: MILESTONE_SNAPSHOT_TYPE,
    content,
    display: false,
    details: { active, workspace: "/workspace" },
  };
}

function hookHarness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const eventHandlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    events: {
      on(name: string, handler: (...args: any[]) => any) {
        eventHandlers.set(name, handler);
      },
    },
  };
  return { pi: pi as any, handlers, eventHandlers };
}

function context(cwd: string, branch: SessionEntry[] = []) {
  return {
    cwd,
    sessionManager: {
      getBranch: () => branch,
    },
  } as any;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("milestone snapshot hook", () => {
  it("injects nothing for a clean workspace with no effective milestone snapshot", () => {
    const cwd = workspace();
    const { pi, handlers } = hookHarness();
    registerSessionStartHook(pi);

    const result = handlers.get("before_agent_start")!({}, context(cwd));

    assert.equal(result, undefined);
  });

  it("returns a hidden append-only snapshot with workspace and supersession text", () => {
    const cwd = workspace();
    writeMilestones(cwd);
    const { pi, handlers } = hookHarness();
    registerSessionStartHook(pi);

    const result = handlers.get("before_agent_start")!({}, context(cwd));

    assert.equal(result.systemPrompt, undefined);
    assert.equal(result.message.customType, MILESTONE_SNAPSHOT_TYPE);
    assert.equal(result.message.display, false);
    assert.equal(result.message.details.active, true);
    assert.equal(result.message.details.workspace, cwd);
    assert.match(result.message.content, /supersedes all prior UniPi milestone snapshots/);
    assert.match(result.message.content, new RegExp(`Workspace: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.message.content, /Overall progress: 0\/1 items \(0%\)/);
  });

  it("deduplicates against the latest milestone message in effective LLM context", () => {
    const cwd = workspace();
    writeMilestones(cwd);
    const firstHarness = hookHarness();
    registerSessionStartHook(firstHarness.pi);
    const first = firstHarness.handlers.get("before_agent_start")!({}, context(cwd));
    const branch = [
      customEntry("stale-snapshot", null, "stale milestone state"),
      customEntry("latest-snapshot", "stale-snapshot", first.message.content),
    ];

    const secondHarness = hookHarness();
    registerSessionStartHook(secondHarness.pi);
    const result = secondHarness.handlers.get("before_agent_start")!({}, context(cwd, branch));

    assert.equal(result, undefined);
  });

  it("appends an inactive snapshot when an effective active snapshot must be cleared", () => {
    const cwd = workspace();
    const branch = [customEntry("snapshot", null, "older active snapshot")];
    const { pi, handlers } = hookHarness();
    registerSessionStartHook(pi);

    const result = handlers.get("before_agent_start")!({}, context(cwd, branch));

    assert.equal(result.message.details.active, false);
    assert.match(result.message.content, /Status: inactive/);
    assert.match(result.message.content, /No milestones are active/);
  });

  it("clears an active snapshot that compaction removed as a distinct message", () => {
    const cwd = workspace();
    const branch: SessionEntry[] = [
      customEntry("old-snapshot", null, "old active snapshot"),
      {
        type: "message",
        id: "kept",
        parentId: "old-snapshot",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "kept", timestamp: Date.now() },
      },
      {
        type: "compaction",
        id: "compaction",
        parentId: "kept",
        timestamp: new Date().toISOString(),
        summary: "The prior context included an active UniPi milestone snapshot.",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
      },
    ];
    const { pi, handlers } = hookHarness();
    registerSessionStartHook(pi);

    const result = handlers.get("before_agent_start")!({}, context(cwd, branch));

    assert.equal(result.message.details.active, false);
    assert.match(result.message.content, /Status: inactive/);
  });
});

describe("milestone session-end hook", () => {
  it("syncs against session_start ctx.cwd even if process.cwd changes", () => {
    const cwd = workspace();
    const otherCwd = workspace();
    writeMilestones(cwd);
    const plan = path.join(cwd, ".unipi/docs/plans/plan.md");
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, "## Phase 1: Foundation\n\n- [ ] Ship stable prefix\n");

    const { pi, handlers } = hookHarness();
    registerSessionEndHook(pi);
    handlers.get("session_start")!({}, context(cwd));

    fs.writeFileSync(plan, "## Phase 1: Foundation\n\n- [x] Ship stable prefix\n");
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(plan, future, future);

    const originalCwd = process.cwd();
    try {
      process.chdir(otherCwd);
      handlers.get("session_shutdown")!({}, context(otherCwd));
    } finally {
      process.chdir(originalCwd);
    }

    assert.match(
      fs.readFileSync(path.join(cwd, ".unipi/docs/MILESTONES.md"), "utf8"),
      /- \[x\] Ship stable prefix/,
    );
  });
});
