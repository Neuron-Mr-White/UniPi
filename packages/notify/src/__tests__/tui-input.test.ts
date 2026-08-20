/**
 * Test: Notify TUI — normalized key handling & model selector fixes (issue #27)
 *
 * Bug 1 (arrow keys / Escape dead):
 *   The settings overlay and recap model selector compared raw input against
 *   exact legacy byte sequences ("\x1b[A", "\x1b", ...). Under the kitty
 *   keyboard protocol / enhanced encodings (Ghostty, Herdr) these keys arrive
 *   as different strings ("\x1b[27u", "\x1b[57419u", ...), so navigation and
 *   Escape silently did nothing. Both overlays now use matchesKey().
 *
 * Bug 2 (empty model selector):
 *   RecapModelSelectorOverlay only read ~/.unipi/config/models-cache.json and
 *   showed an empty list when that file was missing, even though Pi had models
 *   configured. It now accepts models injected from Pi's live model registry
 *   and falls back to the cache.
 *
 * All tests run with HOME pointed at a temp directory so the user's real
 * notify config and model cache are never read or written.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotifySettingsOverlay } from "../../tui/settings-overlay.ts";
import { RecapModelSelectorOverlay } from "../../tui/recap-model-selector.ts";
import type { CachedModel } from "@pi-unipi/core";

// ─── Key encodings ─────────────────────────────────────────────────────────
// Every form in which Up/Down/Escape/Enter/Backspace/Tab/Space can arrive:
// legacy CSI, SS3 (application cursor mode), kitty CSI-u, modifyOtherKeys.
const UP_ENCODINGS = ["\x1b[A", "\x1bOA", "\x1b[57419u", "\x1b[1;1A"];
const DOWN_ENCODINGS = ["\x1b[B", "\x1bOB", "\x1b[57420u", "\x1b[1;1B"];
const ESCAPE_ENCODINGS = ["\x1b", "\x1b[27u", "\x1b[27;1;27~"];
const ENTER_ENCODINGS = ["\r", "\x1b[13u"];
const BACKSPACE_ENCODINGS = ["\x7f", "\x1b[127u"];

const TEST_MODELS: CachedModel[] = [
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "openrouter", id: "openai/gpt-oss-20b", name: "GPT OSS 20B" },
];

// ─── HOME isolation ────────────────────────────────────────────────────────

const REAL_HOME = process.env.HOME;
let home = "";

function freshHome(): void {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "notify-tui-test-"));
  process.env.HOME = home;
}

before(() => freshHome());
after(() => {
  rmSync(home, { recursive: true, force: true });
  if (REAL_HOME) process.env.HOME = REAL_HOME;
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Strip ANSI SGR escape sequences so substring assertions see plain text. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Render the overlay and return the line carrying the selection marker ▸. */
function selectedLine(overlay: { render(w: number): string[] }): string {
  const lines = overlay.render(80);
  return lines.find((l) => l.includes("▸")) ?? "";
}

/** Overlay with an onClose spy; returns [overlay, wasClosed getter]. */
function withCloseSpy<T extends { onClose?: () => void }>(overlay: T): [T, () => boolean] {
  let closed = false;
  overlay.onClose = () => {
    closed = true;
  };
  return [overlay, () => closed];
}

function readNotifyConfig(): Record<string, unknown> {
  const p = join(home, ".unipi/config/notify/config.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

/**
 * Seed a notify config whose recap.model matches no test model, so the
 * selector starts with index 0 selected (the constructor otherwise
 * pre-selects the configured model — by default openrouter/openai/gpt-oss-20b).
 */
function seedBaselineSelection(): void {
  const dir = join(home, ".unipi/config/notify");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ recap: { enabled: false, model: "zzz/nonexistent" } }),
    "utf-8"
  );
}

// ─── Settings overlay: arrow-key navigation across encodings ───────────────

