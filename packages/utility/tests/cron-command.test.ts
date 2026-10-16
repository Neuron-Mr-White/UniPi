/**
 * @pi-unipi/utility — /unipi:cron (UNI-315): pure rendering of
 * `unipi-host cron … --json` payloads, argument parsing/completions, and
 * the handler wiring, with a fake `exec` standing in for the real CLI.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CRON_HELP,
  cronCompletions,
  cronUnavailableText,
  parseCronJson,
  registerCronCommand,
  renderList,
  renderOverview,
  renderRuns,
  renderShow,
  renderStatus,
  resetCronIdsCacheForTests,
  splitCronArgs,
  type CronExec,
} from "../src/cron/index.ts";

describe("parseCronJson", () => {
  it("parses the last line (--json prints one JSON line)", () => {
    assert.deepEqual(parseCronJson('{"a":1}\n'), { a: 1 });
  });
  it("returns null on malformed output instead of throwing", () => {
    assert.equal(parseCronJson("not json"), null);
    assert.equal(parseCronJson(""), null);
  });
});

describe("renderList", () => {
  it("empty -> a hint to add one", () => {
    assert.match(renderList({ jobs: [] }), /No cron jobs yet/);
  });
  it("one job -> id, enabled, schedule, tz, name", () => {
    const text = renderList({ jobs: [{ id: "digest", enabled: true, schedule: "0 0 9 * * *", tz: "Europe/Berlin", name: "daily digest" }] });
    assert.match(text, /digest/);
    assert.match(text, /enabled/);
    assert.match(text, /Europe\/Berlin/);
    assert.match(text, /daily digest/);
  });
});

describe("renderShow", () => {
  it("renders job fields and a run list, or 'none yet'", () => {
    const empty = renderShow({ job: { id: "x", name: "X", enabled: false, prompt: "p", cwd: "/tmp", schedule: "s", tz: "UTC" }, runs: [] });
    assert.match(empty, /none yet/);
    const withRuns = renderShow({
      job: { id: "x", name: "X", enabled: true, prompt: "p", cwd: "/tmp", schedule: "s", tz: "UTC", model: "gpt", cost_cap_usd: 0.5 },
      runs: [{ id: "r1", status: "ok", summary: "done" }],
    });
    assert.match(withRuns, /r1/);
    assert.match(withRuns, /ok/);
    assert.match(withRuns, /done/);
    assert.match(withRuns, /cost cap: \$0\.50/);
    assert.match(withRuns, /model: gpt/);
  });
});

describe("renderRuns", () => {
  it("empty -> 'No runs yet.'", () => {
    assert.equal(renderRuns({ runs: [] }), "No runs yet.");
  });
  it("falls back to reason when summary is absent", () => {
    const text = renderRuns({ runs: [{ job_id: "x", id: "r1", status: "failed", reason: "cost cap" }] });
    assert.match(text, /cost cap/);
  });
});

describe("renderStatus / renderOverview", () => {
  it("renderStatus shows paused/running, concurrency, next fire, running flag", () => {
    const text = renderStatus({ paused: true, concurrency: 2, jobs: [{ id: "x", enabled: true, next_fire: "2025-01-01T00:00:00Z", running: true }] });
    assert.match(text, /^paused/);
    assert.match(text, /concurrency 2/);
    assert.match(text, /next 2025-01-01T00:00:00Z/);
    assert.match(text, /\(running\)/);
  });
  it("renderOverview merges status + list (adds the job name)", () => {
    const text = renderOverview(
      { paused: false, concurrency: 1, jobs: [{ id: "x", enabled: true, next_fire: "-", running: false }] },
      { jobs: [{ id: "x", name: "daily digest" }] },
    );
    assert.match(text, /^running/);
    assert.match(text, /daily digest/);
  });
  it("renderOverview with no jobs -> hint", () => {
    assert.match(renderOverview({ paused: false, concurrency: 0, jobs: [] }, { jobs: [] }), /No cron jobs yet/);
  });
});

describe("cronUnavailableText", () => {
  it("names the host app as the thing to check", () => {
    assert.match(cronUnavailableText("ENOENT"), /ENOENT/);
    assert.match(cronUnavailableText("ENOENT"), /UniPi app/);
  });
});

describe("splitCronArgs", () => {
  it("bare args -> empty sub", () => {
    assert.deepEqual(splitCronArgs(""), { sub: "", rest: [] });
  });
  it("sub + id + extra", () => {
    assert.deepEqual(splitCronArgs("runs digest 5"), { sub: "runs", rest: ["digest", "5"] });
  });
  it("lowercases the subcommand", () => {
    assert.deepEqual(splitCronArgs("LIST"), { sub: "list", rest: [] });
  });
});

describe("cronCompletions", () => {
  beforeEach(() => resetCronIdsCacheForTests());

  const fakeExec: CronExec = async (args: string[]) => {
    if (args[0] === "list") return { stdout: JSON.stringify({ jobs: [{ id: "digest" }, { id: "deploy" }] }) };
    return { error: "unused" };
  };

  it("bare prefix -> subcommand names", async () => {
    const items = await cronCompletions(fakeExec, "");
    assert.ok(items && items.some((i) => i.value === "list"));
    assert.ok(items && items.some((i) => i.value === "status"));
  });

  it("partial subcommand -> filtered", async () => {
    const items = await cronCompletions(fakeExec, "sta");
    assert.deepEqual(items?.map((i) => i.value), ["status"]);
  });

  it("'show <TAB>' -> job ids, full-args value", async () => {
    const items = await cronCompletions(fakeExec, "show ");
    assert.ok(items);
    assert.deepEqual(
      items!.map((i) => i.value).sort(),
      ["show deploy", "show digest"],
    );
  });

  it("'show d<TAB>' -> filtered by partial id", async () => {
    const items = await cronCompletions(fakeExec, "show de");
    assert.deepEqual(items?.map((i) => i.value), ["show deploy"]);
  });

  it("pause/resume/list take no id -> no id completions offered", async () => {
    const items = await cronCompletions(fakeExec, "pause ");
    assert.equal(items, null);
  });
});

describe("registerCronCommand handler (fake exec, fake ctx)", () => {
  function fakeCtx() {
    const notified: Array<{ text: string; level: string }> = [];
    return { notified, ctx: { ui: { notify: (text: string, level?: string) => notified.push({ text, level: level ?? "info" }) } } as never };
  }
  function fakePi() {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    return {
      pi: { registerCommand: (_name: string, opts: { handler: typeof handler }) => { handler = opts.handler; } } as never,
      run: (args: string, ctx: unknown) => handler!(args, ctx),
    };
  }

  it("bare command renders the overview from status+list", async () => {
    const { pi, run } = fakePi();
    const exec: CronExec = async (args) => {
      if (args[0] === "status") return { stdout: JSON.stringify({ paused: false, concurrency: 1, jobs: [{ id: "x", enabled: true, next_fire: "-", running: false }] }) };
      if (args[0] === "list") return { stdout: JSON.stringify({ jobs: [{ id: "x", name: "digest" }] }) };
      return { error: "nope" };
    };
    registerCronCommand(pi, exec);
    const { notified, ctx } = fakeCtx();
    await run("", ctx);
    assert.equal(notified.length, 1);
    assert.match(notified[0]!.text, /digest/);
  });

  it("unreachable host -> a clear warning, not a crash", async () => {
    const { pi, run } = fakePi();
    const exec: CronExec = async () => ({ error: "spawn unipi-host ENOENT" });
    registerCronCommand(pi, exec);
    const { notified, ctx } = fakeCtx();
    await run("list", ctx);
    assert.equal(notified[0]!.level, "warning");
    assert.match(notified[0]!.text, /ENOENT/);
  });

  it("show/runs/stop/enable without an id -> asks for one, does not call exec", async () => {
    const { pi, run } = fakePi();
    let called = false;
    const exec: CronExec = async () => {
      called = true;
      return { error: "should not be called" };
    };
    registerCronCommand(pi, exec);
    const { notified, ctx } = fakeCtx();
    await run("show", ctx);
    assert.equal(called, false);
    assert.match(notified[0]!.text, /needs a job id/);
  });

  it("unknown subcommand -> the help text", async () => {
    const { pi, run } = fakePi();
    registerCronCommand(pi, async () => ({ error: "unused" }));
    const { notified, ctx } = fakeCtx();
    await run("bogus", ctx);
    assert.equal(notified[0]!.text, CRON_HELP);
  });

  it("run <id> -> reports the started run id", async () => {
    const { pi, run } = fakePi();
    const exec: CronExec = async (args) => {
      assert.deepEqual(args, ["run", "digest"]);
      return { stdout: JSON.stringify({ run_id: "r42" }) };
    };
    registerCronCommand(pi, exec);
    const { notified, ctx } = fakeCtx();
    await run("run digest", ctx);
    assert.match(notified[0]!.text, /r42/);
  });

  it("stop <id> -> Stopped. or Nothing was running., from the stopped flag", async () => {
    const { pi, run } = fakePi();
    registerCronCommand(pi, async () => ({ stdout: JSON.stringify({ stopped: true }) }));
    const { notified, ctx } = fakeCtx();
    await run("stop digest", ctx);
    assert.equal(notified[0]!.text, "Stopped.");
  });

  it("runs <id> N -> passes --limit through", async () => {
    const { pi, run } = fakePi();
    const exec: CronExec = async (args) => {
      assert.deepEqual(args, ["runs", "digest", "--limit", "5"]);
      return { stdout: JSON.stringify({ runs: [] }) };
    };
    registerCronCommand(pi, exec);
    const { ctx } = fakeCtx();
    await run("runs digest 5", ctx);
  });

  it("pause/resume -> fixed confirmation text", async () => {
    const { pi, run } = fakePi();
    registerCronCommand(pi, async () => ({ stdout: "{}" }));
    const { notified, ctx } = fakeCtx();
    await run("pause", ctx);
    assert.match(notified[0]!.text, /Paused/);
    await run("resume", ctx);
    assert.match(notified[1]!.text, /Resumed/);
  });
});
