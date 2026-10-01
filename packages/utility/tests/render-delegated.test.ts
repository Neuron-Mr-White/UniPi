/**
 * @pi-unipi/utility — render/delegated.ts: the approved UNI-2 delegated-panel
 * renderer against pi's REAL CustomEntryComponent host (deep import), so the
 * wrapper/unwrap path the spacing patch relies on is exercised end to end.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setSettings } from "@pi-unipi/core";
// Registers the "utility" settings namespace (module side effect).
import "@pi-unipi/utility/src/settings.js";
import { findTranscriptContainer, patchTranscriptSpacing, type SpacingGroupPosition, type TranscriptContainer } from "../src/render/spacing.js";
import { delegatedPanelBg, nativeFactoryStats, paintDelegatedLine, renderDelegatedStep, stripNestedBackgrounds, type DelegatedStep } from "../src/render/delegated.ts";

// This file writes the utility render style via setSettings(..., "global") —
// global settings resolve from the real HOME, so isolate HOME and the pi
// agent dir before ANY settings/theme call and restore after the suite.
const scratch = mkdtempSync(join(tmpdir(), "uni-delegated-"));
const prevEnv: Array<[string, string | undefined]> = [
  ["HOME", process.env.HOME],
  ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
  ["PI_AGENT_DIR", process.env.PI_AGENT_DIR],
];
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_AGENT_DIR = join(scratch, "agent");
after(() => {
  for (const [name, value] of prevEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

initTheme("dark");
setSettings("utility", { render: { style: "simple" } }, "global", scratch);

const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { CustomEntryComponent } = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/components/custom-entry.js")).href)) as {
  CustomEntryComponent: new (entry: unknown, renderer: (entry: unknown, opts: { expanded: boolean }, theme: unknown) => unknown) => {
    render(width: number): string[];
    setExpanded(expanded: boolean): void;
    invalidate(): void;
  };
};

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never as Theme;
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "").trimEnd();

const PANEL_BG = delegatedPanelBg(undefined);
const RAIL_FG = "\x1b[38;2;34;211;238m";

const tool = (over: Partial<Extract<DelegatedStep, { kind: "tool" }>> = {}): DelegatedStep => ({
  kind: "tool", name: "bash", arg: "pwd && ls", output: "a\nb\nc", isError: false, durationMs: 12,
  args: { command: "pwd && ls" }, ...over,
});
const text = (body: string, thinking?: string): DelegatedStep => ({ kind: "text", text: body, thinking });

/** A real CustomEntryComponent host around the shared renderer. */
function entry(step: DelegatedStep, group: string, label?: string) {
  return new CustomEntryComponent({ customType: "sidekick-step", data: step }, (e, opts) =>
    renderDelegatedStep((e as { data: DelegatedStep }).data, opts.expanded, theme, { group, label })) as unknown as { render(w: number): string[]; setExpanded(b: boolean): void };
}

function chatWith(children: Array<{ render(w: number): string[] }>): TranscriptContainer {
  return { children: children as never, render: (w: number) => children.flatMap((c) => c.render(w)) };
}

function patched(children: Array<{ render(w: number): string[] }>): TranscriptContainer {
  const chat = chatWith(children);
  patchTranscriptSpacing(chat);
  return chat;
}

