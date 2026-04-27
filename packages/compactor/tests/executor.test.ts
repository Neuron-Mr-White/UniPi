import { describe, it, expect } from "bun:test";
import { PolyglotExecutor } from "../src/executor/executor.js";

describe("PolyglotExecutor", () => {
  it("executes JavaScript code", async () => {
    const executor = new PolyglotExecutor();
    const result = await executor.execute({
      language: "javascript",
      code: "console.log('hello');",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("executes Python code", async () => {
    const executor = new PolyglotExecutor();
    const result = await executor.execute({
      language: "python",
      code: "print('hello')",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("executes shell commands", async () => {
    const executor = new PolyglotExecutor();
    const result = await executor.execute({
      language: "shell",
      code: "echo hello",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("respects output cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 100 });
    const result = await executor.execute({
      language: "javascript",
      code: "console.log('x'.repeat(1000));",
      timeout: 5000,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });

  it("times out long-running code", async () => {
    const executor = new PolyglotExecutor();
    const result = await executor.execute({
      language: "shell",
      code: "sleep 5",
      timeout: 500,
    });
    expect(result.timedOut).toBe(true);
  });
});
