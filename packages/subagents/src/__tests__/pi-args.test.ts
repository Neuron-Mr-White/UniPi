/**
 * pi-args + pi-spawn tests — ported from pi-subagents pi-args.test.ts
 * essentials (task delivery, session args, model+thinking suffix, tool
 * allowlist, prompt files) with OUR env prefixes.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPiArgs,
  resolveSubagentTaskDelivery,
  cleanupTempDir,
  SUBAGENT_TASK_DELIVERY_ENV,
} from "../pi-args.js";
import { getPiSpawnCommand, UNIPI_SUBAGENT_PI_BINARY_ENV } from "../pi-spawn.js";

const TMP = mkdtempSync(join(tmpdir(), "unipi-piargs-test-"));

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("resolveSubagentTaskDelivery", () => {
  it("defaults to auto; file only when explicitly set", () => {
    assert.equal(resolveSubagentTaskDelivery({}), "auto");
    assert.equal(resolveSubagentTaskDelivery({ [SUBAGENT_TASK_DELIVERY_ENV]: "file" }), "file");
    assert.equal(resolveSubagentTaskDelivery({ [SUBAGENT_TASK_DELIVERY_ENV]: "" }), "auto");
    assert.equal(resolveSubagentTaskDelivery({ [SUBAGENT_TASK_DELIVERY_ENV]: "FILE" }), "file");
  });
});

describe("buildPiArgs", () => {
  it("delivers short tasks inline and long tasks via task.md", () => {
    const short = buildPiArgs({ baseArgs: ["--mode", "json", "-p"], task: "short task" });
    assert.ok(short.args.includes("Task: short task"));
    assert.equal(existsSync(join(short.tempDir, "task.md")), false);
    cleanupTempDir(short.tempDir);

    const longTask = "x".repeat(9000);
    const long = buildPiArgs({ baseArgs: [], task: longTask });
    const taskRef = long.args.find((arg) => arg.startsWith("@"));
    assert.ok(taskRef, "long task should be delivered via @file");
    assert.equal(existsSync(taskRef!.slice(1)), true);
    assert.equal(readFileSync(taskRef!.slice(1), "utf8"), `Task: ${longTask}`);
    cleanupTempDir(long.tempDir);
  });

  it("file delivery always uses a task file even for short tasks", () => {
    const result = buildPiArgs({ baseArgs: [], task: "tiny", taskDelivery: "file" });
    assert.ok(result.args.some((arg) => arg.startsWith("@")));
    cleanupTempDir(result.tempDir);
  });

  it("session flags: --session file, --session-dir, --no-session", () => {
    const withFile = buildPiArgs({ baseArgs: [], task: "t", sessionFile: join(TMP, "s.jsonl") });
    const sessionIdx = withFile.args.indexOf("--session");
    assert.equal(sessionIdx !== -1 && withFile.args[sessionIdx + 1], join(TMP, "s.jsonl"));
    cleanupTempDir(withFile.tempDir);

    const withDir = buildPiArgs({ baseArgs: [], task: "t", sessionDir: join(TMP, "sessions") });
    assert.ok(withDir.args.includes("--session-dir"));
    cleanupTempDir(withDir.tempDir);

    const none = buildPiArgs({ baseArgs: [], task: "t", noSession: true });
    assert.ok(none.args.includes("--no-session"));
    cleanupTempDir(none.tempDir);
  });

  it("model with thinking suffix; off/false omits suffix", () => {
    const modelValue = (r: ReturnType<typeof buildPiArgs>): string => {
      const idx = r.args.indexOf("--model");
      return idx === -1 ? "" : (r.args[idx + 1] as string);
    };
    assert.equal(modelValue(buildPiArgs({ baseArgs: [], task: "t", model: "haiku", thinking: "high" })), "haiku--thinking=high");
    const t1 = buildPiArgs({ baseArgs: [], task: "t", model: "haiku", thinking: "high" }); cleanupTempDir(t1.tempDir);
    assert.equal(modelValue(buildPiArgs({ baseArgs: [], task: "t", model: "haiku", thinking: "off" })), "haiku");
    const t2 = buildPiArgs({ baseArgs: [], task: "t", model: "haiku", thinking: "off" }); cleanupTempDir(t2.tempDir);
    assert.equal(modelValue(buildPiArgs({ baseArgs: [], task: "t", model: "haiku" })), "haiku");
    const t3 = buildPiArgs({ baseArgs: [], task: "t", model: "haiku" }); cleanupTempDir(t3.tempDir);
  });

  it("tool allowlist: --tools list or --no-tools", () => {
    const tools = buildPiArgs({ baseArgs: [], task: "t", tools: ["read", "grep"] });
    const toolsIdx = tools.args.indexOf("--tools");
    assert.equal(toolsIdx !== -1 && tools.args[toolsIdx + 1], "read,grep");
    cleanupTempDir(tools.tempDir);

    const none = buildPiArgs({ baseArgs: [], task: "t", tools: [] });
    assert.ok(none.args.includes("--no-tools"));
    cleanupTempDir(none.tempDir);
  });

  it("system prompt written to a temp file with active_agent tag", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "t",
      systemPrompt: "be helpful",
      systemPromptMode: "replace",
      childAgentName: "scout",
    });
    const promptIdx = result.args.indexOf("--system-prompt");
    assert.ok(promptIdx !== -1);
    const promptPath = result.args[promptIdx + 1]!;
    const content = readFileSync(promptPath, "utf8");
    assert.ok(content.includes('<active_agent name="scout"/>'));
    assert.ok(content.includes("be helpful"));
    cleanupTempDir(result.tempDir);
  });

  it("child env identifies the subagent + parent session", () => {
    const result = buildPiArgs({
      baseArgs: [],
      task: "t",
      parentSessionId: "parent-123",
      childAgentName: "reviewer",
      runId: "run-9",
    });
    assert.equal(result.env.UNIPI_SUBAGENT_CHILD, "1");
    assert.equal(result.env.UNIPI_SUBAGENT_PARENT_SESSION, "parent-123");
    assert.equal(result.env.UNIPI_SUBAGENT_CHILD_AGENT, "reviewer");
    assert.equal(result.env.UNIPI_SUBAGENT_RUN_ID, "run-9");
    cleanupTempDir(result.tempDir);
  });
});

describe("getPiSpawnCommand", () => {
  it("UNIPI_SUBAGENT_PI_BINARY wins when set", () => {
    const spec = getPiSpawnCommand(["--version"], {
      env: { [UNIPI_SUBAGENT_PI_BINARY_ENV]: "/opt/custom-pi" },
    });
    assert.deepEqual(spec, { command: "/opt/custom-pi", args: ["--version"] });
  });

  it("falls back to plain `pi` on PATH when nothing resolves", () => {
    const spec = getPiSpawnCommand(["--version"], {
      env: {},
      execPath: "/usr/local/bin/node",
      argv1: undefined,
      existsSync: () => false,
    });
    assert.deepEqual(spec, { command: "pi", args: ["--version"] });
  });

  it("uses execPath directly when the host IS a standalone pi binary", () => {
    const spec = getPiSpawnCommand(["--mode", "json"], {
      env: {},
      execPath: "/opt/pi",
    });
    assert.deepEqual(spec, { command: "/opt/pi", args: ["--mode", "json"] });
  });

  it("resolves the installed pi CLI script through package.json bin", () => {
    const spec = getPiSpawnCommand(["--version"], {
      env: {},
      execPath: "/usr/local/bin/node",
      argv1: undefined,
      existsSync: (filePath: string) => filePath.endsWith("cli.js"),
      realpathSync: (filePath: string) => filePath,
      resolvePackageJson: () => "/fake/pi/package.json",
      readFileSync: (filePath: string) =>
        filePath === "/fake/pi/package.json" ? JSON.stringify({ bin: "./cli.js" }) : "",
    });
    assert.deepEqual(spec, { command: "/usr/local/bin/node", args: ["/fake/pi/cli.js", "--version"] });
  });
});
