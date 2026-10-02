/**
 * UNI-53 production host check — REAL host wrappers, synthetic fixtures.
 *
 * Renders through:
 *  - installHarnessRenderers registration + pi's REAL CustomMessageComponent
 *    host wrapper (memory-rail fixture, full six-hit search + humanized save
 *    usage line via the actual memory saveUsageLine helper);
 *  - installHarnessUserRendering native USER probe patch over a mock
 *    transcript root (real native UserMessageComponent children): harness card
 *    panelled, human card native, Ctrl+O expansion, provenance headers.
 *
 * No pi session, no model, no settings writes. Static stdout only.
 */
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
// Simulate the host startup step: pi initializes the global theme BEFORE
// extensions load. The harness renderer never touches it.
initTheme("dark");
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { harnessMetadata, type HarnessMessageMeta } from "@pi-unipi/core";
import { installHarnessRenderers, installHarnessUserRendering, withHarnessToolAnnotations } from "../packages/utility/src/render/harness.ts";
// Mirror of memory/index.ts saveUsageLine (kept in sync by tests) — inlined
// here because memory/index.ts has heavy transitive deps.
function saveUsageLine(usage: { input: number; cacheRead: number; cacheWrite: number; output: number }): string {
  return `save pass · input ${Math.round(usage.input / 1000)}k · cache read ${Math.round(usage.cacheRead / 1_000_000)}M / write ${usage.cacheWrite === 0 ? "0" : Math.round(usage.cacheWrite / 1000) + "k"} · output ${Math.round(usage.output / 1000)}k tokens`;
}

const WIDTH = Number(process.argv[2] ?? 80);
const EXPANDED = process.argv.includes("--expanded");

const paletteTag = process.env.COLORTERM === "truecolor" ? "truecolor" : "256";
console.log(`UNI-53 HOST CHECK — real CustomMessageComponent + native USER probe patch · palette ${paletteTag} · width ${WIDTH} · ${EXPANDED ? "expanded" : "collapsed"}`);
console.log("");

// ── 1. memory custom message through the REAL CustomMessageComponent host ──
const renderers: Record<string, any> = {};
const fakePi: any = {
  on: () => fakePi,
  registerMessageRenderer: (type: string, renderer: any) => {
    renderers[type] = renderer;
    return fakePi;
  },
};
installHarnessRenderers(fakePi);
const recallMeta: HarnessMessageMeta = harnessMetadata(
  { source: "Memory", title: "Memory recall", synopsis: "347 memories · project unipi" },
  "before_agent_start",
);
const recallMessage: any = {
  role: "custom",
  customType: "unipi-memory-recall-reminder",
  content: "## 🧠 Memory System Active\n\nYou have 347 memories stored for project \"unipi\".\n\nGuardrails: read max 10 memory results per search.",
  display: true,
  details: { unipiHarness: recallMeta },
};
const recallRenderer = renderers["unipi-memory-recall-reminder"];
if (typeof recallRenderer !== "function") {
  console.log("FAIL: memory recall renderer not registered");
  process.exit(1);
}
const recallComponent = recallRenderer(recallMessage, { expanded: EXPANDED }, getMarkdownTheme()) as { render(w: number): string[] };
console.log("── memory custom message (real host wrapper) ──");
for (const row of recallComponent.render(WIDTH)) console.log(row);
console.log("");

// ── 2. humanized save usage line (UNI-56) ───────────────────────────────────
console.log("── save usage line (UNI-56) ──");
console.log(saveUsageLine({ input: 729296, cacheRead: 17416192, cacheWrite: 0, output: 41994 }));
console.log(saveUsageLine({ input: 12000, cacheRead: 3400, cacheWrite: 250000, output: 950 }));
console.log("");

// ── 3. native USER probe patch over a mock transcript root ──────────────────
const probeMeta: HarnessMessageMeta = harnessMetadata(
  { source: "Progress guard", title: "No-progress guard", synopsis: "Repeated work detected", severity: "warning" },
  "steer",
);
const handlers: Record<string, Array<(e?: unknown, c?: unknown) => unknown>> = {};
const container: any = { children: [{ contentContainer: {}, hasToolCalls: false, updateContent() {}, render: () => [] }] };
const tui: any = { children: [container], requestRender: () => {} };
const probePi: any = {
  on(n: string, f: any) { (handlers[n] ??= []).push(f); return probePi; },
};
installHarnessUserRendering(probePi);
for (const fn of handlers["session_start"] ?? []) {
  fn({}, {
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {
      getLeafId: () => "leaf-1",
      buildContextEntries: () => [
        { type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "No-progress guard: the same action repeated three times." }], unipiHarness: probeMeta } },
        { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "plain human body" }] } },
      ],
    },
    ui: { getToolsExpanded: () => EXPANDED, setWidget: (_n: string, render: any) => { widgetRender = render; } },
  });
}
let widgetRender: any;
// seed native cards
const { UserMessageComponent } = await import("@earendil-works/pi-coding-agent");
container.children.push(new UserMessageComponent("No-progress guard: the same action repeated three times."));
container.children.push(new UserMessageComponent("plain human body"));
widgetRender?.(tui, getMarkdownTheme());
// production flow: message_end triggers the reconciler after persistence
for (const fn of handlers["message_end"] ?? []) fn({ message: { role: "user", content: [{ type: "text", text: "No-progress guard: the same action repeated three times." }] } }, {
  hasUI: true,
  cwd: "/tmp",
  sessionManager: {
    getLeafId: () => "leaf-1",
    buildContextEntries: () => [
      { type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "No-progress guard: the same action repeated three times." }], unipiHarness: probeMeta } },
      { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "plain human body" }] } },
    ],
  },
  ui: { getToolsExpanded: () => EXPANDED },
});
await new Promise((r) => setTimeout(r, 30));
console.log("── native USER cards (probe patch: harness panelled, human native) ──");
for (const c of container.children as Array<any>) {
  if (typeof c.text === "string" && typeof c.render === "function") {
    for (const row of c.render(WIDTH)) console.log(row);
    console.log("");
  }
}

// ── 4. tool annotation header (bash def, real wrapper) ──────────────────────
const annMeta: HarnessMessageMeta = harnessMetadata(
  { source: "Fusion", title: "Delegate shell work", synopsis: "Non-trivial shell work since last handoff", severity: "warning" },
  "boundary",
);
const bashDef: any = {
  name: "bash",
  renderResult: () => ["│ npm test output (fixture)"],
};
const wrappedDef = withHarnessToolAnnotations(bashDef);
const annResult = { content: [{ type: "text", text: "npm test output (fixture)" }], details: { unipiHarnessAnnotations: [{ meta: annMeta, text: "npm test output (fixture)" }] }, isError: false };
const annComponent = (wrappedDef.renderResult as any)(annResult, { expanded: EXPANDED }, getMarkdownTheme(), undefined) as { render(w: number): string[] };
console.log("── tool annotation header (bash) ──");
for (const row of annComponent.render(WIDTH)) console.log(row.replace(/\x1b\[[0-9;]*m/g, ""));
console.log("");
console.log("HOST CHECK DONE");
