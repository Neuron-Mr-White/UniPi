/**
 * @pi-unipi/footer — Registry tests (slimmed data store)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FooterRegistry } from "../src/registry/index.ts";

describe("FooterRegistry (data store)", () => {
  let registry: FooterRegistry;

  beforeEach(() => {
    registry = new FooterRegistry();
  });

  describe("updateData / getGroupData", () => {
    it("stores and retrieves data", () => {
      registry.updateData("core", { lhMode: "goal" });
      const data = registry.getGroupData("core") as Record<string, string>;
      assert.equal(data.lhMode, "goal");
    });

    it("returns undefined for unknown group", () => {
      assert.equal(registry.getGroupData("unknown"), undefined);
    });

    it("overwrites previous data", () => {
      registry.updateData("core", { permissionMode: "ask" });
      registry.updateData("core", { permissionMode: "full" });
      const data = registry.getGroupData("core") as Record<string, string>;
      assert.equal(data.permissionMode, "full");
    });
  });

  describe("subscribe", () => {
    it("calls subscribers when data is updated", () => {
      let callCount = 0;
      registry.subscribe(() => callCount++);
      registry.updateData("core", { planMode: true });
      assert.equal(callCount, 1);
    });

    it("unsubscribe function stops notifications", () => {
      let callCount = 0;
      const unsub = registry.subscribe(() => callCount++);
      unsub();
      registry.updateData("core", { planMode: true });
      assert.equal(callCount, 0);
    });

    it("does not notify when same data is set", () => {
      let callCount = 0;
      const data = { planMode: true };
      registry.subscribe(() => callCount++);
      registry.updateData("core", data);
      registry.updateData("core", data); // Same reference
      assert.equal(callCount, 1);
    });
  });

  describe("invalidateAll", () => {
    it("clears all cached data", () => {
      registry.updateData("core", { planMode: true });
      registry.updateData("other", { count: 10 });
      registry.invalidateAll();
      assert.equal(registry.getGroupData("core"), undefined);
      assert.equal(registry.getGroupData("other"), undefined);
    });

    it("notifies subscribers", () => {
      let callCount = 0;
      registry.subscribe(() => callCount++);
      registry.invalidateAll();
      assert.equal(callCount, 1);
    });
  });
});
