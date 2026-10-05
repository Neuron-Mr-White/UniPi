import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompletionCard, renderLaunchCard } from "../cards.js";
import type { BgTaskSnapshot } from "../types.js";

// Minimal theme stub — tags text so assertions can check which colour/weight
// a fragment carries without a real terminal/ANSI renderer.
const theme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
};

function task(overrides: Partial<BgTaskSnapshot> = {}): BgTaskSnapshot {
  return {
    id: "abc12345",
    name: "Run full test suite",
    command: "npm test",
    status: "running",
    outputPath: "/tmp/out.log",
    cwd: "/repo",
    startTime: 0,
    bytesWritten: 0,
    isAgent: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    ...overrides,
  };
}

describe("renderLaunchCard — collapsed", () => {
  it("is the BG chip line only — no command line", () => {
    const lines = renderLaunchCard(theme as never, task()).render(100);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("BG"));
    assert.ok(lines[0]!.includes("**Run full test suite**"));
    assert.ok(lines[0]!.includes("started · wakes agent"));
  });

  it("right side is exactly 'started · notifies' when trigger is off but notify stays on", () => {
    const [line] = renderLaunchCard(theme as never, task({ triggerOnCompletion: false })).render(100);
    assert.ok(line.includes("started · notifies"));
    assert.ok(!line.includes("on completion"));
  });

  it("right side is exactly 'started · silent' when neither notify nor trigger are set", () => {
    const [line] = renderLaunchCard(
      theme as never,
      task({ triggerOnCompletion: false, notifyOnCompletion: false }),
    ).render(100);
    assert.ok(line.includes("started · silent"));
  });
});

describe("renderLaunchCard — expanded", () => {
  it("adds the dim command line", () => {
    const lines = renderLaunchCard(theme as never, task(), true).render(100);
    assert.equal(lines.length, 4);
    assert.ok(lines[1]!.includes("[dim]"));
    assert.ok(lines[1]!.includes("npm test"));
    assert.ok(lines[2]!.includes(task().outputPath));
    assert.ok(lines[3]!.includes(task().id));
  });
});

describe("renderCompletionCard — collapsed", () => {
  it("DONE: 'exit 0 · 25s · agent woken' — one line, no command/tail/path/id", () => {
    const t = task({ status: "completed", exitCode: 0, endTime: 25_000, startTime: 0 });
    const lines = renderCompletionCard(theme as never, t, false).render(100);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("DONE"));
    assert.ok(lines[0]!.includes("exit 0 · 25s · agent woken"));
    assert.ok(!lines[0]!.includes("npm test"));
  });

  it("FAIL with an exit code: 'exit 101 · 12s · agent woken' — no extra failed/error note", () => {
    const t = task({ status: "failed", exitCode: 101, endTime: 12_000, startTime: 0, error: "boom" });
    const [line] = renderCompletionCard(theme as never, t, false).render(100);
    assert.ok(line.includes("FAIL"));
    assert.ok(line.includes("exit 101 · 12s · agent woken"));
    // the chip itself is coloured "error" (STATE_COLOR.failed), so assert on
    // the meta tokens specifically rather than the substring "error".
    assert.ok(!line.includes("· failed"));
    assert.ok(!line.includes("· error"));
  });

  it("FAIL without an exit code falls back to 'error' (has an error message) or 'failed' (no message)", () => {
    const withError = task({ status: "failed", error: "boom" });
    const noError = task({ status: "failed" });
    const [l1] = renderCompletionCard(theme as never, withError, false).render(100);
    const [l2] = renderCompletionCard(theme as never, noError, false).render(100);
    assert.ok(l1.includes("[dim]error"));
    assert.ok(l2.includes("[dim]failed"));
  });

  it("STOP: exactly 'killed · duration' — no exit code or agent-woken note", () => {
    const t = task({ status: "killed", endTime: 4_000, startTime: 0, exitCode: null });
    const [line] = renderCompletionCard(theme as never, t, false).render(100);
    assert.ok(line.includes("STOP"));
    assert.ok(line.includes("killed · 4s"));
    assert.ok(!line.includes("exit"));
    assert.ok(!line.includes("agent woken"));
  });

  it("renders a fallback DONE chip when the task snapshot is missing", () => {
    const [line] = renderCompletionCard(theme as never, undefined, false).render(100);
    assert.ok(line.includes("DONE"));
  });
});

describe("renderCompletionCard — expanded", () => {
  it("adds the dim command, error in error colour, output tail, dim path and id", () => {
    const t = task({
      status: "failed",
      error: "exit 1",
      outputTail: ["line one", "line two"],
    });
    const lines = renderCompletionCard(theme as never, t, true).render(100);
    const body = lines.join("\n");
    assert.ok(body.includes("[dim]"));
    assert.ok(body.includes("npm test"));
    assert.ok(body.includes("[error]"));
    assert.ok(body.includes("exit 1"));
    assert.ok(body.includes("line one"));
    assert.ok(body.includes("line two"));
    assert.ok(body.includes("/tmp/out.log"));
    assert.ok(body.includes(t.id));
  });

  it("omits the error line entirely when there is no error", () => {
    const t = task({ status: "completed", exitCode: 0 });
    const lines = renderCompletionCard(theme as never, t, true).render(100);
    for (const l of lines) assert.ok(!l.includes("[error]"));
  });

  it("every expanded line fits the given width (truncateToWidth, no crash on tiny widths)", () => {
    const t = task({
      status: "failed",
      error: "a very long error message that would otherwise overflow a narrow terminal width",
      outputTail: ["a very long output line that would otherwise overflow a narrow terminal width too"],
      command: "x".repeat(300),
    });
    // Use a theme whose fg/bold are no-ops (not the bracket-tagging stub
    // above, whose literal `[color]`/`[/color]` text would inflate visible
    // width and give a false width-fit failure): this isolates the real
    // truncateToWidth behaviour against each line's true visible width.
    const plainTheme = { fg: (_c: string, t2: string) => t2, bg: (_c: string, t2: string) => t2, bold: (t2: string) => t2 };
    for (const width of [10, 20, 40, 100]) {
      const lines = renderCompletionCard(plainTheme as never, t, true).render(width);
      for (const l of lines) assert.ok(visibleWidth(l) <= width, `line exceeds width ${String(width)}: ${JSON.stringify(l)}`);
    }
  });
});
