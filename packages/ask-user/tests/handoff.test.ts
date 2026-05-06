import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_HANDOFF_FALLBACK_MS,
  queueCompactHandoff,
  queueDirectHandoff,
} from "../handoff.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakePi(options: { throwOnSend?: boolean } = {}) {
  const sent: Array<{ message: string; options: { deliverAs?: string } | undefined }> = [];
  return {
    sent,
    pi: {
      sendUserMessage(message: string, sendOptions?: { deliverAs?: string }) {
        if (options.throwOnSend) {
          throw new Error("send failed");
        }
        sent.push({ message, options: sendOptions });
      },
    },
  };
}

function createFakeCtx(options: {
  compact?: (compactOptions: {
    customInstructions?: string;
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }) => void;
  throwOnEditor?: boolean;
} = {}) {
  const notifications: Array<{ message: string; level: string }> = [];
  let editorText = "";
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setEditorText(text: string) {
        if (options.throwOnEditor) {
          throw new Error("editor failed");
        }
        editorText = text;
      },
    },
    compact: options.compact ?? (() => undefined),
  };

  return {
    ctx,
    notifications,
    get editorText() {
      return editorText;
    },
  };
}

describe("ask-user handoff helpers", () => {
  it("queues direct handoff as a follow-up user message", () => {
    const { pi, sent } = createFakePi();
    const { ctx } = createFakeCtx();

    const result = queueDirectHandoff(pi as never, ctx as never, "  /unipi:work specs:plan.md  ");

    assert.deepEqual(result, {
      status: "queued",
      reason: "direct",
      prefill: "/unipi:work specs:plan.md",
    });
    assert.deepEqual(sent, [
      {
        message: "/unipi:work specs:plan.md",
        options: { deliverAs: "followUp" },
      },
    ]);
  });

  it("cancels empty direct handoff without queuing", () => {
    const { pi, sent } = createFakePi();
    const { ctx } = createFakeCtx();

    const result = queueDirectHandoff(pi as never, ctx as never, "   ");

    assert.equal(result.status, "cancelled");
    assert.equal(result.reason, "empty-prefill");
    assert.equal(sent.length, 0);
  });

  it("falls back to editor prefill when direct delivery throws", () => {
    const { pi } = createFakePi({ throwOnSend: true });
    const fakeCtx = createFakeCtx();

    const result = queueDirectHandoff(pi as never, fakeCtx.ctx as never, "/unipi:plan specs:design.md");

    assert.equal(result.status, "editor_prefill");
    assert.equal(fakeCtx.editorText, "/unipi:plan specs:design.md");
    assert.equal(fakeCtx.notifications[0]?.level, "warning");
  });

  it("delivers compact handoff from completion callback exactly once", async () => {
    const { pi, sent } = createFakePi();
    let onComplete: (() => void) | undefined;
    const { ctx } = createFakeCtx({
      compact: (options) => {
        onComplete = options.onComplete;
      },
    });

    const result = queueCompactHandoff({
      pi: pi as never,
      ctx: ctx as never,
      prefill: "/unipi:review-work plan:plan.md",
      customInstructions: "__compactor__\nPreparing",
    });

    assert.equal(result.status, "scheduled");
    assert.equal(sent.length, 0);

    onComplete?.();
    onComplete?.();
    await wait(20);

    assert.deepEqual(sent, [
      {
        message: "/unipi:review-work plan:plan.md",
        options: { deliverAs: "followUp" },
      },
    ]);
  });

  it("delivers compact handoff from fallback timer exactly once", async () => {
    const { pi, sent } = createFakePi();
    let onComplete: (() => void) | undefined;
    const { ctx } = createFakeCtx({
      compact: (options) => {
        onComplete = options.onComplete;
      },
    });

    const result = queueCompactHandoff({
      pi: pi as never,
      ctx: ctx as never,
      prefill: "/unipi:work specs:plan.md",
      customInstructions: "__compactor__\nPreparing",
    });

    assert.equal(result.status, "scheduled");
    await wait(COMPACT_HANDOFF_FALLBACK_MS + 50);
    onComplete?.();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.message, "/unipi:work specs:plan.md");
  });

  it("delivers compact handoff if compact start throws", () => {
    const { pi, sent } = createFakePi();
    const { ctx } = createFakeCtx({
      compact: () => {
        throw new Error("compact unavailable");
      },
    });

    const result = queueCompactHandoff({
      pi: pi as never,
      ctx: ctx as never,
      prefill: "/unipi:plan specs:design.md",
      customInstructions: "__compactor__\nPreparing",
    });

    assert.equal(result.status, "queued");
    assert.equal(result.reason, "compact-start-failed");
    assert.equal(sent.length, 1);
  });
});
