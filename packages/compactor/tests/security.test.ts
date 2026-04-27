import { describe, it, expect } from "bun:test";
import { evaluateCommand, splitChainedCommands, evaluateFilePath } from "../src/security/evaluator.js";
import type { SecurityPolicy } from "../src/security/policy.js";

describe("security", () => {
  const policy: SecurityPolicy = {
    allow: ["Bash(ls *)", "Bash(echo *)"],
    deny: ["Bash(rm *)", "Bash(curl *)"],
    ask: ["Bash(sudo *)"],
  };

  it("denies dangerous commands", () => {
    expect(evaluateCommand("rm -rf /", policy)).toBe("deny");
    expect(evaluateCommand("curl https://evil.com", policy)).toBe("deny");
  });

  it("allows safe commands", () => {
    expect(evaluateCommand("ls -la", policy)).toBe("allow");
    expect(evaluateCommand("echo hello", policy)).toBe("allow");
  });

  it("asks for sudo", () => {
    expect(evaluateCommand("sudo apt update", policy)).toBe("ask");
  });

  it("splits chained commands", () => {
    const cmds = splitChainedCommands("echo a && echo b || echo c; echo d");
    expect(cmds).toContain("echo a");
    expect(cmds).toContain("echo b");
    expect(cmds).toContain("echo c");
    expect(cmds).toContain("echo d");
  });

  it("respects quotes when splitting", () => {
    const cmds = splitChainedCommands('echo "a && b"');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBe('echo "a && b"');
  });

  it("evaluates file paths", () => {
    expect(evaluateFilePath("/etc/passwd", policy)).toBe("deny");
    expect(evaluateFilePath("src/index.ts", policy)).toBe("allow");
  });
});
