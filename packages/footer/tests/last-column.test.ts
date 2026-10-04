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
import { renderSessionStrip } from "../src/strip.ts";
import { tpsTracker } from "../src/tps-tracker.ts";
import type { SessionSnapshot } from "../src/session-scan.ts";
import type { FooterSettings } from "../src/types.ts";
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
      assert.equal(glanceFrameWidth(width), width - 1, `width ${width}`);
    }
  });

  it("keeps the 8-column floor below that", () => {
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
    tpsTracker.reset();
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

  it("session strip never fills the last column at any width", () => {
    const settings: FooterSettings = {
      enabled: true,
      iconStyle: "nerd",
      colorMode: "none",
      rainbow: "off",
      processLine: true,
      strip: { turns: true, time: true, speed: true, tokens: true, cost: true, compactions: true, cache: true },
      badges: { mode: true, planPermission: true, fusion: true, kanboard: true },
    };
    const snapshot: SessionSnapshot = {
      branchLength: 4,
      userCount: 2,
      assistantCount: 2,
      input: 12_300,
      output: 4_100,
      cacheRead: 40_000,
      cacheWrite: 0,
      cost: 1.23,
      compactionCount: 2,
      compactionBefore: 39_000,
      compactionAfter: 13_000,
      compactionLastAt: Date.now() - 180_000,
      lastAssistantAt: Date.now(),
    };
    tpsTracker.syncBranchStats(2, 2);
    for (let width = 2; width <= 300; width++) {
      for (const line of renderSessionStrip(settings, snapshot, {}, width)) {
        const w = visibleWidth(line);
        assert.ok(
          w < width,
          `width ${width}: strip is ${w} cols — exactly-full-width lines desync wrapping terminals`,
        );
      }
    }
  });
});
