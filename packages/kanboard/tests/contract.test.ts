/**
 * JSON contract test: every shape the extension consumes is produced by the REAL
 * binary (no stubs) and pushed through the same parsers the extension uses, so a
 * change on the Rust side fails here instead of in the user's session.
 * (Runner-era helpers — nothingReadyMessage, attachmentSection — died with the
 * runner; the JSON shapes themselves are still asserted here.)
 *
 * Regression: K4 turned `list --json` into `{tasks, problems}` while the
 * extension still cast it to an array — `/unipi:kanboard work` died with
 * "all.map is not a function" after the task had already been claimed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asClaimResult,
  asDaemonStatus,
  asProject,
  asProjectDetail,
  asProjectList,
  asStopResult,
  asTask,
  asTaskList,
  KanboardShapeError,
  type KanboardTask,
} from "../src/shapes.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const binary = join(repoRoot, "crates", "kanboard", "target", "debug", "unipi-kanboard");
const hasBinary = existsSync(binary);

/** Run the binary as the extension does: `--json`, project + actor env. */
function cli(home: string, cwd: string, args: string[], env: Record<string, string> = {}): unknown {
  const stdout = execFileSync(binary, [...args, "--json"], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      UNIPI_KANBOARD_HOME: home,
      UNIPI_KANBOARD_ACTOR: "user",
      ...env,
    },
  });
  return JSON.parse(stdout);
}

describe("CLI JSON contract (real binary)", { skip: !hasBinary }, () => {
  let home: string;
  let workspace: string;
  let slug: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "kb-contract-"));
    workspace = mkdtempSync(join(tmpdir(), "kb-contract-ws-"));
    const project = asProject("project add", cli(home, workspace, ["project", "add", "--name", "Contract"]));
    slug = project.slug;
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const env = (): Record<string, string> => ({ UNIPI_KANBOARD_PROJECT: slug });

  it("`list --json` is {tasks, problems} and parses", () => {
    const first = asTask("add", cli(home, workspace, ["add", "contract task", "--status", "todo"], env()));
    const raw = cli(home, workspace, ["list"], env());
    assert.equal(Array.isArray(raw), false, "an array here means a stale binary — the K4 regression");
    const { tasks, problems } = asTaskList(raw);
    assert.ok(tasks.some((task) => task.id === first.id));
    assert.ok(Array.isArray(problems));
    assert.ok(tasks.every((task) => typeof task.id === "string" && typeof task.title === "string"));
  });

  it("`add` and `show` return one task", () => {
    const created = asTask("add", cli(home, workspace, ["add", "another task", "--status", "todo"], env()));
    assert.equal(typeof created.id, "string");
    assert.equal(created.status, "todo");
    assert.deepEqual(created.deps, []);
    assert.ok(Array.isArray(created.activity));

    const shown = asTask("show", cli(home, workspace, ["show", created.id], env()));
    assert.equal(shown.id, created.id);
    assert.equal(shown.title, "another task");
    // Fields the extension relies on.
    assert.ok(Array.isArray(shown.activity) && shown.activity.length > 0);
    assert.ok("waitingFor" in shown || !shown.deps?.length);
    assert.equal(typeof shown.staleness, "string");
  });

  const agent = (session = "contract"): Record<string, string> => ({
    ...env(),
    UNIPI_KANBOARD_ACTOR: "agent",
    UNIPI_KANBOARD_SESSION: session,
    UNIPI_KANBOARD_PID: String(process.pid),
  });

  it("`next` is {task, waiting} with a nullable task, and `start` claims it for the session", () => {
    const suggested = asClaimResult(cli(home, workspace, ["next"], env()));
    assert.ok(suggested.task, "one todo task was ready");
    assert.equal(suggested.task!.status, "todo", "next only suggests");
    const started = asTask("start", cli(home, workspace, ["start", suggested.task!.id], agent()));
    assert.equal(started.status, "in_progress");
    assert.equal((started.run as { session?: string; owner?: string })?.session, "contract");
    assert.equal((started.run as { owner?: string })?.owner, "agent");
    // Hand it back for the following tests.
    asTask("release", cli(home, workspace, ["release", started.id, "--to", "todo", "--comment", "contract"], env()));
  });

  it("a Backlog dependency surfaces as `lockedBy` in list and in next's waiting", () => {
    const home2 = mkdtempSync(join(tmpdir(), "kb-contract-lock-"));
    const ws2 = mkdtempSync(join(tmpdir(), "kb-contract-lock-ws-"));
    try {
      const project = asProject("project add", cli(home2, ws2, ["project", "add", "--name", "Locks"]));
      const env2 = { UNIPI_KANBOARD_PROJECT: project.slug };
      const parent = asTask("add", cli(home2, ws2, ["add", "parked parent"], env2));
      const child = asTask("add", cli(home2, ws2, ["add", "child", "--status", "todo", "--after", parent.id], env2));
      const listed = asTaskList(cli(home2, ws2, ["list"], env2)).tasks.find((task) => task.id === child.id)!;
      assert.deepEqual(listed.lockedBy, [parent.id]);
      const next = asClaimResult(cli(home2, ws2, ["next"], env2));
      assert.equal(next.task, null);
      const entry = next.waiting!.find((item) => item.id === child.id)!;
      assert.deepEqual(entry.lockedBy, [parent.id]);
    } finally {
      rmSync(home2, { recursive: true, force: true });
      rmSync(ws2, { recursive: true, force: true });
    }
  });

  it("`start`, `note`, `move`, `finish` and `release` return the updated task", () => {
    const task = asTask("add", cli(home, workspace, ["add", "transitioned", "--status", "todo"], env()));
    const started = asTask("start", cli(home, workspace, ["start", task.id], agent()));
    assert.equal(started.status, "in_progress");

    const noted = asTask("note", cli(home, workspace, ["note", task.id, "a note"], env()));
    assert.equal(noted.activity?.at(-1)?.text, "a note");

    // Only the agent session holding it may block a running task.
    const moved = asTask("move", cli(home, workspace, ["move", task.id, "blocked", "--comment", "waiting"], agent()));
    assert.equal(moved.status, "blocked");

    const second = asTask("add", cli(home, workspace, ["add", "to be finished", "--status", "todo"], env()));
    asTask("start", cli(home, workspace, ["start", second.id], agent()));
    const finished = asTask("finish", cli(home, workspace, ["finish", second.id, "--comment", "done: x"], agent()));
    assert.equal(finished.status, "in_review");
    assert.ok(finished.run === null || finished.run === undefined, "leaving in_progress clears the run");

    // `release` hands a claim back (user/system).
    const third = asTask("add", cli(home, workspace, ["add", "to be released", "--status", "todo"], env()));
    asTask("start", cli(home, workspace, ["start", third.id], agent()));
    const released = asTask(
      "release",
      cli(home, workspace, ["release", third.id, "--to", "todo", "--comment", "back"], { ...env(), UNIPI_KANBOARD_ACTOR: "system" }),
    );
    assert.equal(released.status, "todo");
    assert.ok(released.run === null || released.run === undefined, "leaving in_progress clears the run");
  });

  it("`project add/list/show` parse, and show carries counts + problems", () => {
    const projects = asProjectList(cli(home, workspace, ["project", "list"]));
    assert.ok(projects.some((project) => project.slug === slug));
    const detail = asProjectDetail(cli(home, workspace, ["project", "show"], env()));
    assert.equal(detail.slug, slug);
    assert.equal(typeof detail.total, "number");
    assert.equal(typeof detail.counts, "object");
    assert.ok(Array.isArray(detail.problems));
  });

  it("`status`, `stop` and `validate` parse", () => {
    const status = asDaemonStatus(cli(home, workspace, ["status"]));
    assert.equal(status.alive, false, "no daemon in this temp home");
    assert.equal(status.daemon, null);

    const stop = asStopResult(cli(home, workspace, ["stop"]));
    assert.equal(typeof stop.stopped, "boolean");

    const validate = cli(home, workspace, ["validate"], env());
    const result = validate as { ok?: boolean; problems?: unknown[] };
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.problems));
  });

  it("a shape mismatch produces a clear error, not a crash", () => {
    // This is what the stale binary did: an array where {tasks} is expected.
    assert.throws(() => asTaskList([{ id: "X-1" }]), (error: unknown) => {
      assert.ok(error instanceof KanboardShapeError);
      assert.match((error as Error).message, /unexpected list output/);
      assert.match((error as Error).message, /older than the extension/);
      return true;
    });
    assert.throws(() => asClaimResult({ tasks: [] }), KanboardShapeError);
    assert.throws(() => asTask("show", { title: "no id" }), KanboardShapeError);
    assert.throws(() => asProject("project add", {}), KanboardShapeError);
    assert.throws(() => asStopResult({}), KanboardShapeError);
  });

  it("every list entry parses into the task type the extension uses", () => {
    const { tasks } = asTaskList(cli(home, workspace, ["list"], env()));
    for (const task of tasks as KanboardTask[]) {
      assert.equal(typeof task.id, "string");
      assert.equal(typeof task.status, "string");
      assert.ok(Array.isArray(task.deps));
      assert.ok(Array.isArray(task.activity));
    }
  });
});

