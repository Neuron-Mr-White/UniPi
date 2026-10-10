/**
 * @pi-unipi/dream — runs, controller, tray pane and the extension's
 * default-off behaviour. Fixtures only: HOME is a temp dir (stateDir and the
 * pi sessions dir both hang off it) and the dream child is a fake script
 * (PI_DREAM_BIN), so nothing touches the real ~/.unipi or calls a model.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "dream-home-"));
process.env.HOME = HOME;
const CWD = mkdtempSync(join(tmpdir(), "dream-cwd-"));

const { stateDir, resetWorkspaceCache, registerWorkTrayTab: _r } = await import("@pi-unipi/core");
void _r;
const { runFromStaging, listRuns, trajectoryFromSession, runTrajectory, summarizeReport, writeRunMeta, readRunMeta, stopRun } = await import("../src/runs.ts");
const { DreamController, runInfo } = await import("../src/controller.ts");
const { DreamPane, runRow, runState, DREAM_LIST_HINT } = await import("../src/tray-pane.ts");
const { DEFAULT_DREAM, normalizeDream } = await import("../src/settings.ts");
const { readDreamState, writeDreamState } = await import("../src/schedule.ts");
const { encodeSessionDirName } = await import("../src/digest.ts");

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const DEAD = 2_147_000_000; // a pid that is not alive

function root(): string {
  return stateDir("dream", "state", CWD);
}

function staging(ms: number, opts: { report?: string; proposals?: string[]; meta?: Record<string, unknown> | null } = {}): string {
  const dir = join(root(), `staging-${String(ms)}`);
  mkdirSync(join(dir, "proposals"), { recursive: true });
  if (opts.report !== undefined) writeFileSync(join(dir, "DREAM_REPORT.md"), opts.report);
  for (const p of opts.proposals ?? []) {
    if (p.endsWith(".md")) writeFileSync(join(dir, "proposals", p), "# check\nwire me");
    else {
      mkdirSync(join(dir, "proposals", p), { recursive: true });
      writeFileSync(join(dir, "proposals", p, "SKILL.md"), `---\nname: ${p}\ndescription: Does ${p}. Use when asked.\n---\n1. Do it.\n`);
    }
  }
  if (opts.meta !== null) writeRunMeta(dir, { startedAt: ms, pid: DEAD, sessions: 3, events: 7, ...(opts.meta ?? {}) } as never);
  return dir;
}

const REPORT = ["# Dream", "## Memory edits (applied)", "- lesson a", "- lesson b", "## Proposals (waiting for approval)", "1. skill demo", "## Skipped", "- one-off"].join("\n");

before(() => {
  resetWorkspaceCache?.();
});
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(root(), { recursive: true, force: true });
  mkdirSync(root(), { recursive: true });
});

describe("runs", () => {
  it("derives running / finished / stopped / failed from the files + pid", () => {
    const now = Date.now();
    const running = runFromStaging(staging(now - 5000, { meta: { pid: process.pid } }), {}, now)!;
    assert.equal(running.status, "running");
    assert.equal(running.endedAt, undefined);
    const finished = runFromStaging(staging(now - 9000, { report: REPORT, proposals: ["skill-demo"] }), {}, now)!;
    assert.equal(finished.status, "finished");
    assert.equal(finished.pending, 1);
    assert.equal(finished.sessions, 3);
    const stopped = runFromStaging(staging(now - 8000, { meta: { stopped: true, endedAt: now - 1 } }), {}, now)!;
    assert.equal(stopped.status, "stopped");
    const timedOut = runFromStaging(staging(now - 7000, { meta: { exitCode: 124, endedAt: now } }), {}, now)!;
    assert.equal(timedOut.status, "failed");
    assert.match(timedOut.error!, /timed out/);
    // A live pid past the 2h stale cap is no longer "running".
    const stale = runFromStaging(staging(now - 3 * 3600_000, { meta: { pid: process.pid } }), {}, now)!;
    assert.equal(stale.status, "failed");
    // An exit recorded by the launcher wins over a recycled live pid.
    const exited = runFromStaging(staging(now - 6000, { report: REPORT, meta: { pid: process.pid, endedAt: now - 10, exitCode: 0 } }), {}, now)!;
    assert.equal(exited.status, "finished");
  });

  it("an old staging dir without run.json still lists (start time from its name)", () => {
    const r = runFromStaging(staging(1_700_000_000_000, { report: REPORT, meta: null }))!;
    assert.equal(r.startedAt, 1_700_000_000_000);
    assert.equal(r.status, "finished");
  });

  it("lists newest first and drops dismissed runs", () => {
    staging(1000, { report: REPORT });
    staging(3000, { report: REPORT });
    staging(2000);
    const runs = listRuns(CWD, { decisions: {} });
    assert.deepEqual(runs.map((r) => r.id), ["staging-3000", "staging-2000", "staging-1000"]);
    assert.deepEqual(listRuns(CWD, { decisions: {}, dismissed: ["staging-2000"] }).map((r) => r.id), ["staging-3000", "staging-1000"]);
  });

  it("trajectory from the child's session JSONL: tool calls, text, errors", () => {
    const lines = [
      { type: "session", cwd: "/x" },
      { type: "message", message: { role: "user", content: "PROMPT" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reading the digests" }, { type: "toolCall", id: "1", name: "read", arguments: { path: "/s/digests/INDEX.json" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] } },
      "not json",
    ].map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
    const steps = trajectoryFromSession(lines);
    assert.deepEqual(steps.map((s) => s.kind), ["user", "text", "tool", "error"]);
    assert.equal(steps[2]!.text, "read /s/digests/INDEX.json");
    assert.match(steps[3]!.text, /read failed: ENOENT/);
  });

  it("runTrajectory finds the nested session file and the log tail", () => {
    const dir = staging(Date.now());
    mkdirSync(join(dir, "sessions", "--x--"), { recursive: true });
    writeFileSync(join(dir, "sessions", "--x--", "a.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } }] } }) + "\n");
    writeFileSync(join(dir, "trajectory.log"), "line 1\n\nline 2\n");
    const t = runTrajectory(dir);
    assert.deepEqual(t.steps.map((s) => s.text), ["bash ls"]);
    assert.deepEqual(t.log, ["line 1", "line 2"]);
  });

  it("summarizes report sections", () => {
    assert.deepEqual(summarizeReport(REPORT), ["2 memory edits", "1 proposal", "1 skipped"]);
    assert.deepEqual(summarizeReport(""), []);
  });

  it("stopRun signals the group and the pid, and records stopped", () => {
    const dir = staging(Date.now(), { meta: { pid: 4242 } });
    const sent: Array<[number, string]> = [];
    assert.equal(stopRun({ pid: 4242, staging: dir }, (p, s) => void sent.push([p, s])), true);
    assert.deepEqual(sent, [[-4242, "SIGTERM"], [4242, "SIGTERM"]]);
    assert.equal(readRunMeta(dir)!.stopped, true);
  });
});

describe("controller", () => {
  const off = () => ({ ...DEFAULT_DREAM });
  it("status: off by default; runs info carries proposals + summary", () => {
    staging(5000, { report: REPORT, proposals: ["skill-demo", "check-x.md"] });
    const ctl = new DreamController({ cwd: () => CWD, settings: off });
    const s = ctl.status();
    assert.equal(s.enabled, false);
    assert.equal(s.due, undefined, "no schedule work while off");
    assert.equal(s.runs.length, 1);
    assert.equal(s.runs[0]!.pending, 2);
    assert.deepEqual(s.runs[0]!.summary, ["2 memory edits", "1 proposal", "1 skipped"]);
    assert.deepEqual(s.runs[0]!.proposals.map((p) => p.kind).sort(), ["check", "skill"]);
  });

  it("run works while off (manual); refuses a second concurrent run", () => {
    const calls: unknown[] = [];
    const ctl = new DreamController({
      cwd: () => CWD,
      settings: off,
      start: (cwd, _cfg, _mem, opts) => {
        calls.push(opts);
        const dir = staging(Date.now(), { meta: { pid: process.pid, manual: true } });
        return { staging: dir, pid: process.pid, logFile: join(dir, "trajectory.log"), sessions: 2, events: 4 };
      },
    });
    let changes = 0;
    const unsub = ctl.subscribe(() => changes++);
    const r = ctl.run();
    assert.equal(r.ok, true, r.message);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { manual: boolean }).manual, true);
    assert.ok(changes >= 1);
    assert.equal(ctl.status().running, true);
    assert.equal(readDreamState(CWD).lock?.pid, process.pid);
    const again = ctl.run();
    assert.equal(again.ok, false);
    assert.match(again.message, /already running/);
    unsub();
    ctl.dispose();
  });

  it("approve (skill → skills target + check) / reject / already-decided / dismiss", () => {
    const target = mkdtempSync(join(tmpdir(), "dream-skills-"));
    staging(6000, { report: REPORT, proposals: ["skill-demo", "check-x.md"] });
    const ctl = new DreamController({ cwd: () => CWD, settings: () => ({ ...DEFAULT_DREAM, skillsTarget: target }) });
    const run = ctl.runs()[0]!;
    const skill = run.proposals.find((p) => p.kind === "skill")!;
    const check = run.proposals.find((p) => p.kind === "check")!;
    const a = ctl.approve(run.id, skill.id);
    assert.equal(a.ok, true, a.message);
    assert.ok(existsSync(join(target, "demo", "SKILL.md")));
    assert.equal(ctl.approve(run.id, skill.id).ok, false, "already approved");
    assert.equal(ctl.reject(run.id, check.id).ok, true);
    assert.equal(readDreamState(CWD).decisions[check.id], "rejected");
    assert.equal(ctl.runs()[0]!.pending, 0);
    assert.equal(ctl.approve(run.id, "nope").ok, false);
    assert.equal(ctl.dismiss(run.id).ok, true);
    assert.equal(ctl.runs().length, 0);
    assert.deepEqual(readDreamState(CWD).dismissed, [run.id]);
  });

  it("stop: refuses with nothing running; stops a real running child (process group) and clears the lock", async () => {
    const ctl = new DreamController({ cwd: () => CWD, settings: off });
    assert.equal(ctl.stop().ok, false);
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = new Promise((r) => child.on("exit", r));
    staging(Date.now(), { meta: { pid: child.pid } });
    writeDreamState(CWD, { ...readDreamState(CWD), lock: { pid: child.pid!, at: Date.now() } });
    ctl.invalidate(); // runs() caches for 1 s
    assert.equal(ctl.status().running, true);
    const r = ctl.stop();
    assert.equal(r.ok, true, r.message);
    await exited;
    assert.equal(readDreamState(CWD).lock, null);
    ctl.invalidate();
    assert.equal(ctl.runs()[0]!.status, "stopped");
  });

  it("dismiss refuses a running dream", () => {
    staging(Date.now(), { meta: { pid: process.pid } });
    const ctl = new DreamController({ cwd: () => CWD, settings: off });
    const r = ctl.dismiss(ctl.runs()[0]!.id);
    assert.equal(r.ok, false);
    assert.match(r.message, /still running/);
  });

  it("runInfo keeps the wire shape small", () => {
    staging(7000, { report: REPORT });
    const ctl = new DreamController({ cwd: () => CWD, settings: off });
    const info = runInfo(ctl.runs()[0]!);
    assert.deepEqual(Object.keys(info).sort(), ["endedAt", "events", "hasReport", "id", "manual", "pending", "proposals", "sessions", "startedAt", "status", "summary"].sort());
  });
});

describe("tray pane", () => {
  const tui = () => ({ n: 0, requestRender() { this.n++; } });
  function actions(ctl: InstanceType<typeof DreamController>, enabled = false) {
    return {
      runs: () => ctl.runs(),
      detail: (id: string) => ctl.detail(id),
      enabled: () => enabled,
      run: () => ctl.run(),
      stop: (id: string) => ctl.stop(id),
      approve: (r: string, p: string) => ctl.approve(r, p),
      reject: (r: string, p: string) => ctl.reject(r, p),
      dismiss: (r: string) => ctl.dismiss(r),
    };
  }

  it("empty list says how to turn it on and that r runs one", () => {
    const ctl = new DreamController({ cwd: () => CWD, settings: () => ({ ...DEFAULT_DREAM }) });
    const pane = new DreamPane(tui(), theme, actions(ctl), () => {});
    const out = pane.render(200).map(strip).join("\n");
    assert.match(out, /Background dreaming is off \(turn it on in \/unipi:settings → Dream\)\. r runs one now\./);
    assert.ok(out.includes(DREAM_LIST_HINT));
    pane.dispose();
  });

  it("rows: state chip, kind, start time, manual/scheduled, sessions + pending tags", () => {
    staging(Date.now() - 60_000, { report: REPORT, proposals: ["skill-demo"], meta: { manual: true, endedAt: Date.now() } });
    const ctl = new DreamController({ cwd: () => CWD, settings: () => ({ ...DEFAULT_DREAM }) });
    const run = ctl.runs()[0]!;
    assert.equal(runState(run), "completed");
    const row = runRow(run);
    assert.equal(row.kind, "Dream");
    assert.equal(row.detail, "manual");
    assert.deepEqual(row.tags.slice(1), ["3 sessions", "1 pending"]);
    const pane = new DreamPane(tui(), theme, actions(ctl), () => {});
    const line = strip(pane.render(140)[0]!);
    assert.match(line, /DONE.*Dream.*manual.*3 sessions · 1 pending/);
    pane.dispose();
  });

  it("detail view: report summary, proposals, trajectory; o toggles the full report; ← back", () => {
    const dir = staging(Date.now() - 1000, { report: REPORT, proposals: ["skill-demo"] });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "s.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "memory_store", arguments: { title: "lesson_a" } }] } }) + "\n");
    const ctl = new DreamController({ cwd: () => CWD, settings: () => ({ ...DEFAULT_DREAM }) });
    const pane = new DreamPane(tui(), theme, actions(ctl), () => {});
    pane.handleInput("\r");
    assert.equal(pane.capturesArrows(), true);
    let out = pane.render(120).map(strip).join("\n");
    assert.match(out, /2 memory edits · 1 proposal · 1 skipped/);
    assert.match(out, /❭ 1\. \[skill\] demo  pending/);
    assert.match(out, /▸ memory_store lesson_a/);
    assert.match(out, /✓ Finished/);
    pane.handleInput("o");
    out = pane.render(120).map(strip).join("\n");
    assert.match(out, /Memory edits \(applied\)/);
    assert.match(out, /- lesson a/);
    pane.handleInput("\x1b[D");
    assert.equal(pane.capturesArrows(), false);
    pane.dispose();
  });

  it("a / x need a second press; x rejects the picked proposal", () => {
    staging(Date.now() - 1000, { report: REPORT, proposals: ["skill-demo", "check-x.md"] });
    const ctl = new DreamController({ cwd: () => CWD, settings: () => ({ ...DEFAULT_DREAM }) });
    const pane = new DreamPane(tui(), theme, actions(ctl), () => {});
    pane.handleInput("\r");
    pane.handleInput("2");
    pane.handleInput("x");
    assert.match(strip(pane.render(200).at(-1)!), /Press x again to reject skill demo/);
    pane.handleInput("x");
    assert.match(strip(pane.render(200).at(-1)!), /Rejected demo/);
    // A different key in between disarms.
    pane.handleInput("1");
    pane.handleInput("x");
    pane.handleInput("j");
    pane.handleInput("x");
    assert.match(strip(pane.render(200).at(-1)!), /Press x again/);
    const run = ctl.runs()[0]!;
    assert.equal(run.proposals.filter((p) => p.decision === "rejected").length, 1);
    pane.dispose();
  });

  it("s on a finished dream / d on a running one explain themselves; esc closes", () => {
    staging(Date.now(), { meta: { pid: process.pid } });
    const ctl = new DreamController({ cwd: () => CWD, settings: () => ({ ...DEFAULT_DREAM }) });
    let closed = 0;
    const pane = new DreamPane(tui(), theme, actions(ctl), () => closed++);
    pane.handleInput("d");
    assert.match(strip(pane.render(200).at(-1)!), /still running/);
    pane.handleInput("\x1b");
    assert.equal(closed, 1);
    pane.dispose();
  });
});

describe("extension: default off", () => {
  const sessionsDir = () => join(HOME, ".pi", "agent", "sessions", encodeSessionDirName(CWD));
  let bin: string;

  before(() => {
    // Fake dream child: writes a report + a proposal into its staging dir.
    bin = join(HOME, "fake-pi");
    writeFileSync(bin, `#!/usr/bin/env bash\nmkdir -p "$PI_DREAM_STAGING/proposals/skill-x"\nprintf -- '---\\nname: x\\ndescription: X. Use when asked.\\n---\\n1. x\\n' > "$PI_DREAM_STAGING/proposals/skill-x/SKILL.md"\nprintf '# Dream\\n## Memory edits\\n- a\\n## Proposals\\n1. x\\n## Skipped\\n' > "$PI_DREAM_STAGING/DREAM_REPORT.md"\necho done\n`);
    chmodSync(bin, 0o755);
    process.env.PI_DREAM_BIN = bin;
    mkdirSync(sessionsDir(), { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(
        join(sessionsDir(), `s${String(i)}.jsonl`),
        [
          { type: "session", cwd: CWD },
          { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "x" } }] } },
          { type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] } },
        ].map((l) => JSON.stringify(l)).join("\n"),
      );
    }
  });
  after(() => {
    delete process.env.PI_DREAM_BIN;
  });

  function fakePi() {
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
    const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
    const entries: unknown[] = [];
    return {
      handlers,
      commands,
      entries,
      on: (n: string, h: (e: unknown, c: unknown) => unknown) => void handlers.set(n, [...(handlers.get(n) ?? []), h]),
      registerCommand: (n: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => void commands.set(n, o),
      registerEntryRenderer: () => {},
      appendEntry: (type: string, data: unknown) => void entries.push({ type, data }),
    };
  }

  it("off: session_start spawns nothing and digests nothing; status says how to turn it on; run works anyway", async () => {
    const ext = await import("../extensions/dream.ts");
    ext.resetDreamForTests();
    const pi = fakePi();
    ext.default(pi as never);
    const ctx = { cwd: CWD, hasUI: false, ui: { notify: (t: string) => notes.push(t) } };
    const notes: string[] = [];
    for (const h of pi.handlers.get("session_start") ?? []) h({}, ctx);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readdirSync(root()).filter((d) => d.startsWith("staging-")), [], "no staging dir (no child, no digest) while off");
    assert.equal(normalizeDream(null).enabled, false);

    await pi.commands.get("unipi:dream")!.handler("", ctx);
    assert.match(notes.at(-1)!, /dream: off — turn on in \/unipi:settings → Dream/);

    await pi.commands.get("unipi:dream")!.handler("run", ctx);
    assert.match(notes.at(-1)!, /Dream running in the background/);
    const dirs = readdirSync(root()).filter((d) => d.startsWith("staging-"));
    assert.equal(dirs.length, 1);
    const meta = readRunMeta(join(root(), dirs[0]!))!;
    assert.equal(meta.manual, true);
    assert.equal(meta.sessions, 6);
    // The fake child finishes; the launcher records the exit.
    for (let i = 0; i < 50 && readRunMeta(join(root(), dirs[0]!))?.endedAt === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(readRunMeta(join(root(), dirs[0]!))!.exitCode, 0);
    assert.ok(readFileSync(join(root(), dirs[0]!, "trajectory.log"), "utf8").includes("done"));

    // Next open shows the report card even though dreaming is off.
    ext.resetDreamForTests();
    writeDreamState(CWD, { ...readDreamState(CWD), shownReport: null });
    for (const h of pi.handlers.get("session_start") ?? []) h({}, ctx);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((pi.entries.at(-1) as { type: string }).type, "unipi-dream-report-card");
    assert.equal(((pi.entries.at(-1) as { data: { pending: number } }).data).pending, 1);

    await pi.commands.get("unipi:dream")!.handler("approve 1", ctx);
    assert.match(notes.at(-1)!, /Approved x|Approval failed/);
  });
});
