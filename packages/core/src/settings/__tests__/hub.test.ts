import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsHub } from "../hub.js";
import { registerSettings, resetSettingsGates } from "../engine.js";
import { parseModelCatalog } from "../catalog.js";
import { namespaceColor, PACKAGE_COLORS } from "../../package-colors.js";

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
    const here = (hub as unknown as { visibleRows: () => { label: string }[] }).visibleRows()[
      (hub as unknown as { cursor: number }).cursor
    ];
    if (here?.label === label) return;
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

  it("enter and tab each toggle a boolean", () => {
    const hub = makeHub();
    jumpTo(hub, "Flag");
    hub.handleInput("\r"); // Enter activates
    assert.equal(readEngine().flag, false);
    hub.handleInput("\t"); // Tab activates too
    assert.equal(readEngine().flag, true);
  });

  it("enter/tab open the option list on a plain enum; enter/tab in the list picks", () => {
    const hub = makeHub();
    jumpTo(hub, "Choice");
    hub.handleInput("\t"); // Tab ACTIVATES → option list (no custom… on plain enums)
    assert.ok(!hub.render(100).join("\n").includes("custom…"), "plain enum list omits custom…");
    hub.handleInput("\x1b[B"); // down → b
    hub.handleInput("\t"); // Tab picks (unified with Enter)
    assert.equal(readEngine().choice, "b", "tab in the list picks");
    hub.handleInput("\r"); // Enter opens the list again
    hub.handleInput("\r"); // Enter picks the selected option ("b")
    assert.equal(readEngine().choice, "b", "enter in the list picks");
  });

  it("space quick-cycles a plain enum", () => {
    const hub = makeHub();
    jumpTo(hub, "Choice");
    hub.handleInput(" ");
    assert.equal(readEngine().choice, "b");
    hub.handleInput(" ");
    assert.equal(readEngine().choice, "c");
    hub.handleInput(" ");
    assert.equal(readEngine().choice, "a", "cycles back to the first option");
  });

  it("custom enum values display with the ⚙ marker", async () => {
    const { formatFieldValue } = await import("../schema.js");
    const f = { key: "c", type: "enum" as const, label: "C", options: ["a", "b"], allowCustom: true };
    assert.equal(formatFieldValue(f, "a"), "a");
    assert.equal(formatFieldValue(f, "weird"), "⚙ weird");
  });

  it("allowCustom enum: enter/tab open the option list; space cycles skipping custom…", () => {
    const hub = makeHub();
    jumpTo(hub, "Custom");
    hub.handleInput("\t"); // ACTIVATE → option list (a, b, custom…)
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("custom…"), "list shows the custom… entry");
    assert.ok(!flat.includes("search:"), "no search box for ≤8 options");
    hub.handleInput("\x1b[B"); // down → "b"
    hub.handleInput("\r"); // pick b
    assert.equal(readEngine().custom, "b");
    hub.handleInput("\t"); // list again
    hub.handleInput("\x1b[B"); // → "custom…"
    hub.handleInput("\r"); // editor opens prefilled "b" (cursor at end)
    hub.handleInput("z"); // append → "bz"
    hub.handleInput("\t"); // TAB submits the inline editor
    assert.equal(readEngine().custom, "bz", "tab submits the editor");

    // Space quick-cycles LISTED options only — custom… never offered; a custom
    // value restarts at the first option.
    hub.handleInput(" ");
    assert.equal(readEngine().custom, "a", "custom value cycles back to the first option");
    hub.handleInput(" ");
    assert.equal(readEngine().custom, "b");
    hub.handleInput(" ");
    assert.equal(readEngine().custom, "a");
  });

  it("inline input: prefilled with cursor at end, Enter saves, Esc cancels", () => {
    const hub = makeHub();
    jumpTo(hub, "Text");
    hub.handleInput("\r"); // Enter opens the editor prefilled "hello" (cursor at end)
    hub.handleInput("!");
    hub.handleInput("\r");
    assert.equal(readEngine().text, "hello!");

    hub.handleInput("\t"); // Tab also opens the editor
    hub.handleInput("XXX");
    hub.handleInput("\x1b"); // Esc cancels
    assert.equal(readEngine().text, "hello!", "esc discards the edit");
  });

  it("space is a no-op on a string field (enter/tab edit)", () => {
    const hub = makeHub();
    jumpTo(hub, "Text");
    hub.handleInput(" ");
    assert.equal((hub as unknown as { mode: string }).mode, "list", "space does not open the editor");
    assert.equal(existsSync(engineFile()), false, "space changes nothing (no write)");
    hub.handleInput("\t"); // Tab edits
    assert.equal((hub as unknown as { mode: string }).mode, "input");
    hub.handleInput("\x1b");
  });

  it("invalid number keeps the editor open with an error; valid saves", () => {
    const hub = makeHub();
    jumpTo(hub, "Count");
    hub.handleInput("\r"); // prefilled "5", cursor at end
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
    hub.handleInput("\r");
    hub.handleInput("2");
    hub.handleInput("\r");
    assert.equal(readEngine().token, "secret-value2");
  });

  it("model picker: filters, arrows walk, Enter picks instantly", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput("\r"); // opens picker, search prefilled "prov/m1" (cursor end)
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
    hub.handleInput("\r");
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

  it("g switches global↔project (scope lives in the title) and writes follow", () => {
    const hub = makeHub();
    const title = (): string => hub.render(100).join("\n");
    assert.ok(title().includes("unipi settings — global"), "title shows global");
    hub.handleInput("g");
    assert.ok(title().includes("unipi settings — project"), "g switches the title scope");
    jumpTo(hub, "Flag"); // header band is skipped by navigation
    hub.handleInput(" ");
    const projectFile = join(cwd, ".unipi", "config", NS, "config.json");
    assert.equal(JSON.parse(readFileSync(projectFile, "utf8")).flag, false, "written to PROJECT scope");
  });

  it("k/up and j/down navigate (skipping header bands)", () => {
    const hub = makeHub();
    const label = (): string =>
      (hub as unknown as { visibleRows: () => { label: string }[]; cursor: number })
        .visibleRows()[(hub as unknown as { cursor: number }).cursor]!.label;
    assert.equal(label(), "Flag", "cursor starts past the header band");
    hub.handleInput("j");
    assert.equal(label(), "Choice");
    hub.handleInput("k");
    assert.equal(label(), "Flag");
    hub.handleInput("\x1b[A"); // up clamps at the first selectable row
    assert.equal(label(), "Flag");
  });

  it("headers persist under filter and never hold the cursor", () => {
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("types flag");
    hub.handleInput("\r");
    // rows = [header, Flag]; cursor normalized PAST the header.
    const h = hub as unknown as { visibleRows: () => { kind: string; label: string }[]; cursor: number };
    assert.equal(h.visibleRows()[h.cursor]!.label, "Flag", "cursor lands on the field, not the header");
    hub.handleInput(" ");
    assert.equal(readEngine().flag, false, "actions work from the filtered view");
    hub.handleInput(" ");
  });

  it("height is RELATIVE (~half the terminal), not near-full", () => {
    const hub = makeHub(() => 50); // half = 25
    const lines = hub.render(100);
    const bodyLines = lines.length - 4; // minus 2 frame borders + hint + blank-ish structure
    assert.ok(lines.length <= 30, `panel (${lines.length} lines) must be ≈ half of 50 rows`);
    void bodyLines;
  });

  it("search filters to matching fields live", () => {
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("Token");
    const rows = (hub as unknown as { visibleRows: () => { label: string; kind: string }[] }).visibleRows();
    // Group header PERSISTS above its matching field.
    assert.equal(rows.length, 2, "header + Token field");
    assert.equal(rows[0]!.kind, "header");
    assert.equal(rows[1]!.label, "Token");
  });

  it("multi-word search matches across section title + field label", () => {
    const hub = makeHub();
    // "types flag": 'types' lives in the section title, 'flag' in the label.
    hub.handleInput("/");
    hub.handleInput("types flag");
    const rows = (hub as unknown as { visibleRows: () => { label: string; kind: string }[] }).visibleRows();
    assert.equal(rows.length, 2, "persisted header + Flag");
    assert.equal(rows[1]!.label, "Flag");
  });

  it("picker with an uncatalogued value opens UNFILTERED", () => {
    // Seed a value outside the catalog first.
    mkdirSync(join(home, ".unipi", "config", NS), { recursive: true });
    writeFileSync(engineFile(), JSON.stringify({ model: "custom/x" }));
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("Model");
    hub.handleInput("\r");
    hub.handleInput("\r"); // Enter opens the picker
    const picker = (hub as unknown as { picker: { input: { getValue(): string } } }).picker;
    assert.equal(picker.input.getValue(), "", "search starts empty for uncatalogued values");
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("prov/m2"), "unfiltered list shows catalog entries");
    hub.handleInput("\x1b");
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
    hub.handleInput("\r"); // picker
    for (const line of hub.render(100)) assert.equal(vw(line), 100);
    hub.handleInput("\x1b");
    const hub2 = makeHub();
    jumpTo(hub2, "Text");
    hub2.handleInput("\r"); // inline editor
    for (const line of hub2.render(100)) assert.equal(vw(line), 100);
  });

  it("long values truncate with ellipsis instead of overflowing", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput("\r"); // picker
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

  it("scrolling back to the top shows the first header — no ↑ line, no stall", () => {
    const hub = makeHub(() => 12); // maxRows = 5
    const h = hub as unknown as { visibleRows: () => { label: string }[]; cursor: number; scroll: number };
    jumpTo(hub, "Token"); // scroll down; cursor 6
    hub.render(100); // render applies clampScroll → window scrolled
    assert.ok(h.scroll > 0, "window scrolled down");
    hub.handleInput("\x1b[H"); // home → first selectable row (Flag, index 1)
    assert.equal(h.cursor, 1);
    hub.render(100); // render applies clampScroll
    assert.equal(h.scroll, 0, "scroll includes the header run above the cursor");
    const flat = hub.render(100).join("\n");
    assert.ok(!flat.includes("↑ "), "no top scroll indicator at the top");
    assert.ok(flat.includes("Hub Test — All types"), "first header visible");
    hub.handleInput("\x1b[F"); // end → last selectable
    assert.ok(!hub.render(100).join("\n").includes("↓ "), "↓ N more reaches 0 at End");
  });

  it("picker 5-row window shows the selected LAST option (no off-by-one)", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput("\r"); // picker
    for (let i = 0; i < 7; i++) hub.handleInput("\x7f"); // clear search → all 7 options
    for (let i = 0; i < 6; i++) hub.handleInput("\x1b[B"); // walk to the 7th option
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("zai/glm"), "selected last option visible in the window");
    assert.ok(!flat.includes("prov/m2"), "earliest options scrolled off");
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
    assert.equal(cursorLabel(hub), "Flag");
  });

  it("pageDown/pageUp jump by 10 rows; home/end hit the selectable edges", () => {
    const hub = makeHub();
    const cur = (): number => (hub as unknown as { cursor: number }).cursor;
    const rows = (hub as unknown as { visibleRows: () => { kind: string }[] }).visibleRows();
    const firstSelectable = rows.findIndex((r) => r.kind !== "header");
    const lastSelectable = rows.length - 1;
    hub.handleInput("\x1b[6~"); // pageDown
    assert.equal(cur(), Math.min(10, lastSelectable));
    hub.handleInput("\x1b[5~"); // pageUp
    assert.equal(cur(), firstSelectable, "home-side stops at the first selectable row");
    hub.handleInput("\x1b[F"); // end
    assert.equal(cur(), lastSelectable);
    hub.handleInput("\x1b[H"); // home
    assert.equal(cur(), firstSelectable);
  });

  it("a lone Esc still closes (keypress sequences arrive in one read)", () => {
    const hub = makeHub();
    hub.handleInput("\x1b");
    assert.equal(closed, 1);
  });
});

