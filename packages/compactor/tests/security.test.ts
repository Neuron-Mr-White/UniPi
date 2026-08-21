import { describe, it, expect } from "bun:test";
import { evaluateCommand, evaluateFilePath } from "../src/security/evaluator.js";
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


  it("evaluates file paths", () => {
    expect(evaluateFilePath("/etc/passwd", policy)).toBe("deny");
    expect(evaluateFilePath("src/index.ts", policy)).toBe("allow");
  });
});
