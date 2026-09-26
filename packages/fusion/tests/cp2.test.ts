import { test } from "node:test";
import assert from "node:assert/strict";
import { SidekickRuntime } from "../src/sidekick-runtime.js";
import { leadExtensionArgs } from "../src/child-args.js";
import { renderSidekickStep } from "../src/transcript.js";
import { mergeDefaultModel } from "../src/pi-settings.js";
import type { SidekickStep } from "../src/sidekick-runtime.js";

// ── step emission ────────────────────────────────────────────────────────────

function runtimeWithSteps() {
  const steps: SidekickStep[] = [];
  const runtime = new SidekickRuntime({
    cwd: "/tmp",
    model: "x/y" as never,
    thinking: "medium",
    sessionFile: "/tmp/x.jsonl",
    systemPrompt: "sys",
    spawn: () => undefined as never,
    onStep: (s) => steps.push(s),
  });
  return { runtime: runtime as never as { handleMessage(m: unknown): void }, steps };
}

test("tool_execution_end emits a tool step with capped output", () => {
  const { runtime, steps } = runtimeWithSteps();
  const msg = { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } };
  // handoff must exist for events to accumulate — fake the pending slot
  const rt = runtime as unknown as { pending: unknown };
  rt.pending = {
    id: "h1", message: "", startedAt: Date.now(), usage: {}, retriedPrompt: false,
    openBgTasks: 0, settled: false, resolve: () => {},
    progress: { toolCalls: 0, recentTools: [], textTail: "", startedAt: Date.now(), events: [], droppedEvents: 0 },
  };
  runtime.handleMessage(msg);
  const longOutput = Array.from({ length: 50 }, (_, i) => `line ${String(i)}`).join("\n");
  runtime.handleMessage({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: longOutput }] } });
  assert.equal(steps.length, 1);
  const step = steps[0];
  assert.equal(step.kind, "tool");
  if (step.kind === "tool") {
    assert.equal(step.name, "bash");
    assert.equal(step.output.split("\n").length, 40, "output capped at 40 lines");
    assert.equal(step.arg, "ls");
  }
});

test("intermediate text is emitted; the final report text is not", () => {
  const { runtime, steps } = runtimeWithSteps();
  const rt = runtime as unknown as { pending: unknown; finish(s: string, t?: string): void };
  rt.pending = {
    id: "h1", message: "", startedAt: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, retriedPrompt: false,
    openBgTasks: 0, settled: false, resolve: () => {},
    progress: { toolCalls: 0, recentTools: [], textTail: "", startedAt: Date.now(), events: [], droppedEvents: 0 },
  };
  runtime.handleMessage({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me check" } });
  runtime.handleMessage({ type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: {} });
  assert.equal(steps.length, 1, "intermediate text flushed at next tool call");
  assert.equal(steps[0].kind, "text");
  runtime.handleMessage({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Final report" } });
  rt.finish("completed", "Final report");
  assert.equal(steps.length, 1, "final report text skipped");
});

// ── renderer ─────────────────────────────────────────────────────────────────

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

test("tool step renders collapsed (≤3 output lines) and expanded shows all", () => {
  const step: SidekickStep = { kind: "tool", name: "bash", arg: "ls", output: "a\nb\nc\nd\ne", isError: false, durationMs: 10 };
  const collapsed = renderSidekickStep(step, false, theme).render(200).join("\n");
  assert.match(collapsed, /◆ bash ls/);
  assert.ok(collapsed.includes("c") && collapsed.includes("e"));
  assert.ok(collapsed.includes("2 earlier lines"));
  const expanded = renderSidekickStep(step, true, theme).render(200).join("\n");
  for (const l of ["a", "b", "c", "d", "e"]) assert.ok(expanded.split("\n").some((r) => r.trimEnd().endsWith(l)), `expanded shows ${l}`);
});

test("text step renders ◆ + markdown; thinking only when expanded", () => {
  const step: SidekickStep = { kind: "text", text: "answer", thinking: "deep thought" };
  const collapsed = renderSidekickStep(step, false, theme).render(200).join("\n");
  assert.ok(collapsed.includes("answer"));
  assert.ok(!collapsed.includes("deep thought"), "thinking hidden collapsed");
  const expanded = renderSidekickStep(step, true, theme).render(200).join("\n");
  assert.ok(expanded.includes("deep thought"));
});

// ── child argv passthrough ───────────────────────────────────────────────────

test("leadExtensionArgs extracts -e/--extension, --no-extensions, --skill, always --no-skills", () => {
  assert.deepEqual(leadExtensionArgs(["pi", "-e", "/repo/index.ts", "--no-extensions", "--no-skills"]),
    ["--extension", "/repo/index.ts", "--no-extensions", "--no-skills"]);
  assert.deepEqual(leadExtensionArgs(["pi", "--extension", "/a.ts", "--skill", "/s.md"]),
    ["--extension", "/a.ts", "--skill", "/s.md", "--no-skills"]);
  assert.deepEqual(leadExtensionArgs(["pi"]), ["--no-skills"]);
});

// ── settings merge ───────────────────────────────────────────────────────────

test("mergeDefaultModel preserves other keys and sets provider/model/effort", () => {
  const out = mergeDefaultModel({ theme: "dark", defaultModel: "old" }, { provider: "p", model: "m", thinkingLevel: "high" });
  assert.equal(out.theme, "dark");
  assert.equal(out.defaultProvider, "p");
  assert.equal(out.defaultModel, "m");
  assert.equal(out.defaultThinkingLevel, "high");
});

// ── prompt sections coexist (long-horizon + fusion, in load order) ───────────

test("long-horizon and fusion both contribute prompt sections — no forced prompt", async () => {
  const { renderModeFragment } = await import("../../long-horizon/src/gate.js");
  const { leadPolicy } = await import("../src/prompts.js");
  const { buildSystemPrompt } = await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js");

  const options: { sections: Record<string, string> } = { sections: {} };
  // load order: long-horizon first, fusion second — each writes its own section
  const fragment = renderModeFragment({ mode: "graph", source: "explicit" } as never);
  options.sections["long-horizon"] = fragment.replace(/^<long-horizon[^>]*>\n?/, "").replace(/\n?<\/long-horizon>$/, "");
  options.sections["fusion-lead-policy"] = leadPolicy({ leadName: "A", leadEffort: "", sidekickName: "B", sidekickEffort: "" } as never);

  const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], sections: options.sections } as never);
  assert.match(prompt, /<long-horizon>[\s\S]*graph/i, "long-horizon section present");
  assert.match(prompt, /<fusion-lead-policy>[\s\S]*Sidekick/, "fusion lead policy present");
});

test("long-horizon's before_agent_start no longer returns a forced systemPrompt", async () => {
  const gate = await import("../../long-horizon/src/gate.js");
  const src = (await import("node:fs")).readFileSync(
    new URL("../../long-horizon/src/gate.ts", import.meta.url), "utf8");
  assert.ok(src.includes('event.systemPromptOptions.sections["long-horizon"]'), "section write");
  assert.ok(!/return\s*\{\s*systemPrompt:/.test(src), "no forced systemPrompt return");
  void gate;
});
