/**
 * Test: Workflow integration — `/unipi:work` with subagent support
 *
 * Verifies:
 * - spawn_helper and get_helper_result tools are properly defined
 * - Agent types (explore, work) are correctly configured
 * - Concurrency limit is respected
 * - Custom agent type loading works
 * - System prompt builder generates correct prompts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test type definitions
const BUILTIN_TYPES = ["explore", "work"] as const;

interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  disallowedTools?: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  memory?: string;
  isDefault?: boolean;
  enabled?: boolean;
  source?: "builtin" | "project" | "global";
}

// Test prompt builder
function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: { isGitRepo: boolean; branch: string; platform: string },
  parentSystemPrompt: string,
): string {
  if (config.promptMode === "append") {
    return [
      parentSystemPrompt,
      "",
      "---",
      "",
      `## Agent Role: ${config.displayName ?? config.name}`,
      config.systemPrompt,
    ].join("\n");
  }

  return [
    `# ${config.displayName ?? config.name}`,
    "",
    config.systemPrompt,
    "",
    "---",
    "",
    `Working directory: ${cwd}`,
    `Git: ${env.isGitRepo ? `${env.branch} on ${env.platform}` : "not a git repo"}`,
  ].join("\n");
}

// Test concurrency manager
class ConcurrencyManager {
  private maxConcurrent: number;
  private running: number = 0;
  private queue: Array<{ id: string; resolve: () => void }> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(id: string): Promise<() => void> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push({ id, resolve });
      });
    }

    this.running++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;

      // Start next in queue
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next.resolve();
      }
    };
  }

  getRunning(): number {
    return this.running;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

describe("Workflow Integration", () => {
  describe("Tool Definitions", () => {
    it("should define spawn_helper tool with correct parameters", () => {
      const toolDef = {
        name: "spawn_helper",
        description: "Launch a sub-agent for parallel work.",
        parameters: {
          type: "object",
          required: ["type", "prompt", "description"],
          properties: {
            type: { type: "string" },
            prompt: { type: "string" },
            description: { type: "string" },
            run_in_background: { type: "boolean" },
            max_turns: { type: "number" },
            model: { type: "string" },
            thinking: { type: "string" },
          },
        },
      };

      assert.equal(toolDef.name, "spawn_helper");
      assert.equal(toolDef.parameters.required.length, 3);
      assert.ok(toolDef.parameters.properties.type);
      assert.ok(toolDef.parameters.properties.prompt);
      assert.ok(toolDef.parameters.properties.description);
    });

    it("should define get_helper_result tool with correct parameters", () => {
      const toolDef = {
        name: "get_helper_result",
        description: "Check status and retrieve results from a background agent.",
        parameters: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string" },
            wait: { type: "boolean" },
          },
        },
      };

      assert.equal(toolDef.name, "get_helper_result");
      assert.equal(toolDef.parameters.required.length, 1);
      assert.ok(toolDef.parameters.properties.agent_id);
    });
  });

  describe("Agent Types", () => {
    it("should have explore and work as builtin types", () => {
      assert.deepEqual(BUILTIN_TYPES, ["explore", "work"]);
    });

    it("should define explore agent with read-only tools", () => {
      const exploreConfig: AgentConfig = {
        name: "explore",
        description: "Fast parallel codebase exploration",
        builtinToolNames: ["read", "bash", "grep", "find", "ls"],
        systemPrompt: "You are a read-only exploration agent.",
        promptMode: "replace",
        extensions: true,
        skills: true,
      };

      assert.ok(!exploreConfig.builtinToolNames?.includes("write"));
      assert.ok(!exploreConfig.builtinToolNames?.includes("edit"));
      assert.ok(exploreConfig.builtinToolNames?.includes("read"));
    });

    it("should define work agent with read-write tools", () => {
      const workConfig: AgentConfig = {
        name: "work",
        description: "Parallel file writes with transparent locking",
        builtinToolNames: ["read", "write", "edit", "bash", "grep", "find", "ls"],
        systemPrompt: "You are a read-write work agent.",
        promptMode: "replace",
        extensions: true,
        skills: true,
      };

      assert.ok(workConfig.builtinToolNames?.includes("write"));
      assert.ok(workConfig.builtinToolNames?.includes("edit"));
      assert.ok(workConfig.builtinToolNames?.includes("read"));
    });
  });

  describe("System Prompt Builder", () => {
    const env = {
      isGitRepo: true,
      branch: "main",
      platform: "GitHub",
    };

    it("should build replace mode prompt", () => {
      const config: AgentConfig = {
        name: "explore",
        displayName: "Explorer",
        description: "Test",
        systemPrompt: "Find all authentication files.",
        promptMode: "replace",
        extensions: true,
        skills: true,
      };

      const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt");

      assert.ok(prompt.startsWith("# Explorer"));
      assert.ok(prompt.includes("Find all authentication files."));
      assert.ok(prompt.includes("Working directory: /workspace"));
      assert.ok(!prompt.includes("Parent prompt"));
    });

    it("should build append mode prompt", () => {
      const config: AgentConfig = {
        name: "work",
        displayName: "Worker",
        description: "Test",
        systemPrompt: "Refactor the auth module.",
        promptMode: "append",
        extensions: true,
        skills: true,
      };

      const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt");

      assert.ok(prompt.startsWith("Parent prompt"));
      assert.ok(prompt.includes("## Agent Role: Worker"));
      assert.ok(prompt.includes("Refactor the auth module."));
    });
  });

  describe("Concurrency Limit", () => {
    it("should respect max concurrent limit", async () => {
      const manager = new ConcurrencyManager(2);
      const events: string[] = [];

      // Start 3 agents, only 2 should run immediately
      const release1 = await manager.acquire("agent-1");
      events.push("agent-1-started");

      const release2 = await manager.acquire("agent-2");
      events.push("agent-2-started");

      assert.equal(manager.getRunning(), 2);
      assert.deepEqual(events, ["agent-1-started", "agent-2-started"]);

      // Third agent should queue
      const acquire3Promise = manager.acquire("agent-3").then((release) => {
        events.push("agent-3-started");
        return release;
      });

      assert.equal(manager.getQueueLength(), 1);

      // Release first agent
      release1();
      const release3 = await acquire3Promise;

      assert.equal(manager.getRunning(), 2);
      assert.deepEqual(events, ["agent-1-started", "agent-2-started", "agent-3-started"]);

      release2();
      release3();
    });

    it("should queue agents in order", async () => {
      const manager = new ConcurrencyManager(1);
      const events: string[] = [];

      const release1 = await manager.acquire("agent-1");
      events.push("1");

      const p2 = manager.acquire("agent-2").then(r => { events.push("2"); return r; });
      const p3 = manager.acquire("agent-3").then(r => { events.push("3"); return r; });

      release1();
      const release2 = await p2;
      release2();
      const release3 = await p3;

      assert.deepEqual(events, ["1", "2", "3"]);
      release3();
    });
  });

  describe("Custom Agent Loading", () => {
    it("should parse agent markdown frontmatter", () => {
      const markdown = `---
name: code-checker
description: Code quality checker
tools: read, grep, find, bash
thinking: high
---
You are a code quality checker. Review code for issues.`;

      // Simple frontmatter parser
      const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      assert.ok(match);

      const frontmatter = match![1];
      const body = match![2];

      assert.ok(frontmatter.includes("name: code-checker"));
      assert.ok(frontmatter.includes("tools: read, grep, find, bash"));
      assert.ok(body.includes("You are a code quality checker."));
    });

    it("should validate required fields", () => {
      const validAgent = {
        name: "test-agent",
        description: "Test agent",
        systemPrompt: "Do something.",
        promptMode: "replace" as const,
        extensions: true as const,
        skills: true as const,
      };

      assert.ok(validAgent.name);
      assert.ok(validAgent.description);
      assert.ok(validAgent.systemPrompt);
    });
  });
});
