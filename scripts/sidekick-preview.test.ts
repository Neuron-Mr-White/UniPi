// UNI-2 design-mockup preview: focused self-tests for scripts/sidekick-preview.ts.
// Run: npx tsx --test scripts/sidekick-preview.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  HANDOFFS,
  SCENARIOS,
  STYLES,
  STATES,
  browserLines,
  mixedLines,
  paintPanelLine,
  productionLines,
  renderState,
  stateLines,
  stripAnsi,
  stripNestedBackgrounds,
} from "./sidekick-preview.ts";

const PANEL_BG = "\x1b[48;2;18;54;59m";
const RAIL = "\x1b[38;2;34;211;238m▏ ";
const strip = (s: string) => stripAnsi(s).trimEnd();

const forEachCombo = (fn: (style: any, state: any, expanded: boolean, width: number) => void) => {
  for (const style of STYLES)
    for (const state of STATES)
      for (const expanded of [false, true])
        for (const width of [24, 80, 120]) fn(style, state, expanded, width);
};

describe("uni-2 preview rendering", () => {
  it("widths 24/80/120: every line bounded, panel rows exactly width, all styles/states/expanded", () => {
    forEachCombo((style, state, expanded, width) => {
      const r = renderState(state, style, { width, expanded });
      const lines = stateLines(r, width);
      for (const l of lines) {
        if (l === "") continue; // unpainted gap between distinct panels
        assert.ok(visibleWidth(l) <= width, `${style}/${state}/w${width}: line wider than panel: ${JSON.stringify(strip(l))}`);
        assert.ok(visibleWidth(l) === width, `${style}/${state}/w${width}: panel row not filled to width: ${JSON.stringify(strip(l))}`);
      }
    });
  });

  it("every panel row carries the same bg + cyan rail, blank interior rows included", () => {
    const r = renderState("attached", "simple", { width: 80 });
    const lines = stateLines(r, 80);
    const blanks = lines.filter((l) => strip(l) === "▏");
    assert.ok(blanks.length >= 1, "expected a rail-painted blank row before prose");
    for (const l of lines) {
      if (l === "") continue; // unpainted gap between distinct panels
      assert.ok(l.startsWith(PANEL_BG + RAIL), `row missing panel bg+rail: ${JSON.stringify(l.slice(0, 60))}`);
    }
    for (const b of blanks) assert.equal(stripAnsi(b).trimEnd(), "▏", "blank row is rail+spaces only");
  });

  it("no nested background escapes after outer painting (no 256-bg, no non-panel truecolor bg)", () => {
    forEachCombo((style, state, expanded, width) => {
      for (const l of stateLines(renderState(state, style, { width, expanded }), width)) {
        if (l === "") continue; // unpainted gap between distinct panels
        assert.ok(!/48;5;/.test(l), `256-colour bg escaped: ${JSON.stringify(l.slice(0, 80))}`);
        for (const m of l.matchAll(/48;2;(\d+);(\d+);(\d+)/g)) {
          assert.equal(`${m[1]};${m[2]};${m[3]}`, "18;54;59", `non-panel truecolor bg escaped: ${m[0]}`);
        }
        assert.ok(!/48;2;\d+;(\d+);(\d+)/.test(l.replace(/48;2;18;54;59/g, "")), "extra truecolor bg");
      }
    });
  });

  it("simple: consecutive tools use ├ then └, prose follows on a painted blank", () => {
    const lines = stateLines(renderState("attached", "simple", { width: 96 }), 96).map(strip);
    const tools = lines.filter((l) => /Ran  (pwd|git)/.test(l) || /Read /.test(l));
    assert.equal(tools.length, 4);
    assert.match(tools[0]!, /^▏ ├/);
    assert.match(tools[1]!, /^▏ ├/);
    assert.match(tools[2]!, /^▏ ├/);
    assert.match(tools[3]!, /^▏ └/);
    const proseAt = lines.findIndex((l) => l.startsWith("▏ ●"));
    assert.ok(proseAt > 0);
    assert.equal(lines[proseAt - 1]!, "▏", "painted blank between tools and prose");
  });

  it("regular: native cards render raw-args fixtures (command echo + output tail)", () => {
    const lines = stateLines(renderState("attached", "regular", { width: 96 }), 96).map(strip);
    assert.ok(lines.some((l) => l.includes("$ pwd && ls")), "native bash card echoes the command");
    assert.ok(lines.some((l) => l.includes("tsconfig.json")), "native output tail shows ls lines");
    assert.ok(lines.some((l) => l.includes("$ git status --short --branch")));
    assert.ok(lines.some((l) => l.includes("## main...origin/main")));
  });

  it("legacy state (no raw args) falls back to ◆ regular lines", () => {
    const r = renderState("legacy", "regular", { width: 96 });
    const lines = stateLines(r, 96).map(strip);
    assert.ok(r.panels.every((p) => p.fallbackUsed), "fallback reported");
    assert.ok(!lines.some((l) => l.includes("$ ")), "no native card");
    assert.ok(lines.some((l) => l.includes("◆ bash pwd && ls")), "styledToolCallLines regular fallback");
  });

  it("wake widget line exists only in the background state", () => {
    for (const state of STATES) {
      const r = renderState(state, "advanced", { width: 80 });
      if (state === "background") assert.equal(r.wake, "sidekick working · 9 tool calls · 12.0s — resumes automatically when done");
      else assert.equal(r.wake, undefined, `${state} must not show the wake widget`);
    }
    const all = stateLines(renderState("background", "advanced", { width: 80 }), 80).map(strip).join("\n");
    assert.ok(!all.includes("sidekick working"), "wake line lives outside the painted panels");
  });

  it("CJK + long lines truncate within width (expanded output)", () => {
    const lines = stateLines(renderState("attached", "advanced", { width: 80, expanded: true }), 80).map(strip);
    const cjk = lines.filter((l) => l.includes("サイドキック"));
    assert.ok(cjk.length >= 1, "CJK output line present");
    for (const l of stateLines(renderState("attached", "advanced", { width: 80, expanded: true }), 80)) {
      assert.ok(visibleWidth(l) <= 80);
    }
  });

  it("separate handoffs are distinct panels (unpainted gap between them)", () => {
    const lines = stateLines(renderState("completed", "simple", { width: 96 }), 96);
    const gaps = lines.filter((l) => l === "");
    assert.equal(gaps.length, HANDOFFS.length - 1);
  });

  it("no settings/agent-dir writes while rendering", () => {
    const scratch = mkdtempSync(join(tmpdir(), "uni2-preview-"));
    const prev = [process.env.HOME, process.env.PI_AGENT_DIR, process.env.PI_CODING_AGENT_DIR];
    process.env.HOME = scratch;
    process.env.PI_AGENT_DIR = join(scratch, ".pi", "agent");
    process.env.PI_CODING_AGENT_DIR = join(scratch, ".pi", "agent");
    try {
      forEachCombo((style, state, expanded, width) => void renderState(state, style, { width, expanded }));
      assert.deepEqual(readdirSync(scratch), [], "render must not write into HOME/agent dir");
    } finally {
      const restore = (name: string, v: string | undefined) => {
        if (v === undefined) delete process.env[name]; else process.env[name] = v;
      };
      restore("HOME", prev[0]);
      restore("PI_AGENT_DIR", prev[1]);
      restore("PI_CODING_AGENT_DIR", prev[2]);
    }
  });

  it("interactive browser frame: wake row only in the background state, bounded width", () => {
    for (const state of STATES) {
      const lines = browserLines(state, "simple", false, 80, 24);
      const flat = lines.map(strip).join("\n");
      if (state === "background") assert.match(flat, /sidekick working · 9 tool calls · 12\.0s — resumes automatically when done/, "wake row in background");
      else assert.ok(!flat.includes("sidekick working"), `${state} must not show the wake row`);
      for (const l of lines) assert.ok(visibleWidth(l) <= 80, "browser row bounded to width");
    }
  });

  it("native collapsed hint is reworded for the mockup (no empty key name)", () => {
    const lines = stateLines(renderState("attached", "regular", { width: 96 }), 96).map(strip).join("\n");
    assert.ok(!/,\s+to expand\)/.test(lines), "no blank key hint");
    assert.match(lines, /\(\d+ earlier lines; press e to expand in the browser, or --expand\)/);
  });
});