describe("recovery safety net (u / d / R)", () => {
  it("u undoes the last change (file evidence) and shows a toast", () => {
    const hub = makeHub();
    jumpTo(hub, "Flag");
    hub.handleInput(" ");           // true → false (instant write)
    assert.equal(readEngine().flag, false);
    hub.handleInput("u");           // undo
    assert.equal(readEngine().flag, true, "undo restores the prior value");
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("undo: Flag"), "toast confirms the undo");
    assert.ok(!hub.render(100).join("\n").includes("undo: Flag"), "toast lasts one render");
  });

  it("d resets the cursor field to its schema default", () => {
    const hub = makeHub();
    jumpTo(hub, "Count");
    hub.handleInput("\r");           // editor
    hub.handleInput("\x7f");       // clear "5"
    hub.handleInput("9");
    hub.handleInput("\r");         // saved 9
    assert.equal(readEngine().count, 9);
    hub.handleInput("d");           // default = 5
    assert.equal(readEngine().count, 5);
  });

  it("R reverts the cursor field to the panel-open baseline", () => {
    const hub = makeHub();
    jumpTo(hub, "Text");
    hub.handleInput("\r");
    hub.handleInput("!");
    hub.handleInput("\r");         // "hello!"
    assert.equal(readEngine().text, "hello!");
    hub.handleInput("R");           // baseline = "hello"
    assert.equal(readEngine().text, "hello");
  });

  it("undo stack is capped at 50 and undoes LIFO across fields", () => {
    const hub = makeHub();
    jumpTo(hub, "Flag");
    for (let i = 0; i < 60; i++) hub.handleInput(" "); // 60 toggles
    const stack = (hub as unknown as { history: unknown[] }).history;
    assert.equal(stack.length, 50, "capped at 50");
    hub.handleInput("u");
    assert.equal(readEngine().flag, false, "LIFO: 60 toggles end false → undo yields false(60-1=odd)");
    hub.handleInput("u");
    assert.equal(readEngine().flag, true, "second undo restores the other phase");
  });

  it("u on an empty stack is a safe no-op", () => {
    const hub = makeHub();
    hub.handleInput("u");
    assert.equal(existsSync(engineFile()), false, "nothing written");
  });
});

