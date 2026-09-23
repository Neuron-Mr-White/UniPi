/**
 * Saved rules: glob matching, deny-wins, pattern suggestions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globMatches, matchRule, normalizeRules, suggestPattern, type PermissionRule } from "../src/permission/rules.js";

const rule = (pattern: string, decision: "allow" | "deny", tool = "bash"): PermissionRule => ({
  tool,
  pattern,
  decision,
  scope: "project",
});

describe("globMatches", () => {
  it("matches * across spaces and paths", () => {
    assert.equal(globMatches("npm run *", "npm run build --watch"), true);
    assert.equal(globMatches("/tmp/*", "/tmp/a/b"), true);
    assert.equal(globMatches("npm run *", "yarn run build"), false);
  });

  it("treats other characters literally", () => {
    assert.equal(globMatches("rm -rf /tmp/wd-test", "rm -rf /tmp/wd-test"), true);
    assert.equal(globMatches("a.b", "axb"), false);
    assert.equal(globMatches("a+b", "a+b"), true);
  });

  it("? matches exactly one character", () => {
    assert.equal(globMatches("v?", "v1"), true);
    assert.equal(globMatches("v?", "v12"), false);
  });
});

describe("matchRule", () => {
  it("deny shadows allow for the same subject", () => {
    const rules = [rule("git push *", "allow"), rule("git push *", "deny")];
    assert.equal(matchRule(rules, "bash", "git push origin main")?.decision, "deny");
  });

  it("matches only the right tool unless the rule is *", () => {
    const rules = [{ ...rule("/tmp/*", "allow"), tool: "write" }, rule("*all*", "deny", "*")];
    assert.equal(matchRule(rules, "write", "/tmp/x")?.decision, "allow");
    assert.equal(matchRule(rules, "bash", "install-all")?.decision, "deny");
  });

  it("returns undefined when nothing matches", () => {
    assert.equal(matchRule([rule("npm *", "allow")], "bash", "ls"), undefined);
  });
});

describe("normalizeRules", () => {
  it("drops malformed entries", () => {
    const rules = normalizeRules([
      { tool: "bash", pattern: "npm *", decision: "allow" },
      { pattern: "", decision: "allow" },
      { pattern: "x", decision: "maybe" },
      null,
      "nope",
    ]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.scope, "project");
  });

  it("returns [] for a non-array", () => {
    assert.deepEqual(normalizeRules(undefined), []);
  });
});

describe("suggestPattern", () => {
  it("takes the first two words for a normal command", () => {
    assert.equal(suggestPattern("bash", "npm run build --watch"), "npm run *");
    assert.equal(suggestPattern("bash", "npm install left-pad"), "npm install *");
  });

  it("keeps destructive commands exact", () => {
    assert.equal(suggestPattern("bash", "rm -rf /tmp/wd-test"), "rm -rf /tmp/wd-test");
    assert.equal(suggestPattern("bash", "chmod -R 777 ."), "chmod -R 777 .");
  });

  it("keeps compound commands exact", () => {
    assert.equal(suggestPattern("bash", "cd /tmp && ./loop.sh --verbose"), "cd /tmp && ./loop.sh --verbose");
    assert.equal(suggestPattern("bash", "ls | wc -l"), "ls | wc -l");
    assert.equal(suggestPattern("bash", "a; b"), "a; b");
  });

  it("uses the containing directory for a path", () => {
    assert.equal(suggestPattern("write", "/home/me/project/src/a.ts"), "/home/me/project/src/*");
  });

  it("stops at a path segment", () => {
    assert.equal(suggestPattern("bash", "git add src/a.ts"), "git add *");
  });
});