describe("renderDelegatedStep (real CustomEntryComponent host)", () => {
  it("adjacent same-group entries join continuous: no gaps, ├├└ tree, label once", () => {
    const chat = patched([
      entry(tool(), "sidekick:h1", "Sidekick"),
      entry(tool({ name: "read", arg: "a.ts", args: { path: "a.ts" } }), "sidekick:h1", "Sidekick"),
      entry(tool({ output: "" }), "sidekick:h1", "Sidekick"),
    ]);
    const lines = chat.render(80).map(strip);
    assert.equal(lines.length, 4, `label + 3 rows, no separators: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], "▏ ◆ Sidekick");
    assert.match(lines[1]!, /^▏ ├ • Ran {2}pwd && ls/);
    assert.match(lines[2]!, /^▏ ├ • Read \(a\.ts\)/);
    assert.match(lines[3]!, /^▏ └ • Ran {2}pwd && ls/);
  });

  it("different groups render as separate panels with a real gap between", () => {
    const chat = patched([entry(tool(), "sidekick:h1"), entry(tool(), "sidekick:h2")]);
    const lines = chat.render(80).map(strip);
    const gap = lines.findIndex((l, i) => i > 0 && l === "");
    assert.ok(gap > 0, `gap between panels: ${JSON.stringify(lines)}`);
    assert.ok(lines[0]!.startsWith("▏") && lines[gap - 1]!.startsWith("▏") && lines[gap + 1]!.startsWith("▏"));
  });

  it("lead tool rows separate panels; mouseLayout heights track outer children", () => {
    const lead = { updateArgs() {}, updateResult() {}, render: () => ["lead row"] };
    const chat = patched([lead, entry(tool(), "g1"), entry(tool(), "g1")]);
    const lines = chat.render(80).map(strip);
    assert.equal(lines[0], "lead row");
    assert.equal(lines[1], "", "gap between lead and panel");
    assert.ok(chat.mouseLayout !== undefined);
    // pi attributes the separator row to the child below it, so e1's outer
    // height is separator + row (2) — the joined e2 stays 1.
    assert.deepEqual(chat.mouseLayout!.children.map((c) => c.height), [1, 2, 1]);
    assert.equal(chat.mouseLayout!.children.reduce((a, c) => a + c.height, 0), chat.render(80).length);
  });

  it("expansion rebuilds the inner component and positions re-apply", () => {
    const e1 = entry(tool(), "g1");
    const e2 = entry(tool(), "g1");
    const chat = patched([e1, e2]);
    const before = chat.render(80).map(strip);
    assert.equal(before.length, 2);
    e1.setExpanded(true);
    const after = chat.render(80).map(strip);
    assert.ok(after.length > 3, "expanded output rows appear");
    assert.match(after[0]!, /^▏ ├/, "first member still ├ after rebuild");
    assert.match(after[after.length - 1]!, /^▏ └/, "last member still └ after rebuild");
  });

  it("a transcript of only custom entries is discovered and patched", () => {
    const host = patched([entry(tool(), "g1"), entry(tool(), "g1")]);
    const root = { children: [{ children: host.children, render: (w: number) => host.children.flatMap((c: any) => c.render(w)) }] };
    assert.equal(findTranscriptContainer(root), root.children[0], "custom-entry-only host found");
  });

  it("positions reset when a member leaves the group run", () => {
    const positions: SpacingGroupPosition[] = [];
    const member = {
      render: () => ["m"],
      spacingGroup: "g1",
      spacingKind: "tool",
      setGroupPosition: (p: SpacingGroupPosition) => positions.push(p),
    };
    const chat = patched([member]);
    chat.render(80);
    const first = positions.at(-1)!;
    assert.equal(first.index, 0);
    assert.equal(first.count, 1);
    // A non-group child splits the run: the persistent member is reset.
    chat.children.push({ render: () => ["lead"], updateArgs() {}, updateResult() {} } as never);
    chat.render(80);
    const last = positions.at(-1)!;
    assert.equal(last.index, 0);
    assert.equal(last.count, 1);
  });

  it("rail+fill on every row incl blanks; no nested bg escapes; bounded at 100/24/8", () => {
    for (const style of ["regular", "advanced", "simple"] as const) {
      for (const width of [100, 24, 8]) {
        const comp = renderDelegatedStep(tool({ output: Array.from({ length: 9 }, (_, i) => `line-${i}`).join("\n") }), false, theme, { group: "g", style });
        for (const l of comp.render(width)) {
          assert.ok(visibleWidth(l) <= width, `${style}/${width}: ${JSON.stringify(strip(l))}`);
          assert.ok(l.includes(PANEL_BG), `${style}/${width}: row missing panel fill`);
          assert.ok(l.includes(`${RAIL_FG}▏`), `${style}/${width}: row missing rail`);
          for (const m of l.matchAll(/48;2;(\d+);(\d+);(\d+)/g)) {
            assert.equal(`${m[1]};${m[2]};${m[3]}`, "18;54;59", `${style}/${width}: nested truecolor bg ${m[0]}`);
          }
          assert.ok(!/48;5;/.test(l), `${style}/${width}: 256-colour bg escaped`);
        }
      }
    }
  });

  it("legacy fallback: no raw args in regular style renders ◆ lines", () => {
    const comp = renderDelegatedStep(tool({ args: undefined }), false, theme, { group: "g", style: "regular" });
    const lines = comp.render(80).map(strip);
    assert.ok(!lines.some((l) => l.includes("$ ")), "no native card");
    assert.match(lines[0]!, /^▏ ◆ bash pwd && ls/);
  });

  it("thinking: hidden collapsed, provider-stored string shown expanded", () => {
    const collapsed = renderDelegatedStep(text("visible prose", "provider stored string"), false, theme, { group: "g" }).render(80).map(strip);
    assert.ok(collapsed.some((l) => l.includes("visible prose")));
    assert.ok(!collapsed.some((l) => l.includes("provider stored string")));
    const expanded = renderDelegatedStep(text("visible prose", "provider stored string"), true, theme, { group: "g" }).render(80).map(strip);
    assert.ok(expanded.some((l) => l.includes("thinking")));
    assert.ok(expanded.some((l) => l.includes("provider stored string")));
  });

  it("errors: red ✗/× markers and failed verbs per style", () => {
    assert.match(renderDelegatedStep(tool({ isError: true, args: undefined }), false, theme, { group: "g", style: "simple" }).render(80).map(strip).join("\n"), /× Command failed/);
    assert.match(renderDelegatedStep(tool({ isError: true, args: undefined }), false, theme, { group: "g", style: "advanced" }).render(80).map(strip).join("\n"), /Command failed/);
    assert.match(renderDelegatedStep(tool({ isError: true, args: undefined }), false, theme, { group: "g", style: "regular" }).render(80).map(strip).join("\n"), /✗/);
  });

  it("group header drawn exactly once across the run", () => {
    const chat = patched([entry(tool(), "g1", "General subagent · demo"), entry(tool(), "g1", "General subagent · demo")]);
    const lines = chat.render(80).map(strip);
    assert.equal(lines.filter((l) => l.includes("General subagent · demo")).length, 1);
  });

  it("blank interior rows (native pad) are rail-painted, not gaps", () => {
    const comp = renderDelegatedStep(tool({ output: Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n") }), true, theme, { group: "g", style: "regular" });
    const lines = comp.render(80).map(strip);
    assert.ok(lines.some((l) => l === "▏"), "blank panel row present");
    for (const l of comp.render(80)) assert.ok(l.includes(PANEL_BG), "blank row painted");
  });

  it("paintDelegatedLine + stripNestedBackgrounds basics", () => {
    assert.equal(stripNestedBackgrounds("a\x1b[48;2;90;20;20mb\x1b[49m"), "ab");
    assert.equal(stripNestedBackgrounds("a\x1b[48;5;17mb"), "ab");
    assert.equal(stripNestedBackgrounds("a\x1b[38;2;255;107;107mx"), "a\x1b[38;2;255;107;107mx");
    const painted = paintDelegatedLine("hello", 20);
    assert.equal(visibleWidth(painted), 20);
    assert.ok(painted.includes(PANEL_BG));
    assert.equal(visibleWidth(paintDelegatedLine("x", 8)), 8);
  });
});

describe("renderDelegatedStep rework regressions", () => {
  it("getColorMode '256color': exact cube indices for the approved palette, no truecolor", () => {
    const theme256 = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      getColorMode: () => "256color" as const,
    };
    for (const style of ["simple", "advanced", "regular"] as const) {
      const comp = renderDelegatedStep(tool({ args: undefined, output: "a\nb" }), false, theme256 as never, { group: "g", style });
      for (const l of comp.render(80)) {
        // Rail #22d3ee: channels 34/211/238 → cube 0/175/255 = 16+36·0+6·3+5 = 45
        // (cyan cube cell, NOT grayscale); panel #12363b: 18/54/59 — nearest
        // ramp entry 48 (232+4) genuinely beats the closest cube cell under the
        // weighted distance (pi-identical math), so the fill is 48;5;236.
        assert.ok(l.includes("\x1b[38;5;45m"), `${style}: rail fg is cube cell 45 (cyan)`);
        assert.ok(l.includes("\x1b[48;5;236m"), `${style}: panel fill present`);
        assert.ok(!/48;2;\d+;\d+;\d+/.test(l), `${style}: no truecolor bg`);
        assert.ok(!/38;2;\d+;\d+;\d+/.test(l), `${style}: no truecolor fg from our palette`);
        assert.ok(l.includes("▏"), `${style}: rail glyph`);
      }
    }
  });

  it("group removal: persistent owner row flips ├ → └ on the next render, no stale pos", () => {
    const positions: SpacingGroupPosition[] = [];
    const owner: { render(w: number): string[]; spacingGroup?: string; spacingKind: string; setGroupPosition(p: SpacingGroupPosition): void } = {
      render: (w: number) => {
        const p = positions.at(-1);
        return [p !== undefined && p.index === 0 && p.count > 1 ? `▏ ├ row ${String(w)}` : `▏ └ row ${String(w)}`];
      },
      spacingGroup: "g1",
      spacingKind: "tool",
      setGroupPosition: (p) => positions.push(p),
    };
    const sibling = { render: () => ["▏ └ sib"], spacingGroup: "g1", spacingKind: "tool" };
    const chat = chatWith([owner, sibling]);
    patchTranscriptSpacing(chat);
    assert.match(strip(chat.render(80)[0]!), /├/, "grouped with nextKind tool → ├");
    // Group removed from the persistent owner between renders.
    delete owner.spacingGroup;
    const lines = chat.render(80).map(strip);
    assert.match(lines[0]!, /└/, "├ → └ same tick after removal");
    assert.ok(!lines.some((l) => l.includes("├ row")), `no stale ├: ${JSON.stringify(lines)}`);
    assert.equal(positions.at(-1)!.index, 0);
    assert.equal(positions.at(-1)!.count, 1);
  });

  it("unchanged re-render does not re-run the native factory; position change still reflects", () => {
    const e1 = entry(tool(), "g1");
    const e2 = entry(tool({ name: "read", arg: "a.ts", args: { path: "a.ts" } }), "g1");
    const chat = chatWith([e1, e2]);
    patchTranscriptSpacing(chat);
    chat.render(80);
    chat.render(80);
    const settled = nativeFactoryStats.calls;
    chat.render(80);
    chat.render(80);
    assert.equal(nativeFactoryStats.calls, settled, "identical re-render reuses the cached native component");
    const lines = chat.render(80).map(strip);
    assert.match(lines.filter((l) => l.startsWith("▏"))[0]!, /├/, "positioned connector still applied");
  });
});
