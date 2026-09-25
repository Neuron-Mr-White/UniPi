import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSettings } from "@pi-unipi/core";
import {
  applyLimitEnv,
  DEFAULT_SETTINGS,
  readKanboardSettings,
  registerKanboardSettings,
} from "../src/settings.js";
import { runRotateTokenAction, syncPiRuntime } from "../src/commands.js";
import type { CommandDeps } from "../src/commands.js";

describe("kanboard settings", () => {
  it("new fields default and validate like the old ones", () => {
    registerKanboardSettings();
    const cwd = mkdtempSync(join(tmpdir(), "kb-set-"));
    try {
      const defaults = readKanboardSettings(cwd);
      assert.equal(defaults.requireAuth, false);
      assert.equal(defaults.keepToken, false);
      assert.equal(defaults.queueMax, 10);
      assert.equal(defaults.maxSessions, 2);
      assert.equal(defaults.turnAddLimit, 20);

      setSettings(
        "kanboard",
        { queueMax: -1, maxSessions: 0, turnAddLimit: "many", requireAuth: true, keepToken: true },
        "project",
        cwd,
      );
      const bad = readKanboardSettings(cwd);
      assert.equal(bad.queueMax, DEFAULT_SETTINGS.queueMax);
      assert.equal(bad.maxSessions, DEFAULT_SETTINGS.maxSessions);
      assert.equal(bad.turnAddLimit, DEFAULT_SETTINGS.turnAddLimit);
      assert.equal(bad.requireAuth, true);
      assert.equal(bad.keepToken, true);

      setSettings("kanboard", { queueMax: 0, maxSessions: 4, turnAddLimit: 0 }, "project", cwd);
      const zeroed = readKanboardSettings(cwd);
      assert.equal(zeroed.queueMax, 0, "0 = unlimited");
      assert.equal(zeroed.maxSessions, 4);
      assert.equal(zeroed.turnAddLimit, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applyLimitEnv exports both limits to process.env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kb-env-"));
    try {
      applyLimitEnv({ ...DEFAULT_SETTINGS, queueMax: 3, maxSessions: 1 });
      assert.equal(process.env.UNIPI_KANBOARD_QUEUE_MAX, "3");
      assert.equal(process.env.UNIPI_KANBOARD_MAX_SESSIONS, "1");
    } finally {
      delete process.env.UNIPI_KANBOARD_QUEUE_MAX;
      delete process.env.UNIPI_KANBOARD_MAX_SESSIONS;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("settings hub actions", () => {
  function deps(calls: string[][], replies: Record<string, unknown> = {}): CommandDeps {
    return {
      cli: {
        binary: { path: "/bin/kb", source: "dev-build" },
        run: async (argv: string[]) => {
          calls.push(argv);
          if (argv[0] === "settings" && argv[1] === "show") return { agentCommand: "old -p" };
          if (argv[0] === "settings" && argv[1] === "set") return { agentCommand: argv[3] };
          return replies[argv[0]!] ?? {};
        },
      } as never,
      settings: () => DEFAULT_SETTINGS,
      unavailable: "no binary",
      guard: { open: () => undefined, check: () => null, onAgentEnd: () => false },
      session: () => "pi-test",
      revealSkill: () => undefined,
      drainQueue: async () => undefined,
      work: async () => undefined,
      stop: () => undefined,
      status: () => ({ taskId: null, mode: null, phase: "idle" }),
      exec: async () => "",
      debug: () => undefined,
    };
  }

  it("syncPiRuntime writes piCommand argv and the models list", async () => {
    const calls: string[][] = [];
    const ctx = {
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude" }, { provider: "openai", id: "gpt-5" }] },
      ui: { notify: () => undefined },
    };
    await syncPiRuntime(deps(calls), ctx as never);
    const piSet = calls.find((argv) => argv[2] === "pi-command");
    const modelsSet = calls.find((argv) => argv[2] === "models");
    const argv = JSON.parse(piSet![3]!);
    assert.equal(argv[0], process.execPath);
    assert.ok(argv.length <= 2, "execPath + optional script");
    if (argv.length === 2) assert.ok(argv[1].includes("pi"), argv[1]);
    assert.deepEqual(JSON.parse(modelsSet![3]!), ["anthropic/claude", "openai/gpt-5"]);
  });

  it("rotate-token runs the command and tells the user to restart", async () => {
    const calls: string[][] = [];
    const notes: string[] = [];
    await runRotateTokenAction(deps(calls), { ui: { notify: (m: string) => notes.push(m) } } as never);
    assert.deepEqual(calls.at(-1), ["rotate-token"]);
    assert.match(notes.at(-1) ?? "", /new token on the next daemon start/);
  });
});
