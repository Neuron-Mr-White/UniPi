/**
 * @pi-unipi/utility — harness provenance rendering (UNI-53): panel geometry,
 * known custom-type renderers, tool-annotation wrapper, native USER card patch.
 */
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
// Initialize pi's dark theme (UserMessageComponent reads the global instance;
// production always has it initialized — tests must mirror that).
const __pi = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const __themeMod = (await import(pathToFileURL(join(dirname(__pi), "modes/interactive/theme/theme.js")).href)) as {
  getThemeByName(name: string): object | undefined;
  setThemeInstance(t: object): void;
};
const __dark = __themeMod.getThemeByName("dark");
if (__dark) __themeMod.setThemeInstance(__dark);
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Production module must not touch the global theme (no dynamic theme import,
 * no setThemeInstance) — asserted on the source to keep the guarantee structural. */
function harnessSource(): string {
  return readFileSync(new URL("../src/render/harness.ts", import.meta.url), "utf8");
}
import { readFileSync } from "node:fs";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { harnessMetadata, harnessToolResultDetails } from "@pi-unipi/core";
import {
  HarnessPanel,
  installHarnessRenderers,
  installHarnessUserRendering,
  KNOWN_CUSTOM_TYPES,
  withHarnessToolAnnotations,
} from "../src/render/harness.ts";

const EXPANDED = () => true;
const THEME = { getColorMode: (): "truecolor" | "256color" => "truecolor", getMarkdownTheme: () => undefined, appearance: "dark" };
const THEME_256 = { getColorMode: (): "truecolor" | "256color" => "256color", getMarkdownTheme: () => undefined, appearance: "dark" };

function panelText(panel: HarnessPanel, width: number): string {
  return panel.render(width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).join("\n");
}

/** Module-level strip for tests below; some tests shadow it locally. */
const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

function fakePi() {
  const handlers: Record<string, Array<(event?: unknown, ctx?: unknown) => unknown>> = {};
  const renderers: Record<string, unknown> = {};
  let widgetRender: ((t: unknown, th: unknown) => unknown) | undefined;
  const pi = {
    on(name: string, fn: (event?: unknown, ctx?: unknown) => unknown) {
      (handlers[name] ??= []).push(fn);
      return pi;
    },
    registerMessageRenderer(customType: string, renderer: unknown) {
      renderers[customType] = renderer;
      return pi;
    },
  };
  return {
    pi: pi as unknown as Parameters<typeof installHarnessRenderers>[0],
    handlers,
    renderers,
    dispatch(name: string, event?: unknown, ctx?: unknown) {
      return (handlers[name] ?? []).map((fn) => fn(event, ctx));
    },
    widgetRender: () => widgetRender,
    setWidgetRender: (fn: (t: unknown, th: unknown) => unknown) => {
      widgetRender = fn;
    },
  };
}

