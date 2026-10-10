import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  groupRows,
  renderTrayDetail,
  renderTrayList,
  trayElapsed,
  trayPlural,
  trayRow,
  TrayListState,
  TrayScroll,
  type TrayRow,
} from "../pane-kit.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as never;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const row = (over: Partial<TrayRow> = {}): TrayRow => ({ id: "a", state: "completed", kind: "Shell", title: "build", tags: ["7s", "1KB", "model-x"], ...over });

describe("pane-kit", () => {
  test("durations + plurals", () => {
    assert.equal(trayElapsed(7_400), "7s");
    assert.equal(trayElapsed(169_000), "2m49s");
    assert.equal(trayElapsed(3_900_000), "1h05m");
    assert.equal(trayPlural(1, "tool"), "1 tool");
    assert.equal(trayPlural(2, "tool"), "2 tools");
  });

  test("row: selection caret, chip, kind, title, dim detail, leader, right tags; never wider than the pane", () => {
    const sel = strip(trayRow(theme, row({ detail: "npm run build" }), true, 100));
    assert.match(sel, /^❭  DONE  Shell build npm run build ·+ 7s · 1KB · model-x$/);
    assert.equal(visibleWidth(sel), 100);
    assert.match(strip(trayRow(theme, row(), false, 100)), /^ {3}DONE/);
    const running = strip(trayRow(theme, row({ state: "running" }), false, 100, 0));
    assert.match(running, /RUN .*·+ [\u2800-\u28ff ]{2} 7s/u, "spinner before the stats while running");
    const narrow = strip(trayRow(theme, row({ title: "a very long title that goes on and on and on" }), false, 60));
    assert.ok(visibleWidth(narrow) <= 60);
    assert.doesNotMatch(narrow, /model-x/, "tags drop from the end first");
    assert.match(narrow, /7s · 1KB/, "kept tags stay");
  });

  test("groupRows: running first, order kept within groups", () => {
    const rows = [row({ id: "1" }), row({ id: "2", state: "running" }), row({ id: "3", state: "failed" }), row({ id: "4", state: "running" })];
    assert.deepEqual(groupRows(rows).map((r) => r.id), ["2", "4", "1", "3"]);
  });

  test("list: Running / Recent headers only when both exist, window with ↑/↓ more, rule + hint/flash", () => {
    const st = new TrayListState();
    const rows = [row({ id: "r", state: "running" }), ...Array.from({ length: 12 }, (_, i) => row({ id: `d${String(i)}` }))];
    st.selectId(rows, undefined);
    assert.equal(st.selected, 0);
    let out = renderTrayList(theme, { rows, state: st, width: 80, empty: "none", hint: "keys", maxRows: 5 }).map(strip);
    assert.equal(out[0], "  Running");
    assert.equal(out[2], "  Recent");
    assert.equal(out.at(-3), "  ↓ 8 more");
    assert.equal(out.at(-1), "keys");
    st.move(20, rows.length);
    out = renderTrayList(theme, { rows, state: st, width: 80, empty: "none", hint: "keys", flash: "Done.", maxRows: 5 }).map(strip);
    assert.equal(out[0], "  ↑ 8 more");
    assert.ok(!out.includes("  Running"));
    assert.match(out.at(-1)!, /^Done\. {2}keys$/);
    const one = renderTrayList(theme, { rows: [row()], state: new TrayListState(), width: 80, empty: "none", hint: "k" }).map(strip);
    assert.ok(!one.some((l) => /Running|Recent/.test(l)));
    assert.equal(renderTrayList(theme, { rows: [], state: new TrayListState(), width: 80, empty: "Nothing yet.", hint: "k" }).map(strip)[0], "  Nothing yet.");
  });

  test("scroll: follows the end, scrolling up freezes, reaching the end resumes", () => {
    const s = new TrayScroll();
    assert.equal(s.fit(100, 10), 90);
    s.by(-5);
    assert.equal(s.fit(120, 10), 85, "frozen while scrolled up even as the body grows");
    s.end();
    assert.equal(s.fit(120, 10), 110);
    s.home();
    assert.equal(s.fit(120, 10), 0);
    s.by(500);
    assert.equal(s.fit(120, 10), 110);
    assert.equal(s.follow, true);
  });

  test("detail: rule title + right, meta (+ position), blank, body window, rule, hint", () => {
    const body = Array.from({ length: 30 }, (_, i) => `l${String(i + 1)}`);
    const out = renderTrayDetail(theme, { width: 60, title: "✓ Shell › build", right: "7s · 1KB", meta: ["id a", "completed"], body, scroll: new TrayScroll(), hint: "keys", viewport: 5 }).map(strip);
    assert.match(out[0]!, /^── ✓ Shell › build ─+ 7s · 1KB ──$/);
    assert.equal(out[1], "id a · completed 30/30");
    assert.equal(out[2], "");
    assert.deepEqual(out.slice(3, 8), ["l26", "l27", "l28", "l29", "l30"]);
    assert.equal(out.at(-1), "keys");
    for (const l of out) assert.ok(visibleWidth(l) <= 60);
  });
});
