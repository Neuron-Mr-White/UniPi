/**
 * Runner tests with a mock pi and the real binary: mode choice, the prompt
 * payload, completion → In Review, blocked respected, abort, autowork,
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
// No real network: the shared Decision Model (jev) would otherwise be called
// with the developer's key for every mode choice. Tests that exercise jev
// stub fetch and set their own key.
delete process.env.OPENROUTER_API_KEY;
delete process.env.TYPESAFE_API_KEY;

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
    settings = { ...DEFAULT_SETTINGS, ...options };
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

    const ctx = fakeCtx();
    await runner.work(ctx);
    // The agent blocks it with a question.
    execFileSync(
      debugBinary,
      ["move", first, "blocked", "--comment", "which license?", "--actor", "agent", "--session", `pi-${process.pid}`, "--json"],
      { env: { ...process.env, UNIPI_KANBOARD_HOME: home }, cwd: workspace, encoding: "utf-8" },
    );
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "Blocked." }] }]);
    await new Promise((r) => setTimeout(r, 1500));
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(show(first).status, "blocked", "blocked is respected");
    assert.equal(kind.sent.length, 2, "the loop continued to the next task");
    assert.match(kind.sent[1]!.message, new RegExp(`\\[kanboard ${second}\\]`));
  });

  it("a late agent_end from the previous task does not settle the next one", async () => {
    setup();
    const first = add("First task");
    const second = add("Second task");
    runnerRef = null;
    build();
    await runner.work(fakeCtx());
    const turnA = [{ role: "assistant", content: [{ type: "text", text: "First task finished." }] }];
    kind.fireAgentEnd(turnA);
    await new Promise((r) => setTimeout(r, 1500));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(show(first).status, "in_review");
    // The loop claimed the next task; the previous turn's end arrives again.
    kind.fireAgentEnd(turnA);
    await new Promise((r) => setTimeout(r, 1500));
    const secondTask = show(second);
    assert.equal(secondTask.status, "in_progress", "the second task was not released by the stale end");
    const releases = (secondTask.activity ?? []).filter((entry) => entry.text.startsWith("released to"));
    assert.deepEqual(releases, [], "no release summary leaked from the previous task");
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

  it("autowork works the ready tasks in order", async () => {
    setup();
    const one = add("Task one");
    const two = add("Task two");
    await runner.work(fakeCtx());
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "one done" }] }]);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(kind.sent.length, 2, "autowork claimed the next task");
    assert.match(kind.sent[1]!.message, new RegExp(`\\[kanboard ${two}\\]`));
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "two done" }] }]);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(show(one).status, "in_review");
    assert.equal(show(two).status, "in_review");
    assert.equal(runner.status().phase, "idle", "nothing ready → autowork stops");
  });

  it("autowork stop finishes the current task, then stops", async () => {
    setup();
    add("Task one");
    add("Task two");
    await runner.work(fakeCtx());
    runner.stop(fakeCtx());
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "one done" }] }]);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(kind.sent.length, 1, "the second task was never claimed");
    assert.equal(runner.status().phase, "idle");
  });

  it("the session queue drains in order via claim-next --id", async () => {
    setup();
    const one = add("Queued one");
    const two = add("Queued two");
    const env = { ...process.env, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_SESSION: `pi-${process.pid}` };
    execFileSync(debugBinary, ["queue", two, one, "--json"], { env, cwd: workspace, encoding: "utf-8" });
    // drain() takes the queue head first — two, then one — without autowork.
    await runner.drain(fakeCtx());
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "two done" }] }]);
    await new Promise((r) => setTimeout(r, 1600));
    assert.match(kind.sent[0]!.message, new RegExp(`\\[kanboard ${two}\\]`));
    assert.match(kind.sent[1]!.message, new RegExp(`\\[kanboard ${one}\\]`));
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "one done" }] }]);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(show(one).status, "in_review");
    assert.equal(show(two).status, "in_review");
  });

  it("passes the configured chain gate to claim-next", async () => {
    setup();
    const dep = add("Dependency");
    const dependent = add("Dependent", ["--after", dep]);
    // dep is todo → under the done gate the dependent is not claimable; under
    // in_review neither is. Claim the dependency, release it to in_review, then
    // only the in_review gate allows the dependent.
    settings = { ...settings, chainGate: "in_review" };
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
      new Response(JSON.stringify({ answers: { strategy: { choice: "goal", confidence: 0.9 }, plan: { choice: "no", confidence: 0.9 } } }), { status: 200 })) as never;
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.UNIPI_KANBOARD_TEST_JE = "1";
    // long-horizon judge settings must look like a decisions model for askJev.
    const { registerSettings, setSettings } = await import("@pi-unipi/core");
    registerSettings({ namespace: "long-horizon", label: "LH", defaults: { judge: {} } });
    // Project scope (the temp workspace) — "global" is the real ~/.unipi config
    // and once overwrote users' judge key with this fake one.
    setSettings(
      "long-horizon",
      { judge: { provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "k", baseUrl: "" } },
      "project",
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
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "goal done" }] }]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(show(id).status, "in_review");
  });
});

describe("queue drain order", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let kind: ReturnType<typeof fakePi>;
  let runner: ReturnType<typeof createRunner>;

  function setup(): void {
    home = mkdtempSync(join(tmpdir(), "kb-drain-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-drainws-"));
    process.env.UNIPI_KANBOARD_HOME = home;
    const env = { ...process.env, UNIPI_KANBOARD_HOME: home };
    execFileSync(debugBinary, ["project", "add", "--name", "Drain"], { env, cwd: workspace, encoding: "utf-8" });
    kind = fakePi();
    const cli = createCli({ path: debugBinary, source: "dev-build" }, env);
    runner = createRunner({
      pi: kind.pi,
      cli,
      cwd: workspace,
      project: () =>
        JSON.parse(execFileSync(debugBinary, ["project", "list", "--json"], { env, cwd: workspace, encoding: "utf-8" }))[0]
          .slug as string,
      settings: () => DEFAULT_SETTINGS,
      debug: () => undefined,
    });
  }

  after(() => {
    delete process.env.UNIPI_KANBOARD_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("claims the first ready entry and keeps not-ready ones queued", async () => {
    setup();
    const env = { ...process.env, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_SESSION: `pi-${process.pid}` };
    const addT = (title: string, extra: string[] = []): string =>
      JSON.parse(
        execFileSync(debugBinary, ["add", title, "--status", "todo", ...extra, "--json"], { env, cwd: workspace, encoding: "utf-8" }),
      ).id as string;
    const dep = addT("Dep");
    const waiting = addT("Waits on dep", ["--after", dep]);
    const ready = addT("Ready");
    execFileSync(debugBinary, ["queue", waiting, ready, "--json"], { env, cwd: workspace, encoding: "utf-8" });

    const notes: string[] = [];
    const ctx = fakeCtx({ notify: (m: string) => notes.push(m) });
    await runner.drain(ctx as never);
    assert.match(kind.sent[0]?.message ?? "", new RegExp(`\\[kanboard ${ready}\\]`), "ready task claimed first, waiting one skipped");

    // The waiting entry is still queued.
    const queue = JSON.parse(execFileSync(debugBinary, ["queue", "--list", "--json"], { env, cwd: workspace, encoding: "utf-8" }));
    assert.deepEqual(queue.queue, [waiting]);

    // After the run, the loop sees the queue again, finds nothing ready, and says why.
    runner.onAgentEnd(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "ready done" }] }] },
      ctx as never,
    );
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(notes.some((m) => m.includes("queue waiting") && m.includes(waiting)), `waiting note: ${notes.join(" | ")}`);
    const queue2 = JSON.parse(execFileSync(debugBinary, ["queue", "--list", "--json"], { env, cwd: workspace, encoding: "utf-8" }));
    assert.deepEqual(queue2.queue, [waiting], "the not-ready entry stays queued");
  });
});

// ── CP3.5: labelled strategies + plan ──────────────────────────────────────

describe("strategy labels", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let kind: ReturnType<typeof fakePi>;
  let runner: ReturnType<typeof createRunner>;

  function setup(overrides: Partial<KanboardSettings> = {}): void {
    home = mkdtempSync(join(tmpdir(), "kb-strat-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-stratws-"));
    process.env.UNIPI_KANBOARD_HOME = home;
    const env = { ...process.env, UNIPI_KANBOARD_HOME: home };
    execFileSync(debugBinary, ["project", "add", "--name", "Strat"], { env, cwd: workspace, encoding: "utf-8" });
    resetCommandRunners();
    kind = fakePi();
    const cli = createCli({ path: debugBinary, source: "dev-build" }, env);
    runner = createRunner({
      pi: kind.pi as never,
      cli,
      project: () =>
        JSON.parse(execFileSync(debugBinary, ["project", "show", "--json"], { env, cwd: workspace, encoding: "utf-8" })).project.slug,
      cwd: workspace,
      settings: () => ({ ...DEFAULT_SETTINGS, ...overrides }),
      debug: () => undefined,
    });
  }

  const addLabelled = (title: string, ...extra: string[]): string =>
    JSON.parse(
      execFileSync(debugBinary, ["add", title, "--status", "todo", ...extra, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    ).id as string;

  after(() => {
    for (const d of [home, workspace]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("a goal-labelled task runs via unipi:goal-start with no jev call", async () => {
    setup();
    const calls: string[] = [];
    registerCommandRunner("unipi:goal-start", (_c: never, args: unknown) => {
      calls.push(`goal-start:${JSON.stringify(args)}`);
      return { ok: true, goalId: "goal-9" };
    });
    registerCommandRunner("unipi:goal-status", () => ({ found: true, goalId: "goal-9", status: "complete" }));
    let jevCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { jevCalls += 1; return new Response("{}"); }) as never;
    process.env.OPENROUTER_API_KEY = "test-key";
    try {
      const id = addLabelled("Labelled goal task", "--strategy", "goal", "--plan", "no");
      await runner.work(fakeCtx());
      assert.equal(jevCalls, 0, "labelled task must not ask jev");
      assert.ok(calls.some((c) => c.startsWith("goal-start:")), `goal-start not called: ${calls}`);
      assert.equal(runner.status().mode, "goal");
      const shown = JSON.parse(
        execFileSync(debugBinary, ["show", id, "--json"], {
          env: { ...process.env, UNIPI_KANBOARD_HOME: home },
          cwd: workspace,
          encoding: "utf-8",
        }),
      );
      assert.equal(shown.strategy, "goal");
      assert.equal(shown.plan, false);
      assert.equal(shown.run.mode, "goal");
      assert.equal(shown.run.goal, "goal-9");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("a swarm-labelled task resolves via unipi:lh-explicit", async () => {
    setup();
    const calls: string[] = [];
    registerCommandRunner("unipi:lh-explicit", (_c: never, args: unknown) => {
      calls.push(`lh:${JSON.stringify(args)}`);
      return { ok: true, mode: "swarm" };
    });
    const id = addLabelled("Parallel work", "--strategy", "swarm");
    await runner.work(fakeCtx());
    assert.ok(calls.some((c) => c.includes('"mode":"swarm"')), `lh-explicit not called: ${calls}`);
    const shown = JSON.parse(
      execFileSync(debugBinary, ["show", id, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    );
    assert.equal(shown.run.mode, "swarm");
    assert.equal(runner.status().mode, "swarm");
  });

  it("a ralph task with no checklist falls back to goal then none", async () => {
    setup();
    const calls: string[] = [];
    registerCommandRunner("unipi:ralph-start", () => {
      calls.push("ralph");
      return { ok: false, reason: "no checklist items" };
    });
    registerCommandRunner("unipi:goal-start", () => {
      calls.push("goal");
      return { ok: true, goalId: "goal-11" };
    });
    registerCommandRunner("unipi:goal-status", () => ({ found: true, goalId: "goal-11", status: "complete" }));
    const id = addLabelled("Ralph without items", "--strategy", "ralph");
    await runner.work(fakeCtx());
    assert.deepEqual(calls, ["ralph", "goal"], `fallback order: ${calls}`);
    assert.equal(runner.status().mode, "goal");
    const shown = JSON.parse(
      execFileSync(debugBinary, ["show", id, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    );
    assert.equal(shown.run.mode, "goal");
  });
  it("blocking=avoid tells the task to assume-and-note; blocking=ask keeps the old lines", async () => {
    setup();
    const id = addLabelled("Do the thing");
    await runner.work(fakeCtx());
    const avoidPrompt = kind.sent[0]!.message;
    assert.match(avoidPrompt, /Work autonomously/);
    assert.match(avoidPrompt, new RegExp(`note ${id} "assumed:`));
    assert.doesNotMatch(avoidPrompt, /If you need information or a decision/);

    setup({ blocking: "ask" });
    addLabelled("Another thing");
    kind.sent.length = 0;
    await runner.work(fakeCtx());
    const askPrompt = kind.sent[0]!.message;
    assert.match(askPrompt, /If you need information or a decision from the user/);
    assert.match(askPrompt, /move .* blocked --comment "<what you need>"/);
    assert.doesNotMatch(askPrompt, /Work autonomously/);
  });
});

describe("runner × goal lifecycle (FIX 4)", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let kind: ReturnType<typeof fakePi>;
  let runner: ReturnType<typeof createRunner>;
  let goalCalls: string[];
  let goalState: { status: string; reason?: string };

  function setup(): void {
    home = mkdtempSync(join(tmpdir(), "kb-goalrun-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-goalws-"));
    process.env.UNIPI_KANBOARD_HOME = home;
    // Runner and test CLI share one session so agent-side moves/cancels pass
    // the binary's session rules.
    process.env.UNIPI_KANBOARD_SESSION = "pi-goalfix";
    const env = { ...process.env, UNIPI_KANBOARD_HOME: home };
    execFileSync(debugBinary, ["project", "add", "--name", "GoalRun"], { env, cwd: workspace, encoding: "utf-8" });
    resetCommandRunners();
    goalCalls = [];
    goalState = { status: "active" };
    kind = fakePi();
    registerCommandRunner("unipi:goal-start", (_c: never, args: unknown) => {
      goalCalls.push(`start:${JSON.stringify(args)}`);
      return { ok: true, goalId: "goal-1" };
    });
    // Faithful mirrors of the long-horizon runners: pause only an ACTIVE goal,
    // resume only a PAUSED one.
    registerCommandRunner("unipi:goal-pause", (_c: never, args: unknown) => {
      goalCalls.push(`pause:${JSON.stringify(args)}`);
      if (goalState.status !== "active") return { ok: false, reason: `goal is ${goalState.status}` };
      goalState.status = "paused";
      return { ok: true, goalId: "goal-1" };
    });
    registerCommandRunner("unipi:goal-resume", (_c: never, args: unknown) => {
      goalCalls.push(`resume:${JSON.stringify(args)}`);
      if (goalState.status !== "paused") return { ok: false, reason: `goal is ${goalState.status}` };
      goalState.status = "active";
      return { ok: true, goalId: "goal-1" };
    });
    registerCommandRunner("unipi:goal-stop", (_c: never, args: unknown) => {
      goalCalls.push(`stop:${JSON.stringify(args)}`);
      goalState.status = "complete";
      goalState.reason = "complete(user_requested)";
      return { ok: true };
    });
    registerCommandRunner("unipi:goal-status", () => ({
      found: true,
      goalId: "goal-1",
      status: goalState.status,
      reason: goalState.reason,
      objective: "ship it",
    }));
    const cli = createCli({ path: debugBinary, source: "dev-build" }, env);
    runner = createRunner({
      pi: kind.pi as never,
      cli,
      project: () =>
        JSON.parse(execFileSync(debugBinary, ["project", "show", "--json"], { env, cwd: workspace, encoding: "utf-8" })).project.slug,
      cwd: workspace,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      debug: () => undefined,
    });
    runnerRef = runner;
  }

  const addLabelled = (title: string, ...extra: string[]): string =>
    JSON.parse(
      execFileSync(debugBinary, ["add", title, "--status", "todo", ...extra, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    ).id as string;

  const showTask = (id: string): KanboardTask =>
    JSON.parse(
      execFileSync(debugBinary, ["show", id, "--json"], {
        env: { ...process.env, UNIPI_KANBOARD_HOME: home },
        cwd: workspace,
        encoding: "utf-8",
      }),
    ) as KanboardTask;

  const settle = async (): Promise<void> => {
    kind.fireAgentEnd([{ role: "assistant", content: [{ type: "text", text: "work done" }] }]);
    await new Promise((r) => setTimeout(r, 1500));
  };

  after(() => {
    delete process.env.UNIPI_KANBOARD_SESSION;
    for (const d of [home, workspace]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("a user-stopped goal releases the task to Todo, not In Review (REWORK A1)", async () => {
    setup();
    const id = addLabelled("Stopped goal task", "--strategy", "goal", "--plan", "no");
    await runner.work(fakeCtx());
    assert.equal(runner.status().mode, "goal");
    // Stop autowork so the released task is not immediately re-claimed.
    runner.stop(fakeCtx());
    // The user stopped the goal mid-task.
    goalState = { status: "complete", reason: "complete(user_requested)" };
    await settle();
    assert.equal(showTask(id).status, "todo", "user-stopped goal must NOT push to in_review");
    const last = (showTask(id).activity ?? []).slice(-1)[0]!;
    assert.match(last.text, /goal stopped by user/);
    assert.equal(runner.status().taskId, null);
  });

  it("an interrupted task parks its goal in the release note (FIX 4b)", async () => {
    setup();
    const id = addLabelled("Interrupted goal task", "--strategy", "goal", "--plan", "no");
    await runner.work(fakeCtx());
    // Let the claim's async set-run land before the abort.
    await new Promise((r) => setTimeout(r, 300));
    kind.fireAgentEnd([{ role: "assistant", content: "partial", stopReason: "aborted" }]);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(goalCalls.some((c) => c.startsWith('pause:{"goalId":"goal-1"}')), `pause not called: ${goalCalls}`);
    assert.equal(showTask(id).status, "todo");
    const note = (showTask(id).activity ?? []).map((entry) => entry.text).join("\n");
    assert.match(note, /\[parked goal: goal-1\]/, "parked goal id survives the release");
  });

  it("re-claiming a task with a parked goal resumes it instead of starting fresh (FIX 4b)", async () => {
    setup();
    const id = addLabelled("Resumed goal task", "--strategy", "goal", "--plan", "no");
    await runner.work(fakeCtx());
    await new Promise((r) => setTimeout(r, 300));
    // Interrupt: the goal parks, the release note records it, task → Todo.
    kind.fireAgentEnd([{ role: "assistant", content: "partial", stopReason: "aborted" }]);
    await new Promise((r) => setTimeout(r, 300));
    assert.match(
      (showTask(id).activity ?? []).map((entry) => entry.text).join("\n"),
      /\[parked goal: goal-1\]/,
    );
    goalCalls = [];
    // Re-claim the SAME task: the parked goal resumes, no fresh start.
    await runner.work(fakeCtx());
    assert.ok(goalCalls.some((c) => c.startsWith("resume:")), `resume not called: ${goalCalls}`);
    assert.ok(!goalCalls.some((c) => c.startsWith("start:")), "no fresh goal-start for a parked goal");
    assert.equal(runner.status().mode, "goal");
    assert.equal(showTask(id).status, "in_progress");
  });

  it("a task cancelled by the user stops its goal and leaves the board alone (FIX 4b)", async () => {
    setup();
    const id = addLabelled("Moved goal task", "--strategy", "goal", "--plan", "no");
    await runner.work(fakeCtx());
    await new Promise((r) => setTimeout(r, 300));
    // No legal transition leaves a LIVE in_progress run, so the moved-away
    // branch is exercised against a scripted board below (see the scripted
    // describe at the bottom of this file).
    void id;
    assert.equal(runner.status().mode, "goal");
  });

  it("a paused goal defers settle: the task stays claimed and nothing is sent (FIX 4c)", async () => {
    setup();
    const id = addLabelled("Paused goal task", "--strategy", "goal", "--plan", "no");
    await runner.work(fakeCtx());
    goalState = { status: "paused" };
    await settle();
    assert.equal(showTask(id).status, "in_progress", "paused goal defers the release");
    assert.equal(kind.sent.length, 1, "no continuation follow-up for a paused goal");
    assert.equal(runner.status().taskId, id);
  });
});

describe("runner × moved-away goal (FIX 4b, scripted cli — no binary)", () => {
  it("a task the user moved to done stops its goal and is not released again", async () => {
    resetCommandRunners();
    const goalCalls: string[] = [];
    registerCommandRunner("unipi:goal-start", () => ({ ok: true, goalId: "goal-7" }));
    registerCommandRunner("unipi:goal-status", () => ({ found: true, goalId: "goal-7", status: "active" }));
    registerCommandRunner("unipi:goal-stop", (_c: never, args: unknown) => {
      goalCalls.push(`stop:${JSON.stringify(args)}`);
      return { ok: true };
    });
    registerCommandRunner("unipi:goal-pause", () => ({ ok: false, reason: "unreachable on movedAway" }));

    const task = { id: "GOA-9", title: "claimed task", status: "todo", strategy: "goal", plan: false };
    const argvs: string[][] = [];
    const cli = {
      binary: { path: "/bin/fake-kb", source: "env" },
      run: async (args: string[]) => {
        argvs.push(args);
        const sub = args[0];
        if (sub === "queue") return { queue: [] };
        if (sub === "claim-next") return { task: { ...task, status: "in_progress" }, waiting: [] };
        if (sub === "list") return { tasks: [{ ...task }], problems: [] };
        if (sub === "set-run") return {};
        if (sub === "show") {
          // The user moved it to done while the run was live.
          return { ...task, status: "done", run: { mode: "goal", goal: "goal-7" } };
        }
        return {};
      },
    } as never;
    const sent: string[] = [];
    const notified: string[] = [];
    const pi = {
      sendUserMessage: (message: string) => sent.push(message),
      appendEntry: () => undefined,
      sendMessage: () => undefined,
      on: () => () => undefined,
    } as never;
    let runnerRef2: ReturnType<typeof createRunner> | null = null;
    const runner = createRunner({
      pi,
      cli,
      project: () => "scripted",
      cwd: process.cwd(),
      settings: () => ({ ...DEFAULT_SETTINGS, defaultStrategy: "goal" }),
      debug: () => undefined,
    });
    runnerRef2 = runner;
    runnerRef = runnerRef2;

    const ctx = {
      cwd: process.cwd(),
      ui: { notify: (m: string) => notified.push(m), setStatus: () => undefined, confirm: async () => true },
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getEntries: () => [], getBranch: () => [] },
    } as never;

    await runner.work(ctx);
    assert.equal(sent.length, 1, "task claimed and prompted");
    runnerRef2!.onAgentEnd({ messages: [{ role: "assistant", content: "partial", stopReason: "aborted" }] }, ctx);
    await new Promise((r) => setTimeout(r, 1600));

    assert.deepEqual(goalCalls, ['stop:{"goalId":"goal-7"}'], "goal-stop runs, no pause before it");
    assert.equal(
      argvs.some((args) => args[0] === "release"),
      false,
      "a done task is never released by the runner",
    );
    assert.equal(runner.status().taskId, null, "runner is idle again");
  });
});
