/**
 * Parity tests for agent overrides, disableBuiltins, aliases, runtime
 * registration, and per-agent memory scopes (ported from pi-subagents
 * applyBuiltinOverrides semantics; settings sourced from OUR subagents.json).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentManager } from "../agent-manager.js";
import {
  applyBuiltinOverrides,
  applySubagentDefaults,
  parseSubagentSettings,
} from "../agent-overrides.js";
import type { AgentConfig } from "../types.js";
import {
  buildAgentMemoryInjection,
  getUserMemoryRoot,
  parseMemoryFrontmatter,
  resolveMemoryDir,
} from "../agent-memory.js";

const TMP = join(tmpdir(), `unipi-subagents-overrides-test-${process.pid}`);

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function builtinAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: `You are ${name}.`,
    promptMode: "replace",
    enabled: true,
    source: "builtin",
    ...overrides,
  };
}

describe("parseSubagentSettings", () => {
  it("parses overrides, defaults, and flags from our subagents.json shape", () => {
    const settings = parseSubagentSettings({
      overrides: { scout: { model: "haiku", disabled: true } },
      defaultModel: "ds/deepseek-v4-flash",
      defaultThinking: "medium",
      disableBuiltins: true,
    });
    assert.equal(settings.overrides.scout?.model, "haiku");
    assert.equal(settings.overrides.scout?.disabled, true);
    assert.equal(settings.defaultModel, "ds/deepseek-v4-flash");
    assert.equal(settings.defaultThinking, "medium");
    assert.equal(settings.disableBuiltins, true);
  });

  it("returns empty settings for missing/garbage input", () => {
    assert.deepEqual(parseSubagentSettings(undefined).overrides, {});
    assert.deepEqual(parseSubagentSettings(null).overrides, {});
    assert.deepEqual(parseSubagentSettings("nope").overrides, {});
    assert.deepEqual(parseSubagentSettings([]).overrides, {});
  });
});

describe("applyBuiltinOverrides", () => {
  it("applies project override over user override for the same agent", () => {
    const agents = [builtinAgent("scout")];
    const result = applyBuiltinOverrides(
      agents,
      { overrides: { scout: { model: "user-model" } } },
      { overrides: { scout: { model: "project-model" } } },
    );
    assert.equal(result[0].model, "project-model");
  });

  it("falls back to user override when project has none for the agent", () => {
    const result = applyBuiltinOverrides(
      [builtinAgent("oracle")],
      { overrides: { oracle: { thinking: "low" } } },
      { overrides: {} },
    );
    assert.equal(result[0].thinking, "low");
  });

  it("disableBuiltins disables every builtin agent", () => {
    const result = applyBuiltinOverrides(
      [builtinAgent("scout"), builtinAgent("reviewer")],
      { overrides: {} },
      { overrides: {}, disableBuiltins: true },
    );
    assert.equal(result[0].enabled, false);
    assert.equal(result[1].enabled, false);
  });

  it("disableThinking clears thinking unless the agent has an explicit override", () => {
    const result = applyBuiltinOverrides(
      [builtinAgent("a", { thinking: "high" }), builtinAgent("b", { thinking: "high" })],
      { overrides: { b: { thinking: "low" } }, disableThinking: true },
      { overrides: {} },
    );
    assert.equal(result[0].thinking, undefined);
    assert.equal(result[1].thinking, "low");
  });

  it("model:false override clears the model", () => {
    const result = applyBuiltinOverrides(
      [builtinAgent("scout", { model: "x" })],
      { overrides: { scout: { model: false } } },
      { overrides: {} },
    );
    assert.equal(result[0].model, undefined);
  });

  it("tools override replaces the tool list; 'inherit' clears it", () => {
    const replaced = applyBuiltinOverrides(
      [builtinAgent("scout")],
      { overrides: { scout: { tools: ["read", "grep"] } } },
      { overrides: {} },
    );
    assert.deepEqual(replaced[0].builtinToolNames, ["read", "grep"]);

    const inherited = applyBuiltinOverrides(
      [builtinAgent("scout", { builtinToolNames: ["read"] })],
      { overrides: { scout: { tools: "inherit" } } },
      { overrides: {} },
    );
    assert.equal(inherited[0].builtinToolNames, undefined);
  });
});

describe("applySubagentDefaults", () => {
  it("applies defaultModel only when the agent has none", () => {
    const result = applySubagentDefaults(
      [builtinAgent("a"), builtinAgent("b", { model: "own" })],
      { overrides: {}, defaultModel: "default" },
    );
    assert.equal(result[0].model, "default");
    assert.equal(result[1].model, "own");
  });

  it("defaultThinking false clears undefined thinking", () => {
    const result = applySubagentDefaults(
      [builtinAgent("a")],
      { overrides: {}, defaultThinking: false },
    );
    assert.equal(result[0].thinking, false);
  });
});

describe("AgentManager aliases + runtime registration", () => {
  it("resolves reference aliases to canonical builtin agents", () => {
    const manager = new AgentManager(undefined, 2, undefined, {}, TMP, { user: {}, project: {} });
    try {
      // oracle ships alias 'advisor'; worker ships alias 'developer'
      assert.equal(manager.resolveAlias("advisor"), "oracle");
      assert.equal(manager.resolveAlias("developer"), "worker");
      assert.equal(manager.resolveAlias("scout"), "scout"); // identity
      const advisor = manager.getAgentConfig("advisor");
      assert.equal(advisor?.name, "oracle");
    } finally {
      manager.dispose();
    }
  });

  it("runtime-registered agents win over builtins and clear cleanly", () => {
    const manager = new AgentManager(undefined, 2, undefined, {}, TMP, { user: {}, project: {} });
    try {
      manager.registerRuntimeAgent({
        name: "custom-runtime",
        description: "runtime agent",
        aliases: ["rt"],
        builtinToolNames: ["read"],
        extensions: false,
        skills: false,
        systemPrompt: "runtime",
        promptMode: "replace",
      });
      assert.ok(manager.getKnownTypes().includes("custom-runtime"));
      assert.equal(manager.getAgentConfig("rt")?.name, "custom-runtime");
      manager.clearRuntimeAgents();
      assert.equal(manager.getAgentConfig("custom-runtime"), undefined);
      assert.equal(manager.resolveAlias("rt"), "rt");
    } finally {
      manager.dispose();
    }
  });

  it("builtin override from our subagents.json applies (model + disable)", () => {
    const manager = new AgentManager(
      undefined,
      2,
      undefined,
      {},
      TMP,
      {
        user: { overrides: { oracle: { model: "test/model" } }, disableBuiltins: false },
        project: { overrides: { scout: { disabled: true } } },
      },
    );
    try {
      assert.equal(manager.getAgentConfig("oracle")?.model, "test/model");
      assert.equal(manager.getAgentConfig("scout")?.enabled, false);
      assert.equal(manager.isTypeEnabled("scout"), false);
      assert.equal(manager.isTypeEnabled("oracle"), true);
    } finally {
      manager.dispose();
    }
  });
});

describe("per-agent memory scopes", () => {
  it("parses memory frontmatter (inline object + YAML lines)", () => {
    assert.deepEqual(parseMemoryFrontmatter('{ scope: "project", path: "security" }'), {
      scope: "project",
      path: "security",
    });
    assert.deepEqual(parseMemoryFrontmatter("scope: user\npath: notes"), {
      scope: "user",
      path: "notes",
    });
    assert.equal(parseMemoryFrontmatter("scope: bogus"), undefined);
    assert.equal(parseMemoryFrontmatter(undefined), undefined);
  });

  it("resolveMemoryDir rejects escapes, absolute paths, and dot segments", () => {
    assert.ok("error" in resolveMemoryDir(TMP, "../escape"));
    assert.ok("error" in resolveMemoryDir(TMP, "/etc/passwd"));
    assert.ok("error" in resolveMemoryDir(TMP, "."));
    const ok = resolveMemoryDir(TMP, "security-reviewer");
    assert.ok("dir" in ok && ok.dir.endsWith("security-reviewer"));
  });

  it("buildAgentMemoryInjection: read-write agent gets the block even without a file", () => {
    const agent = builtinAgent("writer", {
      memory: { scope: "user", path: `test-mem-${process.pid}` },
      builtinToolNames: ["read", "write"],
    });
    const injection = buildAgentMemoryInjection(agent, TMP);
    assert.ok(injection.includes("# Persistent agent memory"));
    assert.ok(injection.includes("No MEMORY.md exists yet"));
  });

  it("buildAgentMemoryInjection: read-only agent without a file gets nothing", () => {
    const agent = builtinAgent("reader", {
      memory: { scope: "user", path: `test-mem-${process.pid}` },
      builtinToolNames: ["read"],
    });
    assert.equal(buildAgentMemoryInjection(agent, TMP), "");
  });

  it("buildAgentMemoryInjection: existing memory contents are injected with boundary", () => {
    const memPath = { scope: "user" as const, path: `test-mem-${process.pid}` };
    // Write a memory file via the same root the builder uses
    const dir = join(getUserMemoryRoot(), memPath.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "line1: verified gotcha\nline2: decision", "utf-8");

    const agent = builtinAgent("reader", {
      memory: memPath,
      builtinToolNames: ["read"],
    });
    const injection = buildAgentMemoryInjection(agent, TMP);
    assert.ok(injection.includes("read-only"));
    assert.ok(injection.includes("verified gotcha"));
    assert.ok(injection.includes("not instructions"));

    rmSync(dir, { recursive: true, force: true });
  });
});
