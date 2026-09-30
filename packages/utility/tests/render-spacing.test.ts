/**
 * @pi-unipi/utility — transcript spacing normalization
 *
 * pi puts a leading Spacer before every chat block; blocks that additionally
 * pad themselves stack 2-4 blank rows. patchTranscriptSpacing trims each
 * child's edge blanks and joins non-empty blocks with exactly one gap.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findTranscriptContainer, patchTranscriptSpacing, type SpacingGroupPosition, type TranscriptContainer } from "../src/render/spacing.ts";

const block = (lines: string[]) => ({ render: (_w: number) => [...lines], invalidate() {} });

function container(children: Array<{ render(w: number): string[] }>): TranscriptContainer {
  return { children, render: (w: number) => children.flatMap((c) => c.render(w)) };
}

/** pi's assistant component shape (contentContainer + hasToolCalls + updateContent). */
const assistant = () => ({
  contentContainer: { children: [] },
  hasToolCalls: false,
  updateContent() {},
  render: (w: number) => [`reply ${String(w)}`],
});

describe("patchTranscriptSpacing", () => {
  it("collapses adjacent edge blanks to exactly one gap between blocks", () => {
    const c = container([
      block(["", "● first reply", "", ""]),
      block(["", "", "└ • Ran ls · 2 output lines", ""]),
      block(["", "● second reply"]),
    ]);
    patchTranscriptSpacing(c);
    const lines = c.render(80);
    assert.deepEqual(lines, ["● first reply", "", "└ • Ran ls · 2 output lines", "", "● second reply"]);
  });

  it("drops children that render only blanks (their spacers vanish into the gap)", () => {
    const c = container([
      block(["text"]),
      block(["", ""]), // hidden-thinking step: renders nothing but spacing
      block(["more"]),
    ]);
    patchTranscriptSpacing(c);
    assert.deepEqual(c.render(80), ["text", "", "more"]);
  });

  it("keeps interior blanks inside a block", () => {
    const c = container([block(["head", "", "", "tail"])]);
    patchTranscriptSpacing(c);
    assert.deepEqual(c.render(80), ["head", "", "", "tail"]);
  });

  it("never produces consecutive blank rows or leading/trailing blanks", () => {
    const c = container([
      block(["", "", "a", ""]),
      block(["", ""]),
      block(["", "", "b", "", ""]),
    ]);
    patchTranscriptSpacing(c);
    const lines = c.render(80);
    assert.equal(lines[0], "a");
    assert.equal(lines.at(-1), "b");
    for (let i = 1; i < lines.length; i++) {
      assert.ok(!(lines[i] === "" && lines[i - 1] === ""), `double blank at ${String(i)}`);
    }
  });

  it("carries OSC-133 zone markers from trimmed blank edges onto surviving lines", () => {
    const zone = "\x1b]133;A\x07";
    const c = container([block([zone, "", "hello"]), block(["", "world"])]);
    patchTranscriptSpacing(c);
    const lines = c.render(80);
    assert.ok(lines[0]!.includes(zone), "zone marker survives the trim");
    assert.equal(lines[0]!.replace(/\x1b\][^\x07]*\x07/g, ""), "hello");
  });

  it("maintains mouseLayout entries per child (separator belongs to the child below, like pi)", () => {
    const c = container([block(["a"]), block(["b", "c"])]);
    patchTranscriptSpacing(c);
    c.render(80);
    assert.equal(c.mouseLayout?.width, 80);
    assert.equal(c.mouseLayout?.children.length, 2);
    assert.equal(c.mouseLayout?.children[1]!.height, 3); // the gap line + "b","c"
  });

  it("is idempotent", () => {
    const c = container([block(["a"])]);
    patchTranscriptSpacing(c);
    const first = c.render;
    patchTranscriptSpacing(c);
    assert.equal(c.render, first);
  });
});

