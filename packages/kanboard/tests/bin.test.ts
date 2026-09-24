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

import { createCli, exeSuffix, platformKey, platformPackagePath, resolveBinary, unavailableMessage, KanboardCliError } from "../src/bin.js";
import { formatBoardUrls, isLoopbackHost, parseOpenArgs, reachableAddresses, readDaemonInfo, resolveHost } from "../src/commands.js";

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

  it("resolves an installed platform package before the dev build", () => {
    // Simulate `npm install` laying out the platform package in node_modules.
    const project = mkdtempSync(join(tmpdir(), "kb-install-"));
    const pkgDir = join(project, "node_modules", `@pi-unipi/kanboard-${platformKey()}`, "bin");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(project, "node_modules", `@pi-unipi/kanboard-${platformKey()}`, "package.json"),
      JSON.stringify({ name: `@pi-unipi/kanboard-${platformKey()}`, version: "9.9.9", main: "index.js" }),
    );
    const binary = join(pkgDir, `unipi-kanboard${exeSuffix()}`);
    writeFileSync(binary, "#!/bin/sh\necho ok\n");
    chmodSync(binary, 0o755);

    const resolved = resolveBinary({} as NodeJS.ProcessEnv, join(project, "index.js"));
    assert.equal(resolved?.source, "platform-package", "the installed package wins");
    assert.equal(resolved?.path, binary);
    // …and the dev build is only a fallback.
    assert.equal(platformPackagePath(join(project, "index.js")), binary);
  });

  it("ignores a platform package that is not installed", () => {
    const empty = mkdtempSync(join(tmpdir(), "kb-empty-"));
    assert.equal(platformPackagePath(join(empty, "index.js")), null);
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

describe("remote access helpers", () => {
  it("parses open flags, overriding the settings for this call only", () => {
    const settings = { host: "127.0.0.1", port: 0 };
    assert.deepEqual(parseOpenArgs("", settings), { host: "127.0.0.1", port: 0, unknown: [] });
    assert.deepEqual(parseOpenArgs("--host 0.0.0.0 --port 37473", settings), {
      host: "0.0.0.0",
      port: 37473,
      unknown: [],
    });
    assert.deepEqual(parseOpenArgs("--host=tailscale --port=1234", settings), {
      host: "tailscale",
      port: 1234,
      unknown: [],
    });
    // A bad port is reported, not silently accepted.
    assert.deepEqual(parseOpenArgs("--port nope", settings), { host: "127.0.0.1", port: 0, unknown: ["--port nope"] });
    assert.deepEqual(parseOpenArgs("--wat", settings).unknown, ["--wat"]);
  });

  it("classifies loopback hosts", () => {
    for (const host of ["127.0.0.1", "127.5.5.5", "localhost", "::1", "[::1]"]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "coffee", "100.82.23.96"]) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });

  it("resolves `tailscale` to the first address of `tailscale ip -4`", async () => {
    const executed: string[] = [];
    const resolved = await resolveHost("tailscale", async (cmd, args) => {
      executed.push(`${cmd} ${args.join(" ")}`);
      return "100.82.23.96\n";
    });
    assert.equal(resolved.host, "100.82.23.96");
    assert.equal(resolved.error, undefined);
    assert.deepEqual(executed, ["tailscale ip -4"]);
  });

  it("reports a clear error when tailscale is missing or silent", async () => {
    const missing = await resolveHost("tailscale", async () => {
      throw new Error("spawn tailscale ENOENT");
    });
    assert.match(missing.error ?? "", /tailscale is not available/);
    assert.match(missing.error ?? "", /--host/);

    const silent = await resolveHost("tailscale", async () => "\n");
    assert.match(silent.error ?? "", /returned nothing/);
  });

  it("passes any other host through untouched", async () => {
    assert.equal((await resolveHost("0.0.0.0")).host, "0.0.0.0");
  });

  it("prints the tunnel hint for a loopback bind", () => {
    const { urls, warnings } = formatBoardUrls({ host: "127.0.0.1", port: 37473, slug: "p-1", hostname: "oi" });
    assert.deepEqual(urls, ["http://127.0.0.1:37473/p/p-1"]);
    assert.match(warnings[0] ?? "", /ssh -N -L 37473:127\.0\.0\.1:37473 oi/);
  });

  it("lists every reachable address with the token for a wildcard bind", () => {
    const { urls, warnings } = formatBoardUrls({
      host: "0.0.0.0",
      port: 37473,
      slug: "p-1",
      token: "tok-123",
      hostname: "coffee",
      addresses: ["192.168.1.10", "10.0.0.4"],
      tailscale: "100.82.23.96",
    });
    assert.deepEqual(urls, [
      "http://coffee:37473/p/p-1?t=tok-123",
      "http://192.168.1.10:37473/p/p-1?t=tok-123",
      "http://10.0.0.4:37473/p/p-1?t=tok-123",
      "http://100.82.23.96:37473/p/p-1?t=tok-123",
    ]);
    assert.match(warnings[0] ?? "", /reachable from the network/);
  });

  it("uses the picker path when no project is onboarded", () => {
    const { urls } = formatBoardUrls({ host: "0.0.0.0", port: 1, slug: null, token: "t" });
    assert.equal(urls[0], "http://0.0.0.0:1/?t=t");
  });

  it("lists non-internal IPv4 interfaces only", () => {
    const addresses = reachableAddresses();
    assert.ok(Array.isArray(addresses));
    for (const address of addresses) assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
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
        host: "127.0.0.1",
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
    const url = noted.lines.find((line) => /^kanboard: http:\/\//.test(line)) ?? "";
    assert.match(url, /^kanboard: http:\/\/127\.0\.0\.1:\d+\/p\//, `got: ${url}`);
    assert.ok(
      noted.lines.some((line) => line.includes("ssh -N -L")),
      "loopback prints the tunnel hint",
    );
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(url)?.[1]);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal((health as { ok: boolean }).ok, true);

    // A second open reuses the same daemon instead of spawning another.
    const again = notifications();
    await runOpen(deps as never, { cwd: workspace, ui: again.ui } as never);
    const againUrl = again.lines.find((line) => /^kanboard: http:\/\//.test(line)) ?? "";
    assert.equal(/127\.0\.0\.1:(\d+)/.exec(againUrl)?.[1], String(port));

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
      settings: () => ({ chainGate: "in_review", continue: false, idleMin: 10, host: "127.0.0.1", port: 0, archiveAfterDays: 0, openBrowser: false }),
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

  it("rebinds the daemon when the requested host differs, and prints the URLs", async () => {
    const { runOpen, runStopDaemon } = await import("../src/commands.js");
    const noted = notifications();
    const ctx = { cwd: workspace, ui: noted.ui } as never;
    process.env.UNIPI_KANBOARD_PROJECT = "kb-test-000000";
    // A daemon on loopback first…
    await runOpen(deps as never, ctx);
    const first = readDaemonInfo();
    assert.equal(first?.host ?? "127.0.0.1", "127.0.0.1");

    // …then a remote bind: it restarts with the new host and prints every URL
    // with the token, plus the network warning.
    const remote = notifications();
    const urls = await runOpen(deps as never, { cwd: workspace, ui: remote.ui } as never, "--host 0.0.0.0 --port 37473");
    assert.ok(
      remote.lines.some((line) => line.includes("restarted kanboard on 0.0.0.0:37473")),
      `expected a restart notice, got ${remote.lines.join(" | ")}`,
    );
    assert.equal(urls.length >= 1, true);
    for (const url of urls) assert.match(url, /^http:\/\/[^/]+:37473\/p\/kb-test-000000\?t=/, url);
    assert.ok(remote.lines.some((line) => line.includes("reachable from the network")), "warns loudly");

    const info = readDaemonInfo();
    assert.equal(info?.host, "0.0.0.0");
    assert.equal(info?.port, 37473);
    assert.ok((info?.token ?? "").length > 20, "a token exists for a remote bind");
    // Same binding again → no restart notice.
    const again = notifications();
    await runOpen(deps as never, { cwd: workspace, ui: again.ui } as never, "--host 0.0.0.0 --port 37473");
    assert.ok(!again.lines.some((line) => line.includes("restarted kanboard")), "no needless restart");
    await runStopDaemon(deps as never, { cwd: workspace, ui: notifications().ui } as never);
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