describe("settings overlay: navigation (issue #27 bug 1)", () => {
  it("navigates down on every Down encoding", () => {
    for (const enc of DOWN_ENCODINGS) {
      freshHome();
      const overlay = new NotifySettingsOverlay();
      assert.ok(
        selectedLine(overlay).includes("Native OS"),
        `precondition: first row selected (${JSON.stringify(enc)})`
      );
      overlay.handleInput(enc);
      assert.ok(
        selectedLine(overlay).includes("Gotify"),
        `Down encoding ${JSON.stringify(enc)} must move selection to second row`
      );
    }
  });

  it("navigates up on every Up encoding", () => {
    for (const enc of UP_ENCODINGS) {
      freshHome();
      const overlay = new NotifySettingsOverlay();
      overlay.handleInput("\x1b[B");
      overlay.handleInput("\x1b[B"); // now on Telegram (index 2)
      overlay.handleInput(enc);
      assert.ok(
        selectedLine(overlay).includes("Gotify"),
        `Up encoding ${JSON.stringify(enc)} must move selection up one row`
      );
    }
  });

  it("j / k still navigate like arrows", () => {
    freshHome();
    const overlay = new NotifySettingsOverlay();
    overlay.handleInput("j");
    assert.ok(selectedLine(overlay).includes("Gotify"), "j moves down");
    overlay.handleInput("k");
    assert.ok(selectedLine(overlay).includes("Native OS"), "k moves up");
  });

  it("navigation works in the Events section too", () => {
    freshHome();
    const overlay = new NotifySettingsOverlay();
    overlay.handleInput("\t"); // platforms -> events
    overlay.handleInput("\x1b[57420u"); // kitty Down
    const line = selectedLine(overlay);
    assert.ok(
      line.includes("ralph_loop_end"),
      "kitty Down in Events section must move selection"
    );
  });
});

describe("settings overlay: close & escape hatch", () => {
  it("closes on every Escape encoding", () => {
    for (const enc of ESCAPE_ENCODINGS) {
      freshHome();
      const [overlay, wasClosed] = withCloseSpy(new NotifySettingsOverlay());
      overlay.handleInput(enc);
      assert.ok(wasClosed(), `Escape encoding ${JSON.stringify(enc)} must close overlay`);
    }
  });

  it("closes on ctrl+c", () => {
    freshHome();
    const [overlay, wasClosed] = withCloseSpy(new NotifySettingsOverlay());
    overlay.handleInput("\x03");
    assert.ok(wasClosed(), "ctrl+c must close overlay");
  });
});

describe("settings overlay: toggle, tab, model-selector key, save", () => {
  it("toggles with Space in both encodings", () => {
    freshHome();
    const overlay = new NotifySettingsOverlay();
    // Native OS is enabled by default (●)
    assert.ok(selectedLine(overlay).includes("●"), "native enabled by default");
    overlay.handleInput(" ");
    assert.ok(selectedLine(overlay).includes("○"), "legacy Space disables");
    overlay.handleInput("\x1b[32u");
    assert.ok(selectedLine(overlay).includes("●"), "kitty Space re-enables");
  });

  it("switches sections with Tab in both encodings", () => {
    freshHome();
    const overlay = new NotifySettingsOverlay();
    overlay.handleInput("\t");
    assert.ok(overlay.render(80).some((l) => l.includes("[Events]")), "legacy Tab -> Events");
    overlay.handleInput("\x1b[9u");
    assert.ok(overlay.render(80).some((l) => l.includes("[Recap]")), "kitty Tab -> Recap");
  });

  it("opens model selector with m and M in recap section only", () => {
    freshHome();
    const overlay = new NotifySettingsOverlay();
    let opened = 0;
    overlay.onOpenModelSelector = () => opened++;
    overlay.handleInput("m");
    assert.equal(opened, 0, "m outside recap section must not open selector");
    overlay.handleInput("\t"); // -> events
    overlay.handleInput("\t"); // -> recap
    overlay.handleInput("m");
    overlay.handleInput("M");
    assert.equal(opened, 2, "m and M must both open selector in recap section");
  });

  it("saves with Enter in both encodings", () => {
    for (const enc of ENTER_ENCODINGS) {
      freshHome();
      const overlay = new NotifySettingsOverlay();
      overlay.handleInput(enc);
      assert.ok(
        overlay.render(80).some((l) => l.includes("Settings saved")),
        `Enter encoding ${JSON.stringify(enc)} must save`
      );
      assert.ok(
        existsSync(join(home, ".unipi/config/notify/config.json")),
        "config file written to isolated HOME"
      );
    }
  });
});