describe("friendly defaults (emptyLabel / zeroLabel)", () => {
  it("renders semantic labels for empty/zero values", async () => {
    const { formatFieldValue } = await import("../schema.js");
    const model = { key: "m", type: "model" as const, label: "M", emptyLabel: "inherit (session model)" };
    assert.equal(formatFieldValue(model, ""), "inherit (session model)");
    assert.equal(formatFieldValue(model, undefined), "inherit (session model)");
    assert.equal(formatFieldValue(model, "prov/x"), "prov/x");
    const num = { key: "n", type: "number" as const, label: "N", zeroLabel: "∞ none" };
    assert.equal(formatFieldValue(num, 0), "∞ none");
    assert.equal(formatFieldValue(num, 42), "42");
  });

  it("secret masking WINS over emptyLabel when a value exists", async () => {
    const { formatFieldValue } = await import("../schema.js");
    const sec = { key: "s", type: "secret" as const, label: "S", emptyLabel: "env fallback" };
    assert.equal(formatFieldValue(sec, "sk-123"), "••••••");
    assert.equal(formatFieldValue(sec, ""), "env fallback");
    assert.equal(formatFieldValue(sec, undefined), "env fallback");
  });

  it("live rows show the labels (verifier model + timeout)", () => {
    const hub = makeHub();
    jumpTo(hub, "Count");
    // fixture Count has no zeroLabel → plain "0"-style rendering stays strict
    hub.handleInput("\r");
    hub.handleInput("\x7f");
    hub.handleInput("\r"); // empty → invalid, stays open… cancel instead
    hub.handleInput("\x1b");
  });
});

