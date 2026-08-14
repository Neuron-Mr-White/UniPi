import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentManager } from "../agent-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempWorkspace(agent?: { name: string; enabled: boolean }): string {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-enablement-"));
  tempDirs.push(cwd);
  if (agent) {
    const dir = join(cwd, ".unipi", "config", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${agent.name}.md`),
      `---\ndescription: Test agent\nenabled: ${agent.enabled}\n---\nTest prompt.\n`,
    );
  }
  return cwd;
}

function spawn(manager: AgentManager, type: string, background: boolean): string {
  return manager.spawn({} as any, {} as any, type, "test", {
    description: "test agent",
    isBackground: background,
  });
}

describe("AgentManager type enablement", () => {
  it("rejects a JSON-disabled built-in before creating foreground or background records", () => {
    const manager = new AgentManager(undefined, 4, undefined, { work: { enabled: false } }, tempWorkspace());
    try {
      assert.throws(() => spawn(manager, "work", false), /Agent type "work" is disabled/);
      assert.throws(() => spawn(manager, "work", true), /Agent type "work" is disabled/);
      assert.equal(manager.listAgents().length, 0);
    } finally {
      manager.dispose();
    }
  });

  it("custom frontmatter self-disable wins even when JSON says enabled", () => {
    const cwd = tempWorkspace({ name: "reviewer", enabled: false });
    const manager = new AgentManager(undefined, 4, undefined, { reviewer: { enabled: true } }, cwd);
    try {
      assert.equal(manager.isTypeEnabled("reviewer"), false);
      assert.throws(() => spawn(manager, "reviewer", true), /disabled by configuration/);
      assert.equal(manager.listAgents().length, 0);
    } finally {
      manager.dispose();
    }
  });

  it("JSON can disable an otherwise enabled custom agent", () => {
    const cwd = tempWorkspace({ name: "reviewer", enabled: true });
    const manager = new AgentManager(undefined, 4, undefined, { reviewer: { enabled: false } }, cwd);
    try {
      assert.equal(manager.isTypeEnabled("reviewer"), false);
      assert.throws(() => spawn(manager, "reviewer", false), /disabled by configuration/);
    } finally {
      manager.dispose();
    }
  });

  it("unmentioned built-in and internal types remain enabled", () => {
    const manager = new AgentManager(undefined, 4, undefined, {}, tempWorkspace());
    try {
      assert.equal(manager.isTypeEnabled("explore"), true);
      assert.equal(manager.isTypeEnabled("name-gen"), true);
    } finally {
      manager.dispose();
    }
  });

  it("returns provider-visible public type names in deterministic code-unit order", () => {
    const cwd = tempWorkspace();
    const dir = join(cwd, ".unipi", "config", "agents");
    mkdirSync(dir, { recursive: true });
    for (const name of ["zeta", "Alpha", "reviewer"]) {
      writeFileSync(
        join(dir, `${name}.md`),
        `---\ndescription: ${name}\n---\n${name} prompt.\n`,
      );
    }

    const manager = new AgentManager(
      undefined,
      4,
      undefined,
      { omega: { enabled: true }, beta: { enabled: true } },
      cwd,
    );
    try {
      const known = manager.getKnownTypes();
      assert.deepEqual(known, [...known].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
      assert.deepEqual(known, ["Alpha", "beta", "explore", "omega", "reviewer", "work", "zeta"]);
      assert.equal(known.includes("name-gen"), false);
    } finally {
      manager.dispose();
    }
  });
});
