import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMoveHandler, type MoveContext, type MoveLogEntry } from "@pi-unipi/core";
import { piSessionsHandler, piTrustHandler, sessionDir } from "../src/move/pi-state.js";
import { gitWorktreesHandler } from "../src/move/git.js";
import { createMoveContext, parseMoveArgs, runMove, validateOldRoot } from "../src/move/index.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "unipi-move-"));
  const oldHome = process.env.HOME;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent-override");
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent; });
  const oldRoot = join(home, "projects", "abc");
  const newRoot = join(home, "archived", "abc");
  mkdirSync(newRoot, { recursive: true });
  const events: MoveLogEntry[] = [];
  const backups: string[] = [];
  const ctx: MoveContext = { oldRoot, newRoot, dryRun: false, log: (e) => events.push(e), backup: (f) => backups.push(f) };
  return { home, ctx, events, backups };
}

function seedSession(root: string, name = "session.jsonl") {
  const dir = sessionDir(root);
  mkdirSync(dir, { recursive: true });
  const first = JSON.stringify({ type: "session", version: 3, id: "move-test", cwd: root });
  const body = '{"type":"message","content":"preserve bytes\\r\\n"}\r\n';
  writeFileSync(join(dir, name), `${first}\n${body}`);
  return { first, body, file: join(dir, name) };
}

test("sessions parent move preserves body bytes, logs original header, removes empty old dir and is idempotent", async (t) => {
  const { ctx, events } = fixture(t);
  const seeded = seedSession(ctx.oldRoot);
  assert.deepEqual(await piSessionsHandler.discoverOrphans!(), [ctx.oldRoot]);
  const items = await piSessionsHandler.scan(ctx);
  assert.equal(items.length, 1);
  await items[0].apply();
  const moved = readFileSync(join(sessionDir(ctx.newRoot), "session.jsonl"), "utf8");
  assert.equal(JSON.parse(moved.split("\n")[0]).cwd, ctx.newRoot);
  assert.equal(moved.slice(moved.indexOf("\n") + 1), seeded.body);
  assert.equal(events.find((e) => e.action === "rewrite-header")?.originalHeader, seeded.first);
  assert.equal(existsSync(sessionDir(ctx.oldRoot)), false);
  assert.equal((await piSessionsHandler.scan(ctx)).length, 0);
});

test("session same-name conflict is skipped without overwriting", async (t) => {
  const { ctx, events } = fixture(t);
  const seeded = seedSession(ctx.oldRoot);
  const target = seedSession(ctx.newRoot);
  const before = readFileSync(target.file);
  await (await piSessionsHandler.scan(ctx))[0].apply();
  assert.deepEqual(readFileSync(target.file), before);
  assert.equal(existsSync(seeded.file), true);
  assert.match(events[0].result, /conflict/);
});

test("dry-run handlers write nothing and no log/backup tree is created", async (t) => {
  const { ctx, home } = fixture(t);
  const seeded = seedSession(ctx.oldRoot);
  const trust = join(process.env.PI_CODING_AGENT_DIR!, "trust.json");
  writeFileSync(trust, JSON.stringify({ [ctx.oldRoot]: true }));
  const before = readFileSync(trust);
  const runtime = createMoveContext(ctx.oldRoot, ctx.newRoot, true);
  for (const handler of [piSessionsHandler, piTrustHandler]) for (const item of await handler.scan(runtime.context)) await item.apply();
  assert.equal(existsSync(seeded.file), true);
  assert.deepEqual(readFileSync(trust), before);
  assert.equal(existsSync(join(home, ".unipi")), false);
});

test("trust migrates false values, backs up first and second scan is empty", async (t) => {
  const { ctx, backups } = fixture(t);
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  const trust = join(process.env.PI_CODING_AGENT_DIR!, "trust.json");
  writeFileSync(trust, JSON.stringify({ [ctx.oldRoot]: false, "/unrelated": true }));
  await (await piTrustHandler.scan(ctx))[0].apply();
  assert.deepEqual(JSON.parse(readFileSync(trust, "utf8")), { [ctx.newRoot]: false, "/unrelated": true });
  assert.deepEqual(backups, [trust]);
  assert.equal((await piTrustHandler.scan(ctx)).length, 0);
});

test("log is JSONL and small-file backup preserves original", (t) => {
  const { ctx, home } = fixture(t);
  const file = join(home, "small.json");
  writeFileSync(file, "original");
  const runtime = createMoveContext(ctx.oldRoot, ctx.newRoot, false);
  runtime.context.backup(file);
  runtime.context.log({ area: "test", action: "write", from: file, to: file, result: "ok" });
  const lines = readFileSync(runtime.logFile, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  assert.equal(lines.length, 2);
  assert.equal(readFileSync(lines[0].to, "utf8"), "original");
  assert.equal(readdirSync(join(home, ".unipi", "move-backup")).length, 1);
});

test("copy or identical root refused; argument parsing accepts quoted rename paths", (t) => {
  const { ctx } = fixture(t);
  assert.throws(() => validateOldRoot(ctx.newRoot, ctx.oldRoot), /copy, not a move/);
  assert.throws(() => validateOldRoot(ctx.newRoot, ctx.newRoot), /same/);
  assert.deepEqual(parseMoveArgs('"/some path/abc" --dry-run'), { oldPath: "/some path/abc", dryRun: true });
  assert.throws(() => parseMoveArgs("--yes"), /Unknown/);
});

test("command dry-run discovers all orphans, ranks matching basename and never confirms or applies", async (t) => {
  const { ctx, home } = fixture(t);
  let applied = 0;
  let confirms = 0;
  const rename = join(home, "old", "rename");
  registerMoveHandler({ id: "command-test", label: "Test", discoverOrphans: async () => [rename, ctx.oldRoot], scan: () => [{ area: "test", description: "planned change", apply: () => { applied++; } }] });
  const notices: string[] = [];
  let offered: string[] = [];
  await runMove("--dry-run", { cwd: ctx.newRoot, hasUI: true, ui: { notify: (s: string) => notices.push(s), select: async (_title: string, options: string[]) => { offered = options; return options[0]; }, confirm: async () => { confirms++; return true; } } as never });
  assert.deepEqual(offered, [ctx.oldRoot, rename]);
  assert.equal(applied, 0);
  assert.equal(confirms, 0);
  assert.equal(existsSync(join(home, ".unipi")), false);
  assert.match(notices.join("\n"), /planned change/);
});

test("git worktree links repaired after rename and second scan empty", async (t) => {
  const { ctx, home } = fixture(t);
  mkdirSync(ctx.oldRoot, { recursive: true });
  const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git(ctx.oldRoot, "init");
  git(ctx.oldRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
  const worktree = `${ctx.oldRoot}-worktree`;
  git(ctx.oldRoot, "worktree", "add", "-b", "other", worktree);
  const renamed = join(home, "archived", "abc2");
  renameSync(ctx.oldRoot, renamed);
  ctx.newRoot = renamed;
  const items = await gitWorktreesHandler.scan(ctx);
  assert.equal(items.length, 1);
  await items[0].apply();
  assert.match(readFileSync(join(worktree, ".git"), "utf8"), /abc2/);
  assert.equal((await gitWorktreesHandler.scan(ctx)).length, 0);
  assert.equal((await piSessionsHandler.scan(ctx)).length, 0);
});
