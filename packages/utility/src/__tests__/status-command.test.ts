import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("utility status command", () => {
  const source = readFileSync(join(import.meta.dir, "..", "commands.ts"), "utf8");
  const statusSection = source.slice(
    source.indexOf(`UTILITY_COMMANDS.STATUS`),
    source.indexOf(`UTILITY_COMMANDS.CLEANUP`),
  );

  it("returns canonical status guidance without a delay or dead broadcast", () => {
    expect(statusSection).toContain("/unipi:info");
    expect(statusSection).toContain("/unipi:doctor");
    expect(statusSection).not.toContain("MODULE_STATUS_REQUEST");
    expect(statusSection).not.toContain("setTimeout");
    expect(statusSection).not.toContain("Request ID");
  });
});
