import { test } from "node:test";
import assert from "node:assert/strict";
import { blendedPrice, renderSlider, sliderPosition } from "../src/slider.js";

test("slider positions use a clamped logarithmic scale", () => {
  assert.equal(sliderPosition(1, 1, 100, 9), 0);
  assert.equal(sliderPosition(100, 1, 100, 9), 8);
  assert.equal(sliderPosition(10, 1, 100, 9), 4);
  assert.equal(sliderPosition(10, 10, 10, 9), 0);
});

test("blended price averages input and output", () => {
  assert.equal(blendedPrice({ input: 10, output: 50 }), 30);
  assert.equal(blendedPrice(undefined), undefined);
});

test("renderSlider emits the requested visible cells and marker", () => {
  const rendered = renderSlider(10, 3);
  assert.equal(rendered.replace(/\x1b\[[0-9;]*m/gu, "").length, 10);
  assert.equal((rendered.match(/●/gu) ?? []).length, 1);
  assert.match(rendered, /^\x1b\[/u);
  assert.ok(rendered.endsWith("\x1b[39m"));
});