describe("attachments contract (real binary)", { skip: !hasBinary }, () => {
  it("`attach` returns the task with an attachment descriptor, and the prompt lists it", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "kb-contract-att-"));
    const ws2 = mkdtempSync(join(tmpdir(), "kb-contract-att-ws-"));
    try {
      const project = asProject("project add", cli(home2, ws2, ["project", "add", "--name", "Att"]));
      const env2 = { UNIPI_KANBOARD_PROJECT: project.slug };
      const task = asTask("add", cli(home2, ws2, ["add", "with a log", "--status", "todo"], env2));
      const file = join(ws2, "build.log");
      writeFileSync(file, "error: linker failed\n");
      const attached = asTask("attach", cli(home2, ws2, ["attach", task.id, file, "--note", "CI output"], env2));
      const descriptor = attached.attachment as { ref: string; path: string; kind: string; markdown: string };
      assert.equal(descriptor.kind, "text");
      assert.match(descriptor.ref, new RegExp(`^att:${task.id}/[0-9a-f]{8}-build\\.log$`));
      assert.equal(descriptor.markdown, `[build.log](${descriptor.ref})`);
      const last = attached.activity!.at(-1)!.text;
      assert.equal(last, `CI output\n${descriptor.markdown}`);

      const shown = asTask("show", cli(home2, ws2, ["show", task.id], env2));
      assert.ok((shown.attachments as unknown[] | undefined)?.length, "the attachment survives a show round-trip");
    } finally {
      rmSync(home2, { recursive: true, force: true });
      rmSync(ws2, { recursive: true, force: true });
    }
  });
});
