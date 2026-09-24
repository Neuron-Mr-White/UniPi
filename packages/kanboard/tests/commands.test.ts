/**
 * `/unipi:kanboard add` argument parsing, through the REAL command handler and
 * the REAL binary.
 *
 * Regression (K7 review): the handler passed everything after `add` straight
 * through as the title, so flags were swallowed into it — coffee ended up with
 * `document the --version flag in README.md" --after PIT-8` as a task title
 * (PIT-9) and a dependency that was never recorded. Quotes the user typed for
 * grouping were stored verbatim too.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCli } from "../src/bin.js";
import { parseAddArgs, registerKanboardCommand, tokenizeArgs, type CommandDeps } from "../src/commands.js";
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

/** Capture the registered command handler so the tests drive the real one. */
function fakePi(): { pi: never; handler: (args: string, ctx: never) => Promise<void>; notifications: string[] } {
  const notifications: string[] = [];
  let handler: ((args: string, ctx: never) => Promise<void>) | null = null;
  const pi = {
    registerCommand: (_name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) => {
      handler = options.handler;
    },
    registerShortcut: () => undefined,
  };
  return {
    pi: pi as never,
    notifications,
    handler: (args: string, ctx: never) => {
      if (!handler) throw new Error("the kanboard command was not registered");
      return handler(args, ctx);
    },
  };
}

describe("add argument parsing", () => {
  it("keeps quoted titles together and drops the quotes", () => {
    assert.deepEqual(parseAddArgs('"title with quotes"'), { title: "title with quotes", flags: [], error: null });
    assert.deepEqual(parseAddArgs("'single quoted'"), { title: "single quoted", flags: [], error: null });
    assert.deepEqual(parseAddArgs('  "  padded  "  '), { title: "padded", flags: [], error: null });
  });

  it("pulls flags out of the title", () => {
    assert.deepEqual(parseAddArgs('"title with quotes" --after PIT-1'), {
      title: "title with quotes",
      flags: ["--after", "PIT-1"],
      error: null,
    });
    assert.deepEqual(parseAddArgs("deploy --priority high --status todo --after PIT-1 --after PIT-2"), {
      title: "deploy",
      flags: ["--priority", "high", "--status", "todo", "--after", "PIT-1", "--after", "PIT-2"],
      error: null,
    });
    assert.deepEqual(parseAddArgs("deploy --after=PIT-1 --priority=low"), {
      title: "deploy",
      flags: ["--after", "PIT-1", "--priority", "low"],
      error: null,
    });
  });

  it("keeps plain words, apostrophes and unknown flags in the title", () => {
    assert.deepEqual(parseAddArgs("plain words"), { title: "plain words", flags: [], error: null });
    assert.deepEqual(parseAddArgs("fix it's cache"), { title: "fix it's cache", flags: [], error: null });
    assert.deepEqual(parseAddArgs("ship --dry-run now"), { title: "ship --dry-run now", flags: [], error: null });
  });

  it("reports a flag with no value instead of eating the title", () => {
    assert.deepEqual(parseAddArgs("deploy --after"), { title: "deploy", flags: [], error: "--after needs a value" });
    assert.deepEqual(parseAddArgs("deploy --priority="), { title: "deploy", flags: [], error: "--priority needs a value" });
  });

  it("tokenizes like a shell", () => {
    assert.deepEqual(tokenizeArgs('a "b c" d'), ["a", "b c", "d"]);
    assert.deepEqual(tokenizeArgs('a "b \\"quoted\\" c"'), ["a", 'b "quoted" c']);
    assert.deepEqual(tokenizeArgs(""), []);
  });
});

describe("add through the real handler + binary", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let deps: CommandDeps;
  let notifications: string[];
  let handler: (args: string, ctx: never) => Promise<void>;
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
      settings: () => ({ ...DEFAULT_SETTINGS, enabled: true, autoOnboard: false }),
      revealSkill: () => undefined,
      work: async () => undefined,
      stop: () => undefined,
      status: () => ({ taskId: null, mode: null, phase: "idle" }),
      debug: () => undefined,
    };
    registerKanboardCommand(pi.pi, deps);
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

  const ctx = () => ({ cwd: workspace, ui: { notify: (message: string) => notifications.push(message) } }) as never;

  /** Register this workspace on the board (the CLI's `onboard` equivalent). */
  function onboard(): string {
    return cliJson<{ slug: string }>(home, workspace, ["project", "add", "--name", workspace.split("/").pop()!]).slug;
  }

  /** Read a task back through the CLI (the same binary the extension uses). */
  function show(id: string): { title: string; status: string; deps: string[] } {
    const raw = cliJson<{ title: string; status: string; deps?: Array<{ id: string }> | string[] }>(home, workspace, [
      "show",
      id,
    ]);
    const depends = (raw.deps ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));
    return { title: raw.title, status: raw.status, deps: depends };
  }

  function listed(): Array<{ id: string; title: string; status: string; priority: string }> {
    return cliJson<{ tasks: Array<{ id: string; title: string; status: string; priority: string }> }>(home, workspace, [
      "list",
    ]).tasks;
  }

  it("stores a clean title and records the dependency", async () => {
    onboard();
    const seed = cliJson<{ id: string }>(home, workspace, ["add", "seed task"]);
    await handler(`add "title with quotes" --after ${seed.id}`, ctx());
    const created = listed().map((task) => task.id).sort().pop()!;
    const task = show(created);
    assert.equal(task.title, "title with quotes");
    assert.deepEqual(task.deps, [seed.id]);
    assert.match(notifications.at(-1) ?? "", /added to Backlog \(--after /);
  });

  it("lands in Todo when --status says so, with the flag reported", async () => {
    onboard();
    await handler("add ship the release --status todo --priority high", ctx());
    const task = listed().find((entry) => entry.priority === "high");
    assert.ok(task, "the task must carry the priority it was given");
    assert.equal(task.status, "todo");
    assert.equal(task.title, "ship the release");
    assert.match(notifications.at(-1) ?? "", /added to Todo \(--status todo --priority high\)/);
  });

  it("keeps an apostrophe and plain words intact", async () => {
    onboard();
    await handler("add fix it's cache", ctx());
    assert.equal(listed().at(-1)!.title, "fix it's cache");
  });

  it("refuses a flag with no value instead of creating a task", async () => {
    onboard();
    await handler("add deploy --after", ctx());
    assert.match(notifications.at(-1) ?? "", /--after needs a value/);
    assert.equal(listed().length, 0);
  });
});

describe("/unipi:kanboard close", () => {
  it("is a subcommand with its own completion", async () => {
    const { SUBCOMMANDS } = await import("../src/commands.js");
    assert.ok((SUBCOMMANDS as readonly string[]).includes("close"));
  });
});
