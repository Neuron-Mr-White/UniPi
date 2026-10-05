/**
 * @pi-unipi/utility — regression: background-task-notification messages never
 * fall back to pi's generic `CustomMessageComponent` purple box frame, in any
 * render style (simple / regular / advanced). The utility package installs
 * no custom handling for this message type itself — @pi-unipi/background-tasks
 * registers its own `registerMessageRenderer("background-task-notification",
 * …)` renderer via `renderCompletionCard`, and that renderer returning a
 * Component is what makes pi's CustomMessageComponent skip its own box/label
 * default rendering (see custom-message.js: customRenderer result wins,
 * default-box path only runs when the renderer throws or returns nothing).
 */
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// CustomMessageComponent reads the global theme instance (same requirement
// as harness.test.ts) — initialize it before constructing any component.
const __pi = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const __themeMod = (await import(pathToFileURL(join(dirname(__pi), "modes/interactive/theme/theme.js")).href)) as {
  getThemeByName(name: string): object | undefined;
  setThemeInstance(t: object): void;
};
const __dark = __themeMod.getThemeByName("dark");
if (__dark) __themeMod.setThemeInstance(__dark);

import assert from "node:assert/strict";
import { CustomMessageComponent } from "@earendil-works/pi-coding-agent";
import { renderCompletionCard } from "../../background-tasks/src/cards.ts";
import type { BgTaskSnapshot } from "../../background-tasks/src/types.ts";

function task(overrides: Partial<BgTaskSnapshot> = {}): BgTaskSnapshot {
  return {
    id: "abc12345",
    name: "Run full test suite",
    command: "npm test",
    status: "completed",
    outputPath: "/tmp/out.log",
    cwd: "/repo",
    startTime: 0,
    endTime: 25_000,
    exitCode: 0,
    bytesWritten: 0,
    isAgent: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    ...overrides,
  };
}

/** The exact renderer @pi-unipi/background-tasks registers for this customType. */
function notificationRenderer(message: { details?: BgTaskSnapshot }, options: { expanded?: boolean }, theme: unknown) {
  return renderCompletionCard(theme as never, message.details, options?.expanded === true);
}

describe("background-task-notification never falls back to the generic custom-message box", () => {
  for (const expanded of [false, true]) {
    it(`expanded=${String(expanded)}: renders the DONE badge/leader line, not pi's purple [customType] box`, () => {
      const message = {
        role: "custom" as const,
        customType: "background-task-notification",
        content: "done",
        details: task(),
      };
      const comp = new CustomMessageComponent(message as never, notificationRenderer as never);
      comp.setExpanded(expanded);
      const lines = comp.render(100);
      const text = lines.join("\n");
      // our renderer's own content: the DONE chip (plus, when expanded, the
      // command/path/id detail lines) — never the generic fallback frame.
      assert.ok(text.includes("DONE"), "the registered renderer's DONE chip is present");
      assert.ok(!text.includes("[background-task-notification]"), "no generic bracketed customType label");
      assert.ok(!text.includes("\x1b[1m["), "no bold bracketed label escape from the default box path");
    });
  }

  it("a renderer that throws (defensive) falls back to the generic box — confirms the test actually distinguishes the two paths", () => {
    const message = {
      role: "custom" as const,
      customType: "background-task-notification",
      content: "done",
      details: task(),
    };
    const throwingRenderer = () => {
      throw new Error("boom");
    };
    const comp = new CustomMessageComponent(message as never, throwingRenderer as never);
    const lines = comp.render(100);
    const text = lines.join("\n");
    assert.ok(text.includes("[background-task-notification]"), "fallback path renders the generic bracketed label");
  });
});
