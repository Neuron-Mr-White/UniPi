/**
 * Regression test for the "stuck starting screen" bug, now guarding the
 * Unicrab splash's self-dismiss timer.
 *
 * pi's `done()` pops the TOPMOST overlay. A timer that dismissed while the
 * updater's prompt was stacked on top closed the prompt instead and stranded
 * the splash. `armSelfDismiss` must defer while covered and retry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { armSelfDismiss } from "../packages/info-screen/tui/self-dismiss.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(opts = {}) {
  const s = { hidden: false, closed: false, destroyed: false };
  const hooks = {
    isDestroyed: () => s.destroyed,
    destroy: () => {
      s.destroyed = true;
    },
    ...(opts.selfHide === false
      ? {}
      : {
          selfHide: () => {
            s.hidden = true;
          },
        }),
    onClose: () => {
      s.closed = true;
    },
    ...opts.hooks,
  };
  return { s, hooks };
}

describe("splash self-dismiss", () => {
  it("hides itself when topmost", async () => {
    const { s, hooks } = harness({ hooks: { isTopmostVisible: () => true } });
    armSelfDismiss(20, hooks);
    await wait(60);
    assert.equal(s.hidden, true);
    assert.equal(s.closed, false, "must not use done() when selfHide exists");
  });

  it("waits while another overlay is stacked on top, then hides", async () => {
    let top = false;
    const { s, hooks } = harness({ hooks: { isTopmostVisible: () => top } });
    armSelfDismiss(20, hooks);
    await wait(80);
    assert.equal(s.hidden, false, "covered → must not dismiss");
    top = true;
    await wait(80);
    assert.equal(s.hidden, true);
  });

  it("falls back to done() only while focused", async () => {
    let focused = false;
    const { s, hooks } = harness({ selfHide: false, hooks: { isTopmostOverlay: () => focused } });
    armSelfDismiss(20, hooks);
    await wait(80);
    assert.equal(s.closed, false);
    focused = true;
    await wait(80);
    assert.equal(s.closed, true);
  });

  it("cancel stops the timer", async () => {
    const { s, hooks } = harness({ hooks: { isTopmostVisible: () => true } });
    const cancel = armSelfDismiss(30, hooks);
    cancel();
    await wait(80);
    assert.equal(s.hidden, false);
  });

  it("no-op for non-positive timeouts", async () => {
    const { s, hooks } = harness();
    armSelfDismiss(0, hooks);
    await wait(30);
    assert.equal(s.hidden, false);
  });
});
