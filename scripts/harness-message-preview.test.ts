// UNI-49 focused tests — npx tsx --test scripts/harness-message-preview.test.ts
// Pure rendering/state assertions only: no terminal, no pi session, no LLM.
// goal.ts and fusion/prompts.ts are PURE modules — imported here so fixture
// drift from the real generators is caught.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bashNudge, EDIT_NUDGE } from "../packages/fusion/src/prompts.ts";
import { CONTINUATION_HINT, RECOVERY_FRAGMENT, renderKickoff, WRAP_UP_PROMPT } from "../packages/long-horizon/src/prompts/goal.ts";
import {
  FIXTURES,
  FIXTURE_IDS,
  PREVIEW_BANNER,
  STYLES,
  browserLines,
  createBrowser,
  galleryLines,
  handleKey,
  main,
  mixedLines,
  parseArgs,
  printAll,
  renderPanel,
  seedBrowser,
  stripAnsi,
} from "./harness-message-preview.ts";

const WIDTHS = [24, 40, 80, 120];
const PLAIN = (lines: string[]): string[] => lines.map(stripAnsi);
const joined = (lines: string[]): string => PLAIN(lines).join("\n");
/** Whitespace-normalized text: markdown reflows long phrases across lines. */
const flat = (lines: string[]): string => PLAIN(lines).join(" ").replace(/\s+/g, " ").trim();
/** Character-normalized text: detects tokens a wrap split across lines (rail glyphs stripped). */
const squashed = (lines: string[]): string => PLAIN(lines).join("").replace(/▏/g, "").replace(/\s+/g, "");

/** Every meaningful payload word must survive rendering. Tokens that a wrap
 * may legally split (CJK phrases, very long identifiers) may be recovered from
 * the character-normalized text instead of the line-preserving one. */
function assertWordsSurvive(payload: string, lines: string[], label: string): void {
  const text = flat(lines);
  const chars = squashed(lines);
  const tokens = payload
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+/u, "").replace(/[^\p{L}\p{N}_]+$/u, ""))
    .filter((w) => w.length > 0 && (w.length >= 2 || /\p{Script=Han}/u.test(w)));
  for (const token of tokens) {
    const mayWrap = /\p{Script=Han}/u.test(token) || token.length > 15;
    assert.ok(
      text.includes(token) || (mayWrap && chars.includes(token)),
      `${label}: payload word lost: ${JSON.stringify(token)}`,
    );
  }
}

