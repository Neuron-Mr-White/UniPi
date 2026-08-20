/**
 * Regression test for the "stuck starting screen" bug.
 *
 * When an update is available, the updater's "Update Available" overlay is
 * stacked on top of the info-screen boot dashboard. The boot auto-close timer
 * closes via `done()`, which pops the *topmost* overlay in the TUI stack — not
 * this overlay specifically. So firing the timer while the update overlay was
 * on top popped the update overlay and spent the info overlay's one-shot
 * `close`, leaving the starting screen stranded (the user could no longer
 * dismiss it). The fix makes `startBootTimer` defer until this overlay is the
 * focused/topmost entry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InfoOverlay } from "../packages/info-screen/tui/info-overlay.ts";

/** Wait `ms` as a real timer (the boot timer uses real timers too). */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("InfoOverlay boot auto-close", () => {
  it("auto-closes when it is the topmost overlay", async () => {
    const overlay = new InfoOverlay();
    let closed = false;
    overlay.onClose = () => {
      closed = true;
    };
    overlay.isTopmostOverlay = () => true;
    overlay.startBootTimer(20);
    await wait(60);
    assert.equal(closed, true, "should close when topmost");
    overlay.destroy();
  });

  it("does not auto-close while another overlay is stacked on top", async () => {
    const overlay = new InfoOverlay();
    let closed = false;
    overlay.onClose = () => {
      closed = true;
    };
    overlay.isTopmostOverlay = () => false; // something is on top of us
    overlay.startBootTimer(20);
    await wait(80);
    assert.equal(
      closed,
      false,
      "must not fire done() while not topmost — that would pop the covering overlay and strand this one",
    );
    overlay.destroy();
  });

  it("auto-closes once it becomes topmost after the covering overlay closes", async () => {
    const overlay = new InfoOverlay();
    let closed = false;
    overlay.onClose = () => {
      closed = true;
    };
    let topmost = false;
    overlay.isTopmostOverlay = () => topmost;
    overlay.startBootTimer(20);
    await wait(80); // timer fired but deferred — covering overlay still up
    assert.equal(closed, false);
    topmost = true; // covering overlay closed; we're topmost now
    await wait(80); // next re-arm fires and closes
    assert.equal(closed, true, "should close after becoming topmost");
  });

  it("any keypress cancels the boot timer (topmost case)", async () => {
    const overlay = new InfoOverlay();
    let closed = false;
    overlay.onClose = () => {
      closed = true;
    };
    overlay.isTopmostOverlay = () => true;
    overlay.startBootTimer(40);
    overlay.handleInput("j"); // user is driving — cancels the timer
    await wait(120);
    assert.equal(closed, false, "keypress should cancel the boot timer");
    overlay.destroy();
  });
});
