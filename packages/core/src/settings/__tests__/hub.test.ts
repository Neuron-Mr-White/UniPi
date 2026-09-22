import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsHub } from "../hub.js";
import { registerSettings, resetSettingsGates } from "../engine.js";
import { parseModelCatalog } from "../catalog.js";

// ── fixture namespace (unique per run to dodge the process-global registry) ─
const NS = "hubtest";

function registerFixture(): void {
  registerSettings({
    namespace: NS,
    label: "Hub Test",
    defaults: {
      flag: true,
      choice: "a",
      custom: "a",
      text: "hello",
      count: 5,
      token: "secret-value",
      model: "prov/m1",
    },
    schema: [
      {
        title: "All types",
        fields: [
          { key: "flag", type: "boolean", label: "Flag" },
          { key: "choice", type: "enum", label: "Choice", options: ["a", "b", "c"] },
          { key: "custom", type: "enum", label: "Custom", options: ["a", "b"], allowCustom: true },
          { key: "text", type: "string", label: "Text" },
          { key: "count", type: "number", label: "Count", min: 0, max: 100 },
          { key: "token", type: "secret", label: "Token" },
          { key: "model", type: "model", label: "Model" },
        ],
      },
    ],
  });
}

const CATALOG = ["prov/m1", "prov/m2", "prov/m3", "other/x1", "other/x2", "other/x3", "zai/glm"];

let home: string;
let cwd: string;
let closed = 0;

function makeHub(rows?: () => number): SettingsHub {
  closed = 0;
  const hub = new SettingsHub({ cwd, modelCatalog: () => CATALOG, ...(rows ? { terminalRows: rows } : {}) });
  hub.onClose = () => { closed++; };
  return hub;
}

