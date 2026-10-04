/**
 * Every page and the splash must return lines of exactly the frame width at
 * any terminal size — a single cell too wide crashes pi-tui.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CRAB, Paint } from "@pi-unipi/core";
import { infoRegistry } from "../registry.ts";
import * as core from "../core-groups.ts";
import { InfoOverlay } from "../tui/info-overlay.ts";
import { renderSplash } from "../tui/splash.ts";
import { collectSession } from "../pages/session.ts";
import { renderUsage, type UsageRaw } from "../pages/usage.ts";
import { renderCompactor, renderMemory, setCompactorHistorySource } from "../pages/modules.ts";
import type { PageContext } from "../types.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const now = Date.now();
const msg = (role: string, extra: Record<string, unknown>, i: number) => ({ type: "message", id: `e${i}`, timestamp: new Date(now - 60_000 + i * 1000).toISOString(), message: { role, ...extra } });
const branch = [
  msg("user", { content: "hi" }, 0),
  msg("assistant", { usage: { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 50, cost: { total: 0.12 } }, content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.ts" } }, { type: "toolCall", id: "t2", name: "bash", arguments: {} }] }, 1),
  msg("toolResult", { toolCallId: "t2", toolName: "bash", isError: true, content: [] }, 2),
  msg("assistant", { usage: { input: 800, output: 900, cacheRead: 12000, cacheWrite: 0, cost: { total: 0.2 } }, content: [{ type: "text", text: "done" }] }, 3),
  { type: "compaction", id: "c1", timestamp: new Date(now).toISOString(), tokensBefore: 9, summary: "" },
];
const ctx = {
  cwd: "/tmp/project-with-a-rather-long-name/and/deeper/still",
  model: { name: "a-model-with-an-extremely-long-display-name-that-must-truncate", provider: "p", contextWindow: 200_000 },
  getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
  sessionManager: { getBranch: () => branch, getLeafId: () => "c1" },
};

before(async () => {
  infoRegistry.persist = false;
  core.setSessionContext(ctx as never);
  core.setPiApi({
    getThinkingLevel: () => "high",
    getActiveTools: () => ["read", "bash"],
    getAllTools: () => Array.from({ length: 40 }, (_, i) => ({ name: `tool_number_${i}`, sourceInfo: { source: i < 7 ? "builtin" : "npm:@pi-unipi/unipi" } })),
    getCommands: () => Array.from({ length: 25 }, (_, i) => ({ name: `skill:skill-${i}`, source: "skill", sourceInfo: { path: "/x", scope: i % 3 ? "user" : "project" } })),
  } as never);
  core.trackModule("memory", "3.0.0-alpha.24");
  core.registerCoreGroups();
  await import("../../../scripts/info-preview/mock-modules.ts");
  await Promise.all(infoRegistry.getAllGroups().map((g) => infoRegistry.getGroupData(g.id)));
});

describe("session collector", () => {
  it("counts replies, tools, errors, files and compactions", () => {
    const r = collectSession(ctx as never, "high");
    assert.equal(r.replies, 2);
    assert.equal(r.prompts, 1);
    assert.equal(r.toolCalls, 2);
    assert.equal(r.toolErrors, 1);
    assert.equal(r.files, 1);
    assert.equal(r.compactions, 1);
    assert.equal(r.input, 2000);
    assert.ok(Math.abs(r.cost - 0.32) < 1e-9);
    assert.deepEqual(r.tools.find((t) => t[0] === "bash"), ["bash", 1, 1]);
  });
});

describe("scope legend", () => {
  it("footer legend reads biggest scope first: g, p, s", () => {
    const o = new InfoOverlay();
    const footer = o.render(110).map(strip).find((l) => l.includes("global"))!;
    o.destroy();
    assert.ok(footer, "footer legend missing");
    const gi = footer.indexOf("g global");
    const pi = footer.indexOf("p project");
    const si = footer.indexOf("s session");
    assert.ok(gi >= 0 && pi > gi && si > pi, `legend order wrong: ${footer.trim()}`);
  });
});

describe("inventory scope tags", () => {
  it("skills: project group tagged p, machine-wide groups tagged g", async () => {
    const raw = infoRegistry.getCachedData("skills")?.raw?.raw as { groupScopes?: Record<string, string> } | undefined;
    assert.equal(raw?.groupScopes?.project, "p");
    assert.equal(raw?.groupScopes?.user, "g");
    const o = new InfoOverlay("skills");
    const legendLine = o.render(100).map(strip).find((l) => l.includes("■"));
    o.destroy();
    assert.match(legendLine ?? "", /■ g user/);
    assert.match(legendLine ?? "", /■ p project/);
  });
  it("tools: the all-tools section header carries the session tag", () => {
    const o = new InfoOverlay("tools");
    const head = o.render(100).map(strip).find((l) => l.replace(/\s+/g, "").includes("ALLTOOLS"))!;
    o.destroy();
    assert.match(head, /T O O L S s /, `missing s tag after the title: ${head.trim()}`);
  });
});

describe("usage multi-model block", () => {
  it("puts an empty line between the share bar and the ranked models", () => {
    const raw: UsageRaw = {
      tokens: { today: 1, week: 1, month: 1, allTime: 1 },
      cost: { today: 1, week: 1, month: 1, allTime: 1 },
      costWeek: 1,
      costMonth: 1,
      sessions: 1,
      sessionsToday: 1,
      daily: [],
      models: [["claude", 5, 1000], ["gpt", 3, 800], ["gemini", 1, 200]],
    };
    const pc: PageContext = { data: { raw: { value: "", raw } }, width: 100, height: 30, paint: new Paint(), accent: CRAB.gold, loading: false, now: Date.now() };
    const lines = renderUsage(pc).map(strip);
    const bar = lines.findIndex((l) => l.includes("▆"));
    assert.ok(bar >= 0, "share bar missing");
    assert.equal(lines[bar + 1]!.trim(), "", `expected blank line after share bar, got: ${lines[bar + 1]}`);
    assert.match(lines[bar + 2]!, /●/);
  });
});

describe("scope-tiered tiles read biggest scope first", () => {
  const pcFor = (raw: unknown): PageContext => ({ data: { raw: { value: "", raw } }, width: 120, height: 30, paint: new Paint(), accent: CRAB.gold, loading: false, now: Date.now() });

  it("compactor: global < project < session in the savings tiles", () => {
    setCompactorHistorySource(() => ({
      global: { count: 99, saved: 1, avoided: 20_000_000, dollars: 20, sent: 5_000_000 },
      project: { count: 9, saved: 1, avoided: 2_000_000, dollars: 2, sent: 500_000 },
    }));
    const raw = { method: "lossless", trigger: "t", piCompact: "same", before: 1, after: 1, saved: 1, history: [], session: { count: 3, saved: 1, avoided: 12_000, dollars: 1.2, sent: 4_000 } };
    const row = renderCompactor(pcFor(raw)).map(strip).find((l) => l.includes("G L O B A L"));
    assert.ok(row, "savings tile row missing");
    const gi = row.indexOf("G L O B A L");
    const pi = row.indexOf("P R O J E C T");
    const si = row.indexOf("S E S S I O N");
    assert.ok(gi >= 0 && pi > gi && si > pi, `tile order wrong: ${row.trim()}`);
  });

  it("memory: global before project (share keeps its project / global sub)", () => {
    const raw = { project: "unipi", projectCount: 419, total: 1288, types: {}, recall: true, write: true, pending: 0, migrate: null };
    const lines = renderMemory(pcFor(raw)).map(strip);
    const row = lines.find((l) => l.includes("G L O B A L"));
    assert.ok(row, "memory tile row missing");
    assert.ok(row.indexOf("G L O B A L") < row.indexOf("P R O J E C T"), `tile order wrong: ${row.trim()}`);
    assert.ok(lines.some((l) => l.includes("project / global")), "share sub lost");
  });
});

describe("dashboard pages are width-exact", () => {
  for (const w of [44, 52, 67, 80, 101, 160]) {
    for (const rows of [20, 50]) {
      it(`every page @ ${w}×${rows}`, () => {
        for (const g of infoRegistry.getAllGroups()) {
          const o = new InfoOverlay(g.id);
          o.terminalRows = () => rows;
          const lines = o.render(w);
          o.destroy();
          for (const l of lines) assert.equal(visibleWidth(l), w, `${g.id} @${w}: ${JSON.stringify(l.replace(/\x1b\[[0-9;]*m/g, ""))}`);
          // Same height for every page (no jumping between tabs).
          assert.equal(lines.length, Math.max(8, Math.min(24, Math.floor(rows * 0.85) - 5)) + 5);
        }
      });
    }
  }
  it("tab keys move between pages and q closes", () => {
    const o = new InfoOverlay();
    let closed = false;
    o.onClose = () => {
      closed = true;
    };
    const first = o.render(90).join("");
    o.handleInput("l");
    assert.notEqual(o.render(90).join(""), first);
    o.handleInput("q");
    assert.equal(closed, true);
  });
});

describe("splash", () => {
  for (const w of [44, 50, 75, 76, 120]) {
    it(`is width-exact @ ${w}`, () => {
      for (const remaining of [1, 0.4, null]) {
        const lines = renderSplash({ width: w, unipiVersion: "3.0.0-alpha.24", piVersion: "0.87.1", readyMs: 1234, remaining, facts: core.splashFacts() });
        assert.ok(lines.length > 5);
        for (const l of lines) assert.equal(visibleWidth(l), w);
      }
    });
  }
  it("renders nothing below 44 columns", () => {
    assert.deepEqual(renderSplash({ width: 43, unipiVersion: "1", piVersion: "1" }), []);
  });
});
