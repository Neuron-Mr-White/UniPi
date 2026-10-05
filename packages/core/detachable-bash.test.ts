import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDetachableBashOperations, withDetachableBash, detachBashCall, setBashBackgroundAdopter } from "./detachable-bash.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function definition() { return withDetachableBash(createBashToolDefinition(process.cwd(), { operations: createDetachableBashOperations() })); }
function text(result: any) { return result.content.map((part: any) => part.text ?? "").join("\n"); }
afterEach(() => setBashBackgroundAdopter(null));

describe("detachable bash", () => {
  it("uses only public pi APIs and executes outside tool context unchanged", async () => {
    const source = await readFile(new URL("./detachable-bash.ts", import.meta.url), "utf8");
    assert.ok(!source.includes("dist/")); assert.ok(!source.includes("import.meta.resolve"));
    let output = "";
    const result = await createDetachableBashOperations().exec("printf plain; exit 3", process.cwd(), { onData: (data) => { output += data.toString(); } });
    assert.equal(result.exitCode, 3); assert.equal(output, "plain");
  });
  it("a null adopter leaves the foreground call running normally", async () => {
    setBashBackgroundAdopter(async () => null);
    const done = definition().execute("null-adopter", { command: "printf a; sleep .2; printf b" }, undefined, undefined, undefined as never);
    await delay(50);
    assert.equal(await detachBashCall("null-adopter", "test"), null);
    assert.equal(text(await done), "ab");
  });
  it("retains exit, nonzero, abort and timeout semantics without detach", async () => {
    assert.equal(text(await definition().execute("ok", { command: "printf hello" }, undefined, undefined, undefined as never)), "hello");
    // pi 0.87 throws nonzero results; pi 1.0 returns isError. Preserve the installed version's contract.
    try {
      const failed = await definition().execute("fail", { command: "echo bad; exit 7" }, undefined, undefined, undefined as never);
      assert.equal(failed.isError, true); assert.match(text(failed), /Command exited with code 7/);
    } catch (error) { assert.match(String(error), /Command exited with code 7/); }
    const abort = new AbortController();
    const stopped = definition().execute("abort", { command: "sleep 30" }, abort.signal, undefined, undefined as never);
    await delay(100); abort.abort(); await assert.rejects(stopped, /Command aborted/);
    await assert.rejects(definition().execute("timeout", { command: "sleep 30", timeout: 0.1 }, undefined, undefined, undefined as never), /Command timed out after 0.1 seconds/);
  });
  it("refuses detachment without a background adopter", async () => {
    const abort = new AbortController();
    const done = definition().execute("unavailable", { command: "sleep 30" }, abort.signal, undefined, undefined as never);
    await delay(100); assert.equal(await detachBashCall("unavailable", "test"), null);
    abort.abort(); await assert.rejects(done, /Command aborted/);
  });
  it("returns normally with initial output, survives Esc, and streams later output to a real registry task", async () => {
    const { BackgroundTaskRegistry } = await import("../background-tasks/src/registry.js");
    let notifications = 0;
    const registry = new BackgroundTaskRegistry({ sendCompletionNotification: (_message, options) => { assert.equal(options.triggerTurn, true); notifications++; } });
    const cwd = await mkdtemp(join(tmpdir(), "detachable-bash-test-"));
    const pidfile = join(cwd, "pid");
    const ctx = { cwd, sessionManager: { getSessionId: () => "detach-test" } } as never;
    setBashBackgroundAdopter(async (request) => {
      assert.equal(request.child.pid, undefined);
      const task = await registry.adoptRunningProcess(ctx, request.child, { command: request.command, startTime: request.startTime,
        stop: request.stop, initialOutput: request.initialOutput, notifyOnCompletion: true, triggerOnCompletion: true, watchdogAdopted: true });
      return { taskId: task.id, outputPath: task.outputPath };
    });
    const abort = new AbortController();
    let ready!: () => void;
    const initial = new Promise<void>((resolve) => { ready = resolve; });
    const done = definition().execute("detach", { command: `echo $$ > '${pidfile}'; printf a; sleep 1; printf b` }, abort.signal,
      (update) => { if (text(update).includes("a")) ready(); }, undefined as never);
    await initial;
    const detached = await detachBashCall("detach", "test looks stuck");
    assert.ok(detached);
    const result = await Promise.race([done, delay(500).then(() => { throw new Error("did not return early"); })]);
    assert.equal(result.isError, false); assert.match(text(result), /a/); assert.ok(text(result).includes(detached.taskId));
    const pid = Number(await readFile(pidfile, "utf8"));
    abort.abort(); process.kill(pid, 0);
    await delay(1300);
    assert.equal(await readFile(detached.outputPath, "utf8"), "ab");
    const task = registry.resolveTask(detached.taskId);
    assert.equal(task.status, "completed"); assert.equal(task.exitCode, 0); assert.equal(notifications, 1);
  });
  it("adopted process groups remain stoppable through the background registry", async () => {
    const { BackgroundTaskRegistry } = await import("../background-tasks/src/registry.js");
    const registry = new BackgroundTaskRegistry({ sendCompletionNotification: () => {}, killGraceMs: 50 });
    const cwd = await mkdtemp(join(tmpdir(), "detach-kill-"));
    const pidfile = join(cwd, "pid");
    const ctx = { cwd, sessionManager: { getSessionId: () => "detach-kill" } } as never;
    setBashBackgroundAdopter(async (request) => {
      assert.equal(request.child.pid, undefined);
      const task = await registry.adoptRunningProcess(ctx, request.child, { command: request.command, startTime: request.startTime,
        stop: request.stop, initialOutput: request.initialOutput, notifyOnCompletion: true, triggerOnCompletion: true, watchdogAdopted: true });
      return { taskId: task.id, outputPath: task.outputPath };
    });
    const running = definition().execute("kill", { command: `echo $$ > '${pidfile}'; printf a; sleep 30` }, undefined, undefined, undefined as never);
    await delay(100);
    const adopted = await detachBashCall("kill", "test");
    assert.ok(adopted); await running;
    const pid = Number(await readFile(pidfile, "utf8"));
    try { await registry.stopTask(registry.resolveTask(adopted.taskId), "user"); }
    finally { try { process.kill(-pid, "SIGKILL"); } catch {} }
    assert.equal(registry.resolveTask(adopted.taskId).status, "killed");
    assert.throws(() => process.kill(pid, 0));
  });
});