describe("HarnessPanel", () => {
  const meta = harnessMetadata({ source: "Progress guard", title: "No-progress guard", synopsis: "Repeated work detected", severity: "warning" }, "steer");
  const content = "No-progress guard: the same action repeated. 宽度压力测试 CJK 行 AND UNI_HARNESS_PREVIEW_WIDTH_STRESS_IDENTIFIER_0123456789 tail-END";

  it("warning panels: glyph in the header label only; rail stays violet ▏ on every row", () => {
    const f = { source: "Progress guard", title: "No-progress guard", synopsis: "Repeated work detected" };
    const m = harnessMetadata({ source: f.source, title: f.title, synopsis: f.synopsis, severity: "warning" }, "steer");
    const rows = new HarnessPanel("guidance text", m, { expanded: false, style: "simple" }, THEME).render(60);
    const plain = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(plain[0]!.includes("⚠ UniPi"), "warning glyph missing from header");
    for (const l of plain) assert.ok(l.startsWith("▏ "), `rail must stay violet ▏ on warning rows: ${JSON.stringify(l.slice(0, 24))}`);
  });

  it("renders one rail row on the dark fill, within width, all styles/widths/expand states", () => {
    for (const style of ["simple", "regular", "advanced"] as const) {
      for (const width of [24, 40, 80, 120]) {
        for (const expanded of [true, false]) {
          const panel = new HarnessPanel(content, meta, { expanded, style }, THEME);
          const rows = panel.render(width);
          assert.ok(rows.length > 0);
          for (const row of rows) {
            const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
            assert.ok(plain.startsWith("▏ "), `row missing violet rail @${width}: ${JSON.stringify(plain.slice(0, 30))}`);
            assert.ok(visibleWidth(row) <= width, `row over width @${width}`);
            assert.ok(row.includes("\x1b[48;2;32;34;45m") || row.includes("\x1b[48;5;235m"), "row missing fill");
          }
        }
      }
    }
  });

  it("expanded rendering preserves every content word incl. CJK and the long identifier", () => {
    const squashed = (lines: string[]) => lines.map(strip).join("").replace(/[▏⚠]/g, "").replace(/\s+/g, "");
const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    for (const style of ["simple", "regular", "advanced"] as const) {
      for (const width of [24, 40, 80, 120]) {
        const text = squashed(new HarnessPanel(content, meta, { expanded: true, style }, THEME).render(width));
        for (const token of ["No-progress", "guard:", "宽度压力测试", "UNI_HARNESS_PREVIEW_WIDTH_STRESS_IDENTIFIER_0123456789", "tail-END"]) {
          assert.ok(text.includes(token.replace(/\s+/g, "")), `${style} w=${width} lost ${token}`);
        }
      }
    }
  });

  it("simple collapsed shows the label line only — no synopsis, no hint, no body", () => {
    const rows = new HarnessPanel(content, meta, { expanded: false, style: "simple" }, THEME).render(80).map(strip);
    assert.equal(rows.length, 1, `simple warning collapses to ONE row, got ${rows.length}: ${JSON.stringify(rows)}`);
    assert.ok(rows[0]!.includes("No-progress guard"), "label missing");
    assert.ok(!rows.join("").includes("Ctrl+O"), "simple warning must not show the hint");
    assert.ok(!rows.join("").includes("Repeated work"), "simple warning must not show the synopsis");
    const expanded = panelText(new HarnessPanel(content, meta, { expanded: true, style: "simple" }, THEME), 80);
    assert.ok(expanded.includes("tail-END"), "expanded simple must inline the body");
    assert.ok(expanded.includes("Repeated work detected"), "expanded simple keeps the synopsis");
  });

  it("regular/advanced warnings collapse to label + synopsis + Ctrl+O hint; expanded adds the body", () => {
    for (const style of ["regular", "advanced"] as const) {
      const rows = new HarnessPanel(content, meta, { expanded: false, style }, THEME).render(80).map(strip);
      assert.equal(rows.length, 3, `${style}: label + synopsis + hint, got ${JSON.stringify(rows)}`);
      assert.ok(rows[1]!.includes("Repeated work detected"), `${style}: synopsis missing`);
      assert.ok(rows[2]!.includes("Ctrl+O: full message"), `${style}: hint missing`);
      assert.ok(!rows.join("").includes("tail-END"), `${style}: collapsed must not inline the body`);
      const expanded = panelText(new HarnessPanel(content, meta, { expanded: true, style }, THEME), 80);
      assert.ok(expanded.includes("tail-END"), `${style}: body missing when expanded`);
      assert.ok(!expanded.includes("Ctrl+O"), `${style}: expanded must drop the hint`);
    }
  });

  it("color mode follows the passed theme (256 vs truecolor) and cache keys per theme", () => {
    const text256 = new HarnessPanel(content256(), meta256(), { expanded: true, style: "simple" }, THEME_256).render(80).join("");
    assert.ok(text256.includes("\x1b[38;5;139m"), "256 violet missing");
    assert.ok(!text256.includes("\x1b[38;2;167;139;250m"), "truecolor leaked in 256 mode");
    const textTC = new HarnessPanel(content256(), meta256(), { expanded: true, style: "simple" }, THEME).render(80).join("");
    assert.ok(textTC.includes("\x1b[38;2;167;139;250m"), "truecolor violet missing");
  });
  function content256(): string { return "mode body"; }
  function meta256() { return harnessMetadata({ source: "T", title: "T" }, "direct"); }

  it("advanced footer names the user role and delivery (non-warning panels only)", () => {
    const plainMeta = harnessMetadata({ source: "Goal", title: "Kickoff" }, "steer");
    const text = panelText(new HarnessPanel(content, plainMeta, { expanded: false, style: "advanced" }, THEME), 80);
    assert.ok(text.includes("model role: user"), "footer missing");
    assert.ok(text.includes("delivery: steer"), "delivery missing");
    assert.ok(!/model role:\s*system/i.test(text));
    // Warnings use the guard shape instead: no origin footer at all.
    const warned = panelText(new HarnessPanel(content, meta, { expanded: false, style: "advanced" }, THEME), 80);
    assert.ok(!warned.includes("model role:"), "warning panel must not show the origin footer");
  });
});

