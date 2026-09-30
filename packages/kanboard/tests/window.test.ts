/**
 * The write budget (src/guard.ts) and the `/unipi:kanboard-do` +
 * `/unipi:kanboard-autowork` handlers: reads always pass, children never
 * write, runner-era subcommands are refused, writes cost the -do budget
 * (own-claim closes are free), and the add cap applies always.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHILD_WRITE_REFUSAL,
  REMOVED_REFUSAL,
  SLOTS_USED_UP,
  WRITES_USED_UP,
  ADD_CAP_REASON,
  addCapReason,
  KNOWN_SUBCOMMANDS,
  createWriteGuard,
  isReadonly,
  kanboardInvocations,
} from "../src/guard.js";
import { registerKanboardCommands, HELP_CUSTOM_TYPE, DOCTOR_CUSTOM_TYPE, doText, autoworkText, kanboardCompletions, kanboardAddCompletions, kanboardDoCompletions, renderShowPlain, showRenderer } from "../src/commands.js";
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
    setAutowork: () => undefined,
    guard: createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false }),
    session: () => "test-session",
    debug: () => undefined,
    ...extra,
  } as CommandDeps;
}

const ctx = () => ({ cwd: process.cwd(), ui: { notify: () => undefined, confirm: async () => true }, isIdle: () => true }) as never;

describe("invocation parsing", () => {
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

  it("F1: only command-position tokens are invocations", () => {
    for (const cmd of [
      "which unipi-kanboard",
      "type unipi-kanboard",
      'find / -name "unipi-kanboard"',
      "ls -l /abs/bin/unipi-kanboard",
      "pip show pi-unipi-kanboard",
      "grep unipi-kanboard notes.txt",
      'echo "unipi-kanboard; echo done"',
    ]) {
      assert.deepEqual(kanboardInvocations(cmd), [], cmd);
    }
    assert.deepEqual(kanboardInvocations("KANBOARD_HOME=/x bin/unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("cd x && /abs/path/unipi-kanboard --actor agent show KB-1"), [
      { sub: "show", args: ["KB-1"] },
    ]);
    assert.deepEqual(kanboardInvocations("exec unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("env FOO=1 unipi-kanboard status"), [{ sub: "status", args: [] }]);
    assert.deepEqual(kanboardInvocations("command unipi-kanboard.exe list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("unipi-kanboard list --json | jq ."), [{ sub: "list", args: ["--json"] }]);
  });

  it("KNOWN_SUBCOMMANDS matches the CLI (crates/kanboard/src/cli.rs)", () => {
    assert.deepEqual([...KNOWN_SUBCOMMANDS].sort(), [
      "add", "archive-sweep", "attach", "attachments", "chain", "claim-next", "duplicate",
      "edit", "finish", "link", "list", "move", "next", "note", "order", "project", "queue",
      "reap", "release", "rotate-token", "search", "serve", "set-run", "settings", "show",
      "start", "status", "stop", "unlink", "unqueue", "validate",
    ]);
    for (const cmd of ["list", "show x", "attachments x", "next", "chain x", "search q", "status", "start x", "finish x"]) {
      const [inv] = kanboardInvocations(`unipi-kanboard ${cmd}`);
      assert.ok(KNOWN_SUBCOMMANDS.has(inv!.sub), cmd);
    }
  });

  it("classifies reads and writes", () => {
    for (const sub of ["list", "show x", "attachments x", "next", "chain x", "search q", "status"]) {
      const [inv] = kanboardInvocations(`unipi-kanboard ${sub}`);
      assert.ok(isReadonly(inv!), sub);
    }
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard project list")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard validate")[0]!));
    for (const cmd of [
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
});

describe("the write budget", () => {
  it("F2: an unknown subcommand is the binary's error, not a block", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    assert.equal(await guard.check("unipi-kanboard start KB-2; unipi-kanboard done KB-1"), null);
    assert.equal(await guard.check("unipi-kanboard done KB-1"), null, "alone it errors in the binary, not the guard");
    assert.equal(await guard.check("unipi-kanboard"), null, "bare binary prints help");
    assert.equal(await guard.check("unipi-kanboard bogus-sub KB-9"), null);
    assert.deepEqual(guard.remaining().writes, 10, "unknown subs never spend budget");
  });

  it("removed runner subcommands are refused, even in autowork and with budget", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    for (const cmd of [
      "unipi-kanboard queue A-1",
      "unipi-kanboard queue --list",
      "unipi-kanboard unqueue A-1",
      "unipi-kanboard claim-next",
      "unipi-kanboard set-run A-1 --mode goal",
      "unipi-kanboard edit A-1 --strategy goal",
      "unipi-kanboard edit A-1 --title x --plan yes",
    ]) {
      assert.equal(await guard.check(cmd), REMOVED_REFUSAL, cmd);
    }
    // Plain edits are ordinary writes.
    assert.equal(await guard.check("unipi-kanboard edit A-1 --title renamed"), null);
    assert.deepEqual(guard.remaining().writes, 9);
  });

  it("children can read but never write", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => true });
    assert.equal(await guard.check("unipi-kanboard list --json"), null, "reads pass");
    assert.equal(await guard.check("unipi-kanboard finish A-1 --comment done"), CHILD_WRITE_REFUSAL, "even free writes");
    guard.setAutowork(true);
    assert.equal(await guard.check("unipi-kanboard add t"), CHILD_WRITE_REFUSAL, "autowork does not unlock children");
    guard.open();
    assert.equal(await guard.check("unipi-kanboard note A-1 x"), CHILD_WRITE_REFUSAL);
  });

  it("finish is always free; blocked/note on own claims are free, otherwise a write", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    const owned = new Set(["UNI-5"]);
    const deps = { ownsClaim: async (id: string) => owned.has(id) };
    assert.equal(await guard.check("unipi-kanboard move UNI-5 blocked --comment need creds", deps), null, "own blocked is free");
    assert.equal(await guard.check("unipi-kanboard note UNI-5 'assumption: x'", deps), null, "own note is free");
    assert.equal(await guard.check("unipi-kanboard attach UNI-5 /tmp/shot.png --note after", deps), null, "own attach is free");
    assert.equal(await guard.check("unipi-kanboard note UNI-8 x"), null, "foreign note costs a write");
    assert.equal(await guard.check("unipi-kanboard move UNI-8 blocked --comment y"), null, "foreign blocked costs a write");
    assert.equal(await guard.check("unipi-kanboard move UNI-5 todo"), null, "move todo costs a write even on own claims");
    assert.deepEqual(guard.remaining(), { slots: 5, writes: 7, autowork: false });
    // The ownership probe is cached per check call, not per invocation.
    let probes = 0;
    const counting = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    counting.open();
    await counting.check(`unipi-kanboard note UNI-5 a && unipi-kanboard move UNI-5 blocked --comment b && unipi-kanboard note UNI-5 c`, {
      ownsClaim: async () => {
        probes += 1;
        return true;
      },
    });
    assert.equal(probes, 1, "one probe per id per check call");
  });

  it("start costs a slot; 0 slots refuses with the raise-the-limit text", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 2, doWrites: () => 10, isChild: () => false });
    assert.equal(await guard.check("unipi-kanboard start UNI-1"), SLOTS_USED_UP);
    guard.open();
    assert.equal(await guard.check("unipi-kanboard start UNI-1"), null);
    assert.equal(await guard.check("unipi-kanboard start UNI-2"), null);
    assert.deepEqual(guard.remaining().slots, 0);
    assert.equal(await guard.check("unipi-kanboard start UNI-3"), SLOTS_USED_UP);
    // Reads and writes still work at 0 slots.
    assert.equal(await guard.check("unipi-kanboard list --json"), null);
    assert.equal(await guard.check("unipi-kanboard note UNI-1 x"), null);
  });

  it("other writes cost the write budget; 0 refuses with the reload text", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 2, isChild: () => false });
    assert.equal(await guard.check("unipi-kanboard add t"), WRITES_USED_UP);
    guard.open();
    assert.equal(await guard.check("unipi-kanboard add a"), null);
    assert.equal(await guard.check("unipi-kanboard link A-1 A-2"), null);
    assert.equal(await guard.check("unipi-kanboard order A-1 A-2"), WRITES_USED_UP);
  });

  it("autowork: everything is free, the add cap still applies", async () => {
    const guard = createWriteGuard({ addLimit: () => 2, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.setAutowork(true);
    for (const cmd of [
      "unipi-kanboard start UNI-1",
      "unipi-kanboard add t",
      "unipi-kanboard note UNI-1 x",
      "unipi-kanboard move UNI-2 todo",
    ]) {
      assert.equal(await guard.check(cmd), null, cmd);
      assert.deepEqual(guard.remaining(), { slots: 0, writes: 0, autowork: true }, cmd);
    }
    assert.equal(await guard.check("unipi-kanboard add second"), null, "two adds fit under the cap");
    assert.equal(await guard.check("unipi-kanboard add third"), addCapReason(2), "the runaway guard survives autowork");
  });

  it("budget persists across turns and tops up to N without stacking", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    for (let i = 0; i < 9; i += 1) assert.equal(await guard.check("unipi-kanboard note A-1 x"), null, `write ${i + 1}`);
    assert.deepEqual(guard.remaining().writes, 1);
    // agent_end closes the -do window label but NOT the budget.
    guard.noteSent();
    guard.onAgentEnd();
    assert.equal(await guard.check("unipi-kanboard edit A-1 x"), null, "budget outlives the turn");
    assert.deepEqual(guard.remaining().writes, 0);
    assert.equal(await guard.check("unipi-kanboard move A-1 done"), WRITES_USED_UP);
    // Re-running -do tops up — it does not stack.
    guard.open();
    assert.deepEqual(guard.remaining(), { slots: 5, writes: 10, autowork: false });
    guard.open();
    assert.deepEqual(guard.remaining(), { slots: 5, writes: 10, autowork: false });
    // off revokes both.
    guard.revoke();
    assert.deepEqual(guard.remaining(), { slots: 0, writes: 0, autowork: false });
    assert.equal(await guard.check("unipi-kanboard move A-1 done"), WRITES_USED_UP);
    assert.equal(await guard.check("unipi-kanboard start A-1"), SLOTS_USED_UP);
  });

  it("closes only after the send (the 150ms echo guard)", async () => {
    const guard = createWriteGuard({});
    guard.open();
    guard.noteSent();
    assert.equal(guard.onAgentEnd(), false, "an immediate agent_end is the previous turn's");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(guard.onAgentEnd(), true);
    assert.equal(guard.onAgentEnd(), false, "the window stays closed");
  });

  it("caps add at the limit per window and resets on open", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 100, isChild: () => false });
    guard.open();
    for (let i = 0; i < 20; i += 1) assert.equal(await guard.check("unipi-kanboard add t"), null, `add ${i + 1}`);
    assert.equal(await guard.check("unipi-kanboard add t"), ADD_CAP_REASON);
    assert.equal(await guard.check("unipi-kanboard note A-1 x"), null, "other writes still allowed");
    guard.open();
    assert.equal(await guard.check("unipi-kanboard add t"), null, "a new window resets the cap");
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

  it("reveals the skill, grants the budget and sends the DO_TEXT", async () => {
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
      assert.match(kind.sent[0]!.message, /5 task slots — each `start` uses one — and 10 board writes/);
      assert.match(kind.sent[0]!.message, /if that is more than 5, start nothing/);
      // Budget persists past agent_end — the window label closes, not the grant.
      assert.equal(await deps.guard.check("unipi-kanboard add x"), null);
      assert.equal(deps.guard.onAgentEnd(), false, "the echo end is ignored");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(deps.guard.onAgentEnd(), true, "the turn's end closes the window label");
      assert.equal(await deps.guard.check("unipi-kanboard add x"), null, "budget survives the turn");
      assert.deepEqual(deps.guard.remaining().writes, 8);
    } finally {
      delete process.env.UNIPI_KANBOARD_PROJECT;
    }
  });

  it("'off' revokes the budget", async () => {
    const kind = fakePi();
    const notifications: string[] = [];
    const deps = depsWith();
    registerKanboardCommands(kind.pi, deps);
    deps.guard.open();
    assert.deepEqual(deps.guard.remaining(), { slots: 5, writes: 10, autowork: false });
    const c = { cwd: process.cwd(), ui: { notify: (m: string) => notifications.push(m) } } as never;
    await kind.handlers.get("unipi:kanboard-do")!("off", c);
    assert.match(notifications.at(-1) ?? "", /revoked/);
    assert.deepEqual(deps.guard.remaining(), { slots: 0, writes: 0, autowork: false });
    assert.equal(await deps.guard.check("unipi-kanboard move A-1 done"), WRITES_USED_UP);
    assert.equal(await deps.guard.check("unipi-kanboard show A-1"), null, "reads stay free");
  });
});

describe("/unipi:kanboard-autowork", () => {
  it("start flips guard+deps to autowork and sends the autowork text; stop turns it off", async () => {
    const kind = fakePi();
    const autowork: boolean[] = [];
    const notifications: string[] = [];
    const deps = depsWith({ setAutowork: (on) => autowork.push(on) });
    registerKanboardCommands(kind.pi, deps);
    process.env.UNIPI_KANBOARD_PROJECT = "test-proj";
    try {
      await kind.handlers.get("unipi:kanboard-autowork")!("start", ctx());
      assert.deepEqual(autowork, [true]);
      assert.equal(kind.sent.length, 1);
      assert.match(kind.sent[0]!.message, /Autowork on project test-proj/);
      assert.match(kind.sent[0]!.message, /work every ready task/);
      assert.equal(deps.guard.remaining().autowork, true);

      await kind.handlers.get("unipi:kanboard-autowork")!("stop", {
        cwd: process.cwd(),
        ui: { notify: (m: string) => notifications.push(m) },
      } as never);
      assert.deepEqual(autowork, [true, false]);
      assert.equal(deps.guard.remaining().autowork, false);

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

describe("doText / autoworkText", () => {
  it("fills in slug and cli verbatim", () => {
    const text = doText("my-slug", "/abs/unipi-kanboard", "file the bugs");
    assert.match(text, /project my-slug/);
    assert.match(text, /`\/abs\/unipi-kanboard --actor agent --project my-slug …`/);
    assert.match(text, /Request: file the bugs$/);
  });

  it("states the budgets, the always-free set and the pre-flight rule", () => {
    const text = doText("s", "/bin/kb", "req", 5, 10);
    assert.match(text, /Budget this session: 5 task slots — each `start` uses one — and 10 board writes/);
    assert.match(text, /Always free: reads, and `finish`, `move <ID> blocked --comment`, `note` and `attach` on tasks you started/);
    assert.match(text, /if that is more than 5, start nothing — tell me you can do 5 now/);
    assert.match(text, /Sidekicks and subagents can read the board but not write it/);
    const singular = doText("s", "/bin/kb", "req", 1, 1);
    assert.match(singular, /1 task slot — each `start` uses one — and 1 board write /);
    assert.doesNotMatch(singular, /slots/);
  });

  it("autowork text: every ready task, no budget limits, any mode", () => {
    const text = autoworkText("s", "/bin/kb");
    assert.match(text, /work every ready task on the board, one at a time/);
    assert.match(text, /No budget limits/);
    assert.match(text, /regular, goal, ralph, swarm, graph/);
    assert.match(text, /Sidekicks and subagents can read the board but not write it/);
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
  it("blocks past the configured limit and 0 is unlimited", async () => {
    const guard = createWriteGuard({ addLimit: () => 3, doTasks: () => 5, doWrites: () => 100, isChild: () => false });
    guard.open();
    assert.equal(await guard.check("unipi-kanboard add a"), null);
    assert.equal(await guard.check("unipi-kanboard add b"), null);
    assert.equal(await guard.check("unipi-kanboard add c"), null);
    assert.equal(await guard.check("unipi-kanboard add d"), "at most 3 new tasks per turn");

    const unlimited = createWriteGuard({ addLimit: () => 0, doTasks: () => 5, doWrites: () => 100, isChild: () => false });
    unlimited.open();
    for (let index = 0; index < 50; index += 1) {
      assert.equal(await unlimited.check(`unipi-kanboard add t${index}`), null);
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
        maxSessions: 1, turnAddLimit: 20,
      }),
    });
    registerKanboardCommands(kind.pi, deps);
    const handler = kind.events.get("tool_call")![0]!;
    try {
      await handler(
        { toolName: "bash", input: { command: "echo hi" } },
        { cwd: process.cwd(), ui: { notify: () => undefined } },
      );
      assert.equal(process.env.UNIPI_KANBOARD_MAX_SESSIONS, "1");
    } finally {
      delete process.env.UNIPI_KANBOARD_MAX_SESSIONS;
    }
  });
});

describe("kanboard completions", () => {
  it("subcommands complete with the full-arg value (prefix is replaced whole)", () => {
    const items = kanboardCompletions("o")!;
    assert.deepEqual(items.map((i) => i.value), ["open", "onboard"]);
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
    const bare = showRenderer({ content: "plain text" }, null, theme as never).render(80);
    assert.deepEqual(bare, ["plain text"]);
  });
});
