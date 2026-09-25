/**
 * The write window (src/guard.ts) and the `/unipi:kanboard-do` +
 * `/unipi:kanboard-autowork` handlers: reads always pass, writes need the
 * window, the add cap is 20, and closing a -do turn drains the session queue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriteGuard, isReadonly, kanboardInvocations, WRITE_BLOCK_REASON, ADD_CAP_REASON } from "../src/guard.js";
import { registerKanboardCommands, HELP_CUSTOM_TYPE, DOCTOR_CUSTOM_TYPE, doText, drainQueueAfterDo, kanboardCompletions, kanboardAddCompletions, kanboardDoCompletions, renderShowPlain, showRenderer } from "../src/commands.js";
import type { CommandDeps } from "../src/commands.js";

function fakePi() {
  const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const sent: Array<{ message: string; options?: unknown }> = [];
  const messages: Array<{ customType: string; content: string }> = [];
  return {
    handlers,
    events,
    sent,
    messages,
    fire: async (event: string, payload: unknown, ctx: unknown) => {
      for (const handler of events.get(event) ?? []) await handler(payload, ctx);
    },
    pi: {
      registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) =>
        handlers.set(name, options.handler),
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
        events.set(name, [...(events.get(name) ?? []), handler]),
      sendMessage: (message: { customType: string; content: string }) => messages.push(message),
      sendUserMessage: (message: string, options?: unknown) => sent.push({ message, options }),
    } as never,
  };
}

function depsWith(extra: Partial<CommandDeps> = {}): CommandDeps {
  return {
    cli: { binary: { path: "/bin/unipi-kanboard", source: "env" }, run: async () => ({}) } as never,
    unavailable: null,
    settings: () => ({ chainGate: "in_review", idleMin: 10, host: "127.0.0.1", port: 0, archiveAfterDays: 0, retentionDays: 90, openBrowser: false }),
    revealSkill: () => undefined,
    work: async () => undefined,
    stop: () => undefined,
    drainQueue: async () => undefined,
    status: () => ({ taskId: null, mode: null, phase: "idle" }),
    guard: createWriteGuard(() => null),
    session: () => "test-session",
    debug: () => undefined,
    ...extra,
  };
}

const ctx = () => ({ cwd: process.cwd(), ui: { notify: () => undefined, confirm: async () => true }, isIdle: () => true }) as never;

describe("the write window", () => {
  it("finds the subcommand past global flags", () => {
    assert.deepEqual(kanboardInvocations('/x/unipi-kanboard --actor agent --project p --json list'), [
      { sub: "list", args: [] },
    ]);
    assert.deepEqual(kanboardInvocations("unipi-kanboard --session=s1 move A-1 done"), [
      { sub: "move", args: ["A-1", "done"] },
    ]);
    assert.deepEqual(kanboardInvocations("echo hi && unipi-kanboard.exe show A-1"), [
      { sub: "show", args: ["A-1"] },
    ]);
    assert.deepEqual(kanboardInvocations("unipi-kanboard"), [{ sub: "", args: [] }]);
    assert.deepEqual(kanboardInvocations("ls -la"), []);
  });

  it("classifies reads and writes", () => {
    for (const sub of ["list", "show x", "attachments x", "next", "chain x", "search q", "status"]) {
      const [inv] = kanboardInvocations(`unipi-kanboard ${sub}`);
      assert.ok(isReadonly(inv!), sub);
    }
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard queue --list")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard queue")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard project list")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard validate")[0]!));
    for (const cmd of [
      "unipi-kanboard queue A-1",
      "unipi-kanboard project add",
      "unipi-kanboard validate --fix",
      "unipi-kanboard add t",
      "unipi-kanboard note A-1 x",
      "unipi-kanboard move A-1 done",
      "unipi-kanboard reap",
    ]) {
      assert.ok(!isReadonly(kanboardInvocations(cmd)[0]!), cmd);
    }
  });

  it("blocks writes outside a window and allows them inside", () => {
    let running = false;
    const guard = createWriteGuard(() => (running ? "T-1" : null));
    assert.equal(guard.check("unipi-kanboard list --json"), null, "reads always pass");
    assert.equal(guard.check("cd x && unipi-kanboard add t --json"), WRITE_BLOCK_REASON);
    assert.equal(guard.check("echo nothing"), null);
    // A running runner task opens the window.
    running = true;
    assert.equal(guard.check("unipi-kanboard note A-1 hi"), null);
    running = false;
    // A -do turn opens it too.
    guard.open();
    assert.equal(guard.check("unipi-kanboard add t"), null);
    guard.onAgentEnd();
    assert.equal(guard.check("unipi-kanboard add t"), WRITE_BLOCK_REASON, "closed after agent_end");
  });

  it("closes only after the send (the 150ms echo guard)", async () => {
    const guard = createWriteGuard(() => null);
    guard.open();
    // An agent_end arriving before noteSent is the previous turn's echo — but
    // noteSent was never called, so sentAt=0 and the guard is already old; the
    // real protection is the -do handler calling noteSent right after send.
    guard.noteSent();
    assert.equal(guard.onAgentEnd(), false, "an immediate agent_end is the previous turn's");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(guard.onAgentEnd(), true);
    assert.equal(guard.onAgentEnd(), false, "the window stays closed");
  });

  it("resets the add cap when the runner moves to a new task", () => {
    let task: string | null = "T-A";
    const guard = createWriteGuard(() => task);
    for (let i = 0; i < 20; i += 1) assert.equal(guard.check("unipi-kanboard add t"), null, `task A add ${i + 1}`);
    assert.equal(guard.check("unipi-kanboard add t"), ADD_CAP_REASON, "task A hits the cap");
    // Between tasks the window is closed…
    task = null;
    assert.equal(guard.check("unipi-kanboard add t"), WRITE_BLOCK_REASON);
    // …and task B gets a fresh 20.
    task = "T-B";
    assert.equal(guard.check("unipi-kanboard add t"), null, "task B starts over");
    // Back on A the counter does not resurrect — each task id is a new window.
    task = "T-A";
    assert.equal(guard.check("unipi-kanboard add t"), null, "task A again is a new window");
  });

  it("caps add at 20 per window and resets on open", () => {
    const guard = createWriteGuard(() => null);
    guard.open();
    for (let i = 0; i < 20; i += 1) assert.equal(guard.check("unipi-kanboard add t"), null, `add ${i + 1}`);
    assert.equal(guard.check("unipi-kanboard add t"), ADD_CAP_REASON);
    // Other writes are still allowed; a new window resets the counter.
    assert.equal(guard.check("unipi-kanboard note A-1 x"), null);
    guard.open();
    assert.equal(guard.check("unipi-kanboard add t"), null);
  });
});

describe("/unipi:kanboard-do", () => {
  it("empty request is a usage notify", async () => {
    const kind = fakePi();
    const notifications: string[] = [];
    const deps = depsWith();
    registerKanboardCommands(kind.pi, deps);
    const c = { cwd: process.cwd(), ui: { notify: (m: string) => notifications.push(m) } } as never;
    await kind.handlers.get("unipi:kanboard-do")!("", c);
    assert.match(notifications.at(-1) ?? "", /needs a request/);
  });

  it("reveals the skill, opens the window and sends the DO_TEXT", async () => {
    const kind = fakePi();
    let revealed = false;
    process.env.UNIPI_KANBOARD_PROJECT = "test-proj";
    const deps = depsWith({ revealSkill: () => (revealed = true) });
    registerKanboardCommands(kind.pi, deps);
    try {
      await kind.handlers.get("unipi:kanboard-do")!("triage the board", ctx());
      assert.ok(revealed, "skill revealed");
      assert.equal(kind.sent.length, 1);
      assert.match(kind.sent[0]!.message, /project test-proj/);
      assert.match(kind.sent[0]!.message, /Request: triage the board/);
      // The window is open: writes pass.
      assert.equal(deps.guard.check("unipi-kanboard add x"), null);
      // agent_end closes it — an immediate one is the previous turn's echo
      // (noteSent arms a 150ms guard); the next one closes the window.
      assert.equal(deps.guard.onAgentEnd(), false, "the echo end is ignored");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(deps.guard.onAgentEnd(), true, "the turn's end closes it");
      assert.equal(deps.guard.check("unipi-kanboard add x"), WRITE_BLOCK_REASON);
    } finally {
      delete process.env.UNIPI_KANBOARD_PROJECT;
    }
  });
});

describe("queue drain after -do", () => {
  it("drains only when the session queue is non-empty", async () => {
    let drained = 0;
    const empty = depsWith({ drainQueue: async () => { drained += 1; } });
    (empty.cli as { run: (a: string[]) => Promise<unknown> }).run = async () => ({ queue: [] });
    process.env.UNIPI_KANBOARD_PROJECT = "test-proj";
    try {
      assert.equal(await drainQueueAfterDo(empty, ctx()), false);
      assert.equal(drained, 0);
      (empty.cli as { run: (a: string[]) => Promise<unknown> }).run = async () => ({ queue: ["PIT-1"] });
      assert.equal(await drainQueueAfterDo(empty, ctx()), true);
      assert.equal(drained, 1);
    } finally {
      delete process.env.UNIPI_KANBOARD_PROJECT;
    }
  });
});

describe("/unipi:kanboard-autowork", () => {
  it("start runs the loop, stop flags the runner", async () => {
    const kind = fakePi();
    let worked = 0;
    let stopped = 0;
    const deps = depsWith({ work: async () => { worked += 1; }, stop: () => { stopped += 1; } });
    registerKanboardCommands(kind.pi, deps);
    process.env.UNIPI_KANBOARD_PROJECT = "test-proj";
    try {
      await kind.handlers.get("unipi:kanboard-autowork")!("start", ctx());
      assert.equal(worked, 1);
      await kind.handlers.get("unipi:kanboard-autowork")!("stop", ctx());
      assert.equal(stopped, 1);
      const notifications: string[] = [];
      await kind.handlers.get("unipi:kanboard-autowork")!("bogus", {
        cwd: process.cwd(),
        ui: { notify: (m: string) => notifications.push(m) },
      } as never);
      assert.match(notifications.at(-1) ?? "", /start\|stop/);
    } finally {
      delete process.env.UNIPI_KANBOARD_PROJECT;
    }
  });
});

describe("context filtering", () => {
  it("drops kanboard help and doctor messages from every turn", async () => {
    const kind = fakePi();
    registerKanboardCommands(kind.pi, depsWith());
    let returned: unknown;
    await kind.fire("context", {
      messages: [
        { role: "user", content: "hi" },
        { role: "custom", customType: HELP_CUSTOM_TYPE, content: HELP_CUSTOM_TYPE },
        { role: "custom", customType: DOCTOR_CUSTOM_TYPE, content: "x" },
        { role: "custom", customType: "unipi:other", content: "keep" },
      ],
    }, {
      // capture what the handler returns: the fake's fire ignores it, so call the raw handler
    });
    // The fake drops return values; call the handler directly instead.
    const handler = kind.events.get("context")![0]!;
    const result = handler(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "custom", customType: HELP_CUSTOM_TYPE, content: "h" },
          { role: "custom", customType: DOCTOR_CUSTOM_TYPE, content: "d" },
          { role: "custom", customType: "unipi:other", content: "keep" },
        ],
      },
      undefined,
    ) as { messages: Array<{ customType?: string }> };
    assert.equal(result.messages.length, 2);
    assert.ok(result.messages.every((m) => m.customType !== HELP_CUSTOM_TYPE && m.customType !== DOCTOR_CUSTOM_TYPE));
  });
});

describe("doText", () => {
  it("fills in slug and cli verbatim", () => {
    const text = doText("my-slug", "/abs/unipi-kanboard", "file the bugs");
    assert.match(text, /project my-slug/);
    assert.match(text, /`\/abs\/unipi-kanboard --actor agent --project my-slug …`/);
    assert.match(text, /Request: file the bugs$/);
    assert.match(text, /queue <IDs>/);
  });
});

describe("doctor: summarize-via-pi check", () => {
  it("reports piCommand presence, executability and the model whitelist", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-doctor-home-"));
    const script = join(home, "pi");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ piCommand: [script], models: ["a/one"], summaryModel: "a/one" }),
    );
    const saved = process.env.UNIPI_KANBOARD_HOME;
    process.env.UNIPI_KANBOARD_HOME = home;
    try {
      const deps = depsWith();
      const kind = fakePi();
      registerKanboardCommands(kind.pi, deps);
      await kind.handlers.get("unipi:kanboard")!("doctor", ctx());
      const message = kind.messages.find((m) => m.customType === DOCTOR_CUSTOM_TYPE);
      assert.ok(message, "doctor message was posted");
      assert.ok(message!.content.includes("✓ summarize via pi:"), message!.content);
      assert.ok(message!.content.includes("✓ summary model: a/one"), message!.content);
    } finally {
      if (saved === undefined) delete process.env.UNIPI_KANBOARD_HOME;
      else process.env.UNIPI_KANBOARD_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("flags a missing piCommand and an unlisted summaryModel", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-doctor-home-"));
    const saved = process.env.UNIPI_KANBOARD_HOME;
    process.env.UNIPI_KANBOARD_HOME = home;
    try {
      const deps = depsWith();
      const kind = fakePi();
      registerKanboardCommands(kind.pi, deps);
      await kind.handlers.get("unipi:kanboard")!("doctor", ctx());
      let message = kind.messages.find((m) => m.customType === DOCTOR_CUSTOM_TYPE);
      assert.ok(message!.content.includes("summarize via pi: not configured"), message!.content);

      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ piCommand: ["/definitely/missing"], models: ["a/one"], summaryModel: "b/two" }),
      );
      kind.messages.length = 0;
      await kind.handlers.get("unipi:kanboard")!("doctor", ctx());
      message = kind.messages.find((m) => m.customType === DOCTOR_CUSTOM_TYPE);
      assert.ok(message!.content.includes("✗ summarize via pi:"), message!.content);
      assert.ok(message!.content.includes("✗ summary model: b/two"), message!.content);
    } finally {
      if (saved === undefined) delete process.env.UNIPI_KANBOARD_HOME;
      else process.env.UNIPI_KANBOARD_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("add cap via turnAddLimit", () => {
  it("blocks past the configured limit and 0 is unlimited", () => {
    const guard = createWriteGuard(() => null, () => 3);
    guard.open();
    assert.equal(guard.check("unipi-kanboard add a"), null);
    assert.equal(guard.check("unipi-kanboard add b"), null);
    assert.equal(guard.check("unipi-kanboard add c"), null);
    assert.equal(guard.check("unipi-kanboard add d"), "at most 3 new tasks per turn");

    const unlimited = createWriteGuard(() => null, () => 0);
    unlimited.open();
    for (let index = 0; index < 50; index += 1) {
      assert.equal(unlimited.check(`unipi-kanboard add t${index}`), null);
    }
  });
});

describe("settings read-only boundary", () => {
  it("settings show reads; settings set and rotate-token write", () => {
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard settings show")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard settings")[0]!));
    assert.ok(!isReadonly(kanboardInvocations("unipi-kanboard settings set agent-command x")[0]!));
    assert.ok(!isReadonly(kanboardInvocations("unipi-kanboard rotate-token")[0]!));
  });
});

describe("env limits refresh before tool_call", () => {
  it("exports the settings' limits into process.env", async () => {
    const kind = fakePi();
    const deps = depsWith({
      settings: () => ({
        chainGate: "in_review", idleMin: 10, host: "127.0.0.1", port: 0,
        archiveAfterDays: 0, retentionDays: 90, openBrowser: false, requireAuth: false, keepToken: false,
        queueMax: 7, maxSessions: 1, turnAddLimit: 20,
      }),
    });
    registerKanboardCommands(kind.pi, deps);
    const handler = kind.events.get("tool_call")![0]!;
    try {
      await handler(
        { toolName: "bash", input: { command: "echo hi" } },
        { cwd: process.cwd(), ui: { notify: () => undefined } },
      );
      assert.equal(process.env.UNIPI_KANBOARD_QUEUE_MAX, "7");
      assert.equal(process.env.UNIPI_KANBOARD_MAX_SESSIONS, "1");
    } finally {
      delete process.env.UNIPI_KANBOARD_QUEUE_MAX;
      delete process.env.UNIPI_KANBOARD_MAX_SESSIONS;
    }
  });
});

describe("doText queue limit wording", () => {
  it("names the configured limit, and drops it at 0", () => {
    const text = doText("s", "/bin/kb", "req", 10);
    assert.match(text, /Todo tasks, at most 10\)/);
    const unlimited = doText("s", "/bin/kb", "req", 0);
    assert.match(unlimited, /\(Todo tasks\)/);
    assert.doesNotMatch(unlimited, /at most/);
  });
});

describe("kanboard completions", () => {
  it("subcommands complete with the full-arg value (prefix is replaced whole)", () => {
    const items = kanboardCompletions("o")!;
    assert.deepEqual(items.map((i) => i.value), ["open", "onboard"]);
    // `show --all` and `open --host` keep earlier tokens.
    const all = kanboardCompletions("show --")!;
    assert.equal(all[0]!.value, "show --all");
    const host = kanboardCompletions("open --host 0")!;
    assert.equal(host[0]!.value, "open --host 0.0.0.0");
    const flags = kanboardCompletions("open --h")!;
    assert.equal(flags[0]!.value, "open --host");
  });

  it("-add completes -p digits, --priority/--status words and --after ids", async () => {
    const taskList = {
      tasks: [
        { id: "KBL-1", title: "write readme", status: "todo" },
        { id: "KBL-9", title: "archived one", status: "archived" },
        { id: "KBL-4", title: "fix bug", status: "in_progress" },
      ],
    };
    const deps = depsWith({
      cli: {
        binary: { path: "/bin/kb", source: "dev-build" },
        run: async () => taskList,
      } as never,
    });
    const p = await kanboardAddCompletions(deps, "-p ");
    assert.deepEqual(p!.map((i) => i.value), ["-p 1", "-p 2", "-p 3", "-p 4", "-p 5"]);
    assert.equal(p!.find((i) => i.value === "-p 5")!.description, "urgent");

    const pri = await kanboardAddCompletions(deps, "--priority u");
    assert.deepEqual(pri!.map((i) => i.value), ["--priority urgent"]);

    const st = await kanboardAddCompletions(deps, "--status ");
    assert.deepEqual(st!.map((i) => i.value), ["--status backlog", "--status todo"]);

    // --after keeps earlier tokens in the value; archived tasks are excluded.
    const after = await kanboardAddCompletions(deps, "-p 3 --after KBL-");
    assert.ok(after!.length > 0);
    assert.ok(after!.every((i) => i.value.startsWith("-p 3 --after KBL-")), JSON.stringify(after));
    assert.ok(!after!.some((i) => i.value.includes("KBL-9")));
  });

  it("-do completes a trailing task-id prefix, nothing else", async () => {
    const deps = depsWith({
      cli: {
        binary: { path: "/bin/kb", source: "dev-build" },
        run: async () => ({ tasks: [{ id: "KBL-2", title: "x", status: "todo" }] }),
      } as never,
    });
    assert.equal(await kanboardDoCompletions(deps, "write a note"), null);
    const items = await kanboardDoCompletions(deps, "release KBL-");
    assert.deepEqual(items!.map((i) => i.value), ["release KBL-2"]);
  });
});

describe("/unipi:kanboard show", () => {
  const tasks = [
    { id: "KBL-1", title: "first", status: "todo", priority: "high", order: 2 },
    { id: "KBL-2", title: "second waits", status: "todo", priority: "none", order: 1, deps: ["KBL-1"], waitingFor: ["KBL-1"], ready: false },
    { id: "KBL-3", title: "running", status: "in_progress", priority: "none", run: { session: "pi-99" } },
    { id: "KBL-4", title: "stuck", status: "blocked", priority: "none", blockedReason: { text: "need creds" } },
    { id: "KBL-5", title: "old", status: "archived", priority: "none" },
  ];

  it("orders lanes, numbers todo by claim order, marks ready/waits", () => {
    const text = renderShowPlain("p", tasks, false);
    const order = ["In Progress", "Blocked", "Todo", "In Review", "Backlog", "Done"];
    let at = -1;
    for (const lane of order) {
      const next = text.indexOf(lane);
      assert.ok(next > at, `${lane} after ${at}: ${text}`);
      at = next;
    }
    assert.ok(!text.includes("old"), "archived hidden without --all");
    assert.match(text, /1\. KBL-1 ↑ first\s+ready/);
    assert.match(text, /└ 1\. KBL-2\s+second waits\s+waits for KBL-1/);
    assert.match(text, /KBL-3\s+running\s+· pi-99/);
    assert.match(text, /KBL-4\s+stuck\s+need creds/);
    assert.match(text, /In Review — empty/);
  });

  it("--all adds cancelled and archived; the themed renderer truncates titles", () => {
    const text = renderShowPlain("p", tasks, true);
    assert.ok(text.includes("Archived\n"));
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const rows = showRenderer(
      { content: "fallback", details: { project: "p", tasks, all: false } },
      null,
      theme as never,
    ).render(40);
    assert.ok(rows.some((line) => line.includes("…") || !line.includes("waits")), "short width truncates");
    assert.ok(rows[0]!.includes("p · 5 tasks"));
    // Fallback: no details → content as-is.
    const bare = showRenderer({ content: "plain text" }, null, theme as never).render(80);
    assert.deepEqual(bare, ["plain text"]);
  });
});
