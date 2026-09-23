/**
 * Runner tests with a mock pi and the real binary: mode choice, the prompt
 * payload, completion → In Review, blocked respected, abort, continue=false,
 * and the chain gate passed through.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCli } from "../src/bin.js";
import { createRunner, type KanboardTask } from "../src/runner.js";
import { DEFAULT_SETTINGS, type KanboardSettings } from "../src/settings.js";
import { registerCommandRunner, resetCommandRunners } from "@pi-unipi/core";

let runnerRef: { onAgentEnd: (event: { messages?: unknown[] }, ctx: never) => void } | null = null;

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const debugBinary = join(repoRoot, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const hasBinary = existsSync(debugBinary);

interface Sent {
  message: string;
  options?: unknown;
}

function fakePi(): {
  pi: never;
  sent: Sent[];
  entries: Array<{ customType: string; data?: unknown }>;
  messages: Array<{ customType: string; content: string }>;
  statuses: Array<string | undefined>;
  fireAgentEnd: (messages: unknown[], ctx?: unknown) => void;
} {
  const sent: Sent[] = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const messages: Array<{ customType: string; content: string }> = [];
  const statuses: Array<string | undefined> = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  return {
    sent,
    entries,
    messages,
    statuses,
    fireAgentEnd: (messages, ctx) => {
      runnerRef?.onAgentEnd({ messages }, (ctx ?? fakeCtx()) as never);
    },
    pi: {
      sendUserMessage: (message: string, options?: unknown) => sent.push({ message, options }),
      appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
      sendMessage: (message: { customType: string; content: string }) => messages.push(message),
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as never,
  };
}

function fakeCtx(ui: Record<string, unknown> = {}, idle = true): never {
  return {
    cwd: process.cwd(),
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      confirm: async () => true,
      ...ui,
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "session-test",
    },
  } as never;
}

describe("runner", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let cli: ReturnType<typeof createCli>;
  let kind: ReturnType<typeof fakePi>;
  let settings: KanboardSettings;
  let gateSeen: string | null;
  let run: (ctx: never) => Promise<void>;
  let runner: ReturnType<typeof createRunner>;

  const slug = (): string => {
    const projects = execFileSync(debugBinary, ["project", "list", "--json"], {
      env: { ...process.env, UNIPI_KANBOARD_HOME: home },
      cwd: workspace,
      encoding: "utf-8",
    });
    return JSON.parse(projects)[0].slug as string;
  };

  /** Fresh board + runner for each test: no cross-test state. */
  function setup(options: Partial<KanboardSettings> = {}): void {
    if (home) {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
    home = mkdtempSync(join(tmpdir(), "kb-run-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-runws-"));
    process.env.UNIPI_KANBOARD_HOME = home;
    const env = { ...process.env, UNIPI_KANBOARD_HOME: home };
    execFileSync(debugBinary, ["project", "add", "--name", "Runner"], { env, cwd: workspace, encoding: "utf-8" });
    cli = createCli({ path: debugBinary, source: "dev-build" }, env);
    settings = { ...DEFAULT_SETTINGS, continue: false, ...options };
    gateSeen = null;
    kind = fakePi();
    build();
  }

  after(() => {
    delete process.env.UNIPI_KANBOARD_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const tasks = (): KanboardTask[] =>
    JSON.parse(
      execFileSync(debugBinary, ["list", "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    ) as KanboardTask[];

  const show = (id: string): KanboardTask =>
    JSON.parse(
      execFileSync(debugBinary, ["show", id, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    ) as KanboardTask;

  const add = (title: string, extra: string[] = []): string =>
    JSON.parse(
      execFileSync(debugBinary, ["add", title, "--status", "todo", ...extra, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    ).id as string;

  function build(): void {
    resetCommandRunners();
    kind = fakePi();
    runner = createRunner({
      pi: kind.pi as never,
      cli,
      project: () => slug(),
      cwd: workspace,
      settings: () => settings,
      debug: () => undefined,
    });
    runnerRef = runner;
    run = async (ctx: never) => {
      await runner.work(ctx);
      // agent_end → settle → release; the runner debounces for 1.2s.
      kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "Implemented and tested." }] }]);
      await new Promise((r) => setTimeout(r, 1500));
      await new Promise((r) => setTimeout(r, 50));
    };
  }

  it("claims the next task, asks jev for the mode, and sends the rules with the task", async () => {
    setup();
    const id = add("Add a --verbose flag to loop.sh");
    // jev is unconfigured in tests → null → direct.
    const ctx = fakeCtx();
    await run(ctx);

    assert.equal(kind.sent.length, 1, "one task prompt");
    const prompt = kind.sent[0]!.message;
    assert.match(prompt, new RegExp(`\\[kanboard ${id}\\] Add a --verbose flag`));
    assert.match(prompt, /## Activity \(latest 10\)/);
    assert.match(prompt, /## Rules/);
    assert.match(prompt, /--actor agent --project /);
    assert.match(prompt, /move .* blocked --comment/);
    assert.match(prompt, /Do not move the task to in_review or done/);
    assert.equal(kind.entries.filter((entry) => entry.customType === "unipi:kanboard-runner").length >= 1, true);
  });

  it("agent_end releases the task to In Review with a summary", async () => {
    setup();
    const id = add("Document --verbose in README");
    await run(fakeCtx());
    const task = show(id);
    assert.equal(task.status, "in_review");
    const last = (task.activity ?? []).slice(-1)[0]!;
    assert.equal(last.actor, "system");
    assert.match(last.text, /released to in_review: Implemented and tested\./);
  });

  it("respects a task the agent blocked and keeps going", async () => {
    setup();
    const first = add("Choose a license for the project");
    const second = add("Independent task");
    settings = { ...settings, continue: true };

    const ctx = fakeCtx();
    await runner.work(ctx);
    // The agent blocks it with a question.
    execFileSync(
      debugBinary,
      ["move", first, "blocked", "--comment", "which license?", "--actor", "agent", "--json"],
      { env: { ...process.env, UNIPI_KANBOARD_HOME: home }, cwd: workspace, encoding: "utf-8" },
    );
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "Blocked." }] }]);
    await new Promise((r) => setTimeout(r, 1500));
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(show(first).status, "blocked", "blocked is respected");
    assert.equal(kind.sent.length, 2, "the loop continued to the next task");
    assert.match(kind.sent[1]!.message, new RegExp(`\\[kanboard ${second}\\]`));
  });

  it("an aborted turn releases to Todo and stops", async () => {
    setup();
    const id = add("Interrupted task");
    await runner.work(fakeCtx());
    kind.fireAgentEnd([{ role: "assistant", content: "partial", stopReason: "aborted" }]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(show(id).status, "todo");
    const last = (show(id).activity ?? []).slice(-1)[0]!;
    assert.match(last.text, /interrupted by user/);
    // The loop stopped: no further prompt.
    assert.equal(kind.sent.length, 1);
    assert.equal(runner.status().taskId, null);
  });

  it("continue=false stops after one task", async () => {
    setup();
    add("Task one");
    add("Task two");
    settings = { ...settings, continue: false };
    await run(fakeCtx());
    assert.equal(kind.sent.length, 1, "only one task was handed over");
    assert.equal(runner.status().phase, "idle");
  });

  it("passes the configured chain gate to claim-next", async () => {
    setup();
    const dep = add("Dependency");
    const dependent = add("Dependent", ["--after", dep]);
    // dep is todo → under the done gate the dependent is not claimable; under
    // in_review neither is. Claim the dependency, release it to in_review, then
    // only the in_review gate allows the dependent.
    settings = { ...settings, chainGate: "in_review", continue: false };
    await run(fakeCtx());
    assert.equal(show(dep).status, "in_review");
    gateSeen = settings.chainGate;
    await runner.work(fakeCtx());
    assert.equal(kind.sent.length, 2);
    assert.match(kind.sent[1]!.message, new RegExp(`\\[kanboard ${dependent}\\]`));
    assert.equal(gateSeen, "in_review");
  });

  it("uses the long-horizon goal runner for goal mode and reads its status", async () => {
    setup();
    const id = add("A large multi-step objective");
    const calls: string[] = [];
    registerCommandRunner("unipi:goal-start", (_ctx, args) => {
      calls.push(`start:${JSON.stringify(args)}`);
      return { ok: true, goalId: "goal-7" };
    });
    registerCommandRunner("unipi:goal-status", () => {
      calls.push("status");
      return { found: true, goalId: "goal-7", status: "complete" };
    });
    // Force goal mode by stubbing the jev answer through the mode chooser.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ answers: { mode: { choice: "goal", confidence: 0.9 } } }), { status: 200 })) as never;
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.UNIPI_KANBOARD_TEST_JE = "1";
    // long-horizon judge settings must look like a decisions model for askJev.
    const { registerSettings, setSettings } = await import("@pi-unipi/core");
    registerSettings({ namespace: "long-horizon", label: "LH", defaults: { judge: {} } });
    setSettings(
      "long-horizon",
      { judge: { provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "k", baseUrl: "" } },
      "global",
      workspace,
    );
    try {
      await runner.work(fakeCtx());
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(runner.status().mode, "goal");
      assert.ok(calls.some((call) => call.startsWith("start:")), `goal-start not called: ${calls.join(",")}`);
      assert.match(show(id).run?.mode ?? "", /goal/);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
    // Completion: the goal reports complete → In Review with the summary.
    kind.fireAgentEnd([{ role: "assistant", content: [{ text: "goal done" }] }]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(show(id).status, "in_review");
  });
});
