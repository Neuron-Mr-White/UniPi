// UNI-126: background-tasks is the first tab of the shared work tray; the old
// status label ("bg 1 running · Shift↓") and the "waiting on N bg tasks"
// wake line are gone (the footer's single UNI-162 waiting line covers it).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import backgroundTasksExtension from "../index.js";
import { resetWorkTrayForTests, workTrayItemCount, WorkTray } from "@pi-unipi/core";

const scratch = mkdtempSync(join(tmpdir(), "uni-bg-tray-"));

function fakePi() {
  const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
  const noop = () => undefined;
  const pi = {
    on: (e: string, h: (...a: unknown[]) => unknown) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
    registerTool: noop,
    registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(n, c),
    registerMessageRenderer: noop,
    registerShortcut: (k: string, s: { handler: (ctx: unknown) => unknown }) => shortcuts.set(k, s),
    sendMessage: noop,
    events: { on: () => noop, emit: noop },
  };
  return { pi, handlers, commands, shortcuts };
}

function fakeCtx() {
  const widgets: string[] = [];
  const statuses: Array<[string, unknown]> = [];
  const opened: WorkTray[] = [];
  let finish: (() => void) | undefined;
  const ctx = {
    hasUI: true,
    cwd: scratch,
    isIdle: () => true,
    ui: {
      setWidget: (k: string) => widgets.push(k),
      setStatus: (k: string, v: unknown) => statuses.push([k, v]),
      onTerminalInput: () => () => undefined,
      notify: () => undefined,
      custom: (factory: (t: unknown, th: unknown, kb: unknown, done: () => void) => unknown) =>
        new Promise<void>((resolve) => {
          // Same contract as pi's showExtensionCustom: done() disposes the component.
          let tray: WorkTray | undefined;
          const done = () => {
            tray?.dispose();
            resolve();
          };
          finish = done;
          tray = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, done) as WorkTray;
          opened.push(tray);
        }),
    },
    sessionManager: { getSessionId: () => "s1" },
  };
  return { ctx, widgets, statuses, opened, close: () => finish?.() };
}

test("registers the Background tasks tab; Shift+↓ and /unipi:bg-tasks open the tray on it; no wake line or status label", async () => {
  resetWorkTrayForTests();
  const { pi, handlers, commands, shortcuts } = fakePi();
  const prev = process.cwd();
  process.chdir(scratch);
  try {
    backgroundTasksExtension(pi as never);
  } finally {
    process.chdir(prev);
  }
  assert.equal(workTrayItemCount(), 0);
  const c = fakeCtx();
  for (const h of handlers.get("session_start") ?? []) await h({}, c.ctx);
  assert.ok(c.widgets.includes("work-tray-strip"), "the tray strip is installed");
  assert.ok(!c.widgets.includes("background-tasks"), "no wake-line widget");
  assert.equal(c.statuses.filter(([k, v]) => k === "background-tasks" && v !== undefined).length, 0, "no status label");

  const viaShortcut = shortcuts.get("shift+down")!.handler(c.ctx) as Promise<void>;
  await Promise.resolve();
  assert.equal(c.opened.length, 1);
  assert.equal(c.opened[0]!.activeTabId(), "bg");
  assert.match(c.opened[0]!.render(100).join("\n"), /Background tasks \(0\)/);
  assert.match(c.opened[0]!.render(100).join("\n"), /No background tasks in this session/);
  c.opened[0]!.handleInput("x"); // pane close → tray closes
  await viaShortcut;

  const viaCommand = commands.get("unipi:bg-tasks")!.handler("", c.ctx) as Promise<void>;
  await Promise.resolve();
  assert.equal(c.opened.length, 2);
  c.close();
  await viaCommand;
  for (const h of handlers.get("session_shutdown") ?? []) await h({}, c.ctx);
  resetWorkTrayForTests();
});
