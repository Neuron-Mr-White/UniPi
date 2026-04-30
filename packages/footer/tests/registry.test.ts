/**
 * @pi-unipi/footer — Registry tests
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FooterRegistry, resetFooterRegistry } from "../src/registry/index.ts";
import type { FooterGroup } from "../src/types.ts";

describe("FooterRegistry", () => {
  let registry: FooterRegistry;

  beforeEach(() => {
    registry = new FooterRegistry();
  });

  describe("registerGroup", () => {
    it("registers a group and retrieves it", () => {
      const group: FooterGroup = {
        id: "test",
        name: "Test Group",
        icon: "",
        segments: [],
        defaultShow: true,
      };
      registry.registerGroup(group);
      assert.equal(registry.getGroup("test"), group);
    });

    it("getAllGroups returns all registered groups", () => {
      registry.registerGroup({ id: "a", name: "A", icon: "", segments: [], defaultShow: true });
      registry.registerGroup({ id: "b", name: "B", icon: "", segments: [], defaultShow: true });
      assert.equal(registry.getAllGroups().length, 2);
    });
  });

  describe("updateData / getGroupData", () => {
    it("stores and retrieves data", () => {
      registry.updateData("compactor", { compactions: 5 });
      const data = registry.getGroupData("compactor") as Record<string, number>;
      assert.equal(data.compactions, 5);
    });

    it("returns undefined for unknown group", () => {
      assert.equal(registry.getGroupData("unknown"), undefined);
    });

    it("overwrites previous data", () => {
      registry.updateData("compactor", { compactions: 5 });
      registry.updateData("compactor", { compactions: 10 });
      const data = registry.getGroupData("compactor") as Record<string, number>;
      assert.equal(data.compactions, 10);
    });
  });

  describe("subscribe", () => {
    it("calls subscribers when data is updated", () => {
      let callCount = 0;
      registry.subscribe(() => callCount++);
      registry.updateData("compactor", { compactions: 5 });
      assert.equal(callCount, 1);
    });

    it("unsubscribe function stops notifications", () => {
      let callCount = 0;
      const unsub = registry.subscribe(() => callCount++);
      unsub();
      registry.updateData("compactor", { compactions: 5 });
      assert.equal(callCount, 0);
    });

    it("does not notify when same data is set", () => {
      let callCount = 0;
      const data = { compactions: 5 };
      registry.subscribe(() => callCount++);
      registry.updateData("compactor", data);
      registry.updateData("compactor", data); // Same reference
      assert.equal(callCount, 1);
    });
  });

  describe("invalidateAll", () => {
    it("clears all cached data", () => {
      registry.updateData("compactor", { compactions: 5 });
      registry.updateData("memory", { count: 10 });
      registry.invalidateAll();
      assert.equal(registry.getGroupData("compactor"), undefined);
      assert.equal(registry.getGroupData("memory"), undefined);
    });

    it("notifies subscribers", () => {
      let callCount = 0;
      registry.subscribe(() => callCount++);
      registry.invalidateAll();
      assert.equal(callCount, 1);
    });
  });
});
