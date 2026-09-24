/**
 * JSON contract test: every shape the extension consumes is produced by the REAL
 * binary (no stubs) and pushed through the same parsers the extension uses, so a
 * change on the Rust side fails here instead of in the user's session.
 *
 * Regression: K4 turned `list --json` into `{tasks, problems}` while the runner
 * still cast it to an array — `/unipi:kanboard work` died with
 * "all.map is not a function" after the task had already been claimed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    // Fields the runner's prompt relies on.
    assert.ok(Array.isArray(shown.activity) && shown.activity.length > 0);
    assert.ok("waitingFor" in shown || !shown.deps?.length);
    assert.equal(typeof shown.staleness, "string");
  });

  it("`claim-next` is {task, waiting} with a nullable task", () => {
    const claimed = asClaimResult(cli(home, workspace, ["claim-next", "--session", "contract", "--pid", "1", "--host", "test"], env()));
    assert.ok(claimed.task, "one todo task was ready");
    assert.equal(claimed.task!.status, "in_progress");
    assert.equal((claimed.task!.run as { host?: string })?.host, "test");
    // Nothing else ready → task null, but `waiting` is still an array.
    const tasks = asTaskList(cli(home, workspace, ["list"], env())).tasks;
    const allClaimed = tasks.filter((task) => task.status === "todo").length === 0;
    if (allClaimed) {
      const again = asClaimResult(cli(home, workspace, ["claim-next", "--session", "contract", "--pid", "1", "--host", "test"], env()));
      assert.equal(again.task, null);
      assert.ok(Array.isArray(again.waiting));
    }
    // Release it back for the following tests.
    asTask("release", cli(home, workspace, ["release", claimed.task!.id, "--to", "todo", "--comment", "contract"], env()));
  });

  it("`release`, `move`, `note` and `set-run` return the updated task", () => {
    const task = asTask("add", cli(home, workspace, ["add", "transitioned", "--status", "todo"], env()));
    const claimed = asClaimResult(
      cli(home, workspace, ["claim-next", "--session", "contract", "--pid", "1", "--host", "test"], env()),
    );
    const id = claimed.task?.id ?? task.id;

    const running = asTask(
      "set-run",
      cli(home, workspace, ["set-run", id, "--mode", "plan"], { ...env(), UNIPI_KANBOARD_ACTOR: "system" }),
    );
    assert.equal(running.run?.mode, "plan");

    const noted = asTask("note", cli(home, workspace, ["note", id, "a note"], env()));
    assert.equal(noted.activity?.at(-1)?.text, "a note");

    // Only an agent may block a running task.
    const moved = asTask(
      "move",
      cli(home, workspace, ["move", id, "blocked", "--comment", "waiting"], { ...env(), UNIPI_KANBOARD_ACTOR: "agent" }),
    );
    assert.equal(moved.status, "blocked");

    // `release` is the runner's own transition, so it needs a claimed task.
    asTask("add", cli(home, workspace, ["add", "to be released", "--status", "todo"], env()));
    const second = asClaimResult(
      cli(home, workspace, ["claim-next", "--session", "contract", "--pid", "1", "--host", "test"], env()),
    ).task;
    assert.ok(second, "a second task was claimable");
    const released = asTask(
      "release",
      cli(home, workspace, ["release", second!.id, "--to", "todo", "--comment", "back"], {
        ...env(),
        UNIPI_KANBOARD_ACTOR: "system",
      }),
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

  it("a shape mismatch produces a clear error, not a crash deep in the runner", () => {
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

  it("every list entry parses into the task type the runner uses", () => {
    const { tasks } = asTaskList(cli(home, workspace, ["list"], env()));
    for (const task of tasks as KanboardTask[]) {
      assert.equal(typeof task.id, "string");
      assert.equal(typeof task.status, "string");
      assert.ok(Array.isArray(task.deps));
      assert.ok(Array.isArray(task.activity));
    }
  });
});
