/**
 * UNI-258: progress chart mode — shared mermaid source (parity with the app),
 * colour flattening for resvg, real PNG rendering (samples → /tmp/qa-258/),
 * the Kitty escape in the overlay frame, throttling, and text fallback.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LhProgressEvent, LhProgressRun } from "@pi-unipi/core";
import { hasProgressChart, mermaidText, nodeId, progressMermaid } from "../progress-mermaid.js";
import {
  chartCellSize,
  chartImageLines,
  chartSupported,
  adaptForBeautifulMermaid,
  flattenSvgColors,
  getChartRenderer,
  LiveChart,
  resolveCssColor,
  setChartRendererFactoryForTests,
  CHART_THROTTLE_MS,
} from "../progress-chart.js";
import { frameWidthOk, progressViewHeight, renderProgressView } from "../progress-view.js";
import { createChartState } from "../visualize.js";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const QA = "/tmp/qa-258";

function graphRun(statuses: Record<string, LhProgressRun["items"][number]["status"]> = {}): LhProgressRun {
  const items = [
    { id: "scan", label: "Scan the repo for TODOs", deps: [], wave: 0 },
    { id: "deps", label: "List outdated dependencies", deps: [], wave: 0 },
    { id: "tests", label: "Run the test suite", deps: [], wave: 0 },
    { id: "merge", label: "Merge findings into a report", deps: ["scan", "deps"], wave: 1 },
    { id: "plan", label: "Draft the fix plan", deps: ["merge", "tests"], wave: 2 },
  ].map((i) => ({ ...i, status: statuses[i.id] ?? ("queued" as const) }));
  const done = items.filter((i) => i.status === "done").length;
  const running = items.filter((i) => i.status === "running").length;
  const failed = items.filter((i) => i.status === "failed").length;
  return { mode: "graph", title: "Repo health", status: "running", items, counts: { total: items.length, done, running, failed, queued: items.length - done - running - failed } };
}

function swarmRun(): LhProgressRun {
  const st = ["done", "done", "running", "failed", "queued", "aborted", "ready"] as const;
  const items = st.map((s, i) => ({ id: `w${i + 1}`, label: `Translate chapter ${i + 1}`, deps: [], status: s }));
  return { mode: "swarm", title: "Translate the book", status: "running", items, counts: { total: 7, done: 2, running: 1, failed: 1, queued: 3 } };
}

const event = (run: LhProgressRun): LhProgressEvent => ({ v: 1, mode: run.mode, current: run, log: [{ at: 1000, text: "scan done", item: "scan", status: "done" }], updatedAt: 1000 });

// ── shared generator: byte-for-byte what the app's progressMermaid emits ──

test("mermaid source matches the app's builder (graph)", () => {
  const src = progressMermaid(graphRun({ scan: "done", deps: "running" }));
  const lines = src.split("\n");
  assert.equal(lines[0], "flowchart LR");
  assert.equal(lines[1], '  subgraph wave0["Wave 1 · 1/3"]');
  assert.equal(lines[2], "    direction TB");
  assert.equal(lines[3], '    n0_scan["✓ scan<br/>Scan the repo for TODOs"]:::done');
  assert.equal(lines[4], '    n1_deps["▶ deps<br/>List outdated dependencies"]:::running');
  assert.ok(lines.includes("  style wave0 fill:#141211,stroke:#2E2825,color:#A39A90"));
  assert.ok(lines.includes("  n0_scan --> n3_merge"));
  assert.ok(lines.includes("  n3_merge --> n4_plan"));
  assert.ok(lines.includes("  classDef running fill:#3A2210,stroke:#F07818,color:#F5EFE6,stroke-width:2px"));
  assert.equal(progressMermaid(graphRun({ scan: "done", deps: "running" })), src, "deterministic");
});

test("mermaid source matches the app's builder (swarm rows of 3)", () => {
  const src = progressMermaid(swarmRun());
  assert.match(src, /^ {2}subgraph items\["Translate the book · 2\/7"\]$/m);
  assert.match(src, /^ {4}n0_w1 ~~~ n1_w2 ~~~ n2_w3$/m);
  assert.match(src, /^ {4}n3_w4 ~~~ n4_w5 ~~~ n5_w6$/m);
  assert.doesNotMatch(src, /-->/);
});

test("labels are sanitised; ids are mermaid-safe", () => {
  assert.equal(mermaidText('say "hi" <b>[x]</b> | #1;'), "say 'hi' b x /b 1");
  assert.equal(nodeId("a b/c", 3), "n3_a_b_c");
  assert.equal(mermaidText("x".repeat(60)).length, 42);
  assert.equal(hasProgressChart(graphRun()), true);
  assert.equal(hasProgressChart({ mode: "goal", items: [] }), false);
  assert.equal(hasProgressChart({ mode: "swarm", items: [] }), false);
});

test("swarm source adapted for beautiful-mermaid: direction LR, no ~~~ rows; graph untouched", () => {
  const swarm = adaptForBeautifulMermaid(progressMermaid(swarmRun()));
  assert.match(swarm, /subgraph items\[[^\n]*\n {4}direction LR\n/);
  assert.doesNotMatch(swarm, /~~~/);
  const graph = progressMermaid(graphRun());
  assert.equal(adaptForBeautifulMermaid(graph), graph);
});

// ── colour flattening ──

test("css vars and color-mix resolve to literal hex", () => {
  const vars = { "--bg": "#000000", "--fg": "#ffffff", "--_line": "var(--line, color-mix(in srgb, var(--fg) 50%, var(--bg)))" };
  assert.equal(resolveCssColor("var(--_line)", vars), "#808080");
  assert.equal(resolveCssColor("var(--missing, #123456)", vars), "#123456");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" style="--bg:#000000;--fg:#ffffff"><style>@import url(\'https://x\'); svg { --_a: color-mix(in srgb, var(--fg) 25%, var(--bg)); }</style><rect fill="var(--_a)" stroke="var(--fg)"/></svg>';
  const flat = flattenSvgColors(svg, {});
  assert.doesNotMatch(flat.replace(/<style>[\s\S]*<\/style>/, ""), /var\(|color-mix/);
  assert.match(flat, /fill="#404040"/);
  assert.match(flat, /stroke="#ffffff"/);
  assert.doesNotMatch(flat, /@import/);
  assert.match(flat, /<rect x="-10000"[^>]*fill="#000000"/, "background painted as a rect");
});

// ── real rendering (beautiful-mermaid + resvg-wasm) ──

test("renders graph + swarm charts to PNG (samples in /tmp/qa-258)", async () => {
  setChartRendererFactoryForTests(null);
  const renderer = await getChartRenderer();
  mkdirSync(QA, { recursive: true });
  const cases: Array<[string, LhProgressRun]> = [
    ["graph-start", graphRun()],
    ["graph-mid", graphRun({ scan: "done", deps: "done", tests: "running", merge: "running" })],
    ["graph-failed", graphRun({ scan: "done", deps: "failed", tests: "done", merge: "aborted" })],
    ["swarm", swarmRun()],
    ["swarm-12", { ...swarmRun(), items: Array.from({ length: 12 }, (_, i) => ({ id: `chapter-${i + 1}`, label: `Translate chapter ${i + 1} of the long book into French`, deps: [], status: (["done", "running", "queued", "failed"] as const)[i % 4] })), counts: { total: 12, done: 3, running: 3, failed: 3, queued: 3 } }],
  ];
  for (const [name, run] of cases) {
    const t0 = Date.now();
    const png = await renderer.render(progressMermaid(run));
    const ms = Date.now() - t0;
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], `${name} is a PNG`);
    assert.ok(png.length > 2000, `${name} has content`);
    assert.ok(ms < 3000, `${name} rendered in ${ms}ms`);
    writeFileSync(`${QA}/${name}.png`, png);
    writeFileSync(`${QA}/${name}.mmd`, progressMermaid(run));
  }
});

// ── overlay frame: kitty escape present, widths intact ──

test("chart lines: one Kitty sequence on line 0, blank rows reserved", () => {
  const frame = { source: "x", base64: "iVBORw0KGgo=", widthPx: 800, heightPx: 400 };
  const size = chartCellSize(frame, 80, 20);
  assert.ok(size.columns <= 80 && size.rows <= 20);
  const lines = chartImageLines(frame, size.columns, size.rows, 4242);
  assert.equal(lines.length, size.rows);
  assert.match(lines[0]!, /^\x1b_Ga=T,f=100,q=2,C=1,c=\d+,r=\d+,i=4242;iVBORw0KGgo=\x1b\\$/);
  assert.ok(lines.slice(1).every((l) => l === ""));
  assert.equal(chartSupported("kitty"), true);
  assert.equal(chartSupported("iterm2"), false);
  assert.equal(chartSupported(null), false);
});

test("view with a chart slot: image replaces the body, log + footer stay, every row exact width", () => {
  const p = event(graphRun({ scan: "done" }));
  const frame = { source: "x", base64: "iVBORw0KGgo=", widthPx: 600, heightPx: 300 };
  const slot = {
    hint: "m text",
    image: (cols: number, rows: number) => {
      const s = chartCellSize(frame, cols, rows);
      return { lines: chartImageLines(frame, s.columns, s.rows, 7), columns: s.columns };
    },
  };
  const h = progressViewHeight(p, 100, 30, true);
  assert.equal(h, 30, "chart mode takes the full height");
  const lines = renderProgressView(plain, p, 100, h, 2000, slot);
  assert.equal(lines.length, 30);
  const imgRow = lines.findIndex((l) => l.includes("\x1b_G"));
  assert.ok(imgRow > 0, "kitty sequence present");
  assert.ok(lines.every((l) => visibleWidth(l) === 100), "widths exact (escape is zero-width)");
  const text = lines.join("\n");
  assert.match(text, /scan done/, "log still shown below the chart");
  assert.match(text, /m text/);
  assert.doesNotMatch(text, /wave 1/, "text graph body not drawn under the image");
  // Without a frame the text body is drawn.
  const fallback = renderProgressView(plain, p, 100, 30, 2000, { hint: "m text · rendering chart…", image: () => undefined });
  assert.ok(frameWidthOk(fallback, 100));
  assert.doesNotMatch(fallback.join("\n"), /\x1b_G/);
});

// ── live chart: renders on change only, throttled ──

test("LiveChart renders only when the source changes, at most ~1/s", async () => {
  let renders = 0;
  setChartRendererFactoryForTests(async () => ({
    async render() {
      renders++;
      // 1x1 PNG
      return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    },
  }));
  let clock = 10_000;
  let frames = 0;
  const live = new LiveChart(() => frames++, () => clock);
  live.update(graphRun());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(renders, 1);
  assert.equal(frames, 1);
  assert.ok(live.current);
  live.update(graphRun()); // same source
  await new Promise((r) => setImmediate(r));
  assert.equal(renders, 1, "no re-render without a change");
  live.update(graphRun({ scan: "running" }));
  live.update(graphRun({ scan: "done" })); // coalesced within the throttle window
  await new Promise((r) => setImmediate(r));
  assert.equal(renders, 1, "throttled");
  clock += CHART_THROTTLE_MS;
  await new Promise((r) => setTimeout(r, CHART_THROTTLE_MS + 50));
  assert.equal(renders, 2, "one render for the coalesced changes");
  assert.match(live.frame!.source, /✓ scan/);
  live.dispose();
  setChartRendererFactoryForTests(null);
});

test("chart state: off on non-image terminals; m toggles; renderer failure falls back to text with a reason", async () => {
  const p = event(graphRun());
  const noImg = createChartState(() => {}, false);
  noImg.update(p);
  assert.equal(noImg.slot(p), undefined, "no image support → plain text view");
  noImg.dispose();

  setChartRendererFactoryForTests(async () => {
    throw new Error("beautiful-mermaid missing");
  });
  let renders = 0;
  const st = createChartState(() => renders++, true);
  st.update(p);
  await new Promise((r) => setTimeout(r, 20));
  const failed = st.slot(p)!;
  assert.equal(failed.active, false);
  assert.match(failed.hint!, /chart unavailable: beautiful-mermaid missing/);
  assert.equal(failed.image(80, 20), undefined);
  st.toggle();
  assert.equal(st.slot(p)!.hint, "m chart");
  // goal runs have no chart → no slot at all
  assert.equal(st.slot({ v: 1, mode: "goal", current: { mode: "goal", title: "g", status: "running", items: [], counts: { total: 0, done: 0, running: 0, failed: 0, queued: 0 } }, log: [], updatedAt: 0 }), undefined);
  st.dispose();
  setChartRendererFactoryForTests(null);
});

// ── the real overlay, driven end to end (fake pi + TUI, real renderer) ──

test("visualize-progress overlay: kitty terminal draws the PNG chart, m toggles to text, live update re-renders", async () => {
  const { setCapabilities, resetCapabilitiesCache } = await import("@earendil-works/pi-tui");
  const { bus, resetBusForTests, UNIPI_EVENTS } = await import("@pi-unipi/core");
  const { registerVisualizeProgress } = await import("../visualize.js");
  resetBusForTests();
  setChartRendererFactoryForTests(null);
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  try {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = { registerCommand: (_n: string, o: { handler: typeof handler }) => (handler = o.handler), on: () => {}, events: { on: () => () => {}, emit: () => {} } };
    registerVisualizeProgress(pi as never);
    bus.emit(UNIPI_EVENTS.LH_PROGRESS, event(graphRun({ scan: "done", deps: "running" })));
    let renders = 0;
    let component: { render(w: number): string[]; handleInput(d: string): void; dispose(): void } | undefined;
    const tui = { requestRender: () => renders++, terminal: { rows: 40 } };
    const ctx = { hasUI: true, ui: { custom: (factory: (...a: unknown[]) => typeof component) => { component = factory(tui, plain, {}, () => {}); return new Promise(() => {}); } } };
    await handler!("", ctx);
    assert.ok(component);
    // First frame: text body while the PNG renders.
    const first = component!.render(120);
    assert.match(first.join("\n"), /rendering chart…/);
    for (let i = 0; i < 100 && !component!.render(120).some((l) => l.includes("\x1b_G")); i++) await new Promise((r) => setTimeout(r, 30));
    const chart = component!.render(120);
    assert.ok(chart.some((l) => l.includes("\x1b_Ga=T,f=100")), `kitty PNG in the frame:\n${chart.join("\n")}`);
    assert.ok(chart.every((l) => visibleWidth(l) === 120));
    assert.match(chart.join("\n"), /m text/);
    writeFileSync(`${QA}/overlay-frame.txt`, chart.map((l) => l.replace(/\x1b_G[^\x1b]*\x1b\\/g, "<KITTY>")).join("\n"));
    // m → text view, no image.
    component!.handleInput("m");
    const text = component!.render(120);
    assert.ok(!text.some((l) => l.includes("\x1b_G")));
    assert.match(text.join("\n"), /m chart/);
    assert.match(text.join("\n"), /wave 1/);
    component!.handleInput("m");
    // A state change re-renders the chart (throttled).
    const before = renders;
    bus.emit(UNIPI_EVENTS.LH_PROGRESS, event(graphRun({ scan: "done", deps: "done", tests: "running" })));
    await new Promise((r) => setTimeout(r, CHART_THROTTLE_MS + 400));
    assert.ok(renders > before);
    const seq = component!.render(120).find((l) => l.includes("\x1b_G"))!;
    assert.notEqual(seq, chart.find((l) => l.includes("\x1b_G")), "new PNG after the state change");
    component!.dispose();
  } finally {
    resetCapabilitiesCache();
    setChartRendererFactoryForTests(null);
    resetBusForTests();
  }
});
