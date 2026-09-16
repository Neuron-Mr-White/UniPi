/**
 * Exactly-once completion delivery.
 *
 * A handoff that ends with no waiter attached (a `hasPendingMessages`
 * interrupt, or a `waitForReport` timeout) must still wake the lead with the
 * same `sidekick-completion` followUp that `block:false` sends — and must never
 * send it when a waiter returned the report inline instead.
 *
 * These drive the real tools against a real SidekickRuntime whose child is a
 * stub (UNIPI_SUBAGENT_PI_BINARY), so `isBusy()` is genuinely true and the
 * report lands through the real RPC settle path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCompletionDelivery, registerFusionTools } from "../src/tools.js";
import { SidekickRuntime, type HandoffReport } from "../src/sidekick-runtime.js";

/** Replies to the runtime's settle handshake with a canned report. */
const CHILD_JS = [
  'let buf = "";',
  'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let index;",
  '  while ((index = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, index);",
  "    buf = buf.slice(index + 1);",
  '    if (line.includes("get_last_assistant_text")) {',
  '      send({ type: "response", command: "get_last_assistant_text", data: { text: process.env.STUB_REPORT_TEXT || "stub report" } });',
  '    } else if (line.includes(\'"type":"prompt"\')) {',
  '      setTimeout(() => send({ type: "agent_settled" }), Number(process.env.STUB_REPORT_DELAY_MS || "50"));',
  "    }",
  "  }",
  "});",
  "",
].join("\n");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the handoff to settle");
    await wait(10);
  }
}