describe("meta.lines (skill reveal rows)", () => {
  const longDescription = `kanboard — Board integration for tasks ${"x".repeat(200)}`;
  const revealMeta = harnessMetadata(
    {
      source: "Skills",
      title: "Skill reveal",
      synopsis: "show-me, kanboard",
      lines: ["show-me — Help the user understand the changes quickly", longDescription],
    },
    "direct",
  );
  const body = "Relevant skills for this request (not in your skills list):\n- show-me — Help\n- kanboard — Board";
  const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");

  it("advanced collapsed: label, one row per line, Ctrl+O row, no origin row, all within width", () => {
    const rows = new HarnessPanel(body, revealMeta, { expanded: false, style: "advanced" }, THEME).render(80);
    const plain = rows.map(strip);
    assert.equal(plain.length, 4, `expected label + 2 lines + Ctrl+O, got ${plain.length}: ${JSON.stringify(plain)}`);
    assert.ok(plain[0]!.includes("UniPi · Skills · Skill reveal"), "label missing");
    assert.equal(plain.filter((l) => l.includes("show-me —")).length, 1, "show-me row missing");
    assert.equal(plain.filter((l) => l.includes("kanboard —")).length, 1, "kanboard row missing");
    assert.ok(plain[3]!.includes("Ctrl+O: full message"), "Ctrl+O hint missing");
    assert.ok(plain.every((l) => !l.includes("origin:")), "origin row must be skipped for lines metas");
    for (const row of rows) assert.ok(visibleWidth(row) <= 80, `row over width: ${visibleWidth(row)}`);
  });

  it("advanced expanded: item rows plus the full body, no Ctrl+O hint", () => {
    const text = panelText(new HarnessPanel(body, revealMeta, { expanded: true, style: "advanced" }, THEME), 80);
    assert.ok(text.includes("show-me —"), "item row lost when expanded");
    assert.ok(text.includes("kanboard — Board"), "full body lost when expanded");
    assert.ok(!text.includes("Ctrl+O: full message"), "expanded must drop the hint");
    assert.ok(!text.includes("origin:"), "origin row must stay skipped when expanded");
  });

  it("advanced without lines is unchanged (origin footer, body preview)", () => {
    const m = harnessMetadata({ source: "T", title: "T" }, "direct");
    const text = panelText(new HarnessPanel(body, m, { expanded: false, style: "advanced" }, THEME), 80);
    assert.ok(text.includes("origin: harness"), "origin footer missing");
    assert.ok(!text.includes("Ctrl+O: full message"), "plain advanced must keep its own collapsed shape");
  });

  it("simple shows the synopsis (the joined names) and the hint", () => {
    const text = panelText(new HarnessPanel(body, revealMeta, { expanded: false, style: "simple" }, THEME), 80);
    assert.ok(text.includes("show-me, kanboard"), "synopsis with names missing");
    assert.ok(text.includes("Ctrl+O: full message"), "hint missing");
  });
});

