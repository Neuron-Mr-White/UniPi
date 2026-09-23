/**
 * Binary resolution, the CLI bridge, and the `/unipi:kanboard` commands.
 * Uses the real debug build against a temp UNIPI_KANBOARD_HOME.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCli, resolveBinary, unavailableMessage, KanboardCliError, platformKey } from "../src/bin.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const debugBinary = join(repoRoot, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const hasBinary = existsSync(debugBinary);

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "kb-test-"));
}

/** A fake binary that answers `--json` with a canned payload. */
function fakeBinary(expression: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-fake-"));
  const path = join(dir, "unipi-kanboard");
  writeFileSync(
    path,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nconst json = args.includes("--json");\n` +
      `const out = ${expression};\n` +
      `if (out.__fail) { process.stderr.write(JSON.stringify({ ok: false, error: "in_review → todo requires --comment (rework note)", kind: "rule" })); process.exit(1); }\n` +
      `process.stdout.write(json ? JSON.stringify(out) : "human output");\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("binary resolution", () => {
  it("prefers UNIPI_KANBOARD_BIN", () => {
    const path = fakeBinary('({ ok: true })');
    const resolved = resolveBinary({ UNIPI_KANBOARD_BIN: path } as NodeJS.ProcessEnv);
    assert.equal(resolved?.source, "env");
    assert.equal(resolved?.path, path);
  });

  it("reports nothing when the env path does not exist", () => {
    assert.equal(resolveBinary({ UNIPI_KANBOARD_BIN: "/nope/unipi-kanboard" } as NodeJS.ProcessEnv), null);
    assert.match(unavailableMessage("linux", "x64"), /^kanboard binary unavailable for linux-x64$/);
  });

  it("falls back to the dev build in the repo", { skip: !hasBinary }, () => {
    const resolved = resolveBinary({} as NodeJS.ProcessEnv);
    assert.equal(resolved?.source, "dev-build");
    assert.match(resolved!.path, /crates\/kanboard\/target\/(release|debug)\/unipi-kanboard$/);
  });

  it("names the platform in the unavailable message", () => {
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
    assert.match(unavailableMessage("win32", "x64"), /win32-x64/);
  });
});

describe("CLI bridge", () => {
  it("parses JSON and adds --json", async () => {
    const path = fakeBinary('({ id: "UNI-1" })');
    const cli = createCli({ path, source: "env" });
    const payload = await cli.run<{ id: string }>(["show", "UNI-1"]);
    assert.equal(payload.id, "UNI-1");
  });

  it("surfaces the rule message and kind on failure", async () => {
    const path = fakeBinary('({ __fail: true })');
    const cli = createCli({ path, source: "env" });
    await assert.rejects(
      () => cli.run(["move", "UNI-1", "todo"]),
      (error: unknown) => {
        assert.ok(error instanceof KanboardCliError);
        assert.match((error as Error).message, /requires --comment/);
        assert.equal((error as KanboardCliError).kind, "rule");
        return true;
      },
    );
  });

  it("passes the project and actor through the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-env-"));
    const probe = join(dir, "unipi-kanboard");
    writeFileSync(
      probe,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ project: process.env.UNIPI_KANBOARD_PROJECT ?? null, actor: process.env.UNIPI_KANBOARD_ACTOR ?? null }));\n`,
    );
    chmodSync(probe, 0o755);
    const cli = createCli({ path: probe, source: "env" }, { PATH: process.env.PATH } as NodeJS.ProcessEnv);
    const payload = await cli.run<{ project: string; actor: string }>(["list"], {
      extraEnv: { UNIPI_KANBOARD_PROJECT: "demo-123456" },
    });
    assert.equal(payload.project, "demo-123456");
    assert.equal(payload.actor, "user", "the extension acts as the user");
  });
});

describe("commands against the real binary", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let cli: ReturnType<typeof createCli>;
  let deps: ReturnType<typeof buildDeps>;

  function notifications(): { lines: string[]; ui: Record<string, unknown> } {
    const lines: string[] = [];
    return {
      lines,
      ui: {
        notify: (message: string) => lines.push(message),
        setStatus: () => undefined,
        confirm: async () => true,
        select: async () => undefined,
        input: async () => undefined,
      },
    };
  }

  function buildDeps(extra: Record<string, unknown> = {}) {
    const noted = notifications();
    return {
      cli,
      unavailable: null,
      settings: () => ({
        chainGate: "in_review" as const,
        continue: false,
        idleMin: 10,
        port: 0,
        archiveAfterDays: 0,
        openBrowser: false,
      }),
      revealSkill: () => undefined,
      work: async () => undefined,
      stop: () => undefined,
      status: () => ({ taskId: null, mode: null, phase: "idle" }),
      debug: () => undefined,
      __noted: noted,
      ...extra,
    };
  }

  before(() => {
    home = tempHome();
    workspace = mkdtempSync(join(tmpdir(), "kb-ws-"));
    process.env.UNIPI_KANBOARD_HOME = home;
    cli = createCli({ path: debugBinary, source: "dev-build" }, { ...process.env, UNIPI_KANBOARD_HOME: home });
  });

  after(() => {
    delete process.env.UNIPI_KANBOARD_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("onboard registers the project once and is idempotent", async () => {
    const { runOnboard } = await import("../src/commands.js");
    deps = buildDeps();
    const ctx = { cwd: workspace, ui: (deps as unknown as { __noted: { ui: unknown } }).__noted.ui } as never;
    const first = await runOnboard(deps as never, ctx);
    assert.ok(first, "project registered");
    const second = await runOnboard(deps as never, ctx);
    assert.equal(second, first, "same slug the second time");
    const projects = execFileSync(debugBinary, ["project", "list", "--json"], {
      env: { ...process.env, UNIPI_KANBOARD_HOME: home },
      cwd: workspace,
      encoding: "utf-8",
    });
    assert.equal(JSON.parse(projects).length, 1, "no duplicate project");
  });

  it("add captures into Backlog and reports the id", async () => {
    const { runAdd } = await import("../src/commands.js");
    const noted = notifications();
    const ctx = { cwd: workspace, ui: noted.ui } as never;
    await runAdd(deps as never, ctx, "write the onboarding guide");
    assert.match(noted.lines.at(-1) ?? "", /^[A-Z]+-\d+ added to Backlog$/);
  });

  it("status reports daemon, project counts and the runner", async () => {
    const { runStatus } = await import("../src/commands.js");
    const noted = notifications();
    const ctx = { cwd: workspace, ui: noted.ui } as never;
    await runStatus(deps as never, ctx);
    const text = noted.lines.at(-1) ?? "";
    assert.match(text, /daemon: not running/);
    assert.match(text, /project: /);
    assert.match(text, /runner: idle/);
  });

  it("unavailable binary: nothing runs and the message names the platform", async () => {
    const { runAdd } = await import("../src/commands.js");
    const noted = notifications();
    const ctx = { cwd: workspace, ui: noted.ui } as never;
    await runAdd(buildDeps({ cli: null, unavailable: unavailableMessage("darwin", "arm64") }) as never, ctx, "nope");
    assert.deepEqual(noted.lines, [`kanboard: ${unavailableMessage("darwin", "arm64")}`]);
  });

  it("open spawns the daemon, reuses it, and stops it", async () => {
    const { runOpen, runStopDaemon } = await import("../src/commands.js");
    process.env.UNIPI_KANBOARD_PROJECT = "kb-test-000000";
    const noted = notifications();
    const ctx = { cwd: workspace, ui: noted.ui } as never;
    await runOpen(deps as never, ctx);
    const url = noted.lines.at(-1) ?? "";
    assert.match(url, /^kanboard: http:\/\/127\.0\.0\.1:\d+\/p\//, `got: ${url}`);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(url)?.[1]);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal((health as { ok: boolean }).ok, true);

    // A second open reuses the same daemon instead of spawning another.
    const again = notifications();
    await runOpen(deps as never, { cwd: workspace, ui: again.ui } as never);
    assert.equal(/127\.0\.0\.1:(\d+)/.exec(again.lines.at(-1) ?? "")?.[1], String(port));

    const stopped = notifications();
    await runStopDaemon(deps as never, { cwd: workspace, ui: stopped.ui } as never);
    assert.match(stopped.lines.at(-1) ?? "", /daemon stopped/);
  });

  it("commands read the binary at call time, not at registration (lazy deps)", async () => {
    // Regression: index.ts registers the command before the binary is resolved.
    // A frozen `cli: null` made every subcommand answer "kanboard: null".
    const { registerKanboardCommand } = await import("../src/commands.js");
    let current: ReturnType<typeof createCli> | null = null;
    let unavailable: string | null = null;
    const noted = notifications();

    let handler!: (args: string, ctx: unknown) => Promise<void>;
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as never;

    const lazyDeps = {
      get cli() {
        return current;
      },
      get unavailable() {
        return unavailable;
      },
      settings: () => ({ chainGate: "in_review", continue: false, idleMin: 10, port: 0, archiveAfterDays: 0, openBrowser: false }),
      revealSkill: () => undefined,
      work: async () => undefined,
      stop: () => undefined,
      status: () => ({ taskId: null, mode: null, phase: "idle" }),
      debug: () => undefined,
    };
    registerKanboardCommand(pi, lazyDeps as never);

    const ctx = { cwd: workspace, ui: noted.ui } as never;
    // Before the binary is resolved: refuse, and say why.
    unavailable = "kanboard binary unavailable for linux-x64";
    await handler("status", ctx);
    assert.deepEqual(noted.lines, ["kanboard: kanboard binary unavailable for linux-x64"]);

    // After it resolves, the same registered handler works.
    current = cli;
    unavailable = null;
    await handler("add lazy capture", ctx);
    assert.match(noted.lines.at(-1) ?? "", /^[A-Z]+-\d+ added to Backlog$/);
  });

  it("archive sweep runs on session start when archiveAfterDays is set", async () => {
    delete process.env.UNIPI_KANBOARD_PROJECT;
    const tasks = execFileSync(debugBinary, ["list", "--json"], {
      env: { ...process.env, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_PROJECT: "" },
      cwd: workspace,
      encoding: "utf-8",
    });
    assert.ok(JSON.parse(tasks).tasks.length >= 1);
    const swept = execFileSync(debugBinary, ["archive-sweep", "--after-days", "7", "--json"], {
      env: { ...process.env, UNIPI_KANBOARD_HOME: home },
      cwd: workspace,
      encoding: "utf-8",
    });
    assert.deepEqual(JSON.parse(swept).archived, [], "nothing old enough yet");
  });
});
