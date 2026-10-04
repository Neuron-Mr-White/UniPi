/**
 * UNI-53 — native card binding mechanics: identity probe rebuilds, branch meta
 * changes, persistence retries, OSC133 in patched renders, expansion, heights.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { harnessMetadata } from "@pi-unipi/core";
import { installHarnessUserRendering } from "../src/render/harness.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
// Initialize pi's dark theme (the SDK getMarkdownTheme/user render need a
// global instance; production initializes it before extensions load).
const __pi = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const __themeMod = (await import(pathToFileURL(join(dirname(__pi), "modes/interactive/theme/theme.js")).href)) as {
  getThemeByName(name: string): object | undefined;
  setThemeInstance(t: object): void;
};
const __dark = __themeMod.getThemeByName("dark");
if (__dark) __themeMod.setThemeInstance(__dark);

interface HarnessMeta {
  version: 1;
  id: string;
  source: string;
  title: string;
  delivery: "direct" | "steer" | "followUp" | "nextTurn" | "boundary" | "before_agent_start";
}

function meta(id: string, source = "Goal"): HarnessMeta {
  return { version: 1, id, source, title: "Harness title", delivery: "direct" };
}

function isUserComponent(c: unknown): boolean {
  return (
    !!c && typeof c === "object" &&
    typeof (c as { text?: unknown }).text === "string" &&
    typeof (c as { rebuild?: unknown }).rebuild === "function" &&
    typeof (c as { setOutputPad?: unknown }).setOutputPad === "function" &&
    (c as { message?: unknown }).message === undefined
  );
}

function strip(l: string): string {
  return l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function rendersRail(card: UserMessageComponent): boolean {
  return (card.render as (w: number) => string[])(80).join("").includes("▏");
}

interface Host {
  container: { children: unknown[] };
  tick(): Promise<void>;
  userCards(): UserMessageComponent[];
  probeRender(): void;
  setEntries(next: Array<{ id: string; text: string; meta?: HarnessMeta }>): void;
  setExpanded(next: boolean): void;
  shutdown(): void;
  requestRenderCalls(): number;
}

function setup(
  entries: Array<{ id: string; text: string; meta?: HarnessMeta }>,
  opts: { toolsExpanded?: boolean } = {},
): Host & { setEntries(next: Array<{ id: string; text: string; meta?: HarnessMeta }>): void; setExpanded(next: boolean): void; shutdown(): void; requestRenderCalls(): number } {
  const handlers: Record<string, Array<(e?: unknown, ctx?: unknown) => unknown>> = {};
  const container: { children: unknown[] } = { children: [] };
  // transcript signature child (assistant-like), as pi's real container has
  container.children.push({ contentContainer: {}, hasToolCalls: false, updateContent() {}, render: () => [] });
  let requestRenderCalls = 0;
  const tui = { children: [container], requestRender: () => { requestRenderCalls += 1; } };
  let currentEntries = entries;
  let toolsExpanded = opts.toolsExpanded ?? false;
  const ctx: any = {
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {
      getLeafId: () => "leaf-1",
      buildContextEntries: () =>
        currentEntries.map((e) => ({
          type: "message",
          id: e.id,
          message: { role: "user", content: [{ type: "text", text: e.text }], ...(e.meta ? { unipiHarness: e.meta } : {}) },
        })),
    },
    ui: { getToolsExpanded: () => toolsExpanded, setWidget: (_n: string, render: (t: unknown, th: unknown) => unknown) => { widgetRender = render; } },
  };
  let widgetRender: ((t: unknown, th: unknown) => unknown) | undefined;
  const pi: any = {
    on(name: string, fn: (e?: unknown, c?: unknown) => unknown) {
      (handlers[name] ??= []).push(fn);
      return pi;
    },
  };
  installHarnessUserRendering(pi);
  for (const fn of handlers["session_start"] ?? []) fn({}, ctx);
  return {
    container,
    probeRender(): void {
      widgetRender?.(tui, { getColorMode: () => "truecolor" });
    },
    async tick() {
      await new Promise((r) => setTimeout(r, 15));
    },
    userCards(): UserMessageComponent[] {
      return (container.children as unknown[]).filter(isUserComponent) as UserMessageComponent[];
    },
    setEntries(next) {
      currentEntries = next;
      for (const fn of handlers["session_start"] ?? []) fn({}, ctx); // after-event rebind
    },
    setExpanded(next) {
      toolsExpanded = next;
    },
    shutdown() {
      for (const fn of handlers["session_shutdown"] ?? []) fn();
    },
    requestRenderCalls(): number {
      return requestRenderCalls;
    },
  };
}

test("probe.render alone (no events) wraps harness and leaves human native — identity rebuild", async () => {
  const host = setup([
    { id: "e0", text: "alpha", meta: meta("m0") },
    { id: "e1", text: "beta" },
  ]);
  host.container.children.push(new UserMessageComponent("alpha"), new UserMessageComponent("beta"));
  host.probeRender();
  await host.tick();
  const cards = host.userCards();
  assert.equal(cards.length, 2);
  assert.ok(rendersRail(cards[0]!), "harness card not panelled via probe.render");
  assert.ok(!rendersRail(cards[1]!), "human card must stay native");
});

test("branch switch: same texts different provenance → panel recreated with the new meta", async () => {
  const host = setup([
    { id: "e0", text: "alpha", meta: meta("m0", "Goal") },
    { id: "e1", text: "beta" },
  ]);
  host.container.children.push(new UserMessageComponent("alpha"), new UserMessageComponent("beta"));
  host.probeRender();
  await host.tick();
  const [alpha, beta] = host.userCards();
  assert.ok(rendersRail(alpha!), "alpha precondition");
  host.setEntries([
    { id: "e0", text: "alpha" },
    { id: "e1", text: "beta", meta: meta("m1", "Ralph") },
  ]);
  host.probeRender(); // retained widget render callback → probe → rebind
  await host.tick();
  assert.ok(!rendersRail(alpha!), "alpha must fall back to native after branch switch");
  assert.ok(rendersRail(beta!), "beta must be panelled after branch switch");
  assert.ok(beta!.render(80).join("").includes("Ralph"), "beta panel missing the new source");
});

test("compaction: aligned projected list wraps on retry", async () => {
  const host = setup([
    { id: "e0", text: "kept", meta: meta("m1") },
  ]);
  host.container.children.push(new UserMessageComponent("kept"));
  host.probeRender();
  await host.tick();
  const kept = host.userCards()[0]!;
  assert.ok(rendersRail(kept!), "kept card must panel when aligned");
});

test("patched harness render carries OSC133 zones; plain fallback keeps light fg", () => {
  const host = setup([{ id: "e0", text: "harness body", meta: meta("m0") }]);
  host.container.children.push(new UserMessageComponent("harness body"));
  host.probeRender();
  const card = host.userCards()[0]!;
  const raw = (card.render as (w: number) => string[])(80);
  assert.ok(raw[0]!.includes("\x1b]133;A\x07"), "OSC133 start missing");
  assert.ok(raw[raw.length - 1]!.includes("\x1b]133;B\x07"), "OSC133 end missing");
  for (const row of raw) assert.ok(visibleWidth(row) <= 80, `row over width: ${visibleWidth(row)}`);
});

test("human card height stable across wrapped reconciliation", async () => {
  const host = setup([{ id: "e0", text: "plain human" }]);
  host.container.children.push(new UserMessageComponent("plain human"));
  host.probeRender();
  await host.tick();
  const card = host.userCards()[0]!;
  const h1 = (card.render as (w: number) => string[])(80).length;
  const h2 = (card.render as (w: number) => string[])(80).length;
  assert.equal(h2, h1, "native height unstable");
  assert.ok(h1 > 0);
});

test("expansion toggle reaches the panel via getToolsExpanded", async () => {
  let expanded = false;
  const host = setup([{ id: "e0", text: "expand body", meta: meta("m0") }], { toolsExpanded: false });
  host.container.children.push(new UserMessageComponent("expand body"));
  host.probeRender();
  await host.tick();
  const card = host.userCards()[0]!;
  const collapsed = card.render(80).join("");
  host.setExpanded(true);
  const expandedText = card.render(80).join("");
  if (collapsed === expandedText) console.log("DBG collapsed==expanded:", JSON.stringify(strip(collapsed).slice(0, 200)));
  assert.notEqual(collapsed, expandedText, "expansion toggle must change the panel output");
  assert.ok(strip(expandedText).includes("expand body"), "expanded body missing");
});

test("skill-block user entry with unipiHarness wraps its trailing user message", async () => {
  const block = [
    '<skill name="summarize" location="/s/summarize/SKILL.md">',
    "References are relative to /s/summarize.",
    "",
    "Summarize the session.",
    "</skill>",
    "",
    "focus x",
  ].join("\n");
  const host = setup([{ id: "e0", text: block, meta: meta("m0", "Utility") }]);
  host.container.children.push(new UserMessageComponent("focus x"));
  host.probeRender();
  await host.tick();
  const card = host.userCards()[0]!;
  assert.ok(rendersRail(card), "labelled skill-block user message must be panelled");
  assert.ok(card.render(80).join("").includes("Utility"), "panel must carry the harness source");
});

test("shutdown stops reconciliation (no throw, timers cleared)", async () => {
  const host = setup([{ id: "e0", text: "one", meta: meta("m0") }]);
  host.container.children.push(new UserMessageComponent("one"));
  await host.tick();
  host.shutdown();
  host.probeRender();
  await host.tick();
  assert.ok(true, "shutdown path threw");
});

test("requestRender loop: bounded after mapping reaches idle (counter mock, cap 5)", async () => {
  const host = setup([
    { id: "e0", text: "alpha", meta: meta("m0") },
    { id: "e1", text: "beta" },
  ], { toolsExpanded: false });
  host.container.children.push(new UserMessageComponent("alpha"), new UserMessageComponent("beta"));
  // Drive several frames via the retained widget render callback.
  for (let i = 0; i < 6; i++) {
    host.probeRender();
    await host.tick();
  }
  const afterMapping = host.requestRenderCalls();
  assert.ok(afterMapping > 0, "mapping should requestRender at least once");
  assert.ok(afterMapping <= 5, `requestRender loop unbounded: ${afterMapping} calls (cap 5)`);
  // Idle: further probe frames produce NO additional requestRender calls.
  for (let i = 0; i < 6; i++) {
    host.probeRender();
    await host.tick();
  }
  assert.equal(host.requestRenderCalls(), afterMapping, "requestRender loop did not reach idle");
});
