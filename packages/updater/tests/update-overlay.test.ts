import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { renderUpdateOverlay } from "../src/tui/update-overlay.js";
import { createListDetailOverlay } from "../src/tui/list-detail-overlay.js";
import type { ChangelogEntry } from "../types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
} as Theme;
const tui = { requestRender() {}, terminal: { columns: 200 } } as any;
const kb = {} as any;
const done = () => {};

before(() => {
  initTheme("dark");
});

describe("update overlay", () => {
  const entry: ChangelogEntry = {
    version: "1.0.1",
    date: "2026-09-15-release-notes-date-that-is-intentionally-long",
    sections: {},
    body: `This is a long paragraph that should wrap to the overlay width instead of being truncated. ${"update details ".repeat(24)}ZZZ_END_MARKER`,
  };

  test("wraps content to the overlay width and keeps the tail visible", () => {
    const overlay = renderUpdateOverlay(
      { currentVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true },
      [entry],
    )(tui, theme, kb, done);

    const initial = overlay.render(60);
    assert.ok(initial.every((line) => visibleWidth(stripTerminalSequences(line)) <= 60));

    overlay.handleInput("G");
    const end = overlay.render(60);
    assert.ok(end.every((line) => visibleWidth(stripTerminalSequences(line)) <= 60));
    assert.match(end.map(stripTerminalSequences).join("\n"), /ZZZ_END_MARKER/);
  });

  test("scrolls with arrows and j/k", () => {
    const body = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
    const overlay = renderUpdateOverlay(
      { currentVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true },
      [{ ...entry, body }],
    )(tui, theme, kb, done);
    const first = overlay.render(60)[5];

    overlay.handleInput("\x1b[B");
    const afterDown = overlay.render(60)[5];
    assert.notEqual(afterDown, first);
    overlay.handleInput("\x1b[A");
    assert.equal(overlay.render(60)[5], first);

    overlay.handleInput("j");
    assert.notEqual(overlay.render(60)[5], first);
    overlay.handleInput("k");
    assert.equal(overlay.render(60)[5], first);
  });
});

describe("list-detail overlay", () => {
  const overlay = createListDetailOverlay({
    title: " README Browser ",
    emptyMessage: "No entries",
    listFooter: " j/k navigate",
    detailFooter: " ↑/↓ j/k scroll",
    loadEntries: () => [{ title: "entry" }],
    renderItem: (entry, selected) => `${selected ? ">" : " "} ${entry.title}`,
    renderDetailTitle: () => "A title that is deliberately long enough to wrap in the detail view",
    renderDetailBody: () => Array.from({ length: 30 }, (_, index) => `detail-${index}`),
    openDirectIndex: 0,
  })(tui, theme, kb, done);

  test("wraps detail lines and scrolls with arrows and j/k", () => {
    const firstRender = overlay.render(60);
    assert.ok(firstRender.every((line) => visibleWidth(stripTerminalSequences(line)) <= 60));
    const first = firstRender.find((line) => stripTerminalSequences(line).includes("detail-0"));
    assert.ok(first);

    overlay.handleInput("\x1b[B");
    const afterDown = overlay.render(60).find((line) => stripTerminalSequences(line).includes("detail-1"));
    assert.ok(afterDown);
    overlay.handleInput("\x1b[A");
    assert.ok(overlay.render(60).some((line) => stripTerminalSequences(line).includes("detail-0")));

    overlay.handleInput("j");
    assert.ok(overlay.render(60).some((line) => stripTerminalSequences(line).includes("detail-1")));
    overlay.handleInput("k");
    assert.ok(overlay.render(60).some((line) => stripTerminalSequences(line).includes("detail-0")));
  });
});