function setup(options: { delayMs: number; text: string }) {
  const stubDir = mkdtempSync(join("/tmp", "fusion-completion-stub-"));
  writeFileSync(join(stubDir, "stub-child.js"), CHILD_JS);
  const bin = join(stubDir, "stub-pi");
  // Ignores the pi RPC argv and hands stdin/stdout to the stub child.
  writeFileSync(bin, '#!/bin/sh\nexec node "$(dirname "$0")/stub-child.js"\n');
  chmodSync(bin, 0o755);

  const previous = {
    bin: process.env.UNIPI_SUBAGENT_PI_BINARY,
    delay: process.env.STUB_REPORT_DELAY_MS,
    text: process.env.STUB_REPORT_TEXT,
  };
  process.env.UNIPI_SUBAGENT_PI_BINARY = bin;
  process.env.STUB_REPORT_DELAY_MS = String(options.delayMs);
  process.env.STUB_REPORT_TEXT = options.text;

  const runtime = new SidekickRuntime({
    cwd: mkdtempSync(join("/tmp", "fusion-completion-cwd-")),
    model: "b/side",
    thinking: "low",
    sessionFile: join(mkdtempSync(join("/tmp", "fusion-completion-session-")), "sidekick.jsonl"),
    systemPrompt: "stub system prompt",
  });

  const tools = new Map<string, any>();
  const sent: any[] = [];
  const reports: HandoffReport[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  registerFusionTools(pi, { getRuntime: () => runtime, onReport: (_ctx, report) => reports.push(report) });

  const state = { pending: false };
  const ctx: any = { hasPendingMessages: () => state.pending };
  const completions = () => sent.filter((entry) => entry.message.customType === "sidekick-completion");

  return {
    runtime,
    tools,
    sent,
    reports,
    completions,
    state,
    ctx,
    shutdown: () => {
      runtime.kill();
      if (previous.bin === undefined) delete process.env.UNIPI_SUBAGENT_PI_BINARY;
      else process.env.UNIPI_SUBAGENT_PI_BINARY = previous.bin;
      if (previous.delay === undefined) delete process.env.STUB_REPORT_DELAY_MS;
      else process.env.STUB_REPORT_DELAY_MS = previous.delay;
      if (previous.text === undefined) delete process.env.STUB_REPORT_TEXT;
      else process.env.STUB_REPORT_TEXT = previous.text;
    },
  };
}

const sidekick = (h: ReturnType<typeof setup>, params: Record<string, unknown>) =>
  h.tools.get("sidekick")!.execute("call", params, undefined, undefined, h.ctx);
const readSubagent = (h: ReturnType<typeof setup>, params: Record<string, unknown>) =>
  h.tools.get("read_subagent")!.execute("call", params, undefined, undefined, h.ctx);

test("interrupt then abandoned: exactly one completion, delivered as a followUp turn", async () => {
  const h = setup({ delayMs: 200, text: "stub report A" });
  try {
    h.state.pending = true;
    const result = await sidekick(h, { message: "work" });
    assert.match(result.content[0].text, /user message arrived/);
    assert.equal(h.sent.length, 0, "nothing is delivered while the lead handles the interrupt");

    await until(() => !h.runtime.isBusy());
    await wait(30);
    assert.equal(h.completions().length, 1);
    assert.deepEqual(h.completions()[0].options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(h.completions()[0].message.content, /stub report A/);
  } finally {
    h.shutdown();
  }
});

test("interrupt then read_subagent collects it: zero completions", async () => {
  const h = setup({ delayMs: 200, text: "stub report B" });
  try {
    h.state.pending = true;
    const interrupted = await sidekick(h, { message: "work" });
    assert.match(interrupted.content[0].text, /user message arrived/);

    // Recovery flow: the lead comes back and waits for the report itself.
    h.state.pending = false;
    const collected = await readSubagent(h, { block: true, timeout: 5 });
    assert.match(collected.content[0].text, /stub report B/, "the report is returned inline");

    await wait(400);
    assert.equal(h.sent.length, 0, "an inline collection must suppress the completion entirely");
    assert.equal(h.completions().length, 0);
    assert.equal(h.reports.length, 1, "onReport still fires for the inline report");
  } finally {
    h.shutdown();
  }
});

test("timeout then abandoned: exactly one completion", async () => {
  const h = setup({ delayMs: 250, text: "stub report C" });
  try {
    await sidekick(h, { message: "work", block: false });
    const timedOut = await readSubagent(h, { block: true, timeout: 0.001 });
    assert.match(timedOut.content[0].text, /is still running/);
    assert.equal(h.sent.length, 0);

    await until(() => !h.runtime.isBusy());
    await wait(30);
    assert.equal(h.completions().length, 1);
    assert.match(h.completions()[0].message.content, /stub report C/);
  } finally {
    h.shutdown();
  }
});

test("two interrupts on the same handoff: still exactly one completion", async () => {
  const h = setup({ delayMs: 250, text: "stub report D" });
  try {
    h.state.pending = true;
    const first = await sidekick(h, { message: "work" });
    const second = await sidekick(h, { message: "also do this" });
    assert.match(first.content[0].text, /user message arrived/);
    assert.match(second.content[0].text, /user message arrived/);
    assert.equal(first.details.id, second.details.id, "the second call steered the same handoff");

    await until(() => !h.runtime.isBusy());
    await wait(30);
    assert.equal(h.completions().length, 1, "still exactly one completion after two interrupts");
  } finally {
    h.shutdown();
  }
});

test("re-detaching the same handoff attaches a single continuation", async () => {
  const sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => sent.push(report));
  const report: HandoffReport = {
    id: "h-rearmed",
    status: "completed",
    text: "done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
    toolCalls: 0,
    durationMs: 1,
  };
  let attaches = 0;
  const done = {
    then: (onFulfilled: (value: HandoffReport) => unknown) => {
      attaches += 1;
      return Promise.resolve(report).then(onFulfilled);
    },
  } as unknown as Promise<HandoffReport>;

  delivery.attach(report.id);
  delivery.detach(report.id, done);
  delivery.detach(report.id, done);
  delivery.detach(report.id, done);
  await wait(10);

  assert.equal(attaches, 1, "one continuation however many waiters give up");
  assert.equal(sent.length, 1);
});

test("a report that already resolved before detach is still delivered once", async () => {
  const sent: HandoffReport[] = [];
  const delivery = createCompletionDelivery((report) => sent.push(report));
  const report: HandoffReport = {
    id: "h-settled",
    status: "completed",
    text: "already done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
    toolCalls: 0,
    durationMs: 1,
  };

  const done = Promise.resolve(report);
  await wait(0);
  delivery.attach(report.id);
  delivery.detach(report.id, done);
  await wait(10);
  assert.equal(sent.length, 1, "a resolved promise still runs the continuation");
  assert.equal(sent[0]?.id, report.id);

  // Same shape, but a waiter consumed it inline first: stays silent.
  const consumed = { ...report, id: "h-settled-consumed" };
  const doneConsumed = Promise.resolve(consumed);
  await wait(0);
  delivery.attach(consumed.id);
  delivery.detach(consumed.id, doneConsumed);
  delivery.consume(consumed.id);
  await wait(10);
  assert.equal(sent.length, 1);
});

test("block:false still delivers exactly one completion", async () => {
  const h = setup({ delayMs: 100, text: "stub report F" });
  try {
    const started = await sidekick(h, { message: "work", block: false });
    assert.match(started.content[0].text, /started in the background/);
    assert.equal(h.sent.length, 0);

    await until(() => !h.runtime.isBusy());
    await wait(30);
    assert.equal(h.completions().length, 1);
    assert.deepEqual(h.completions()[0].options, { deliverAs: "followUp", triggerTurn: true });
    assert.match(h.completions()[0].message.content, /stub report F/);
    assert.equal(h.reports.length, 1);
  } finally {
    h.shutdown();
  }
});
