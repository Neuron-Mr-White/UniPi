/**
 * @pi-unipi/footer — issue #31 regression tests
 *
 * Invariant: the footer must never emit a line at EXACTLY the terminal
 * width. pi-tui joins per-tick rewrites with "\r\n"; an exactly-full-width
 * line desyncs terminals that auto-wrap immediately (and any terminal whose
 * glyph widths disagree with visibleWidth()), after which the differential
 * renderer repaints the glance frame one block lower every second until the
 * screen fills — the "endless rainbow bars" report.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { glanceFrameWidth } from "../src/glance-editor.ts";
import { renderProcessLine } from "../src/process-line.ts";
import {
  setSharedTaskRegistry,
  clearSharedTaskRegistry,
} from "../../background-tasks/src/registry-shared.ts";

function fakeRegistry(tasks: Array<{ status: string }>) {
  return { allTasks: () => tasks } as unknown as Parameters<typeof setSharedTaskRegistry>[0];
}

describe("glanceFrameWidth (issue #31)", () => {
  it("is strictly one column short of the terminal at real widths (>= 10)", () => {
    for (let width = 10; width <= 500; width++) {
      const safe = glanceFrameWidth(width);
      assert.ok(safe < width, `glanceFrameWidth(${width}) = ${safe} must stay under the wrap threshold`);
      assert.equal(safe, width - 1);
    }
  });

  it("keeps the legacy 8-column floor on degenerate terminals", () => {
    assert.equal(glanceFrameWidth(9), 8);
    assert.equal(glanceFrameWidth(80), 79);
    assert.equal(glanceFrameWidth(1), 8);
    assert.equal(glanceFrameWidth(Number.NaN), 8);
  });

  it("glance render derives its whole width ledger from glanceFrameWidth", () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/glance-editor.ts"),
      "utf-8",
    );
    assert.match(src, /const safe = glanceFrameWidth\(width\)/);
    assert.doesNotMatch(src, /const safe = Math\.max\(8, width\)/);
  });
});

describe("last-column discipline across footer widgets", () => {
  beforeEach(() => {
    clearSharedTaskRegistry();
  });

  it("process one-liner never fills the last column at any width", () => {
    setSharedTaskRegistry(
      fakeRegistry([
        { status: "running" },
        { status: "running" },
        { status: "failed" },
        { status: "completed" },
        { status: "killed" },
      ]),
    );
    for (let width = 1; width <= 300; width++) {
      for (const line of renderProcessLine(width)) {
        const w = visibleWidth(line);
        assert.ok(
          w < width,
          `width ${width}: process line is ${w} cols — exactly-full-width lines desync wrapping terminals`,
        );
      }
    }
  });

  it("classic status line + session strip truncate below the terminal width", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf-8");
    assert.match(src, /truncateToWidth\(line, cap\)/, "classic top line must cap at width - 1");
    assert.match(src, /truncateToWidth\(strip, Math\.max\(1, width - 1\)\)/, "session strip must cap at width - 1");
  });
});