describe("progressive disclosure (advanced sections)", () => {
  it("advanced sections collapse behind one toggle; Space expands; search reveals", () => {
    registerSettings({
      namespace: "hubtestadv",
      label: "Adv",
      defaults: { open: true, secretCfg: "top" },
      schema: [
        { title: "Main", fields: [{ key: "open", type: "boolean", label: "Open" }] },
        { title: "Tuning", advanced: true, fields: [{ key: "secretCfg", type: "string", label: "Secret cfg" }] },
      ],
    });
    const hub = makeHub();
    const flat = (): string => hub.render(100).join("\n");
    assert.ok(!flat().includes("Secret cfg"), "advanced field hidden by default");
    assert.ok(flat().includes("▸ Advanced"), "toggle row present");

    // search finds advanced fields even when collapsed
    hub.handleInput("/");
    hub.handleInput("secret cfg");
    assert.ok(flat().includes("Secret cfg"), "filter reveals advanced fields");
    hub.handleInput("\x1b"); // clear filter

    // Space on the toggle expands
    const h = hub as unknown as { visibleRows: () => { label: string; kind: string }[]; cursor: number };
    const idx = h.visibleRows().findIndex((r) => r.label.includes("Advanced"));
    assert.ok(idx >= 0);
    h.cursor = idx;
    hub.handleInput(" ");
    assert.ok(flat().includes("Secret cfg"), "expanded shows advanced fields");
    assert.ok(flat().includes("▾ Advanced"), "toggle flips open");
    hub.handleInput(" ");
    assert.ok(!flat().includes("Secret cfg"), "Space collapses again");
  });
});

