import { describe, expect, it } from "bun:test";
import { mapNotifyPriority } from "../events.js";

describe("notify_user priority mapping", () => {
  it("maps semantic priorities to Gotify's configured scale", () => {
    expect(mapNotifyPriority("gotify", "low")).toBe(2);
    expect(mapNotifyPriority("gotify", "normal")).toBe(5);
    expect(mapNotifyPriority("gotify", "high")).toBe(8);
  });

  it("maps semantic priorities to ntfy's standard scale", () => {
    expect(mapNotifyPriority("ntfy", "low")).toBe(2);
    expect(mapNotifyPriority("ntfy", "normal")).toBe(3);
    expect(mapNotifyPriority("ntfy", "high")).toBe(5);
  });
});
