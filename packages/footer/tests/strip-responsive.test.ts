/**
 * @pi-unipi/footer — Strip responsiveness tests
 *
 * Priority dropping to fit `width - 1` (issue #31), no mid-part truncation,
 * the height gate, and centering.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  fitStripParts,
  stripVisibleAtRows,
  MIN_STRIP_ROWS,
  renderSessionStrip,
  STRIP_PRIORITIES,
  type StripPart,
} from "../src/strip.ts";
import { tpsTracker } from "../src/tps-tracker.ts";
import type { SessionSnapshot } from "../src/session-scan.ts";
import type { FooterSettings } from "../src/types.ts";

function part(id: StripPart["id"], text: string): StripPart {
  return { id, priority: STRIP_PRIORITIES[id], text };
}

function allParts(): StripPart[] {
  return [
    part("tokens", "↑12.3k in · ↓4.1k out"),
    part("cost", "$1.23"),
    part("speed", "350ms avg ttft · 84.0 tok/s"),
    part("turns", "3 turn · 12 steps"),
    part("time", "00:12 · tool 00:04"),
    part("cache", "73% cache hit"),
    part("compactions", "2 compactions · 39k→13k · 3m ago"),
  ];
}

describe("fitStripParts (priority dropping)", () => {
  it("keeps everything when the line fits width - 1", () => {
    const parts = allParts();
    const w = visibleWidth(parts.map(p => p.text).join(" | "));
    const kept = fitStripParts(parts, w + 1);
    assert.equal(kept.length, parts.length);
  });

  it("drops the lowest priority first (compactions)", () => {
    const parts = allParts();
    const full = visibleWidth(parts.map(p => p.text).join(" | "));
    // One column too wide for the full line.
    const kept = fitStripParts(parts, full);
    assert.equal(kept.at(-1)!.id, "cache");
    assert.ok(!kept.some(p => p.id === "compactions"));
  });

  it("drop order is compactions → cache → time → turns → speed → cost → tokens", () => {
    const dropSequence: string[] = [];
    let parts = allParts();
    while (parts.length > 1) {
      const full = visibleWidth(parts.map(p => p.text).join(" | "));
      // Fit at one column below the full width → exactly one drop.
      parts = fitStripParts(parts, full - 1);
      const ids = new Set(parts.map(p => p.id));
      for (const id of ["tokens", "cost", "speed", "turns", "time", "cache", "compactions"] as const) {
        if (!ids.has(id)) {
          if (dropSequence.at(-1) !== id) dropSequence.push(id);
          break;
        }
      }
    }
    assert.deepEqual(dropSequence, ["compactions", "cache", "time", "turns", "speed", "cost"]);
    assert.equal(parts[0].id, "tokens");
  });

  it("output visible width never reaches the terminal width (≤ width-1)", () => {
    const parts = allParts();
    for (let width = 10; width <= 200; width++) {
      const kept = fitStripParts(parts, width);
      if (kept.length > 1) {
        const w = visibleWidth(kept.map(p => p.text).join(" | "));
        assert.ok(w <= width - 1, `width ${width}: got ${w} (parts ${kept.map(p => p.id).join(",")})`);
      }
    }
  });

  it("never truncates mid-part while more than one part remains", () => {
    const parts = allParts();
    for (let width = 10; width <= 200; width++) {
      const kept = fitStripParts(parts, width);
      if (kept.length > 1) {
        for (const p of kept) {
          assert.ok(p.text.length > 0 && p.text === allParts().find(x => x.id === p.id)!.text,
            `part ${p.id} was altered (mid-part truncation) at width ${width}`);
        }
      }
    }
  });
});

describe("strip height gate", () => {
  it("hides below 20 rows, shows at 20", () => {
    assert.equal(MIN_STRIP_ROWS, 20);
    assert.equal(stripVisibleAtRows(19), false);
    assert.equal(stripVisibleAtRows(20), true);
    assert.equal(stripVisibleAtRows(60), true);
  });

  it("shows when rows are unknown", () => {
    assert.equal(stripVisibleAtRows(undefined), true);
    assert.equal(stripVisibleAtRows(null), true);
    assert.equal(stripVisibleAtRows(Number.NaN), true);
  });
});

describe("renderSessionStrip layout", () => {
  beforeEach(() => {
    tpsTracker.reset();
  });

  const settings = (strip = {}): FooterSettings => ({
    enabled: true,
    iconStyle: "nerd",
    colorMode: "none",
    rainbow: "off",
    processLine: true,
    strip: { turns: true, time: true, speed: true, tokens: true, cost: true, compactions: true, cache: true, ...strip },
    badges: { mode: true, planPermission: true, fusion: true, kanboard: true },
  });

  const snapshot = (): SessionSnapshot => ({
    branchLength: 5,
    userCount: 3,
    assistantCount: 2,
    input: 12_300,
    output: 4_100,
    cacheRead: 40_000,
    cacheWrite: 0,
    cost: 1.234,
    compactionCount: 2,
    compactionBefore: 39_000,
    compactionAfter: 13_000,
    compactionLastAt: Date.now() - 180_000,
    lastAssistantAt: Date.now(),
  });

  it("renders one centered line on wide terminals", () => {
    const lines = renderSessionStrip(settings(), snapshot(), {}, 200);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(" "), "wide strip is centered");
    const w = visibleWidth(lines[0]);
    assert.ok(w < 200, "never fills the last column");
  });

  it("narrow widths drop parts instead of mid-part truncation", () => {
    for (const width of [30, 45, 60, 80]) {
      const lines = renderSessionStrip(settings(), snapshot(), {}, width);
      assert.equal(lines.length, 1);
      const w = visibleWidth(lines[0]);
      assert.ok(w <= width - 1, `width ${width}: strip is ${w} cols`);
    }
  });

  it("returns [] when nothing is displayable", () => {
    tpsTracker.reset();
    const empty: SessionSnapshot = {
      branchLength: 0, userCount: 0, assistantCount: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
      compactionCount: 0, compactionBefore: 0, compactionAfter: 0,
      lastAssistantAt: null,
    };
    assert.deepEqual(renderSessionStrip(settings(), empty, {}, 100), []);
  });
});