describe("uni-2 mixed scenario (lead + delegated sidekick)", () => {
  const PANEL = /\x1b\[48;2;18;54;59m/;
  const mixed = (state: any, style: any, o: object = {}) => mixedLines(state, style, { width: 96, ...o });

  it("chronology: lead rows before and after the subagent panel; delegation between", () => {
    const lines = mixed("completed", "simple").map(strip);
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const lead = at(/^■ LEAD/);
    const deleg = at(/Delegated \(Run fixture checks\)|Delegating \(Run fixture checks\)/);
    const sub = at(/^▏ .*SUBAGENT/);
    const npm = at(/Ran  npm test/);
    const summary = at(/Fixture summary/);
    assert.ok(lead >= 0 && deleg > lead && sub > deleg, "delegation after lead header, panel after delegation");
    assert.ok(npm > sub, "lead npm test after the subagent panel");
    assert.ok(summary > npm, "summary last");
  });

  it("lead rows carry no cyan rail/panel; delegated panel rows all do", () => {
    for (const style of STYLES) {
      const lines = mixed("completed", style);
      let inPanel = false;
      for (const l of lines) {
        const s = strip(l);
        if (/SUBAGENT/.test(s)) inPanel = true;
        if (/^▏/.test(s) || PANEL.test(l)) {
          assert.ok(PANEL.test(l) && /^▏/.test(strip(l)), `panel row missing rail+fill: ${JSON.stringify(s.slice(0, 50))}`);
        } else {
          assert.ok(!PANEL.test(l) && !s.startsWith("▏"), `lead row painted cyan: ${JSON.stringify(s.slice(0, 50))}`);
        }
        if (inPanel && /└ (Completed|Replayed)/.test(s)) inPanel = false;
      }
    }
  });

  it("regular style: lead native cards keep a neutral bg (#1f2430), panel stays cyan-only", () => {
    const lines = mixed("completed", "regular");
    assert.ok(lines.some((l) => l.includes("\x1b[48;2;31;36;48m")), "lead native card bg #1f2430 present");
    for (const l of lines) {
      if (PANEL.test(l)) assert.ok(!l.includes("48;2;31;36;48"), "panel row must not carry lead bg");
    }
  });

  it("both labels present; mockup disclaimer mentions cards+dock", () => {
    const flat = mixed("completed", "advanced").map(strip).join("\n");
    assert.match(flat, /LEAD/);
    assert.match(flat, /SUBAGENT/);
  });

  it("demo thinking shows by default and the toggle hides it (both agents)", () => {
    const on = mixed("completed", "simple").map(strip).join("\n");
    assert.match(on, /Demo planning text/);
    assert.match(on, /Demo sidekick plan/);
    const off = mixed("completed", "simple", { thinking: false }).map(strip).join("\n");
    assert.ok(!off.includes("Demo planning text"));
    assert.ok(!off.includes("Demo sidekick plan"));
  });

  it("summary appears only for completed/legacy; failed ends red without it", () => {
    for (const state of STATES) {
      const flat = mixed(state, "simple").map(strip).join("\n");
      if (state === "completed" || state === "legacy") assert.match(flat, /Fixture summary/, `${state} has summary`);
      else assert.ok(!flat.includes("Fixture summary"), `${state} must not show the summary`);
    }
    const failedFlat = mixed("failed", "simple", { expanded: true }).map(strip).join("\n");
    assert.match(failedFlat, /not a git repository \(fixture error\)/);
    assert.match(failedFlat, /Delegation failed|× /);
  });

  it("background: panel pending + wake line, no subagent tools yet", () => {
    const flat = mixed("background", "advanced").map(strip).join("\n");
    assert.match(flat, /Pending · queued on the child/);
    assert.ok(!flat.includes("npm test"), "lead npm test not reached while pending");
  });

  it("all scenarios/styles/states/expanded bounded at widths 24/80/120", () => {
    for (const scenario of SCENARIOS)
      for (const style of STYLES)
        for (const state of STATES)
          for (const expanded of [false, true])
            for (const width of [24, 80, 120]) {
              const lines = scenario === "mixed" ? mixedLines(state, style, { width, expanded }) : stateLines(renderState(state, style, { width, expanded }), width);
              for (const l of lines) {
                assert.ok(visibleWidth(l) <= width, `${scenario}/${style}/${state}/w${width}: ${JSON.stringify(strip(l).slice(0, 60))}`);
              }
            }
  });

  it("interactive browser renders mixed with wake row in background and scenario header", () => {
    const head = strip(browserLines("completed", "simple", false, 80, 24, 0, "mixed")[0]!);
    assert.match(head, /scenario mixed/);
    const bgFlat = browserLines("background", "simple", false, 80, 30, 0, "mixed").map(strip).join("\n");
    assert.match(bgFlat, /sidekick working · 9 tool calls/);
    const attFlat = browserLines("attached", "simple", false, 80, 30, 0, "mixed").map(strip).join("\n");
    assert.ok(!attFlat.includes("sidekick working ·"), "no wake row when attached");
  });
});

describe("uni-2 preview helpers", () => {
  it("stripNestedBackgrounds drops bg SGR but keeps extended fg intact", () => {
    assert.equal(stripNestedBackgrounds("a\x1b[48;2;90;20;20mb\x1b[49m"), "ab");
    assert.equal(stripNestedBackgrounds("a\x1b[48;5;17mb"), "ab");
    assert.equal(stripNestedBackgrounds("a\x1b[43mb\x1b[103m"), "ab");
    assert.equal(stripNestedBackgrounds("a\x1b[38;2;255;107;107mx"), "a\x1b[38;2;255;107;107mx");
    assert.equal(stripNestedBackgrounds("a\x1b[1;48;2;1;2;3;4mb"), "a\x1b[1;4mb");
    assert.equal(stripNestedBackgrounds("a\x1b[m"), "a\x1b[0m");
  });

  it("paintPanelLine reopens the fill after resets and pads to width", () => {
    const painted = paintPanelLine("hello", 20);
    assert.equal(visibleWidth(painted), 20);
    assert.ok(painted.includes(PANEL_BG));
    assert.ok(painted.split(PANEL_BG).length >= 2);
  });

  it("stripAnsi keeps OSC-8 link text", () => {
    assert.equal(stripAnsi("a\x1b]8;;file:///x\x1b\\TEXT\x1b]8;;\x1b\\b\x1b[31m!\x1b[39m"), "aTEXTb!");
  });
});

describe("uni-2 preview --production (real renderer evidence)", () => {
  const PANEL = "\x1b[48;2;18;54;59m";
  const RAIL = "\x1b[38;2;34;211;238m▏ ";
  const strip = (s: string) => stripAnsi(s).trimEnd();

  it("rows bounded at 80/24; delegated rows painted, lead rows unpainted", () => {
    for (const width of [80, 24]) {
      for (const style of STYLES) {
        const lines = productionLines(style, false, width);
        assert.ok(lines.length > 5, "transcript rendered");
        let seenPanel = false;
        for (const l of lines) {
          assert.ok(visibleWidth(l) <= width, `w${width}: ${JSON.stringify(strip(l).slice(0, 50))}`);
          const isPanel = l.includes(PANEL);
          if (isPanel) {
            seenPanel = true;
            assert.ok(l.includes(RAIL), "panel row carries rail");
            assert.match(strip(l), /^▏/, "panel row starts with rail");
          }
        }
        assert.ok(seenPanel, "delegated panel present");
      }
    }
  });

  it("lead stand-in rows carry no panel fill; panels continuous per group", () => {
    const lines = productionLines("simple", false, 96);
    const lead = lines.filter((l) => l.startsWith(`\x1b[38;2;34;211;238m■`) || strip(l).startsWith("■ LEAD"));
    assert.ok(lead.length >= 1 && lead.every((l) => !l.includes(PANEL)), "lead rows unpainted");
    const panelRows = lines.filter((l) => l.includes(PANEL));
    assert.ok(panelRows.length >= 4, "two panels' rows present");
    assert.ok(panelRows.some((l) => strip(l).includes("Sidekick")) && panelRows.some((l) => strip(l).includes("General subagent · demo")), "both labels");
  });

  it("expanded shows synthetic thinking; plain output has zero escapes", () => {
    const collapsed = productionLines("advanced", false, 96).map(strip).join("\n");
    assert.ok(!collapsed.includes("Demo sidekick thought"), "thinking hidden collapsed");
    const expanded = productionLines("advanced", true, 96).map(strip).join("\n");
    assert.match(expanded, /Demo sidekick thought/, "thinking shown expanded");
    const plain = productionLines("advanced", true, 96).map(stripAnsi).join("\n");
    assert.ok(!/\x1b\[/.test(plain), "no ANSI left after stripAnsi");
  });
});
