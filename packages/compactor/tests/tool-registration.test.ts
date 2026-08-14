import { describe, expect, it } from "bun:test";
import { registerCompactorTools } from "../src/tools/register.js";
import { PolyglotExecutor } from "../src/executor/executor.js";

const SANDBOX_TOOLS = [
  "sandbox",
  "ctx_execute",
  "sandbox_file",
  "ctx_execute_file",
  "sandbox_batch",
  "ctx_batch_execute",
];

function createRegistrationHarness(sandbox?: {
  executor: PolyglotExecutor;
  allowedLanguages: Array<"javascript" | "python">;
}) {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  };
  const sessionDB = {
    incrementSandboxRuns() {},
    incrementSearchQueries() {},
  };

  registerCompactorTools(pi as any, {
    sessionDB: sessionDB as any,
    getSessionId: () => "session-1",
    getBlocks: () => [],
    sandbox,
  });

  return tools;
}

describe("Compactor sandbox registration", () => {
  it("does not register sandbox tools when sandbox execution is off", () => {
    const tools = createRegistrationHarness();

    for (const name of SANDBOX_TOOLS) expect(tools.has(name)).toBe(false);
    expect(tools.has("compact")).toBe(true);
    expect(tools.has("session_recall")).toBe(true);
  });

  it("rejects a disabled language before executing it", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 100 });
    const tools = createRegistrationHarness({ executor, allowedLanguages: ["javascript"] });

    const result = await tools.get("sandbox").execute(
      "call-1",
      { language: "python", code: "print('must not run')" },
    );

    expect(result.content[0].text).toContain('Language "python" is disabled');
    expect(result.content[0].text).not.toContain("must not run");
  });

  it("uses the configured executor output limit", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 64 });
    const tools = createRegistrationHarness({ executor, allowedLanguages: ["javascript"] });

    const result = await tools.get("sandbox").execute(
      "call-1",
      { language: "javascript", code: "console.log('x'.repeat(2000))" },
    );

    expect(result.details.stdout.length).toBeLessThanOrEqual(64);
  });
});
