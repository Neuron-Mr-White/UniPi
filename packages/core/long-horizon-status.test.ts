import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getSharedLongHorizonMode,
  setSharedLongHorizonMode,
} from "./long-horizon-status.js";

describe("shared long-horizon mode", () => {
  it("round-trips a mode id through the process-global holder", () => {
    setSharedLongHorizonMode("goal");
    assert.equal(getSharedLongHorizonMode(), "goal");
    setSharedLongHorizonMode("swarm");
    assert.equal(getSharedLongHorizonMode(), "swarm");
  });

  it("clears to undefined", () => {
    setSharedLongHorizonMode("ralph");
    setSharedLongHorizonMode(undefined);
    assert.equal(getSharedLongHorizonMode(), undefined);
  });

  it("survives across module instances via Symbol.for (pull, not event)", async () => {
    setSharedLongHorizonMode("graph");
    // A fresh import resolves to the same Symbol.for-keyed holder — this is why
    // the footer can PULL the mode set by long-horizon without a shared bus.
    const again = await import("./long-horizon-status.js");
    assert.equal(again.getSharedLongHorizonMode(), "graph");
  });
});