/** Strip ANSI and measure visible width. */
function vw(line: string): number {
  return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

/** Row order: scope, header, then 7 fields (registration order). */
function jumpTo(hub: SettingsHub, label: string): void {
  // navigate down until the rendered row contains the label
  for (let i = 0; i < 30; i++) {
    hub.handleInput("\x1b[B");
    const row = (hub as unknown as { visibleRows: () => { label: string }[] }).visibleRows()[
      (hub as unknown as { cursor: number }).cursor
    ];
    if (row?.label === label) return;
  }
  throw new Error(`row not found: ${label}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hub-home-"));
  cwd = mkdtempSync(join(tmpdir(), "hub-cwd-"));
  process.env.HOME = home;
  resetSettingsGates();
  registerFixture();
});

afterEach(() => {
  process.env.HOME = process.env.HOME === home ? undefined : process.env.HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const engineFile = () => join(home, ".unipi", "config", NS, "config.json");
const readEngine = () => JSON.parse(readFileSync(engineFile(), "utf8"));

describe("hub interactions (instant apply)", () => {
  it("space toggles a boolean instantly and writes the engine file", () => {
    const hub = makeHub();
    jumpTo(hub, "Flag");
    hub.handleInput(" ");
    assert.equal(readEngine().flag, false, "instant write to engine file");
    hub.handleInput(" ");
    assert.equal(readEngine().flag, true);
  });

  it("tab toggles a boolean too", () => {
    const hub = makeHub();
    jumpTo(hub, "Flag");
    hub.handleInput("\t");
    assert.equal(readEngine().flag, false);
  });

  it("tab cycles a plain enum; space is ignored on plain enums", () => {
    const hub = makeHub();
    jumpTo(hub, "Choice");
    hub.handleInput("\t");
    assert.equal(readEngine().choice, "b");
    hub.handleInput(" ");
    assert.equal(readEngine().choice, "b", "space must not change a plain enum");
  });

  it("allowCustom enum: tab walks options then custom… opens the prefilled input", () => {
    const hub = makeHub();
    jumpTo(hub, "Custom");
    hub.handleInput("\t"); // a → b
    assert.equal(readEngine().custom, "b");
    hub.handleInput("\t"); // b → custom… → editor opens prefilled "b" (cursor at end)
    hub.handleInput("z"); // append → "bz"
    hub.handleInput("\r"); // Enter saves
    assert.equal(readEngine().custom, "bz");
    hub.handleInput(" "); // space jumps straight to custom editor from any position
    hub.handleInput("\r"); // save prefilled "bz" unchanged
    assert.equal(readEngine().custom, "bz");
  });

  it("inline input: prefilled with cursor at end, Enter saves, Esc cancels", () => {
    const hub = makeHub();
    jumpTo(hub, "Text");
    hub.handleInput(" "); // opens editor prefilled "hello" (cursor at end)
    hub.handleInput("!");
    hub.handleInput("\r");
    assert.equal(readEngine().text, "hello!");

    hub.handleInput(" ");
    hub.handleInput("XXX");
    hub.handleInput("\x1b"); // Esc cancels
    assert.equal(readEngine().text, "hello!", "esc discards the edit");
  });

  it("invalid number keeps the editor open with an error; valid saves", () => {
    const hub = makeHub();
    jumpTo(hub, "Count");
    hub.handleInput(" "); // prefilled "5", cursor at end
    for (let i = 0; i < 1; i++) hub.handleInput("\x7f"); // "5" → ""
    hub.handleInput("999"); // out of range
    hub.handleInput("\r");
    assert.equal(existsSync(engineFile()), false, "invalid input writes nothing");
    hub.handleInput("\x7f"); // 999 → 99
    hub.handleInput("\x7f"); // 99 → 9
    hub.handleInput("\r");
    assert.equal(readEngine().count, 9);
  });

  it("secret edits prefills the real value and saves", () => {
    const hub = makeHub();
    jumpTo(hub, "Token");
    hub.handleInput(" ");
    hub.handleInput("2");
    hub.handleInput("\r");
    assert.equal(readEngine().token, "secret-value2");
  });

  it("model picker: filters, arrows walk, Enter picks instantly", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput(" "); // opens picker, search prefilled "prov/m1" (cursor end)
    for (let i = 0; i < 7; i++) hub.handleInput("\x7f"); // clear "prov/m1"
    hub.handleInput("glm"); // → zai/glm
    hub.handleInput("\r");
    assert.equal(readEngine().model, "zai/glm");

    hub.handleInput("\t"); // Tab also opens the picker
    for (let i = 0; i < 7; i++) hub.handleInput("\x7f"); // clear "zai/glm"
    hub.handleInput("other/x");
    hub.handleInput("\x1b[B"); // down → second match
    hub.handleInput("\r");
    assert.equal(readEngine().model, "other/x2");
  });

  it("model picker renders EXACTLY 5 visible rows regardless of list size", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput(" ");
    for (let i = 0; i < 7; i++) hub.handleInput("\x7f"); // clear → all 7 options
    const lines = hub.render(100).join("\n");
    // The picker window shows EXACTLY the first 5 of 7 options: m1,m2,m3,x1,x2
    // visible; x3 and glm sit beyond the fold until arrowed to.
    for (const id of ["prov/m2", "prov/m3", "other/x1", "other/x2"]) {
      assert.ok(lines.includes(id), `${id} visible in the 5-row window`);
    }
    assert.ok(!lines.includes("other/x3"), "6th option beyond the window");
    assert.ok(!lines.includes("zai/glm"), "7th option beyond the window");
  });

  it("esc closes the panel; search-esc only exits search first", () => {
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("\x1b"); // exit search
    assert.equal(closed, 0);
    hub.handleInput("\x1b"); // close panel
    assert.equal(closed, 1);
  });

  it("scope row: tab switches global↔project and writes go to the active scope", () => {
    const hub = makeHub();
    // scope row is row 0
    hub.handleInput("\t");
    hub.handleInput("\x1b[B"); // down to header
    jumpTo(hub, "Flag");
    hub.handleInput(" ");
    const projectFile = join(cwd, ".unipi", "config", NS, "config.json");
    assert.equal(JSON.parse(readFileSync(projectFile, "utf8")).flag, false, "written to PROJECT scope");
  });

  it("k/up and j/down navigate", () => {
    const hub = makeHub();
    const before = (hub as unknown as { cursor: number }).cursor;
    hub.handleInput("\x1b[B");
    hub.handleInput("j");
    assert.equal((hub as unknown as { cursor: number }).cursor, before + 2);
    hub.handleInput("\x1b[A");
    hub.handleInput("k");
    assert.equal((hub as unknown as { cursor: number }).cursor, before);
  });

  it("search filters to matching fields live", () => {
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("Token");
    const rows = (hub as unknown as { visibleRows: () => { label: string }[] }).visibleRows();
    assert.equal(rows.length, 1, "just the Token field (headers/scope filtered out)");
    assert.equal(rows[0]!.label, "Token");
  });

  it("multi-word search matches across section title + field label", () => {
    const hub = makeHub();
    // "types flag": 'types' lives in the section title, 'flag' in the label.
    hub.handleInput("/");
    hub.handleInput("types flag");
    const rows = (hub as unknown as { visibleRows: () => { label: string }[] }).visibleRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.label, "Flag");
  });

  it("a word matching nothing empties the list (no crash)", () => {
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("zzz nothing");
    assert.equal((hub as unknown as { visibleRows: () => unknown[] }).visibleRows().length, 0);
  });
});

describe("model catalog", () => {
  it("parses pi models.json provider/model ids", () => {
    const ids = parseModelCatalog(() =>
      JSON.stringify({ providers: { omniroute: { models: [{ id: "zai/glm-5.3" }, { id: "cc/opus" }] }, local: { models: [{ id: "m1" }] } } }),
    );
    assert.deepEqual(ids, ["omniroute/zai/glm-5.3", "omniroute/cc/opus", "local/m1"]);
  });

  it("missing file or bad json → empty catalog", () => {
    assert.deepEqual(parseModelCatalog(() => { throw new Error("enoent"); }), []);
    assert.deepEqual(parseModelCatalog(() => "not json"), []);
  });
});

describe("layout: uniform paint + viewport", () => {
  it("every rendered line is EXACTLY the frame width (uniform bg paint)", () => {
    const hub = makeHub();
    for (const width of [80, 100, 160]) {
      for (const line of hub.render(width)) {
        assert.equal(vw(line), width, `line must be exactly ${width} cells: ${line.slice(0, 40)}`);
      }
    }
  });

  it("lines stay exact width with the picker and inline editor open", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput(" ");
    for (const line of hub.render(100)) assert.equal(vw(line), 100);
    hub.handleInput("\x1b");
    const hub2 = makeHub();
    jumpTo(hub2, "Text");
    hub2.handleInput(" ");
    for (const line of hub2.render(100)) assert.equal(vw(line), 100);
  });

  it("long values truncate with ellipsis instead of overflowing", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput(" "); // picker
    for (let i = 0; i < 3; i++) hub.handleInput("\x7f"); // clear "m1" prefill partially
    hub.handleInput("verylongmodelname/that-should-truncate/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    hub.handleInput("\r");
    for (const line of hub.render(60)) assert.equal(vw(line), 60);
  });

  it("viewport: panel fits a short terminal and shows scroll indicators", () => {
    // 20 terminal rows → window ≈ 13 rows; fixture has scope+header+7 fields = 9 rows… use narrow rows.
    const hub = makeHub(() => 12); // maxRows = 12 - 7 = 5
    const lines = hub.render(100);
    const flat = lines.join("\n");
    assert.ok(flat.includes("↓ 4 more") || flat.includes("↓ "), "bottom scroll indicator present");
    // Window shows at most 5 rows + indicator + hint + frame — never more rows than fit.
    const bodyRows = lines.length;
    assert.ok(bodyRows <= 12, `panel height ${bodyRows} must fit the terminal (12)`);
  });

  it("cursor moves scroll the window to stay visible", () => {
    const hub = makeHub(() => 12); // maxRows = 5
    // Cursor starts at 0 (scope); walk to the last row (Token field = row 8).
    jumpTo(hub, "Token");
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("Token"), "cursor row stays inside the window");
    assert.ok(flat.includes("↑ "), "top scroll indicator shows the hidden rows");
    const rows = (hub as unknown as { visibleRows: () => { label: string }[] }).visibleRows();
    const idx = rows.findIndex((r) => r.label === "Token");
    const scroll = (hub as unknown as { scroll: number }).scroll;
    assert.ok(idx >= scroll && idx < scroll + 5, "cursor within [scroll, scroll+maxRows)");
  });
});

describe("key router (real-terminal encodings)", () => {
  function cursorLabel(hub: SettingsHub): string {
    const h = hub as unknown as { visibleRows: () => { label: string }[]; cursor: number };
    return h.visibleRows()[h.cursor]?.label ?? "";
  }

  it("arrows work in CSI (\x1b[A) and SS3 (\x1bOA) encodings", () => {
    const hub = makeHub();
    hub.handleInput("\x1b[B"); // CSI down → header
    const afterCsi = cursorLabel(hub);
    hub.handleInput("\x1bOB"); // SS3 down → next
    assert.notEqual(cursorLabel(hub), afterCsi, "SS3 arrow moves the cursor too");
    hub.handleInput("\x1bOA"); // SS3 up → back
    assert.equal(cursorLabel(hub), afterCsi);
  });

  it("j/k navigate regardless of encoding (plain bytes here)", () => {
    const hub = makeHub();
    hub.handleInput("j");
    hub.handleInput("j");
    const two = cursorLabel(hub);
    hub.handleInput("k");
    assert.notEqual(cursorLabel(hub), two);
  });

  it("kitty CSI-u printable 'j' also navigates", () => {
    const hub = makeHub();
    hub.handleInput("\x1b[106u"); // 'j' as CSI-u (kitty flag 1)
    hub.handleInput("\x1b[107u"); // 'k' CSI-u
    // cursor ended where it started (down then up)
    assert.equal(cursorLabel(hub), "Write scope");
  });

  it("pageDown/pageUp jump by 10 rows; home/end hit the edges", () => {
    const hub = makeHub();
    hub.handleInput("\x1b[6~"); // pageDown
    const rows = (hub as unknown as { visibleRows: () => unknown[] }).visibleRows();
    assert.equal((hub as unknown as { cursor: number }).cursor, Math.min(10, rows.length - 1));
    hub.handleInput("\x1b[5~"); // pageUp
    assert.equal((hub as unknown as { cursor: number }).cursor, 0);
    hub.handleInput("\x1b[F"); // end
    assert.equal((hub as unknown as { cursor: number }).cursor, rows.length - 1);
    hub.handleInput("\x1b[H"); // home
    assert.equal((hub as unknown as { cursor: number }).cursor, 0);
  });

  it("a lone Esc still closes (keypress sequences arrive in one read)", () => {
    const hub = makeHub();
    hub.handleInput("\x1b");
    assert.equal(closed, 1);
  });
});
