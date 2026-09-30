/**
 * captureToBacklog — the `globalThis.__unipi_kanboard_api` entry point the
 * input-shortcuts K chord calls. Stubbed CLI: asserts the argv shape (no
 * title positional, --body-file, one --attach per detected path,
 * --status backlog), the not-onboarded refusal and error pass-through.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSettings } from "@pi-unipi/core";

import { captureToBacklog, type CommandDeps } from "../src/commands.js";
import { registerKanboardSettings } from "../src/settings.js";
import { KanboardCliError, type KanboardCli, type RunCliOptions } from "../src/bin.js";

registerKanboardSettings();

interface RecordedCall {
  args: string[];
  options?: RunCliOptions;
}

function depsWith(run: (args: string[], options?: RunCliOptions) => Promise<unknown>, unavailable: string | null = null): { deps: CommandDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const cli = {
    binary: { path: "/stub/unipi-kanboard", source: "dev-build" },
    run,
  } as KanboardCli;
  const deps = {
    // An unavailable binary resolves to no client at all.
    get cli() {
      return unavailable ? null : cli;
    },
    get unavailable() {
      return unavailable;
    },
    settings: () => ({}),
    revealSkill: () => undefined,
    guard: {},
    session: () => "test-session",
    debug: () => undefined,
  } as unknown as CommandDeps;
  return { deps, calls };
}

describe("captureToBacklog", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "kb-capture-ws-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const onboard = (): void => {
    setSettings("kanboard", { slug: "TST" }, "project", workspace);
  };

  it("adds a body-only backlog task: no title positional, --body-file, --attach per path, --status backlog", async () => {
    onboard();
    const file = join(mkdtempSync(join(tmpdir(), "kb-capture-att-")), "shot.png");
    writeFileSync(file, "png");
    let bodyContent: string | null = null;
    let bodyFileSeen: string | null = null;
    const { deps, calls } = depsWith(async (args, options) => {
      calls.push({ args, options });
      // Read while the file still exists — captureToBacklog cleans up after.
      bodyFileSeen = args[args.indexOf("--body-file") + 1]!;
      bodyContent = readFileSync(bodyFileSeen, "utf-8");
      return { id: "TST-7", title: "", displayTitle: "the capture text", status: "backlog" };
    });
    const result = await captureToBacklog(deps, { cwd: workspace, text: `the capture text\nsee ${file}` });
    assert.deepEqual(result, { ok: true, id: "TST-7", attachments: 1 });

    assert.equal(calls.length, 1);
    const { args, options } = calls[0]!;
    const add = args.indexOf("add");
    assert.ok(add >= 0, "argv contains add");
    // No title positional: the first token after `add` is a flag.
    assert.ok(args[add + 1]!.startsWith("--"), `no title after add: ${args[add + 1]}`);
    assert.deepEqual(args.slice(0, 3), ["--project", "TST", "add"]);
    assert.deepEqual(args.slice(3, 5), ["--status", "backlog"]);
    assert.equal(args[5], "--body-file");
    const bodyFile = args[6]!;
    assert.equal(bodyContent, `the capture text\nsee ${file}`);
    assert.deepEqual(args.slice(7), ["--attach", file]);
    assert.equal((options as { cwd?: string } | undefined)?.cwd, workspace);
    // The temp body dir is cleaned up.
    assert.equal(existsSync(bodyFile), false);
    assert.ok(bodyFileSeen!.startsWith(join(tmpdir(), "kb-capture-")));
    rmSync(join(file, ".."), { recursive: true, force: true });
  });

  it("refuses when the folder is not onboarded (no prompts from a shortcut)", async () => {
    const { deps, calls } = depsWith(async () => ({}));
    const result = await captureToBacklog(deps, { cwd: workspace, text: "some text" });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /kanboard is not set up here/);
    assert.equal(calls.length, 0);
  });

  it("refuses when the binary is unavailable", async () => {
    onboard();
    const { deps } = depsWith(async () => ({}), "kanboard binary unavailable for sunos-sparc");
    const result = await captureToBacklog(deps, { cwd: workspace, text: "some text" });
    assert.deepEqual(result, { ok: false, reason: "kanboard binary unavailable for sunos-sparc" });
  });

  it("passes CLI errors through as the reason", async () => {
    onboard();
    const { deps } = depsWith(async () => {
      throw new KanboardCliError("board is locked", 1, "rule");
    });
    const result = await captureToBacklog(deps, { cwd: workspace, text: "some text" });
    assert.deepEqual(result, { ok: false, reason: "board is locked" });
  });

  it("refuses empty text before touching the CLI", async () => {
    onboard();
    const { deps, calls } = depsWith(async () => ({}));
    const result = await captureToBacklog(deps, { cwd: workspace, text: "   \n  " });
    assert.deepEqual(result, { ok: false, reason: "nothing to add" });
    assert.equal(calls.length, 0);
  });
});