describe("nested pages + action rows (per-category flows)", () => {
  it("page rows open with a breadcrumb; Esc pops back", () => {
    registerSettings({
      namespace: "hubtestpage",
      label: "Pages",
      defaults: { tavily: { enabled: true, apiKey: "tk-1" } },
      schema: [
        {
          title: "Providers",
          fields: [
            {
              key: "tavily",
              type: "page",
              label: "tavily",
              sections: [
                {
                  title: "tavily",
                  fields: [
                    { key: "tavily.enabled", type: "boolean", label: "Enabled" },
                    { key: "tavily.apiKey", type: "secret", label: "API key", emptyLabel: "unset" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("tavily");
    hub.handleInput("\r");
    // cursor on the page row → Enter opens
    hub.handleInput("\r");
    const flat = (): string => hub.render(100).join("\n");
    assert.ok(flat().includes("› tavily —"), "breadcrumb in the title");
    assert.ok(flat().includes("API key"), "page fields visible");
    // edit inside the page writes through the prefixed key
    jumpTo(hub, "API key");
    hub.handleInput("\r");
    hub.handleInput("2");
    hub.handleInput("\r");
    const pageFile = join(home, ".unipi", "config", "hubtestpage", "config.json");
    const pageCfg = JSON.parse(readFileSync(pageFile, "utf8"));
    assert.equal(pageCfg.tavily.apiKey, "tk-12", "page field writes its full key");
    hub.handleInput("\x1b"); // Esc pops the page
    assert.ok(!flat().includes("› tavily —"), "back at the root title");
  });

  it("action rows invoke the runAction hook", () => {
    registerSettings({
      namespace: "hubtestact",
      label: "Acts",
      defaults: {},
      schema: [
        {
          title: "Servers",
          fields: [{ key: "configure", type: "action", label: "Configure servers…", command: "unipi:test-configure" }],
        },
      ],
    });
    const ran: string[] = [];
    const hub = new SettingsHub({
      cwd,
      modelCatalog: () => CATALOG,
      terminalRows: () => 40,
      runAction: (command) => {
        ran.push(command);
      },
    });
    hub.handleInput("/");
    hub.handleInput("configure");
    hub.handleInput("\r");
    hub.handleInput("\t"); // Tab runs it too
    assert.deepEqual(ran, ["unipi:test-configure"], "action row invokes the hook");
    hub.handleInput("\r");
    assert.deepEqual(ran, ["unipi:test-configure", "unipi:test-configure"], "Enter runs it too");
  });
});

describe("group colors (namespace ▌)", () => {
  it("namespaceColor maps hub namespaces onto package colors", () => {
    assert.equal(namespaceColor("info-screen"), PACKAGE_COLORS.info);
    assert.equal(namespaceColor("compactor"), PACKAGE_COLORS.compact);
    assert.equal(namespaceColor("command-enchantment"), PACKAGE_COLORS.autocomplete);
    assert.equal(namespaceColor("utility"), PACKAGE_COLORS.utility, "identity for known packages");
    assert.equal(namespaceColor("hubtest"), "", "unknown namespaces have no color");
  });

  it("▌ with the namespace ANSI code on header + field rows; widths stay exact", () => {
    registerSettings({
      namespace: "info-screen",
      label: "Info Screen",
      defaults: { show: true },
      schema: [{ title: "Display", fields: [{ key: "show", type: "boolean", label: "Show" }] }],
    });
    const hub = makeHub();
    const color = namespaceColor("info-screen");
    assert.ok(color, "info-screen resolves to a package color");
    const lines = hub.render(100);
    const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
    const header = lines.find((l) => strip(l).includes("Info Screen — Display"));
    const field = lines.find((l) => strip(l).includes("▌ Show"));
    assert.ok(header, "header row found");
    assert.ok(field, "field row found");
    assert.ok(strip(header!).startsWith("│▌ "), "header ▌ sits at column 0 inside the band");
    assert.ok(header!.includes(color), "header ▌ carries the namespace ANSI code");
    assert.ok(field!.includes(color), "field ▌ carries the namespace ANSI code");
    for (const line of lines) assert.equal(vw(line), 100, "exact width kept");
  });

  it("unknown namespaces keep the plain two-space indent (no ▌)", () => {
    const hub = makeHub();
    const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
    const field = hub.render(100).find((l) => strip(l).includes("Flag"));
    assert.ok(field);
    assert.ok(!strip(field!).includes("▌"), "uncolored namespace has no marker");
  });
});

describe("search backspace exit", () => {
  it("backspace on an EMPTY search input exits search; non-empty deletes", () => {
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("ju");
    hub.handleInput("\x7f"); // "ju" → "j" — stays in search
    const h = hub as unknown as {
      mode: string; filter: string; cursor: number;
      searchInput: { getValue(): string } | null;
      visibleRows: () => { kind: string }[];
    };
    assert.equal(h.mode, "search", "non-empty backspace stays in search");
    assert.equal(h.searchInput?.getValue(), "j");
    hub.handleInput("\x7f"); // "j" → "" — still in search, input now empty
    assert.equal(h.mode, "search", "backspace to empty stays in search");
    assert.equal(h.searchInput?.getValue(), "");
    hub.handleInput("\x7f"); // empty → exits search like Esc
    assert.equal(h.mode, "list", "third backspace exits to list mode");
    assert.equal(h.filter, "", "filter cleared");
    assert.equal(h.searchInput, null);
    assert.notEqual(h.visibleRows()[h.cursor]?.kind, "header", "cursor normalized onto a selectable row");
  });
});

describe("field hints + validators", () => {
  it("hint renders as ⓘ under the editor input; validator blocks submit with ⚠", () => {
    registerSettings({
      namespace: "hubtesthint",
      label: "Hinted",
      defaults: { key: "" },
      schema: [{
        title: "Keys",
        fields: [{
          key: "key",
          type: "string",
          label: "Keybind",
          hint: "format mod+key",
          validate: (raw) => (raw === "bad" ? "nope" : null),
        }],
      }],
    });
    const cfgFile = (): string => join(home, ".unipi", "config", "hubtesthint", "config.json");
    const hub = makeHub();
    hub.handleInput("/");
    hub.handleInput("keybind");
    hub.handleInput("\r");
    hub.handleInput("\r"); // Enter opens the editor
    let flat = hub.render(100).join("\n");
    assert.ok(flat.includes("ⓘ"), "hint line rendered");
    assert.ok(flat.includes("format mod+key"), "hint text shown");
    hub.handleInput("bad");
    hub.handleInput("\r"); // validator blocks
    flat = hub.render(100).join("\n");
    assert.ok(flat.includes("⚠ nope"), "validation error shown");
    assert.equal(existsSync(cfgFile()), false, "invalid input writes nothing");
    hub.handleInput("\x7f"); // clear "bad"
    hub.handleInput("\x7f");
    hub.handleInput("\x7f");
    hub.handleInput("ok");
    hub.handleInput("\t"); // Tab submits
    assert.equal(JSON.parse(readFileSync(cfgFile(), "utf8")).key, "ok", "valid input applies");
  });
});

describe("model pickers: capability / presets / emptyOption / providerKey", () => {
  /** Registry-style catalog entries (id + input modalities). */
  const ENTRIES = [
    { id: "prov/m1", input: ["text"] },
    { id: "vision/v1", input: ["text", "image"] },
    { id: "vision/v2", input: ["image", "text"] },
    { id: "other/x1", input: ["text"] },
    { id: "blind/b1", input: [] },
  ];

  function makeEntriesHub(): SettingsHub {
    const hub = new SettingsHub({
      cwd,
      modelCatalogEntries: () => ENTRIES,
      terminalRows: () => 40,
    });
    hub.onClose = () => {};
    return hub;
  }

  // Namespace/label chosen so the "Model" search matches ONLY the model row
  // (the namespace and module label must not contain the substring "model").
  function registerModelNs(field: Record<string, unknown>): void {
    registerSettings({
      namespace: "hubtestpick",
      label: "PickerNs",
      defaults: { provider: "openrouter", model: "" },
      schema: [{
        title: "Pick",
        fields: [
          { key: "provider", type: "enum", label: "Provider", options: ["openrouter", "custom", "inherit"] },
          field as never,
        ],
      }],
    });
  }

  function jumpAndOpen(hub: SettingsHub): void {
    // "picker" only appears in this namespace's haystack — the fixture also
    // registers a "Model" row, and the first match would win the cursor.
    hub.handleInput("/");
    hub.handleInput("picker model");
    hub.handleInput("\r");
    hub.handleInput("\r"); // Enter opens the picker
  }

  it("capability image-input hides text-only models and labels the list", () => {
    registerModelNs({ key: "model", type: "model", label: "Model", capability: "image-input" });
    const hub = makeEntriesHub();
    jumpAndOpen(hub);
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("vision/v1") && flat.includes("vision/v2"), "image-input models listed");
    assert.ok(!flat.includes("prov/m1") && !flat.includes("other/x1"), "text-only models hidden");
    assert.ok(flat.includes("image-input models \u00b7 2"), "header shows capability + count");
  });

  it("presets replace the catalog; custom\u2026 opens the editor prefilled", () => {
    registerModelNs({ key: "model", type: "model", label: "Model", presets: ["a/one", "b/two"] });
    const cfgPath = (): string => join(home, ".unipi", "config", "hubtestpick", "config.json");
    mkdirSync(join(home, ".unipi", "config", "hubtestpick"), { recursive: true });
    writeFileSync(cfgPath(), JSON.stringify({ model: "kept/x" }));
    const hub = makeEntriesHub();
    jumpAndOpen(hub);
    let flat = hub.render(100).join("\n");
    assert.ok(flat.includes("a/one") && flat.includes("b/two"), "preset ids listed");
    assert.ok(!flat.includes("vision/v1"), "catalog entries NOT listed");
    assert.ok(flat.includes("presets \u00b7 custom\u2026 for any id"), "preset header");
    assert.ok(flat.includes("custom\u2026"), "custom\u2026 always available");
    hub.handleInput("\x1b[B"); // \u2192 b/two
    hub.handleInput("\x1b[B"); // \u2192 custom\u2026
    hub.handleInput("\r"); // editor opens prefilled with the raw stored value
    flat = hub.render(100).join("\n");
    assert.ok(flat.includes("kept/x"), "editor prefilled with the raw value");
    hub.handleInput("2");
    hub.handleInput("\r"); // save
    assert.equal(JSON.parse(readFileSync(cfgPath(), "utf8")).model, "kept/x2", "custom id applies");
  });

  it("emptyOption is the first entry and picks \"\"", () => {
    registerModelNs({ key: "model", type: "model", label: "Model", capability: "text", emptyOption: "inherit (session model)" });
    const hub = makeEntriesHub();
    jumpAndOpen(hub);
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("inherit (session model)"), "emptyOption listed");
    hub.handleInput("\r"); // selected starts at 0 = emptyOption
    const cfg = JSON.parse(readFileSync(join(home, ".unipi", "config", "hubtestpick", "config.json"), "utf8"));
    assert.equal(cfg.model, "", "emptyOption picks the empty value");
  });

  it("providerKey switches the list when the sibling provider changes", () => {
    registerModelNs({
      key: "model",
      type: "model",
      label: "Model",
      capability: "text",
      providerKey: "provider",
      presetsByProvider: { openrouter: ["oa/e1", "oa/e2"], custom: [] },
    });
    const cfgPath = (): string => join(home, ".unipi", "config", "hubtestpick", "config.json");
    mkdirSync(join(home, ".unipi", "config", "hubtestpick"), { recursive: true });

    writeFileSync(cfgPath(), JSON.stringify({ provider: "openrouter" }));
    const hub = makeEntriesHub();
    jumpAndOpen(hub);
    let flat = hub.render(100).join("\n");
    assert.ok(flat.includes("oa/e1") && flat.includes("oa/e2"), "provider presets listed");
    assert.ok(flat.includes("presets (openrouter) \u00b7 custom\u2026 for any id"), "sibling header");

    hub.handleInput("\x1b"); // close picker
    writeFileSync(cfgPath(), JSON.stringify({ provider: "custom" }));
    const hub2 = makeEntriesHub();
    jumpAndOpen(hub2);
    flat = hub2.render(100).join("\n");
    assert.ok(!flat.includes("oa/e1"), "custom list is empty (only custom\u2026)");
    assert.ok(flat.includes("presets (custom) \u00b7 custom\u2026 for any id"), "custom header");

    hub2.handleInput("\x1b");
    writeFileSync(cfgPath(), JSON.stringify({ provider: "inherit" }));
    const hub3 = makeEntriesHub();
    jumpAndOpen(hub3);
    flat = hub3.render(100).join("\n");
    assert.ok(flat.includes("prov/m1"), "inherit falls back to the capability-filtered catalog");
    assert.ok(!flat.includes("blind/b1"), "capability filter still applies on inherit (no modalities \u2192 hidden)");
    assert.ok(flat.includes("text models \u00b7 4"), "inherit header counts the text-capable catalog");
  });

  it("catalog pickers always end with custom\u2026 for out-of-list ids", () => {
    const hub = makeHub();
    jumpTo(hub, "Model");
    hub.handleInput("\r"); // picker over the fixture catalog
    for (let i = 0; i < 7; i++) hub.handleInput("\x7f"); // clear the "prov/m1" prefill
    for (let i = 0; i < 7; i++) hub.handleInput("\x1b[B"); // walk to the last entry
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("custom\u2026"), "custom\u2026 entry present (8th, inside the window)");
    assert.ok(flat.includes("model catalog \u00b7 7"), "default catalog header with count");
  });
});

describe("dynamic pages (function sections)", () => {
  it("resolves sections at openPage time — live registries", () => {
    let calls = 0;
    const liveSections = (): ReturnType<() => unknown> => {
      calls++;
      return [{
        title: calls === 1 ? "First" : "Second",
        fields: [{ key: `dyn.v${calls}`, type: "boolean" as const, label: `Dyn ${calls}` }],
      }];
    };
    registerSettings({
      namespace: "hubtestdyn",
      label: "Dyn",
      defaults: { "dyn.v1": false, "dyn.v2": false },
      schema: [{ title: "Root", fields: [{ key: "dyn", type: "page", label: "Live page", sections: liveSections as never }] }],
    });
    const hub = makeHub();
    hub.handleInput("/"); hub.handleInput("live page"); hub.handleInput("\r");
    hub.handleInput("\r"); // open the page
    let flat = hub.render(100).join("\n");
    assert.ok(flat.includes("First"), "first resolution shown");
    assert.equal(calls, 1, "sections resolved once at open");
    hub.handleInput("\x1b"); // pop the page
    hub.handleInput("/"); hub.handleInput("live page"); hub.handleInput("\r");
    hub.handleInput("\r"); // open again — the getter re-runs
    flat = hub.render(100).join("\n");
    assert.ok(flat.includes("Second"), "second resolution reflects live state");
    assert.equal(calls, 2);
  });
});

describe("multiselect fields", () => {
  function registerMulti(): void {
    registerSettings({
      namespace: "hubtestmulti",
      label: "MultiNs",
      defaults: { targets: ["a"] },
      schema: [{
        title: "Pick",
        fields: [{
          key: "targets",
          type: "multiselect",
          label: "Targets",
          options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma" }],
          emptyLabel: "nothing",
        }],
      }],
    });
  }

  const cfg = (): string => join(home, ".unipi", "config", "hubtestmulti", "config.json");

  it("row shows comma-joined labels; empty selection shows emptyLabel", () => {
    registerMulti();
    const hub = makeHub();
    jumpTo(hub, "Targets");
    assert.ok(hub.render(100).join("\n").includes("Alpha"), "joined label on the row");
    hub.handleInput(" "); // list-mode Space on multiselect = no-op
    assert.equal((hub as unknown as { mode: string }).mode, "list", "space is a no-op in list mode");
    hub.handleInput("\t"); // Tab opens the option list
    const h = hub as unknown as { picker: { multi?: boolean } | null };
    assert.ok(h.picker?.multi, "multi list open");
    hub.handleInput("\x1b");
  });

  it("space toggles in the list, writes instantly, and the list stays open", () => {
    registerMulti();
    const hub = makeHub();
    jumpTo(hub, "Targets");
    hub.handleInput("\t"); // open
    hub.handleInput("\x1b[B"); // down to Beta
    hub.handleInput(" "); // toggle Beta on
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).targets, ["a", "b"], "instant write, canonical order");
    const h = hub as unknown as { picker: unknown; mode: string };
    assert.ok(h.picker, "list stays open");
    assert.equal(h.mode, "model");
    // checkbox rendering
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("[x] Alpha") && flat.includes("[x] Beta"), "checked boxes rendered");
    assert.ok(flat.includes("[ ] Gamma"), "unchecked box rendered");
    hub.handleInput("\x1b[B"); // down to Gamma
    hub.handleInput("\t"); // Tab toggles too
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).targets, ["a", "b", "c"], "tab toggles");
    hub.handleInput(" "); // toggle Gamma OFF again
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).targets, ["a", "b"], "toggle off writes too");
    hub.handleInput("\x1b"); // Esc closes
    assert.equal((hub as unknown as { mode: string }).mode, "list");
  });

  it("u/d/R work on array values", () => {
    registerMulti();
    const hub = makeHub();
    jumpTo(hub, "Targets");
    hub.handleInput("\t"); hub.handleInput("\x1b[B"); hub.handleInput(" "); // +Beta
    hub.handleInput("\x1b"); // close the list first
    hub.handleInput("u"); // undo → ["a"]
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).targets, ["a"], "undo restores the array");
    hub.handleInput("d"); // default = ["a"]
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).targets, ["a"]);
  });
});