describe("known custom-type renderers", () => {
  it("registers all KNOWN_CUSTOM_TYPES and uses details.unipiHarness when present", () => {
    const h = fakePi();
    installHarnessRenderers(h.pi);
    for (const customType of Object.keys(KNOWN_CUSTOM_TYPES)) {
      assert.ok(h.renderers[customType], `renderer missing for ${customType}`);
    }
    const meta = harnessMetadata({ source: "Goal", title: "Kickoff", synopsis: "New goal" }, "boundary");
    const render = h.renderers["unipi:lh-continue"] as (m: unknown, o: unknown) => unknown;
    const component = render({ content: "goal body", details: { unipiHarness: meta } }, { expanded: true }) as HarnessPanel;
    const text = panelText(component as HarnessPanel, 80);
    assert.ok(text.includes("Goal"), "details meta source missing");
    assert.ok(text.includes("goal body"), "body lost");
  });

  it("fallback deliveries are faithful to the actual transport", () => {
    assert.equal(KNOWN_CUSTOM_TYPES["unipi-response"].delivery, "followUp");
    assert.equal(KNOWN_CUSTOM_TYPES["compactor-recall"].delivery, "direct");
    assert.equal(KNOWN_CUSTOM_TYPES["unipi:plan-mode-message"].delivery, "direct");
    assert.equal(KNOWN_CUSTOM_TYPES["unipi-memory-recall-reminder"].delivery, "before_agent_start");
    assert.equal(KNOWN_CUSTOM_TYPES["unipi:lh-continue"].delivery, "boundary");
  });

  it("fallback meta ids are stable (no fresh ids per paint)", () => {
    const h = fakePi();
    installHarnessRenderers(h.pi);
    const render = h.renderers["unipi-watchdog"] as (m: unknown, o: unknown) => HarnessPanel;
    const a = render({ content: "w" }, { expanded: false }) as HarnessPanel;
    const b = render({ content: "w" }, { expanded: false }) as HarnessPanel;
    const at = panelText(a, 80);
    assert.equal(at, panelText(b, 80), "fallback meta must be stable per customType");
    assert.ok(!at.includes("hm-fallback"), "internal id leaked (collapsed simple shows no details)");
  });

  it("falls back to the generic type meta when details are absent (no text detection)", () => {
    const h = fakePi();
    installHarnessRenderers(h.pi);
    const render = h.renderers["unipi-watchdog"] as (m: unknown, o: unknown) => unknown;
    const component = render({ content: "drained warnings" }, { expanded: true }) as HarnessPanel;
    const text = panelText(component as HarnessPanel, 80);
    assert.ok(text.includes("Watchdog"), "fallback source missing");
  });
});

describe("withHarnessToolAnnotations", () => {
  it("appends a provenance header to renderResult and width-aware rows to simpleResult", () => {
    const meta = harnessMetadata({ source: "Kanboard", title: "R1 progress reminder", synopsis: "UNI-12 still Todo", severity: "warning" }, "boundary");
    const def: { name?: string; renderResult?: () => unknown; simpleResult?: () => unknown } = {
      name: "bash",
      renderResult: () => ["│ tool output", "│ …annotation text shown once…"],
      simpleResult: () => ["▸ bash · ok"],
    };
    const wrapped = withHarnessToolAnnotations(def as never);
    const result = { content: [], details: { unipiHarnessAnnotations: [{ meta, text: "annotation text" }] } };
    const out = wrapped.renderResult!(result, { expanded: false }, {}, undefined) as unknown;
    const tail = (out as { render(w: number): string[] }).render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    const header = tail.slice(-3); // label + synopsis + hint
    assert.ok(header[0]!.includes("UniPi · Kanboard · R1 progress reminder"), "label missing");
    assert.ok(header[1]!.includes("UNI-12 still Todo"), "synopsis missing");
    assert.ok(header[2]!.includes("Ctrl+O: full message"), "collapsed hint missing");
    for (const row of header) assert.ok(row.startsWith("▏ "), `warning header rows must carry the rail: ${JSON.stringify(row.slice(0, 30))}`);
    assert.ok(!header.join("\n").includes("annotation text"), "header duplicated the annotation body");
    // expanded renderResult drops the hint (the guidance text itself follows)
    const expandedOut = wrapped.renderResult!(result, { expanded: true }, {}, undefined) as { render(w: number): string[] };
    const expandedHeader = expandedOut.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).slice(-2);
    assert.ok(!expandedHeader.join("\n").includes("Ctrl+O"), "expanded must drop the hint");
    assert.ok(expandedHeader[1]!.includes("UNI-12 still Todo"), "expanded synopsis missing");
    const simple = wrapped.simpleResult!(result, {}, undefined) as { render(w: number): string[] };
    assert.ok(typeof simple === "object" && typeof simple.render === "function", "simple annotation rows must be width-aware");
    const simpleRows = simple.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(simpleRows.filter((l) => l.includes("R1 progress reminder")).length, 1, "simple warning annotation must be ONE label row");
    assert.ok(simpleRows.at(-1)!.startsWith("▏ "), "simple warning row must carry the rail");
    assert.ok(!simpleRows.join("").includes("UNI-12 still Todo"), "simple mode must not show the synopsis");
  });

  it(" Component simpleResult hooks (memory searchCard) survive the wrapper", () => {
    const componentBase = { render: (w: number) => [`memory card @${w}`], invalidate() {} };
    const def = { simpleResult: () => componentBase };
    const wrapped = withHarnessToolAnnotations(def as never);
    const simple = wrapped.simpleResult!({ details: {} }, {}, undefined) as { render(w: number): string[] };
    assert.equal(simple, componentBase, "unrelated simpleResult must return the EXACT original value");
    assert.ok(simple.render(80).join("").includes("memory card"));
  });

  it("leaves results without annotations untouched (exact original return)", () => {
    const def = { name: "read", renderResult: () => ["out"], simpleResult: () => ["s"] };
    const wrapped = withHarnessToolAnnotations(def as never);
    const result = { content: [], details: { diff: "kept" } };
    assert.deepEqual(wrapped.renderResult!(result, { expanded: false }, {}, undefined), ["out"]);
    assert.deepEqual(wrapped.simpleResult!(result, {}, undefined), ["s"]);
    assert.deepEqual(result.details, { diff: "kept" }, "existing details must be preserved");
  });
});