// ─── Recap model selector: navigation, close, filter ───────────────────────

describe("model selector: navigation & close (issue #27 bug 1)", () => {
  it("navigates down on every Down encoding", () => {
    for (const enc of DOWN_ENCODINGS) {
      freshHome();
      seedBaselineSelection();
      const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
      assert.ok(
        selectedLine(overlay).includes("GPT-4o"),
        `precondition: first model selected (${JSON.stringify(enc)})`
      );
      overlay.handleInput(enc);
      assert.ok(
        selectedLine(overlay).includes("Claude Sonnet 4.6"),
        `Down encoding ${JSON.stringify(enc)} must move selection`
      );
    }
  });

  it("navigates up on every Up encoding", () => {
    for (const enc of UP_ENCODINGS) {
      freshHome();
      seedBaselineSelection();
      const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
      overlay.handleInput("\x1b[B");
      overlay.handleInput("\x1b[B"); // index 2
      overlay.handleInput(enc);
      assert.ok(
        selectedLine(overlay).includes("Claude Sonnet 4.6"),
        `Up encoding ${JSON.stringify(enc)} must move selection up one row`
      );
    }
  });

  it("j / k still navigate", () => {
    freshHome();
    seedBaselineSelection();
    const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    overlay.handleInput("j");
    assert.ok(selectedLine(overlay).includes("Claude Sonnet 4.6"));
    overlay.handleInput("k");
    assert.ok(selectedLine(overlay).includes("GPT-4o"));
  });

  it("closes on every Escape encoding", () => {
    for (const enc of ESCAPE_ENCODINGS) {
      const [overlay, wasClosed] = withCloseSpy(new RecapModelSelectorOverlay(TEST_MODELS));
      overlay.handleInput(enc);
      assert.ok(wasClosed(), `Escape encoding ${JSON.stringify(enc)} must close selector`);
    }
  });

  it("closes on ctrl+c even in filter mode", () => {
    const [overlay, wasClosed] = withCloseSpy(new RecapModelSelectorOverlay(TEST_MODELS));
    overlay.handleInput("/");
    overlay.handleInput("\x03");
    assert.ok(wasClosed(), "ctrl+c must close even mid-filter");
  });

  it("selects and saves the model with Enter in both encodings", () => {
    // Legacy Enter on the first model (selection starts at index 0).
    freshHome();
    seedBaselineSelection();
    let overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    overlay.handleInput("\r");
    const cfg = readNotifyConfig() as { recap: { model: string } };
    assert.equal(cfg.recap.model, "openai/gpt-4o");

    // Kitty Enter after navigating to a different model.
    freshHome();
    seedBaselineSelection();
    overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    overlay.handleInput("j"); // -> Claude
    overlay.handleInput("\x1b[13u");
    const cfg2 = readNotifyConfig() as { recap: { model: string } };
    assert.equal(cfg2.recap.model, "anthropic/claude-sonnet-4-6");
  });
});

