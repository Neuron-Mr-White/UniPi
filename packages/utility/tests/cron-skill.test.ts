/**
 * @pi-unipi/utility — skill:cron (UNI-315): gated on unipi-host being
 * installed (same cheap check browser's gate uses), and the SKILL.md
 * carries the required guidance (self-contained prompts, confirm the
 * schedule back, never create test jobs you don't clean up).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hostInstalled } from "../src/browser/state.ts";

describe("cron SKILL.md", () => {
  const text = readFileSync(new URL("../skills/cron/SKILL.md", import.meta.url), "utf8");

  it("has name: cron and a description that triggers on scheduling/reminders", () => {
    assert.match(text, /^---\nname: cron\n/);
    assert.match(text, /schedul/i);
    assert.match(text, /remind/i);
  });

  it("tells the agent to write self-contained, one-shot prompts", () => {
    assert.match(text, /self-contained/i);
    assert.match(text, /unattended/i);
    assert.match(text, /nobody|no one/i);
  });

  it("tells the agent where results go", () => {
    assert.match(text, /where the result goes|Say where the result goes/i);
    assert.ok(/file|note|notification/i.test(text));
  });

  it("tells the agent to confirm the schedule back with next fire times", () => {
    assert.match(text, /next 3\s+fire\s+times/i);
    assert.match(text, /Confirm the schedule back/i);
  });

  it("tells the agent to use cron runs / log to check results", () => {
    assert.match(text, /cron runs/);
    assert.match(text, /cron log/);
  });

  it("tells the agent never to create unasked-for jobs, and to remove test jobs", () => {
    assert.match(text, /Never create a job the user didn't ask for/i);
    assert.match(text, /Remove test jobs/i);
  });

  it("references the real CLI subcommands", () => {
    for (const cmd of ["cron add", "cron list", "cron show", "cron edit", "cron enable", "cron rm", "cron run", "cron stop", "cron pause", "cron status"]) {
      assert.ok(text.includes(cmd), `missing ${cmd}`);
    }
  });
});

describe("cron skill condition (gated like browser)", () => {
  it("hostInstalled reused as-is: no host dir, no PATH entry -> not installed", () => {
    assert.equal(hostInstalled("/does/not/exist", { PATH: "/usr/bin" }), false);
  });

  it("hostInstalled: host dir exists -> installed", () => {
    assert.equal(hostInstalled(".", { PATH: "" }), true);
  });
});
