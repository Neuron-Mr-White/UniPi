/**
 * @pi-unipi/skill-registry — skill condition gate (UNI-300): a condition
 * registered over core's generic gate removes the skill from
 * `options.skills` and blocks `/skill:name` with a clear notice.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  registerSkillCondition,
  registerSkillConditionReason,
  resetSkillConditionsForTests,
} from "@pi-unipi/core";
import skillRegistry from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

describe("skill-registry — condition gate", () => {
  let home: string;
  let origHome: string | undefined;
  let handlers: Record<string, Handler>;
  let notes: Array<{ text: string; level: string }>;

  function fakePi(): unknown {
    handlers = {};
    return {
      on: (event: string, handler: Handler) => { handlers[event] = handler; },
      registerCommand: () => {},
      appendEntry: () => {},
      getCommands: () => [],
    };
  }

  function fakeCtx(): unknown {
    notes = [];
    return {
      hasUI: true,
      cwd: process.cwd(),
      ui: { setStatus: () => {}, notify: (text: string, level: string) => notes.push({ text, level }) },
      sessionManager: { getSessionId: () => "s", getEntries: () => [] },
    };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "skillreg-test-"));
    origHome = process.env.HOME;
    process.env.HOME = home;
    resetSkillConditionsForTests();
  });

  afterEach(() => {
    resetSkillConditionsForTests();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("condition false → the skill is removed from options.skills", async () => {
    let on = false;
    registerSkillCondition("browser", () => on);
    const pi = fakePi();
    skillRegistry(pi as never);
    const ctx = fakeCtx();
    (ctx as { sessionManager: { getSessionId: () => string } }).sessionManager.getSessionId();
    const event = {
      prompt: "hi",
      systemPromptOptions: { skills: [{ name: "browser", description: "browse" }, { name: "other", description: "d" }], sections: {} as Record<string, string> },
    };
    await (handlers["before_agent_start"] as (e: unknown, c: unknown) => Promise<unknown>)(event, ctx);
    const names = (event.systemPromptOptions.skills as Array<{ name: string }>).map((s) => s.name);
    assert.deepEqual(names, ["other"]);
  });

  it("condition true → the skill is listed", async () => {
    registerSkillCondition("browser", () => true);
    const pi = fakePi();
    skillRegistry(pi as never);
    const ctx = fakeCtx();
    const event = {
      prompt: "hi",
      systemPromptOptions: { skills: [{ name: "browser", description: "browse" }, { name: "other", description: "d" }], sections: {} as Record<string, string> },
    };
    await (handlers["before_agent_start"] as (e: unknown, c: unknown) => Promise<unknown>)(event, ctx);
    const names = (event.systemPromptOptions.skills as Array<{ name: string }>).map((s) => s.name);
    assert.deepEqual(names.sort(), ["browser", "other"]);
  });

  it("/skill:browser is blocked with the registered reason when the condition is false", async () => {
    registerSkillCondition("browser", () => false);
    registerSkillConditionReason("browser", () => "the browser is off on this PC — turn it on in the UniPi app");
    const pi = fakePi();
    skillRegistry(pi as never);
    const ctx = fakeCtx();
    const result = await (handlers["input"] as (e: unknown, c: unknown) => Promise<unknown>)({ text: "/skill:browser do a thing" }, ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.text, "the browser is off on this PC — turn it on in the UniPi app");
    assert.equal(notes[0]!.level, "warning");
  });

  it("/skill:browser passes through when the condition is true", async () => {
    registerSkillCondition("browser", () => true);
    const pi = fakePi();
    skillRegistry(pi as never);
    const ctx = fakeCtx();
    const result = await (handlers["input"] as (e: unknown, c: unknown) => Promise<unknown>)({ text: "/skill:browser do a thing" }, ctx);
    assert.equal(result, undefined);
    assert.equal(notes.length, 0);
  });
});
