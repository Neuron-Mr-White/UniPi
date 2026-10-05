/**
 * `/unipi:move` kanboard handler — discovery of orphaned project roots,
 * rebinding through the real Rust binary (`project rebind <slug> --root`),
 * and the settings-cache follow-up write. Uses the real debug build against
 * a temp `UNIPI_KANBOARD_HOME` (built by `cargo build` in crates/kanboard).
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MoveContext, MoveLogEntry } from "@pi-unipi/core";
import { registerKanboardSettings } from "../src/settings.js";
import { kanboardHome, kanboardMoveHandler } from "../src/move.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const binary = join(repoRoot, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const hasBinary = existsSync(binary);

function run(home: string, cwd: string, args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(binary, args, {
      cwd,
      env: { ...process.env, UNIPI_KANBOARD_HOME: home, UNIPI_KANBOARD_ACTOR: "user" },
      encoding: "utf-8",
    });
    return { stdout, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: String(err.stdout ?? ""), code: err.status ?? 1 };
  }
}

describe("kanboard move handler", { skip: !hasBinary ? "debug binary not built (cargo build -p kanboard)" : false }, () => {
  let home: string;
  let oldRoot: string;
  let newRoot: string;
  let savedEnv: Record<string, string | undefined>;

  before(() => {
    registerKanboardSettings();
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kb-move-home-"));
    oldRoot = mkdtempSync(join(tmpdir(), "kb-move-old-"));
    newRoot = mkdtempSync(join(tmpdir(), "kb-move-new-"));
    savedEnv = { HOME: process.env.HOME, UNIPI_KANBOARD_HOME: process.env.UNIPI_KANBOARD_HOME, UNIPI_KANBOARD_PROJECT: process.env.UNIPI_KANBOARD_PROJECT };
    process.env.HOME = home;
    process.env.UNIPI_KANBOARD_HOME = home;
    delete process.env.UNIPI_KANBOARD_PROJECT;
  });

  afterEach(() => {
    if (savedEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.HOME;
    if (savedEnv.UNIPI_KANBOARD_HOME === undefined) delete process.env.UNIPI_KANBOARD_HOME;
    else process.env.UNIPI_KANBOARD_HOME = savedEnv.UNIPI_KANBOARD_HOME;
    if (savedEnv.UNIPI_KANBOARD_PROJECT === undefined) delete process.env.UNIPI_KANBOARD_PROJECT;
    else process.env.UNIPI_KANBOARD_PROJECT = savedEnv.UNIPI_KANBOARD_PROJECT;
  });

  function context(dryRun = false): { ctx: MoveContext; entries: MoveLogEntry[]; backups: string[] } {
    const entries: MoveLogEntry[] = [];
    const backups: string[] = [];
    const ctx: MoveContext = {
      oldRoot,
      newRoot,
      dryRun,
      log: (entry) => entries.push(entry),
      backup: (file) => backups.push(file),
    };
    return { ctx, entries, backups };
  }

  it("honours UNIPI_KANBOARD_HOME: kanboardHome() reflects the env override", () => {
    assert.equal(kanboardHome({ UNIPI_KANBOARD_HOME: home }), home);
    assert.equal(kanboardHome({}).length > 0, true);
  });

  it("discoverOrphans reports a registered project whose root no longer exists", async () => {
    const added = run(home, oldRoot, ["project", "add", "--name", "Orphan", "--prefix", "ORP", "--json"]);
    assert.equal(added.code, 0, added.stdout);
    rmSync(oldRoot, { recursive: true, force: true });
    mkdirSync(newRoot, { recursive: true }); // keep newRoot (a different project) alive

    const roots = await kanboardMoveHandler.discoverOrphans!();
    assert.deepEqual(roots, [oldRoot]);
  });

  it("discoverOrphans is empty when every registered root still exists", async () => {
    run(home, oldRoot, ["project", "add", "--name", "Live", "--prefix", "LIV", "--json"]);
    const roots = await kanboardMoveHandler.discoverOrphans!();
    assert.deepEqual(roots, []);
  });

  it("scan finds nothing for a root with no registered project", async () => {
    const { ctx } = context();
    const items = await kanboardMoveHandler.scan(ctx);
    assert.equal(items.length, 0);
  });

  it("scan + apply rebinds the project through the binary, backs up project.json, and updates the settings cache", async () => {
    const added = run(home, oldRoot, ["project", "add", "--name", "Movable", "--prefix", "MOV", "--json"]);
    assert.equal(added.code, 0, added.stdout);
    const slug = (JSON.parse(added.stdout) as { slug: string }).slug;

    const { ctx, entries, backups } = context();
    const items = await kanboardMoveHandler.scan(ctx);
    assert.equal(items.length, 1);
    assert.match(items[0].description, new RegExp(slug));

    await items[0].apply();

    const rebound = JSON.parse(readFileSync(join(home, "projects", slug, "project.json"), "utf-8")) as { root: string };
    assert.equal(rebound.root, newRoot);
    assert.ok(backups.some((file) => file.endsWith("project.json")), "project.json was backed up before the binary ran");
    assert.ok(entries.some((e) => e.action === "rebind" && e.result === "ok"));
    assert.ok(entries.some((e) => e.action === "settings-cache" && e.result === "ok"));

    // A second scan after a successful rebind finds nothing left to do (the
    // project's root now matches newRoot, not ctx.oldRoot).
    assert.equal((await kanboardMoveHandler.scan(ctx)).length, 0);
  });

  it("dry-run reports the plan but writes nothing", async () => {
    const added = run(home, oldRoot, ["project", "add", "--name", "DryRun", "--prefix", "DRY", "--json"]);
    const slug = (JSON.parse(added.stdout) as { slug: string }).slug;
    const before = readFileSync(join(home, "projects", slug, "project.json"), "utf-8");

    const { ctx, entries } = context(true);
    const items = await kanboardMoveHandler.scan(ctx);
    assert.equal(items.length, 1);
    await items[0].apply();

    const after = readFileSync(join(home, "projects", slug, "project.json"), "utf-8");
    assert.equal(after, before);
    assert.equal(entries.length, 0);
  });

  it("refuses a duplicate root: the binary's rule error is logged and no cache write follows", async () => {
    const movable = run(home, oldRoot, ["project", "add", "--name", "A", "--prefix", "AAA", "--json"]);
    const slugA = (JSON.parse(movable.stdout) as { slug: string }).slug;
    const occupied = mkdtempSync(join(tmpdir(), "kb-move-occupied-"));
    run(home, occupied, ["project", "add", "--name", "B", "--prefix", "BBB", "--json"]);

    const { ctx, entries } = context();
    newRoot = occupied; // rebind onto an already-registered root
    ctx.newRoot = occupied;
    const items = await kanboardMoveHandler.scan(ctx);
    await assert.rejects(async () => items[0].apply(), /already registered/);

    assert.ok(entries.some((e) => e.action === "rebind" && e.result.startsWith("failed:")));
    assert.ok(!entries.some((e) => e.action === "settings-cache"));

    const projectJson = JSON.parse(readFileSync(join(home, "projects", slugA, "project.json"), "utf-8")) as { root: string };
    assert.equal(projectJson.root, oldRoot, "the refused rebind left the original project untouched");
  });
});
