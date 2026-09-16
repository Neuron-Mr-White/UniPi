import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelPicker, type PickerResult, type PickerState } from "../src/picker.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const TAB = "\t";
const ENTER = "\r";
const ESCAPE = ESC;

function state(over: Partial<PickerState> = {}): PickerState {
  return {
    models: [
      { key: "a/opus", name: "Opus", provider: "a", cost: { input: 10, cachedInput: 0.25, output: 50 }, reasoning: true },
      { key: "b/glm", name: "GLM Flash", provider: "b", cost: { input: 0.2, cachedInput: 0.02, output: 1.2 }, reasoning: true },
      { key: "c/mini", name: "Mini", provider: "c", reasoning: false },
    ],
    fusionLeads: ["a/opus"],
    fusionSidekicks: ["b/glm", "c/mini"],
    fusionDefault: { lead: "a/opus", sidekick: "b/glm" },
    recent: ["c/mini"],
    active: { kind: "single", model: "b/glm" },
    currentModelKey: "b/glm",
    effort: { "a/opus": "medium" },
    fallbackEffort: "low",
    ...over,
  };
}

function run(s: PickerState, keys: string[]): { result: PickerResult | undefined; picker: ModelPicker } {
  let result: PickerResult | undefined;
  const picker = new ModelPicker({ state: s, theme, onDone: (r) => (result = r) });
  for (const k of keys) picker.handleInput(k);
  return { result, picker };
}

test("row order: active pinned, Fusion, recent, preset, then the rest of the catalogue", () => {
  const { picker } = run(state(), []);
  assert.deepEqual(picker.rows(), [
    { kind: "model", key: "b/glm" },
    { kind: "fusion" },
    { kind: "model", key: "c/mini" },
    { kind: "model", key: "a/opus" },
  ]);
});

test("every catalogue model is listed even with a preset", () => {
  const { picker } = run(state({ models: [...state().models, { key: "d/other", name: "Other", provider: "d", reasoning: false }] }), []);
  assert.deepEqual(picker.rows().map((r) => (r.kind === "model" ? r.key : "fusion")), [
    "b/glm", "fusion", "c/mini", "a/opus", "d/other",
  ]);
});

test("active fusion pins the Fusion row first", () => {
  const { picker } = run(state({ active: { kind: "fusion", lead: "a/opus", sidekick: "b/glm" } }), []);
  assert.equal(picker.rows()[0]?.kind, "fusion");
});

test("search filters but keeps the pinned row", () => {
  const { picker } = run(state(), ["o", "p"]);
  assert.deepEqual(picker.rows(), [{ kind: "model", key: "b/glm" }, { kind: "fusion" }, { kind: "model", key: "a/opus" }]);
});

test("←/→ steps per-model effort and confirm returns it", () => {
  const { result } = run(state(), [RIGHT, RIGHT, ENTER]);
  assert.equal(result?.type, "single");
  if (result?.type === "single") {
    assert.equal(result.model, "b/glm");
    assert.equal(result.effort, "high"); // fallback low → medium → high
  }
});

test("effort clamps at both ends", () => {
  const { result } = run(state(), [LEFT, LEFT, LEFT, LEFT, LEFT, ENTER]);
  assert.equal(result?.type === "single" && result.effort, "off");
  const { result: r2 } = run(state(), Array<string>(10).fill(RIGHT).concat(ENTER));
  assert.equal(r2?.type === "single" && r2.effort, "max");
});

test("Fusion row: tab → lead dropdown → tab → sidekick dropdown → pick → confirm", () => {
  const { result } = run(state(), [DOWN, TAB, TAB, DOWN, ENTER, ENTER]);
  assert.equal(result?.type, "fusion");
  if (result?.type === "fusion") {
    assert.equal(result.lead, "a/opus");
    assert.equal(result.sidekick, "c/mini");
    assert.equal(result.leadEffort, "medium");
    assert.equal(result.sidekickEffort, "low");
  }
});

test("esc in dropdown collapses instead of cancelling", () => {
  const { result, picker } = run(state(), [DOWN, TAB, ESCAPE]);
  assert.equal(result, undefined);
  picker.handleInput(ESCAPE);
});

test("render includes price columns for fusion incl. sidekick", () => {
  const { picker } = run(state(), [DOWN]);
  const text = picker.render(140).join("\n");
  assert.match(text, /Sidekick input/);
  assert.match(text, /\$10 \/ 1M/);
  assert.match(text, /\$0\.2 \/ 1M/);
  assert.match(text, /tab lead/);
});

