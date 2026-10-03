import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installSimpleImageCollapse } from "../src/render/images.ts";

describe("installSimpleImageCollapse", () => {
  function makeFakeClass() {
    let updateDisplayCalls = 0;
    class FakeToolExecution {
      expanded = false;
      children: unknown[] = [];
      imageComponents: unknown[] = [];
      imageSpacers: unknown[] = [];

      removeChild(child: unknown) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children.splice(idx, 1);
      }

      updateDisplay() {
        updateDisplayCalls++;
        const img = { type: "image" };
        const spacer = { type: "spacer" };
        this.imageComponents.push(img);
        this.imageSpacers.push(spacer);
        this.children.push(spacer, img);
      }
    }
    return { FakeToolExecution, getCalls: () => updateDisplayCalls };
  }

  it("enabled + collapsed -> arrays empty and children cleared", () => {
    const { FakeToolExecution } = makeFakeClass();
    installSimpleImageCollapse(FakeToolExecution.prototype, () => true);
    const instance = new FakeToolExecution();
    instance.expanded = false;
    instance.updateDisplay();
    assert.deepEqual(instance.imageComponents, []);
    assert.deepEqual(instance.imageSpacers, []);
    assert.deepEqual(instance.children, []);
  });

  it("enabled + expanded -> kept", () => {
    const { FakeToolExecution } = makeFakeClass();
    installSimpleImageCollapse(FakeToolExecution.prototype, () => true);
    const instance = new FakeToolExecution();
    instance.expanded = true;
    instance.updateDisplay();
    assert.equal(instance.imageComponents.length, 1);
    assert.equal(instance.imageSpacers.length, 1);
    assert.equal(instance.children.length, 2);
  });

  it("disabled -> kept", () => {
    const { FakeToolExecution } = makeFakeClass();
    installSimpleImageCollapse(FakeToolExecution.prototype, () => false);
    const instance = new FakeToolExecution();
    instance.expanded = false;
    instance.updateDisplay();
    assert.equal(instance.imageComponents.length, 1);
    assert.equal(instance.imageSpacers.length, 1);
    assert.equal(instance.children.length, 2);
  });

  it("double install doesn't double-wrap (original called once per updateDisplay)", () => {
    const { FakeToolExecution, getCalls } = makeFakeClass();
    const enabled = () => true;
    installSimpleImageCollapse(FakeToolExecution.prototype, enabled);
    installSimpleImageCollapse(FakeToolExecution.prototype, enabled);
    const instance = new FakeToolExecution();
    instance.updateDisplay();
    assert.equal(getCalls(), 1);
  });
});