describe("spacing groups", () => {
  /** Child that carries a group mark and (optionally) renders its position. */
  const grouped = (lines: string[], group = "sk", kind = "tool", renderPos = false) => {
    const c = {
      spacingGroup: group,
      spacingKind: kind,
      pos: undefined as SpacingGroupPosition | undefined,
      setGroupPosition(p: SpacingGroupPosition) {
        c.pos = p;
      },
      render: (w: number) => (renderPos && c.pos ? [`${String(c.pos.index)}/${String(c.pos.count)} ${w}`] : [...lines]),
      invalidate() {},
    };
    return c;
  };

  it("joins adjacent same-group children with no blank row", () => {
    const c = container([
      block(["lead text"]),
      grouped(["▏ • Read a"]),
      grouped(["▏ • Ran npm test"]),
      grouped(["▏ • Edited a"]),
      block(["lead text again"]),
    ]);
    patchTranscriptSpacing(c);
    assert.deepEqual(c.render(80), [
      "lead text",
      "",
      "▏ • Read a",
      "▏ • Ran npm test",
      "▏ • Edited a",
      "",
      "lead text again",
    ]);
  });

  it("different spacingGroups still get the gap", () => {
    const c = container([grouped(["a"], "x"), grouped(["b"], "y")]);
    patchTranscriptSpacing(c);
    assert.deepEqual(c.render(80), ["a", "", "b"]);
  });

  it("an invisible child between same-group members doesn't break the run", () => {
    const c = container([grouped(["a"]), block(["", ""]), grouped(["b"])]);
    patchTranscriptSpacing(c);
    assert.deepEqual(c.render(80), ["a", "b"]);
  });

  it("calls setGroupPosition with index/count and neighbour kinds, then re-renders", () => {
    const a = grouped(["A"], "sk", "tool", true);
    const b = grouped(["B"], "sk", "text", true);
    const c2 = grouped(["C"], "sk", "tool", true);
    const c = container([a, b, c2]);
    patchTranscriptSpacing(c);
    const lines = c.render(80);
    assert.deepEqual(a.pos, { index: 0, count: 3, prevKind: undefined, nextKind: "text" });
    assert.deepEqual(b.pos, { index: 1, count: 3, prevKind: "tool", nextKind: "tool" });
    assert.deepEqual(c2.pos, { index: 2, count: 3, prevKind: "text", nextKind: undefined });
    assert.deepEqual(lines, ["0/3 80", "1/3 80", "2/3 80"], "render used the assigned positions");
  });

  it("mouseLayout heights are just the child's lines for joined members", () => {
    const c = container([grouped(["a", "aa"]), grouped(["b"])]);
    patchTranscriptSpacing(c);
    c.render(80);
    assert.deepEqual(
      c.mouseLayout?.children.map((e) => e.height),
      [2, 1],
    );
  });

  it("a singleton group member still gets {index:0,count:1}", () => {
    const a = grouped(["a"]);
    const c = container([block(["x"]), a]);
    patchTranscriptSpacing(c);
    c.render(80);
    assert.deepEqual(a.pos, { index: 0, count: 1, prevKind: undefined, nextKind: undefined });
    assert.deepEqual(c.render(80), ["x", "", "a"]);
  });
});

describe("findTranscriptContainer", () => {
  it("finds the container whose children include an assistant block", () => {
    const chat = container([block(["spacer"]), assistant()]);
    const outer = container([block(["chrome"]), chat]);
    const hit = findTranscriptContainer(outer);
    assert.equal(hit, chat);
  });

  it("finds it via a tool-execution child too", () => {
    const tool = { updateArgs() {}, updateResult() {}, render: () => ["tool"] };
    const chat = container([tool]);
    const root = container([block(["header"]), chat]);
    assert.equal(findTranscriptContainer(root), chat);
  });

  it("returns undefined when no transcript exists yet", () => {
    const root = container([container([block(["x"])])]);
    assert.equal(findTranscriptContainer(root), undefined);
  });
});