test("price headers reserve space for cached input", () => {
  const text = run(state(), [DOWN]).picker.render(160).join("\n");
  assert.match(text, /Sidekick cached input {2,}Sidekick output/);
  assert.doesNotMatch(text, /inputSidekick output/);
});

test("zero pricing renders no marker and provider pricing guidance", () => {
  const models = state().models.map((model) => ({ ...model, cost: { input: 0, cachedInput: 0, output: 0 } }));
  const text = run(state({ models }), [DOWN]).picker.render(120).join("\n");
  assert.match(text, /no pricing data from provider/);
  assert.doesNotMatch(text, /●/);
});

test("an unpriced highlighted row shows provider pricing guidance", () => {
  const text = run(state(), [DOWN, DOWN]).picker.render(120).join("\n");
  assert.match(text, /no pricing data from provider/);
});

test("empty preset still shows a disabled Fusion row before the catalogue", () => {
  const { picker } = run(state({ fusionLeads: [], fusionSidekicks: [], fusionDefault: {}, recent: [], active: undefined }), []);
  assert.deepEqual(picker.rows().map((r) => (r.kind === "model" ? r.key : "fusion")), ["fusion", "a/opus", "b/glm", "c/mini"]);
});

test("disabled Fusion row cannot be confirmed or expanded", () => {
  const empty = state({ fusionLeads: [], fusionSidekicks: [], fusionDefault: {}, recent: [], active: undefined, effort: {} });
  assert.equal(run(empty, [ENTER]).result, undefined);
  const tabbed = run(empty, [TAB]);
  const tabbedText = tabbed.picker.render(140).join("\n");
  assert.doesNotMatch(tabbedText, /no lead models in preset/);
  assert.doesNotMatch(tabbedText, /▸/);
  const selected = run(empty, [RIGHT, DOWN, ENTER]).result;
  assert.equal(selected?.type, "single");
  if (selected?.type === "single") {
    assert.equal(selected.model, "a/opus");
    assert.equal(selected.effort, "low");
  }
});

test("disabled Fusion row renders setup hint", () => {
  const empty = state({ fusionLeads: [], fusionSidekicks: [], fusionDefault: {}, recent: [], active: undefined, effort: {} });
  const text = run(empty, []).picker.render(160).join("\n");
  assert.match(text, /not configured — run \/unipi:fusion-preset/);
  assert.match(text, /Run \/unipi:fusion-preset to enable Fusion/);
  assert.doesNotMatch(text, /tab lead/);
  assert.doesNotMatch(text, /↵ confirm/);
  assert.doesNotMatch(text, /no pricing data from provider/);
});

test("fusion-row effort is independent of per-model effort", () => {
  // Select the Fusion row and bump its effort twice (medium → xhigh).
  const { picker } = run(state(), [DOWN, RIGHT, RIGHT]);
  const text = picker.render(140).join("\n");
  assert.match(text, /Fusion\s+← ▰▰▰▰▰ → XHigh/);
  // The lead model's own row keeps its remembered level (medium = 3 filled).
  assert.match(text, /Opus\s+▰▰▰▱▱\s+Medium/);
});

test("badges render with a colored legend only when present", () => {
  const plain = run(state(), []).picker.render(100).join("\n");
  assert.doesNotMatch(plain, /✱ New/);
  const withBadge = run(state({ models: state().models.map((m) => m.key === "b/glm" ? { ...m, badge: "new" } : m) }), []).picker.render(100).join("\n");
  assert.match(withBadge, /✱/);
  assert.match(withBadge, /✱ New/);
});

test("a single active model lights up with ✓", () => {
  const { picker } = run(state(), []);
  const text = picker.render(140).join("\n");
  assert.match(text, /✓ GLM Flash/);
});

test("when fusion is selected, the Fusion row carries the check and plain rows carry none", () => {
  const { picker } = run(state({ active: { kind: "fusion", lead: "a/opus", sidekick: "c/mini" }, currentModelKey: "a/opus" }), []);
  const text = picker.render(140).join("\n");
  assert.match(text, /✓ Fusion/);
  // exactly one check in the whole overlay
  assert.equal((text.match(/✓/gu) ?? []).length, 1);
  assert.doesNotMatch(text, /◆/);
});

test("wraps selection with ↑ from the top", () => {
  const { result } = run(state(), [UP, ENTER]);
  assert.equal(result?.type === "single" && result.model, "a/opus");
});
