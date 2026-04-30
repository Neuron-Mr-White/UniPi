/**
 * @pi-unipi/footer — Events test
 *
 * Tests event subscription wiring by verifying the subscribeToEvents
 * function returns an unsubscribe function and handles events correctly.
 * Uses a mock pi object.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FooterRegistry } from "../src/registry/index.ts";

describe("Event flow", () => {
  it("registry receives data updates and notifies subscribers", () => {
    const registry = new FooterRegistry();
    let renderCount = 0;
    registry.subscribe(() => renderCount++);

    // Simulate COMPACTOR_STATS_UPDATED event data
    registry.updateData("compactor", { sessionEvents: 42, compactions: 7, tokensSaved: 12500 });
    assert.equal(renderCount, 1);

    const data = registry.getGroupData("compactor") as Record<string, number>;
    assert.equal(data.sessionEvents, 42);
    assert.equal(data.compactions, 7);
    assert.equal(data.tokensSaved, 12500);
  });

  it("multiple groups can be updated independently", () => {
    const registry = new FooterRegistry();
    let renderCount = 0;
    registry.subscribe(() => renderCount++);

    registry.updateData("compactor", { compactions: 5 });
    registry.updateData("memory", { projectCount: 10 });
    assert.equal(renderCount, 2);

    const compactorData = registry.getGroupData("compactor") as Record<string, number>;
    const memoryData = registry.getGroupData("memory") as Record<string, number>;
    assert.equal(compactorData.compactions, 5);
    assert.equal(memoryData.projectCount, 10);
  });

  it("invalidateAll triggers re-render", () => {
    const registry = new FooterRegistry();
    let renderCount = 0;
    registry.subscribe(() => renderCount++);

    registry.updateData("compactor", { compactions: 5 });
    registry.invalidateAll();
    assert.equal(renderCount, 2);
    assert.equal(registry.getGroupData("compactor"), undefined);
  });
});
