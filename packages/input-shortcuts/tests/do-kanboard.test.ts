/**
 * The K chord's kanboard action, driven through the real extension:
 * success clears the editor — but NOT when the user typed while the
 * ~100ms capture was in flight (the new text stays, the ✓ still shows).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

interface Overlay {
  handleInput(data: string): void;
}

type ComponentFactory = (
  tui: never,
  theme: never,
  kb: never,
  done: () => void,
) => Promise<Overlay>;
function stubPi() {
  const shortcuts: Array<{ key: unknown; handler: (ctx: never) => Promise<void> }> = [];
  const pi = {
    registerShortcut: (key: unknown, options: { handler: (ctx: never) => Promise<void> }) => {
      shortcuts.push({ key, handler: options.handler });
    },
    registerEntryRenderer: () => undefined,
    on: () => undefined,
    events: { emit: () => undefined },
  };
  return { pi: pi as never, shortcuts };
}

function stubCtx() {
  let text = "";
  const calls = { setEditor: 0, statuses: [] as Array<string | undefined> };
  let factory: ComponentFactory | null = null;
  const ctx = {
    hasUI: true,
    cwd: "/tmp/workspace",
    ui: {
      getEditorText: () => text,
      setEditorText: (next: string) => {
        calls.setEditor += 1;
        text = next;
      },
      setStatus: (_key: string, value?: string) => {
        calls.statuses.push(value);
      },
      onTerminalInput: () => () => undefined,
      custom: async (make: ComponentFactory) => {
        factory = make;
      },
    },
  };
  return {
    ctx: ctx as never,
    setText: (next: string) => {
      text = next;
    },
    text: () => text,
    calls,
    factory: () => factory,
  };
}

describe("K chord → kanboard capture", () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-chord-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    delete (globalThis as { __unipi_kanboard_api?: unknown }).__unipi_kanboard_api;
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears the editor and reports the new task when the text is untouched", async () => {
    const captured: Array<{ cwd: string; text: string }> = [];
    (globalThis as { __unipi_kanboard_api?: unknown }).__unipi_kanboard_api = {
      captureToBacklog: async (opts: { cwd: string; text: string }) => {
        captured.push(opts);
        return { ok: true as const, id: "TST-1", attachments: 2 };
      },
    };
    const { pi, shortcuts } = stubPi();
    extension(pi);
    assert.equal(shortcuts.length, 2, "ALT+S and ALT+I registered");
    const state = stubCtx();
    state.setText("ship the fix\nsee /tmp/shot.png");

    const handler = shortcuts[0]!.handler;
    await handler(state.ctx);
    const make = state.factory();
    assert.ok(make);
    const overlay = await make(
      { requestRender: () => undefined } as never,
      { fg: (_c: string, t: string) => t } as never,
      {} as never,
      () => undefined,
    );
    overlay.handleInput("k");
    await waitFor(() => state.calls.statuses.length > 0, "the success status");

    assert.deepEqual(captured, [{ cwd: "/tmp/workspace", text: "ship the fix\nsee /tmp/shot.png" }]);
    assert.equal(state.calls.setEditor, 1, "editor cleared once");
    assert.equal(state.text(), "");
    assert.equal(state.calls.statuses.at(-1), "✓ TST-1 added to Backlog (2 attachments)");
  });

  it("leaves the editor alone when the user typed during the capture", async () => {
    let resolveCapture: (value: unknown) => void = () => undefined;
    let captures = 0;
    (globalThis as { __unipi_kanboard_api?: unknown }).__unipi_kanboard_api = {
      captureToBacklog: () =>
        new Promise((resolve) => {
          captures += 1;
          resolveCapture = resolve;
        }),
    };
    const { pi, shortcuts } = stubPi();
    extension(pi);
    const state = stubCtx();
    state.setText("before the chord");

    const handler = shortcuts[0]!.handler;
    await handler(state.ctx);
    const make = state.factory();
    assert.ok(make);
    const overlay = await make(
      { requestRender: () => undefined } as never,
      { fg: (_c: string, t: string) => t } as never,
      {} as never,
      () => undefined,
    );
    overlay.handleInput("k");
    // The capture is in flight; the user keeps typing.
    await waitFor(() => captures === 1, "capture started");
    state.setText("before the chord plus fresh typing");
    resolveCapture({ ok: true, id: "TST-9", attachments: 0 });
    await waitFor(() => state.calls.statuses.length > 0, "the success status");

    assert.equal(state.calls.setEditor, 0, "editor not cleared");
    assert.equal(state.text(), "before the chord plus fresh typing");
    assert.equal(state.calls.statuses.at(-1), "✓ TST-9 added to Backlog (0 attachments)");
  });

  it("shows the failure reason and keeps the text", async () => {
    (globalThis as { __unipi_kanboard_api?: unknown }).__unipi_kanboard_api = {
      captureToBacklog: async () => ({ ok: false as const, reason: "kanboard is not set up here" }),
    };
    const { pi, shortcuts } = stubPi();
    extension(pi);
    const state = stubCtx();
    state.setText("keep me");
    const handler = shortcuts[0]!.handler;
    await handler(state.ctx);
    const make = state.factory();
    assert.ok(make);
    const overlay = await make(
      { requestRender: () => undefined } as never,
      { fg: (_c: string, t: string) => t } as never,
      {} as never,
      () => undefined,
    );
    overlay.handleInput("k");
    await waitFor(() => state.calls.statuses.length > 0, "the failure status");
    assert.equal(state.calls.setEditor, 0);
    assert.equal(state.text(), "keep me");
    assert.equal(state.calls.statuses.at(-1), "kanboard is not set up here");
  });
});