function assertWithinWidth(lines: string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: row exceeds width ${width}: ${JSON.stringify(stripAnsi(line).slice(0, 80))}`,
    );
  }
}

test("banner promises design-preview only", () => {
  assert.equal(PREVIEW_BANNER, "DESIGN PREVIEW — no live renderer or model-role changes");
});

test("all styles × widths × expand states stay within width (gallery + mixed)", () => {
  for (const width of WIDTHS) {
    for (const style of STYLES) {
      for (const expanded of [false, true]) {
        assertWithinWidth(galleryLines(style, { width, expanded }), width, `gallery ${style} w=${width} exp=${expanded}`);
        assertWithinWidth(mixedLines(style, { width, expanded }).lines, width, `mixed ${style} w=${width} exp=${expanded}`);
      }
    }
  }
});

test("payload words survive expanded rendering at every width and style (incl. CJK + long identifier)", () => {
  for (const style of STYLES) {
    for (const width of WIDTHS) {
      for (const f of FIXTURES) {
        assertWordsSurvive(f.payload, galleryLines(style, { width, expanded: true }, [f.id]), `${f.id} ${style} w=${width}`);
      }
      assertWordsSurvive(
        "Please fix the footer TPS counter — it shows 0 on the first turn after a restart. Check the anchored output path first.",
        mixedLines(style, { width, expanded: true }).lines,
        `mixed ${style} w=${width}`,
      );
    }
  }
  // the width-stress fixture exists and carries the CJK + long identifier payload
  const stress = FIXTURES.find((f) => f.id === "width-stress")!;
  assert.ok(stress.payload.includes("UNI_HARNESS_PREVIEW_WIDTH_STRESS_IDENTIFIER_0123456789"));
  assert.ok(/\p{Script=Han}/u.test(stress.payload));
  assert.ok(stress.originNote!.includes("synthetic demo output"));
});

test("simple expanded renders the body at width-2 — the rail never eats wrapped words", () => {
  const f = FIXTURES.find((x) => x.id === "width-stress")!;
  for (const width of WIDTHS) {
    const panel = renderPanel(f, "simple", true, false, width);
    // every painted row starts with the violet rail glyph and stays within width
    for (const line of panel) {
      assert.ok(stripAnsi(line).startsWith("▏ "), `row missing rail at w=${width}: ${JSON.stringify(stripAnsi(line).slice(0, 40))}`);
      assert.ok(visibleWidth(line) <= width, `row over width at w=${width}`);
    }
    assertWordsSurvive(f.payload, panel, `simple-expanded w=${width}`);
  }
});

test("harness rows are painted with the dark-slate fill; human rows are not", () => {
  const harness = renderPanel(FIXTURES.find((f) => f.id === "runaway-guard")!, "simple", true, false, 80);
  assert.ok(harness.every((l) => l.includes("\x1b[48;2;32;34;45m")), "harness row missing #20222d fill");
  assert.ok(harness.every((l) => l.includes("\x1b[38;2;167;139;250m")), "harness row missing violet rail");
  const human = renderPanel(FIXTURES.find((f) => f.id === "human-task")!, "regular", false, false, 80);
  assert.ok(human.every((l) => !l.includes("\x1b[48;2;32;34;45m")), "fill leaked onto human panel");
});

test("detail rows and footers wrap — paths and the user role stay readable at width 24", () => {
  const f = FIXTURES.find((x) => x.id === "kanboard-do")!;
  const advanced = joined(renderPanel(f, "advanced", true, true, 24));
  assert.ok(advanced.includes("model role:"), "advanced footer lost at w=24");
  assert.ok(advanced.includes("user"), "user role not visible at w=24");
  const chars = squashed(renderPanel(f, "advanced", true, true, 24)).replace(/\/{2,}/g, "/");
  assert.ok(chars.includes("packages/kanboard/src/commands.ts"), "origin path cut instead of wrapped");
});

test("human text stays human — including a quoted 'No-progress guard' prefix", () => {
  for (const style of STYLES) {
    for (const id of ["human-task", "human-marker-prefix"]) {
      const f = FIXTURES.find((x) => x.id === id)!;
      const text = joined(renderPanel(f, style, false, false, 80));
      assert.ok(text.includes("YOU"), `${id}: YOU label missing in ${style}`);
      assert.ok(!text.includes("UniPi ·"), `${id}: harness label leaked into human panel in ${style}`);
      assert.ok(!text.includes("origin: harness"), `${id}: harness footer on human panel in ${style}`);
      assert.ok(flat(renderPanel(f, style, false, false, 80)).includes(f.check), `${id}: human payload mutated in ${style}`);
    }
  }
  const marker = FIXTURES.find((x) => x.id === "human-marker-prefix")!;
  const text = flat(renderPanel(marker, "advanced", true, true, 80));
  assert.ok(text.includes("No-progress guard: I keep seeing this reminder"), "marker fixture lost its quoted prefix");
  assert.ok(!text.includes("delivery: steer"), "human panel borrowed harness delivery footer");
});

test("harness panels carry the human-friendly label + UniPi mark; technical id sits in details", () => {
  for (const f of FIXTURES) {
    if (f.category !== "harness-direct" && f.category !== "harness-custom") continue;
    const text = joined(renderPanel(f, "simple", false, false, 100));
    assert.ok(text.includes("UniPi"), `${f.id}: missing UniPi label`);
    assert.ok(text.includes(f.label), `${f.id}: missing human-friendly label`);
    assert.ok(text.includes("e: full message"), `${f.id}: simple style missing expand indicator`);
    const withDetails = joined(renderPanel(f, "simple", false, true, 100));
    assert.ok(withDetails.includes(`id: ${f.id}`) || withDetails.includes(f.id), `${f.id}: technical id missing from details`);
  }
  const labels = FIXTURES.filter((f) => f.category.startsWith("harness")).map((f) => f.label);
  for (const expected of ["Ralph", "Kanboard", "Progress guard", "Memory", "Watchdog"]) {
    assert.ok(labels.includes(expected), `expected human-friendly label missing: ${expected}`);
  }
});

test("advanced footer says model role USER, never SYSTEM", () => {
  for (const f of FIXTURES) {
    if (f.category !== "harness-direct" && f.category !== "harness-custom") continue;
    const text = joined(renderPanel(f, "advanced", false, false, 100));
    assert.ok(text.includes("origin: harness | model role: user"), `${f.id}: advanced footer missing`);
    assert.ok(!/model role:\s*system/i.test(text), `${f.id}: SYSTEM role appeared`);
  }
});

test("hidden and tool-result categories are explicitly distinguished", () => {
  const text = joined(galleryLines("advanced", { width: 100, expanded: true }));
  assert.ok(text.includes("tool-result annotation"), "tool-annotation classification missing");
  assert.ok(text.includes("not a user message"), "tool-annotation 'not a user message' marker missing");
  assert.ok(text.includes("display:false · never rendered"), "hidden classification missing");
  assert.ok(text.includes("existing dedicated renderer"), "existing-renderer status missing");
  const hidden = FIXTURES.find((f) => f.id === "utility-continue")!;
  assert.equal(hidden.payload, "", "hidden fixture payload must be the actual empty string");
  const hiddenPanel = joined(renderPanel(hidden, "advanced", true, true, 100));
  assert.ok(hiddenPanel.includes("(empty content — display:false)"), "empty payload placeholder missing (render-only)");
  assert.ok(!hiddenPanel.includes("model role: user"), "hidden message rendered with a user-role footer");
  for (const id of ["fusion-edit-nudge", "kanboard-r1", "watchdog-kill"]) {
    const panel = joined(renderPanel(FIXTURES.find((f) => f.id === id)!, "simple", false, false, 100));
    assert.ok(panel.includes("tool-result annotation"), `${id}: missing classification`);
  }
});

test("fusion + goal fixtures are byte-equal to the pure source generators (drift guard)", () => {
  const edit = FIXTURES.find((f) => f.id === "fusion-edit-nudge")!;
  assert.equal(edit.payload, EDIT_NUDGE, "EDIT_NUDGE fixture drifted from packages/fusion/src/prompts.ts");
  assert.ok(edit.payload.startsWith("<system_guidance>") && edit.payload.endsWith("</system_guidance>"), "EDIT_NUDGE truncated");
  const bash = FIXTURES.find((f) => f.id === "fusion-bash-nudge")!;
  assert.equal(bash.payload, bashNudge(4), "bashNudge fixture drifted (count must be 4)");
  const kickoff = FIXTURES.find((f) => f.id === "goal-kickoff")!;
  assert.equal(
    kickoff.payload,
    renderKickoff("UNI-49: preview how harness-origin user-content is distinguished from human text"),
    "goal-kickoff fixture drifted from renderKickoff",
  );
  const continuation = FIXTURES.find((f) => f.id === "goal-continuation")!;
  assert.ok(continuation.payload.startsWith(CONTINUATION_HINT), "continuation fixture must start with the exact constant");
  const recovery = FIXTURES.find((f) => f.id === "goal-recovery")!;
  assert.equal(recovery.payload, RECOVERY_FRAGMENT, "recovery fixture drifted from RECOVERY_FRAGMENT");
  const wrapup = FIXTURES.find((f) => f.id === "lh-budget-wrapup")!;
  assert.equal(wrapup.payload, WRAP_UP_PROMPT, "budget wrap-up fixture drifted from WRAP_UP_PROMPT");
});

test("corrected fixture facts: ralph path, plan tool, nudge cap, abort toolName, memory counts", () => {
  const ralph = FIXTURES.find((f) => f.id === "ralph-iteration")!;
  assert.ok(ralph.payload.includes("Task file: .unipi/ralph/uni49-preview.md"), "ralph task file path wrong");
  const plan = FIXTURES.find((f) => f.id === "plan-on")!;
  assert.ok(plan.payload.includes("call plan_submit to ask for approval"), "plan tool must be plan_submit");
  assert.ok(!plan.payload.includes("propose_plan"), "stale propose_plan still present");
  const claim = FIXTURES.find((f) => f.id === "kanboard-claim")!;
  assert.ok(claim.payload.includes("(1/5)"), "claim nudge cap must be MAX_NUDGES_PER_TASK=5");
  const abort = FIXTURES.find((f) => f.id === "watchdog-abort")!;
  assert.equal(abort.payload, '⚠ Watchdog aborted "bash": jev judged it stuck.', "abort notice must quote the toolName only");
  const recall = FIXTURES.find((f) => f.id === "memory-recall")!;
  const titleCount = (recall.payload.match(/^- /gm) ?? []).length;
  assert.equal(titleCount, 20, "memory recall must show 20 titles (generator slice)");
  assert.ok(recall.payload.includes("... and 327 more"), "memory recall remainder line wrong (347 total)");
  assert.ok(recall.delivery.includes("before_agent_start"), "memory recall delivery must say before_agent_start");
  const consolidation = FIXTURES.find((f) => f.id === "memory-consolidation")!;
  assert.ok(consolidation.payload.includes("Review the current session"), "consolidation wrapper missing");
  assert.ok(consolidation.transport.includes("sendUserMessage"), "consolidation is a direct transport");
  for (const id of ["kanboard-claim", "kanboard-next", "ralph-iteration"]) {
    const f = FIXTURES.find((x) => x.id === id)!;
    assert.ok(f.transport.includes("entry") || f.transport.includes("nudge"), `${id}: arbiter/monitor boundary must say custom entry, not sendMessage`);
  }
});

test("full body survives expansion; collapsed advanced shows a truncation hint", () => {
  const f = FIXTURES.find((x) => x.id === "goal-kickoff")!;
  const collapsed = flat(renderPanel(f, "advanced", false, false, 90));
  assert.ok(collapsed.includes("e: expand full"), "collapsed advanced lacks expand hint");
  const expanded = flat(renderPanel(f, "advanced", true, false, 90));
  assert.ok(expanded.includes("blocked threshold is satisfied"), "expanded advanced lost the tail of the body");
  const simpleCollapsed = flat(renderPanel(f, "simple", false, false, 90));
  assert.ok(!simpleCollapsed.includes("blocked threshold"), "simple collapsed should not inline the full body");
  const simpleExpanded = flat(renderPanel(f, "simple", true, false, 90));
  assert.ok(simpleExpanded.includes("blocked threshold is satisfied"), "simple expanded lost the full message");
});

test("CLI: unknown style/fixture exit 2, help exits 0", () => {
  assert.equal(main(["--style", "bogus"]), 2);
  assert.equal(main(["--fixture", "not-a-fixture"]), 2);
  assert.equal(main(["--scenario", "nope"]), 2);
  assert.equal(main(["--frobnicate"]), 2);
  assert.equal(main(["--help"]), 0);
});

test("--plain strips every ANSI escape", () => {
  const plain = printAll({ plain: true, styles: [...STYLES], scenario: "both", fixture: null, width: 72, expanded: false });
  assert.ok(!plain.includes("\x1b"), "plain output still contains ANSI");
  assert.ok(plain.includes(PREVIEW_BANNER), "plain output lost the banner");
  const color = printAll({ plain: false, styles: ["simple"], scenario: "mixed", fixture: null, width: 72, expanded: false });
  assert.ok(color.includes("\x1b["), "colored output unexpectedly plain");
});

test("deterministic output; only pi's own dark theme is installed (no cyan preview theme)", () => {
  const once = galleryLines("regular", { width: 80, expanded: false });
  const twice = galleryLines("regular", { width: 80, expanded: false });
  assert.deepEqual(once, twice, "rendering is not deterministic");
  const allText = printAll({ plain: false, styles: [...STYLES], scenario: "both", fixture: null, width: 80, expanded: true });
  assert.ok(!allText.includes("\x1b[48;2;18;54;59m"), "UNI-2 cyan fill leaked into the harness preview");
  assert.ok(!allText.includes("\x1b[38;2;34;211;238m"), "UNI-2 cyan rail leaked into the harness preview");
  // the only theme override is pi's own built-in dark theme, installed in-memory
  assert.ok(!allText.includes("\x1b[38;2;34;211;238m"), "cyan rail fg leaked (double-check)");
});

test("mixed scenario: human first/last, runaway top-level, consolidation/watchdog/autowork present", () => {
  const { lines } = mixedLines("simple", { width: 96, expanded: false });
  const text = flat(lines);
  const firstHuman = text.indexOf("YOU");
  assert.ok(firstHuman >= 0, "mixed scenario missing human opener");
  assert.ok(text.includes("· Progress guard ·"), "runaway guard missing as a top-level mixed event");
  assert.ok(text.includes("consolidation request"), "memory consolidation wrapper missing");
  assert.ok(text.includes("drained"), "watchdog custom warning batch missing");
  assert.ok(text.includes("autowork mode"), "kanboard autowork wrapper missing");
  assert.ok(text.includes("existing dedicated renderer; not redesigned"), "background completion stand-in unmarked");
  assert.ok(text.includes("ASSISTANT"), "assistant stand-in missing");
  assert.ok(text.includes("demo tool stand-in"), "tool stand-in missing");
  const kanboard = text.indexOf("· Kanboard ·");
  const guard = text.indexOf("· Progress guard ·");
  const ralph = text.indexOf("· Ralph ·");
  assert.ok(kanboard > firstHuman && kanboard < guard && guard < ralph, "mixed ordering broken");
  assert.ok(text.lastIndexOf("YOU") > ralph, "human reply must close the mixed scenario");
});

test("browser seeding: explicit --scenario wins; explicit --fixture opens the gallery on it", () => {
  const fixtureOnly = parseArgs(["--fixture", "goal-kickoff"]);
  assert.ok(fixtureOnly.ok);
  const s1 = seedBrowser(fixtureOnly.opts);
  assert.equal(s1.scenario, "gallery");
  assert.equal(FIXTURE_IDS[s1.fixtureIndex], "goal-kickoff");

  const mixedWins = parseArgs(["--fixture", "goal-kickoff", "--scenario", "mixed"]);
  assert.ok(mixedWins.ok);
  const s2 = seedBrowser(mixedWins.opts);
  assert.equal(s2.scenario, "mixed", "explicit --scenario mixed must win over --fixture");

  const all = parseArgs(["--fixture", "all"]);
  assert.ok(all.ok);
  assert.equal(seedBrowser(all.opts).scenario, "mixed", "no fixture → default mixed");

  const plain = parseArgs(["--interactive", "--style", "simple"]);
  assert.ok(plain.ok);
  const s3 = seedBrowser(plain.opts);
  assert.equal(s3.scenario, "mixed");
  assert.equal(s3.style, "simple");
});

test("browser header: two rows so style + fixture survive narrow widths; short keys when narrow", () => {
  const state = createBrowser({ scenario: "gallery", fixtureIndex: FIXTURE_IDS.indexOf("goal-kickoff"), rows: 20 });
  const frame = browserLines(state, 60);
  assert.ok(stripAnsi(frame[0]!).includes("DESIGN PREVIEW"), "banner row missing");
  assert.ok(stripAnsi(frame[1]!).includes("style simple"), "status row lost the style");
  assert.ok(stripAnsi(frame[1]!).includes("goal-kickoff"), "status row lost the fixture id");
  const narrow = browserLines(createBrowser({ rows: 20 }), 24);
  assert.ok(stripAnsi(narrow[1]!).startsWith("style "), "narrow status row must lead with the style");
  assert.ok(stripAnsi(narrow[narrow.length - 1]!).includes("1/2/3"), "narrow key help missing");
  const wide = browserLines(createBrowser({ rows: 20 }), 110);
  assert.ok(stripAnsi(wide[wide.length - 1]!).includes("pgup/pgdn"), "wide key help missing");
});

test("browser keys: styles, scenario toggle (scroll reset), fixture cycle (scroll reset), expand, details, scroll, quit", () => {
  const state = createBrowser({ rows: 12 });
  assert.equal(state.scenario, "mixed");
  handleKey(state, "m");
  assert.equal(state.scenario, "gallery");
  handleKey(state, "3");
  assert.equal(state.style, "simple");
  handleKey(state, "1");
  assert.equal(state.style, "regular");
  handleKey(state, "2");
  assert.equal(state.style, "advanced");
  const first = FIXTURE_IDS[state.fixtureIndex];
  // use a long body so scrolling has range
  state.fixtureIndex = FIXTURE_IDS.indexOf("goal-kickoff");
  const seeded = FIXTURE_IDS[state.fixtureIndex];
  state.expanded = true;
  state.scroll = 0;
  handleKey(state, "\x1b[6~"); // pageDown
  handleKey(state, "\x1b[6~");
  assert.ok(state.scroll > 0, "pageDown did not scroll");
  handleKey(state, "n");
  assert.equal(
    FIXTURE_IDS[state.fixtureIndex],
    FIXTURE_IDS[(FIXTURE_IDS.indexOf(seeded!) + 1) % FIXTURE_IDS.length],
  );
  assert.equal(state.scroll, 0, "fixture change must reset scroll");
  state.expanded = false;
  handleKey(state, "e");
  assert.equal(state.expanded, true);
  handleKey(state, "d");
  assert.equal(state.details, true);
  handleKey(state, "\x1b[B" /* down */);
  assert.ok(state.scroll >= 1, "down arrow did not scroll");
  handleKey(state, "m"); // back to mixed
  assert.equal(state.scenario, "mixed");
  assert.equal(state.scroll, 0, "scenario change must reset scroll");
  // style change re-clamps to the new layout (mixed expanded has range)
  handleKey(state, "e");
  state.scroll = 999;
  handleKey(state, "1");
  assert.ok(state.scroll < 999, "scroll not re-clamped after style change");
  assert.ok(state.scroll >= 0, "scroll went negative");
  const frame = browserLines(state, 80);
  assert.ok(frame.length <= state.rows - 1, "frame exceeds terminal rows");
  handleKey(state, "q");
  assert.equal(state.quit, true);
});

test("clamp recomputes AFTER mutation: collapse and style change pull scroll into the new range immediately", () => {
  const idx = FIXTURE_IDS.indexOf("goal-kickoff");
  const viewRows = Math.max(6, 12 - 4);
  const maxFor = (expanded: boolean, style: "regular" | "advanced" | "simple") => {
    const lines = galleryLines(style, { width: 96, expanded }, ["goal-kickoff"]);
    return Math.max(0, lines.length - viewRows);
  };
  const collapse = createBrowser({ scenario: "gallery", fixtureIndex: idx, expanded: true, rows: 12 });
  collapse.scroll = 999;
  handleKey(collapse, "e"); // collapse → much shorter body
  assert.equal(collapse.expanded, false);
  assert.ok(collapse.scroll <= maxFor(false, "simple"), `collapse clamp not applied to state (scroll=${collapse.scroll}, max=${maxFor(false, "simple")})`);
  const styleShift = createBrowser({ scenario: "gallery", fixtureIndex: idx, expanded: true, style: "advanced", rows: 12 });
  styleShift.scroll = 999;
  handleKey(styleShift, "1"); // switch style → different body length
  assert.equal(styleShift.style, "regular");
  assert.ok(styleShift.scroll <= maxFor(true, "regular"), `style clamp not applied to state (scroll=${styleShift.scroll}, max=${maxFor(true, "regular")})`);
});

test("mixed n/←→ walk event anchors without crashing at bounds", () => {
  const state = createBrowser({ scenario: "mixed", rows: 10 });
  for (let i = 0; i < 20; i++) handleKey(state, "n", 80);
  for (let i = 0; i < 24; i++) handleKey(state, "\x1b[D", 80);
  assert.ok(state.scroll >= 0, "scroll went negative");
});