describe("model selector: filter mode", () => {
  it("filters by typed text, backspace edits in both encodings, enter exits", () => {
    const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    overlay.handleInput("/");
    overlay.handleInput("g");
    overlay.handleInput("p");
    overlay.handleInput("t");
    let lines = overlay.render(80).map(stripAnsi);
    assert.ok(lines.some((l) => l.includes("Filter: gpt█")), "filter bar shows query");
    assert.ok(lines.some((l) => l.includes("GPT-4o")), "gpt-4o visible");
    assert.ok(!lines.some((l) => l.includes("Claude Sonnet")), "non-matching model hidden");

    overlay.handleInput("\x7f"); // legacy backspace -> "gp"
    lines = overlay.render(80).map(stripAnsi);
    assert.ok(lines.some((l) => l.includes("GPT OSS 20B")), "backspace restores matches");

    overlay.handleInput("\x1b[127u"); // kitty backspace -> "g"
    overlay.handleInput("\x7f"); // legacy backspace -> ""
    assert.ok(
      overlay.render(80).map(stripAnsi).some((l) => l.includes("Claude Sonnet 4.6")),
      "clearing filter restores all models"
    );
    overlay.handleInput("\x1b[13u"); // kitty Enter exits filter mode
    lines = overlay.render(80).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("Claude Sonnet 4.6")),
      "all models visible after clearing filter"
    );
  });

  it("Escape in filter mode clears the filter but does not close the overlay", () => {
    const [overlay, wasClosed] = withCloseSpy(new RecapModelSelectorOverlay(TEST_MODELS));
    overlay.handleInput("/");
    overlay.handleInput("z");
    overlay.handleInput("\x1b[27u"); // kitty Escape
    const lines = overlay.render(80);
    assert.ok(lines.some((l) => l.includes("/3 models")), "filter cleared");
    assert.ok(!wasClosed(), "filter-mode Escape must not close the selector");
  });

  it("arrow keys navigate inside filter mode without leaving it", () => {
    freshHome();
    seedBaselineSelection();
    const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    overlay.handleInput("/");
    overlay.handleInput("\x1b[57420u"); // kitty Down — must not be typed into filter
    const lines = overlay.render(80).map(stripAnsi);
    assert.ok(lines.some((l) => l.includes("Filter: █")), "still in filter mode");
    assert.ok(selectedLine(overlay).includes("Claude Sonnet 4.6"), "selection moved");
  });
});

// ─── Recap model selector: model source (issue #27 bug 2) ─────────────────

describe("model selector: model source (issue #27 bug 2)", () => {
  it("lists injected registry models even with no cache file present", () => {
    freshHome(); // no ~/.unipi/config/models-cache.json exists
    const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    const lines = overlay.render(80);
    assert.ok(lines.some((l) => l.includes("/3 models")), "3 models available");
    assert.ok(lines.some((l) => l.includes("GPT-4o")));
    assert.ok(!lines.some((l) => l.includes("No models available")));
  });

  it("falls back to the cache file when no models are injected", () => {
    freshHome();
    const cacheDir = join(home, ".unipi/config");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "models-cache.json"),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        models: [{ provider: "cached", id: "cached-model", name: "Cached Model" }],
      }),
      "utf-8"
    );
    const overlay = new RecapModelSelectorOverlay();
    assert.ok(
      overlay.render(80).some((l) => l.includes("Cached Model")),
      "cache fallback must populate the list"
    );
  });

  it("shows an actionable empty state when no models exist anywhere", () => {
    freshHome(); // no cache, no injection
    const overlay = new RecapModelSelectorOverlay();
    const lines = overlay.render(80);
    assert.ok(
      lines.some((l) => l.includes("No models")),
      "must explain why the list is empty"
    );
    assert.ok(
      lines.some((l) => l.includes("models.json")),
      "must point at the config to check"
    );
  });

  it("distinguishes an empty model list from a non-matching filter", () => {
    const overlay = new RecapModelSelectorOverlay(TEST_MODELS);
    overlay.handleInput("/");
    overlay.handleInput("z");
    overlay.handleInput("z");
    assert.ok(
      overlay.render(80).some((l) => l.includes('No models match "zz"')),
      "filter miss gets its own message"
    );
  });
});