describe("native USER card patch", () => {
  function harness(id: string, source: string) {
    return harnessMetadata({ source, title: "Harness title" }, "direct");
  }

  function setup(entries: Array<{ text: string; meta?: ReturnType<typeof harness> }>) {
    const h = fakePi();
    // transcript container the finder accepts (one assistant-ish marker child)
    const container = { children: [] as unknown[] };
    container.children.push({ contentContainer: {}, hasToolCalls: false, updateContent: () => {} });
    const tui = { children: [container] };
    installHarnessUserRendering(h.pi);
    h.setWidgetRender((t) => t);
    h.dispatch("session_start", {}, {
      hasUI: true,
      cwd: "/tmp",
      sessionManager: {
        buildContextEntries: () =>
          entries.map((e, i) => ({
            type: "message",
            id: `e${i}`,
            message: { role: "user", content: [{ type: "text", text: e.text }], ...(e.meta ? { unipiHarness: e.meta } : {}) },
          })),
      },
      ui: { getToolsExpanded: () => true, setWidget: (name: string, render: (t: unknown, th: unknown) => unknown) => h.setWidgetRender(render) },
    });
    // acquire the tui through the probe widget render callback
    h.widgetRender()?.(tui, {});
    return { h, container };
  }

  async function reconcile(h: ReturnType<typeof setup>["h"]): Promise<void> {
    // ctx omitted: captureCtx must keep the good session context from setup
    h.dispatch("message_end", { message: { role: "user", content: [{ type: "text", text: "x" }] } });
    await new Promise((r) => setTimeout(r, 20));
  }

  it("harness card renders the panel; human card stays native; identical texts separate by ordinal", async () => {
    const metaA = harness("1", "Progress guard");
    const { h, container } = setup([
      { text: "same words", meta: metaA },
      { text: "same words" },
    ]);
    const harnessCard = new UserMessageComponent("same words");
    const humanCard = new UserMessageComponent("same words");
    container.children.push(harnessCard, humanCard);
    await reconcile(h);
    const harnessRows = harnessCard.render(80).join("\n");
    const humanRows = humanCard.render(80).join("\n");
    assert.ok(harnessRows.includes("▏") && harnessRows.includes("Progress guard"), "harness card not panelled");
    assert.ok(!humanRows.includes("▏"), "human card must stay native");
    assert.ok(humanRows.includes("same words"), "human text lost");
  });

  it("entries without metadata leave native cards untouched", async () => {
    const { h, container } = setup([{ text: "plain human text" }]);
    const card = new UserMessageComponent("plain human text");
    container.children.push(card);
    await reconcile(h);
    assert.ok(!card.render(80).join("\n").includes("▏"));
  });

  it("mismatch (extra component) fails closed and unpatches", async () => {
    const metaA = harness("1", "Goal");
    const { h, container } = setup([
      { text: "one", meta: metaA },
      { text: "two" },
      { text: "three" }, // expected list longer than component list below
    ]);
    const a = new UserMessageComponent("one");
    container.children.push(a);
    await reconcile(h);
    assert.ok(!a.render(80).join("\n").includes("▏"), "mismatch must fail closed to native");
  });
});

