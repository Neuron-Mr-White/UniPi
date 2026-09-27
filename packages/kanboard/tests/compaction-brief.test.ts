import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kanboardCompactionBrief } from "../src/runner.js";

describe("kanboard compaction brief", () => {
  const task = { id: "PIT-3", title: "Fix the header", body: "The header overlaps the hero on mobile.\n\nMake it sticky." } as any;

  it("keeps the task id, body and the runner's rules", () => {
    const brief = kanboardCompactionBrief(task, "goal", "/bin/kb", "site", "avoid");
    assert.match(brief, /^Kanboard task PIT-3 "Fix the header" is in progress \(strategy: goal\)/);
    assert.match(brief, /Task: The header overlaps the hero on mobile\. Make it sticky\./);
    assert.match(brief, /\/bin\/kb --actor agent --project site/);
    assert.match(brief, /Do not move the task to in_review or done/);
  });

  it("ask-mode blocking tells the agent how to hand back to the user", () => {
    assert.match(kanboardCompactionBrief(task, "none", "/bin/kb", "site", "ask"), /move PIT-3 blocked --comment/);
  });
});