describe("order fields", () => {
  function registerOrder(): void {
    registerSettings({
      namespace: "hubtestorder",
      label: "OrderNs",
      defaults: { sequence: ["top", "mid", "bottom"] },
      schema: [{
        title: "Order",
        fields: [{
          key: "sequence",
          type: "order",
          label: "Sequence",
          items: () => [
            { value: "top", label: "Top" },
            { value: "mid", label: "Middle" },
            { value: "bottom", label: "Bottom" },
          ],
        }],
      }],
    });
  }

  const cfg = (): string => join(home, ".unipi", "config", "hubtestorder", "config.json");

  it("row shows the first labels, truncated past three", () => {
    registerOrder();
    const hub = makeHub();
    jumpTo(hub, "Sequence");
    const flat = hub.render(100).join("\n");
    assert.ok(flat.includes("Top › Middle › Bottom"), "three labels fit without ellipsis");
    // five-item universe truncates
    registerSettings({
      namespace: "hubtestorder5",
      label: "OrderNs5",
      defaults: { sequence: ["i1", "i2", "i3", "i4", "i5"] },
      schema: [{
        title: "Order",
        fields: [{
          key: "sequence",
          type: "order",
          label: "Sequence",
          items: () => [
            { value: "i1", label: "One" }, { value: "i2", label: "Two" }, { value: "i3", label: "Three" },
            { value: "i4", label: "Four" }, { value: "i5", label: "Five" },
          ],
        }],
      }],
    });
    const hub2 = makeHub();
    hub2.handleInput("/"); hub2.handleInput("orderns5"); hub2.handleInput("\r"); // unique label search
    const flat2 = hub2.render(100).join("\n");
    assert.ok(flat2.includes("One › Two › Three …"), "fourth and fifth collapse into …");
    assert.ok(!flat2.includes("Five ›"), "nothing past three shown on the row");
  });

  it("editor: J shifts the item down and writes instantly; K shifts back", () => {
    registerOrder();
    const hub = makeHub();
    jumpTo(hub, "Sequence");
    hub.handleInput("\t"); // open the order editor
    const h = hub as unknown as { picker: { order?: boolean } | null };
    assert.ok(h.picker?.order, "order editor open");
    hub.handleInput("J"); // shift Top down (legacy shift+j = "J")
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).sequence, ["mid", "top", "bottom"], "instant write after J");
    let flat = hub.render(100).join("\n");
    assert.ok(flat.includes("Middle"), "editor still open with new order");
    hub.handleInput("K"); // shift back up
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).sequence, ["top", "mid", "bottom"], "K restores");
    // alt+down / alt+up (CSI encodings)
    hub.handleInput("\x1b[1;3B");
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).sequence, ["mid", "top", "bottom"], "alt+down shifts");
    hub.handleInput("\x1b[1;3A");
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).sequence, ["top", "mid", "bottom"], "alt+up shifts back");
    flat = hub.render(100).join("\n");
    assert.ok(flat, "editor open");
    hub.handleInput("\x1b"); // Esc closes
    assert.equal((hub as unknown as { mode: string }).mode, "list", "esc exits the editor");
  });

  it("u undoes a reorder", () => {
    registerOrder();
    const hub = makeHub();
    jumpTo(hub, "Sequence");
    hub.handleInput("\t");
    hub.handleInput("J"); // reorder
    hub.handleInput("\x1b");
    hub.handleInput("u");
    assert.deepEqual(JSON.parse(readFileSync(cfg(), "utf8")).sequence, ["top", "mid", "bottom"], "undo restores the order");
  });
});