/** UNI-53 final corrections — REAL ToolExecutionComponent + simpleWrapTool +
 * builtin factories + memory-search rail integration. */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { simpleWrapTool } from "../src/render/simple.js";

function realUi(): unknown {
  return { requestRender() {}, setWidget() {} };
}

it("real ToolExecutionComponent: annotated bash shows original text once + provenance header at width 40", () => {
  const meta = harnessMetadata({ source: "Fusion", title: "Delegate shell work", synopsis: "Non-trivial shell work", severity: "warning" }, "boundary");
  const raw = createBashToolDefinition("/tmp", {});
  const originalExecute = raw.execute;
  const originalSchema = raw.parameters;
  const wrapped = withHarnessToolAnnotations(raw as never) as typeof raw;
  assert.equal(wrapped.execute, originalExecute, "execute reference changed");
  assert.deepEqual(wrapped.parameters, originalSchema, "schema changed");
  const component = new ToolExecutionComponent(
    "bash",
    "call-1",
    { command: "npm test" },
    undefined,
    wrapped as never,
    realUi() as never,
    "/tmp",
  );
  component.setExpanded(true);
  component.updateResult(
    {
      content: [{ type: "text", text: "npm test output (fixture)" }],
      details: { unipiHarnessAnnotations: [{ meta, text: "npm test output (fixture)" }] },
      isError: false,
    },
    false,
  );
  const rows = (component as unknown as { render(w: number): string[] }).render(40).map((l: string) => stripAnsiLocal(l));
  const joined = rows.join("\n");
  for (const row of (component as unknown as { render(w: number): string[] }).render(40)) {
    assert.ok(visibleWidthLocal(row) <= 40, "row over width 40");
  }
  assert.ok(joined.includes("UniPi"), "provenance header missing");
  assert.ok(joined.includes("Non-trivial shell work"), "synopsis missing (header truncated at actual width by design)");
  const bodyCount = rows.filter((l) => l.includes("npm test output (fixture)")).length;
  assert.equal(bodyCount, 1, `original body must render exactly once (got ${bodyCount})`);
  assert.ok(joined.includes("npm test output"), "original output lost");
});
function visibleWidthLocal(l: string): number {
  return l.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function stripAnsiLocal(l: string): string {
  return l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

it("simpleWrapTool + memory-search def: full six-hit rail preserved; optional annotation appends", () => {
  const hits = ["hit-one", "hit-two", "hit-three", "hit-four", "hit-five", "hit-six"];
  const searchCard = (details: { hits: string[] }, w: number) => details.hits.map((h) => `▐ ${h}`);
  const memorySearchDef = {
    name: "memory_search",
    label: "Memory search",
    description: "Search memories",
    parameters: { type: "object", properties: { query: { type: "string" } } } as never,
    execute: () => ({ content: [], details: { hits }, isError: false }),
    renderShell: "self" as const,
    renderCall: () => ({ render: () => ["searching…"] }),
    renderResult: (result: any, options: any) => ({ render: (w: number) => searchCard(result.details, w) }),
    simpleResult: (result: any, _theme: unknown, _ctx?: unknown) => searchCard(result.details, 200),
  };
  const wrapped = simpleWrapTool(memorySearchDef as never) as unknown as {
    execute: (id: string, p: unknown, s: AbortSignal, u: unknown, c: unknown) => unknown;
    parameters: unknown;
    simpleResult?: (result: any, theme: unknown, ctx?: unknown) => unknown;
    renderResult?: (result: any, options: { expanded?: boolean }, theme: unknown, ctx?: unknown) => unknown;
  };
  assert.equal(wrapped.parameters, memorySearchDef.parameters, "schema reference changed");
  const result = { content: [], details: { hits, ...( {} as object) }, isError: false };
  const simple = wrapped.simpleResult?.(result, {}, undefined);
  const simpleRows = typeof simple === "object" && simple !== null && "render" in (simple as object)
    ? (simple as { render(w: number): string[] }).render(40)
    : (simple as string[]);
  const plain = simpleRows.map(stripAnsiLocal).join("\n");
  for (const hit of hits) assert.ok(plain.includes(hit), `rail hit lost: ${hit}`);
  assert.ok(plain.split("hit-one").length - 1 >= 1, "first hit missing");
  assert.equal(simpleRows.filter((l: string) => l.includes("hit-six")).length, 1, "last hit duplicated/lost");
});

it("unannotated builtins: ctx forwarded EXACTLY; value returned verbatim", () => {
  const seen: unknown[] = [];
  const synthetic = {
    name: "read",
    renderResult: (r: unknown, o: unknown, t: unknown, c: unknown) => {
      seen.push(c);
      return "out";
    },
  };
  const wrapped = withHarnessToolAnnotations(synthetic as never) as unknown as {
    renderResult: (r: unknown, o: unknown, t: unknown, c?: unknown) => unknown;
  };
  const result = { content: [{ type: "text", text: "file body" }], isError: false };
  const ctxStub = { lastComponent: { render: (w: number) => [] } };
  const out = wrapped.renderResult(result, { expanded: false }, {}, ctxStub);
  assert.equal(seen.at(-1), ctxStub, "ctx not forwarded exactly");
  assert.equal(out, "out", "annotation-free render must return the original value verbatim");
  // real builtin (read) def accepts the wrapper without breaking its shape
  const raw = createReadToolDefinition("/tmp", {});
  const originalRender = raw.renderResult;
  const wrappedReal = withHarnessToolAnnotations(raw as never) as typeof raw;
  assert.equal(typeof wrappedReal.renderResult, typeof originalRender);
  assert.equal(wrappedReal.name, raw.name);
});

it("simpleWrapTool double-wrap preserves identity and renders annotation exactly once in collapsed and expanded", () => {
  const def = {
    name: "bash",
    label: "Bash",
    description: "Run commands",
    parameters: { type: "object", properties: { command: { type: "string" } } } as never,
    execute: () => ({ content: [{ type: "text", text: "echo hi" }], details: {}, isError: false }),
    renderShell: "self" as const,
    renderCall: () => ({ render: () => ["running bash…"] }),
    renderResult: (result: any, _options: any) => ({
      render: () => [(result.content?.[0] as { text?: string })?.text ?? "bash output"],
    }),
    simpleResult: (result: any, _theme: unknown, _ctx?: unknown) => [
      (result.content?.[0] as { text?: string })?.text ?? "bash output",
    ],
  };

  const wrapped = simpleWrapTool(def as never);
  const rewrapped = withHarnessToolAnnotations(wrapped as never);
  assert.equal(rewrapped, wrapped, "double-wrap must return same object identity");

  const details = harnessToolResultDetails(
    undefined,
    { source: "Fusion", title: "Delegate shell work", synopsis: "Non-trivial shell work since last handoff", severity: "warning" },
    "boundary",
    "text",
  );
  const result = {
    content: [{ type: "text", text: "npm test output" }],
    details,
    isError: false,
  };

  // Collapsed rendering (expanded: false, isPartial: false)
  const collapsed = rewrapped.renderResult!(result, { expanded: false, isPartial: false } as never, {} as never, { toolCallId: "call-1" } as never);
  assert.ok(collapsed !== undefined && typeof (collapsed as { render?: unknown }).render === "function");
  const collapsedRows = (collapsed as { render: (w: number) => string[] }).render(120).map(stripAnsiLocal);
  const collapsedJoined = collapsedRows.join("\n");
  const collapsedMatches = collapsedJoined.match(/UniPi · Fusion/g) ?? [];
  assert.equal(collapsedMatches.length, 1, `collapsed must contain 'UniPi · Fusion' exactly once (got ${collapsedMatches.length})\n${collapsedJoined}`);

  // Expanded rendering (expanded: true, isPartial: false)
  const expanded = rewrapped.renderResult!(result, { expanded: true, isPartial: false } as never, {} as never, { toolCallId: "call-1" } as never);
  assert.ok(expanded !== undefined && typeof (expanded as { render?: unknown }).render === "function");
  const expandedRows = (expanded as { render: (w: number) => string[] }).render(120).map(stripAnsiLocal);
  const expandedJoined = expandedRows.join("\n");
  const expandedMatches = expandedJoined.match(/UniPi · Fusion/g) ?? [];
  assert.equal(expandedMatches.length, 1, `expanded must contain 'UniPi · Fusion' exactly once (got ${expandedMatches.length})\n${expandedJoined}`);
});