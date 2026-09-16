/**
 * The sidekick wake line: while the lead's turn has ended but the sidekick is
 * still burning tokens, pi's own loader and elapsed timer are stopped and the
 * UI looks idle. This widget keeps an animated "still working" line above the
 * editor until the report lands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDEKICK_WAKE_WIDGET_KEY,
  createSidekickWakeLine,
  isLeadIdle,
  sidekickWakeText,
} from "../src/index.js";
import fusionExtension from "../src/index.js";

interface WidgetCall {
  key: string;
  widget: unknown;
  placement?: string;
}

function createCtx(opts: { idle?: boolean; throws?: boolean; hasUI?: boolean } = {}) {
  const calls: WidgetCall[] = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    isIdle(): boolean {
      if (opts.throws === true) throw new Error("isIdle unavailable");
      return opts.idle ?? true;
    },
    ui: {
      setWidget(key: string, widget: unknown, options?: { placement?: string }): void {
        calls.push({ key, widget, placement: options?.placement });
      },
    },
  };
  return { ctx, calls, wakeCalls: () => calls.filter((call) => call.key === SIDEKICK_WAKE_WIDGET_KEY) };
}

function fakeTui() {
  return { requestRender: () => undefined };
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function renderWidget(widget: unknown, width = 200): string[] {
  const factory = widget as (tui: unknown, theme: unknown) => { render(width: number): string[]; dispose(): void };
  const component = factory(fakeTui(), theme);
  try {
    return component.render(width);
  } finally {
    component.dispose();
  }
}

test("installs the wake line when the sidekick is busy and the lead is idle", () => {
  const { ctx, wakeCalls } = createCtx({ idle: true });
  const line = createSidekickWakeLine({ isBusy: () => true, progress: () => ({ toolCalls: 1, startedAt: Date.now() }) });

  line.publish(ctx as never);

  assert.equal(wakeCalls().length, 1);
  assert.equal(typeof wakeCalls()[0]?.widget, "function");
  assert.equal(wakeCalls()[0]?.placement, "aboveEditor");
});

test("does not install while the lead is still working", () => {
  const { ctx, wakeCalls } = createCtx({ idle: false });
  const line = createSidekickWakeLine({ isBusy: () => true, progress: () => ({ toolCalls: 1, startedAt: Date.now() }) });

  line.publish(ctx as never);

  assert.equal(wakeCalls().length, 0);
});

test("does not install when no handoff is running", () => {
  const { ctx, wakeCalls } = createCtx({ idle: true });
  const line = createSidekickWakeLine({ isBusy: () => false, progress: () => undefined });

  line.publish(ctx as never);

  assert.equal(wakeCalls().length, 0);
});

test("installs once and removes once across repeated publishes", () => {
  let busy = true;
  const { ctx, wakeCalls } = createCtx({ idle: true });
  const line = createSidekickWakeLine({ isBusy: () => busy, progress: () => ({ toolCalls: 3, startedAt: Date.now() }) });

  for (let i = 0; i < 5; i++) line.publish(ctx as never);
  assert.equal(wakeCalls().length, 1, "widget is installed once, not per progress tick");

  busy = false;
  line.publish(ctx as never);
  assert.equal(wakeCalls().length, 2);
  assert.equal(wakeCalls()[1]?.widget, undefined, "removal clears the widget");

  line.publish(ctx as never);
  line.publish(ctx as never);
  assert.equal(wakeCalls().length, 2, "removal happens exactly once");

  busy = true;
  line.publish(ctx as never);
  assert.equal(wakeCalls().length, 3, "re-installs when the condition returns");
  assert.equal(typeof wakeCalls()[2]?.widget, "function");
});

test("treats a throwing isIdle as idle", () => {
  const { ctx, wakeCalls } = createCtx({ throws: true });
  const line = createSidekickWakeLine({ isBusy: () => true, progress: () => ({ toolCalls: 0, startedAt: Date.now() }) });

  line.publish(ctx as never);

  assert.equal(wakeCalls().length, 1);
  assert.equal(isLeadIdle({ isIdle: () => { throw new Error("boom"); } }), true);
  assert.equal(isLeadIdle({ isIdle: () => false }), false);
});

test("does nothing without a UI", () => {
  const { ctx, calls } = createCtx({ hasUI: false });
  const line = createSidekickWakeLine({ isBusy: () => true, progress: () => ({ toolCalls: 1, startedAt: Date.now() }) });

  line.publish(ctx as never);

  assert.equal(calls.length, 0);
});

test("renders the live tool count and elapsed time, and collapses without progress", () => {
  let progress: { toolCalls: number; startedAt: number } | undefined = { toolCalls: 2, startedAt: Date.now() - 5000 };
  const { ctx, wakeCalls } = createCtx({ idle: true });
  const line = createSidekickWakeLine({ isBusy: () => true, progress: () => progress });

  line.publish(ctx as never);
  const widget = wakeCalls()[0]?.widget;
  const rendered = renderWidget(widget);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0] ?? "", /sidekick working · 2 tool calls · 5\.\ds — resumes automatically when done$/);

  progress = undefined;
  assert.deepEqual(renderWidget(widget), [], "no progress collapses the line without disposing the widget");
  assert.equal(sidekickWakeText(undefined), undefined);
  assert.match(sidekickWakeText({ toolCalls: 7, startedAt: Date.now() }) ?? "", /^sidekick working · 7 tool calls · /);
});

test("clear removes the line once and lets it be re-installed", () => {
  const { ctx, wakeCalls } = createCtx({ idle: true });
  const line = createSidekickWakeLine({ isBusy: () => true, progress: () => ({ toolCalls: 1, startedAt: Date.now() }) });

  line.publish(ctx as never);
  line.clear(ctx as never);
  assert.equal(wakeCalls().length, 2);
  assert.equal(wakeCalls()[1]?.widget, undefined);

  line.clear(ctx as never);
  assert.equal(wakeCalls().length, 2, "second clear is a no-op");

  line.publish(ctx as never);
  assert.equal(wakeCalls().length, 3);
});

test("the extension re-evaluates the wake line on turn end and settle", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getThinkingLevel: () => "medium",
  };
  const previous = process.env.UNIPI_FUSION_CHILD;
  delete process.env.UNIPI_FUSION_CHILD;
  try {
    fusionExtension(pi as never);
  } finally {
    if (previous === undefined) delete process.env.UNIPI_FUSION_CHILD;
    else process.env.UNIPI_FUSION_CHILD = previous;
  }

  assert.equal(typeof handlers.get("turn_end"), "function");
  assert.equal(typeof handlers.get("agent_settled"), "function");

  const { ctx, wakeCalls } = createCtx({ idle: true });
  handlers.get("turn_end")?.({}, ctx);
  handlers.get("agent_settled")?.({}, ctx);
  assert.equal(wakeCalls().length, 0, "no sidekick runtime means no wake line");
});
