import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("UniPi event contracts", () => {
  it("wires Compactor completion from emitter to Footer listener", () => {
    expect(source("compactor/src/index.ts")).toContain("UNIPI_EVENTS.COMPACTOR_COMPACTED");
    expect(source("footer/src/events.ts")).toContain("UNIPI_EVENTS.COMPACTOR_COMPACTED");
  });

  it("wires Ralph iteration completion from emitter to Footer listener", () => {
    expect(source("ralph/ralph-loop.ts")).toContain("UNIPI_EVENTS.RALPH_ITERATION_DONE");
    expect(source("footer/src/events.ts")).toContain("UNIPI_EVENTS.RALPH_ITERATION_DONE");
  });

  it("does not retain the stale Compactor stats listener", () => {
    expect(source("footer/src/events.ts")).not.toContain("UNIPI_EVENTS.COMPACTOR_STATS_UPDATED");
  });
});
