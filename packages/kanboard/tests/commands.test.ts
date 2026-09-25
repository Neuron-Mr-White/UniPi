/**
 * `/unipi:kanboard-add` argument parsing — flags before the title, `-p` maps
 * 1..5 to none..urgent, later lines are the body, and existing file paths in
 * the body become `--attach`. The handler tests drive the real command handler
 * and the real binary.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCli } from "../src/bin.js";
import { createWriteGuard } from "../src/guard.js";
import {
  detectFilePaths,
  parseAddArgs,
  registerKanboardCommands,
  tokenizeArgs,
  HELP,
  HELP_CUSTOM_TYPE,
  type CommandDeps,
} from "../src/commands.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const binary = join(repoRoot, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const hasBinary = existsSync(binary);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Read board state the way the extension does (same binary, `--json`). */
function cliJson<T>(home: string, cwd: string, args: string[]): T {
  const stdout = execFileSync(binary, [...args, "--json"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_ACTOR: "user" },
  });
  return JSON.parse(stdout) as T;
}

/** Capture every registered command handler so the tests drive the real ones. */
function fakePi(): {
  pi: never;
  handler: (name: string, args: string, ctx: never) => Promise<void>;
  notifications: string[];
  messages: Array<{ customType: string; content: string }>;
} {
  const notifications: string[] = [];
  const messages: Array<{ customType: string; content: string }> = [];
  const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) => {
      handlers.set(name, options.handler);
    },
    registerShortcut: () => undefined,
    on: () => undefined,
    sendMessage: (message: { customType: string; content: string }) => messages.push(message),
    sendUserMessage: () => undefined,
  };
  return {
    pi: pi as never,
    notifications,
    messages,
    handler: (name: string, args: string, ctx: never) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} was not registered`);
      return handler(args, ctx);
    },
  };
}

describe("add argument parsing", () => {
  it("parses flags before the title and keeps the rest verbatim", () => {
    assert.deepEqual(parseAddArgs("--priority high --status todo ship the release"), {
      title: "ship the release",
      flags: ["--priority", "high", "--status", "todo"],
      description: "",
      attaches: [],
      error: null,
    });
    assert.deepEqual(parseAddArgs("--after PIT-1 --after=PIT-2 deploy"), {
      title: "deploy",
      flags: ["--after", "PIT-1", "--after", "PIT-2"],
      description: "",
      attaches: [],
      error: null,
    });
    // A flag-looking word after the title stays in the title.
    assert.equal(parseAddArgs("ship --dry-run now").title, "ship --dry-run now");
  });

  it("maps -p 1..5 to none..urgent (5 is urgent, not inverted)", () => {
    assert.deepEqual(parseAddArgs("-p 1 task").flags, ["--priority", "none"]);
    assert.deepEqual(parseAddArgs("-p3 task").flags, ["--priority", "medium"]);
    assert.deepEqual(parseAddArgs("-p=5 task").flags, ["--priority", "urgent"]);
    assert.match(parseAddArgs("-p 9 task").error ?? "", /-p takes 1-5/);
    assert.match(parseAddArgs("-p task").error ?? "", /-p takes 1-5/);
  });

  it("missing values and missing titles are usage errors", () => {
    assert.match(parseAddArgs("--after").error ?? "", /--after needs a value/);
    assert.match(parseAddArgs("--priority=").error ?? "", /--priority needs a value/);
    assert.equal(parseAddArgs("--priority high").title, "");
    assert.equal(parseAddArgs("").title, "");
  });

  it("lines below the title are the description; existing paths attach", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kb-att-")), "shot.png");
    writeFileSync(file, "png");
    const parsed = parseAddArgs(`title line\nfirst body line\nsecond line ${file}`);
    assert.equal(parsed.title, "title line");
    assert.equal(parsed.description, `first body line\nsecond line ${file}`);
    assert.deepEqual(parsed.attaches, [file]);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  it("detects ~/ paths and markdown-wrapped paths that exist", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kb-att-")), "log.txt");
    writeFileSync(file, "log");
    assert.deepEqual(detectFilePaths(`see ${file} and !![](${file}) and ${file}.`), [file]);
    assert.deepEqual(detectFilePaths(`see /nope/missing-${Date.now()}.png`), []);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  it("tokenizes like a shell", () => {
    assert.deepEqual(tokenizeArgs('a "b c" d'), ["a", "b c", "d"]);
    assert.deepEqual(tokenizeArgs('a "b \\"quoted\\" c"'), ["a", 'b "quoted" c']);
    assert.deepEqual(tokenizeArgs(""), []);
  });
});

describe("help and legacy subcommands", () => {
  it("bare /unipi:kanboard posts the help as a filtered custom message", async () => {
    const { handler, pi, messages } = fakePi() as ReturnType<typeof fakePi> & { pi: never };
    const deps = { cli: null, unavailable: "no binary" } as never;
    registerKanboardCommands(pi, deps);
    const ctx = { cwd: process.cwd(), ui: { notify: () => undefined } } as never;
    await handler("unipi:kanboard", "", ctx);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.customType, HELP_CUSTOM_TYPE);
    assert.equal(messages[0]!.content, HELP);
  });

  it("old subcommands only point at the new commands", async () => {
    const { handler, pi, notifications } = fakePi();
    registerKanboardCommands(pi, { cli: null, unavailable: "x" } as never);
    const ctx = { cwd: process.cwd(), ui: { notify: (m: string) => notifications.push(m) } } as never;
    await handler("unipi:kanboard", "add buy milk", ctx);
    assert.match(notifications.at(-1) ?? "", /kanboard-add/);
    await handler("unipi:kanboard", "work", ctx);
    assert.match(notifications.at(-1) ?? "", /autowork start/);
    await handler("unipi:kanboard", "stop", ctx);
    assert.match(notifications.at(-1) ?? "", /autowork stop/);
    await handler("unipi:kanboard", "buy milk", ctx);
    assert.match(notifications.at(-1) ?? "", /unknown subcommand/);
  });
});

describe("add through the real handler + binary", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let deps: CommandDeps;
  let notifications: string[];
  let handler: (name: string, args: string, ctx: never) => Promise<void>;
  let projects = 0;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "kb-add-home-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-add-ws-"));
    git(workspace, ["init", "--quiet"]);
    const pi = fakePi();
    handler = pi.handler;
    notifications = pi.notifications;
    const cli = createCli({ path: binary, source: "dev-build" }, {
      ...process.env,
      UNIPI_KANBOARD_HOME: home,
      UNIPI_KANBOARD_ACTOR: "user",
    });
    deps = {
      cli,
      unavailable: null,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      revealSkill: () => undefined,
      work: async () => undefined,
      stop: () => undefined,
      drainQueue: async () => undefined,
      status: () => ({ taskId: null, mode: null, phase: "idle" }),
      guard: createWriteGuard(() => null),
      session: () => "test-session",
      debug: () => undefined,
    };
    registerKanboardCommands(pi.pi, deps);
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  /** One board per test: a unique git worktree keeps slugs from colliding. */
  beforeEach(() => {
    projects += 1;
    workspace = mkdtempSync(join(tmpdir(), `kb-add-ws-${projects}-`));
    git(workspace, ["init", "--quiet"]);
    notifications.length = 0;
  });

  const ctx = () => ({ cwd: workspace, ui: { notify: (message: string) => notifications.push(message), confirm: async () => true } }) as never;

  /** Register this workspace on the board (the CLI's `onboard` equivalent). */
  function onboard(): string {
    return cliJson<{ slug: string }>(home, workspace, ["project", "add", "--name", workspace.split("/").pop()!]).slug;
  }

  function listed(): Array<{ id: string; title: string; status: string; priority: string; body?: string; deps?: Array<{ id: string } | string> }> {
    return cliJson<{ tasks: Array<{ id: string; title: string; status: string; priority: string; body?: string; deps?: Array<{ id: string } | string> }> }>(home, workspace, [
      "list",
    ]).tasks;
  }

  it("stores flags, title and a multi-line body", async () => {
    onboard();
    const seed = cliJson<{ id: string }>(home, workspace, ["add", "seed task"]);
    await handler("unipi:kanboard-add", `--after ${seed.id} --status todo -p 5 deploy tonight\nline two of the body`, ctx());
    const created = listed().find((task) => task.title === "deploy tonight")!;
    assert.equal(created.status, "todo");
    assert.equal(created.priority, "urgent");
    assert.equal(created.body, "line two of the body");
    assert.deepEqual(
      (created.deps ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id)),
      [seed.id],
    );
    assert.match(notifications.at(-1) ?? "", /^✓ .* added to Todo$/);
  });

  it("attaches a pasted file path and embeds its markdown", async () => {
    onboard();
    const file = join(mkdtempSync(join(tmpdir(), "kb-att-ws-")), "shot.png");
    writeFileSync(file, "png bytes");
    await handler("unipi:kanboard-add", `broken layout\nlooks like ${file} here`, ctx());
    const created = listed().find((task) => task.title === "broken layout")!;
    assert.ok(created.body!.includes("shot.png](att:"), `body: ${created.body}`);
    assert.ok(!created.body!.includes(file), `path replaced: ${created.body}`);
    assert.match(notifications.at(-1) ?? "", /\(1 attachment\)/);
  });

  it("a missing title is a usage notify, not a task", async () => {
    onboard();
    await handler("unipi:kanboard-add", "--priority high", ctx());
    assert.match(notifications.at(-1) ?? "", /needs a title/);
    assert.equal(listed().length, 0);
  });
});

describe("/unipi:kanboard close", () => {
  it("is a subcommand with its own completion", async () => {
    const { SUBCOMMANDS } = await import("../src/commands.js");
    assert.ok((SUBCOMMANDS as readonly string[]).includes("close"));
  });
});
