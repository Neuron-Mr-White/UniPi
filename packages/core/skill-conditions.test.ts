/**
 * @pi-unipi/core — skill visibility conditions (UNI-300)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerSkillCondition,
  registerSkillConditionReason,
  resetSkillConditionsForTests,
  skillConditionPasses,
  skillConditionReason,
} from "./src/skill-conditions.js";

beforeEach(() => resetSkillConditionsForTests());

describe("skill conditions", () => {
  it("no condition registered → passes", () => {
    assert.equal(skillConditionPasses("whatever"), true);
  });

  it("registered condition gates the skill", () => {
    let on = false;
    registerSkillCondition("browser", () => on);
    assert.equal(skillConditionPasses("browser"), false);
    on = true;
    assert.equal(skillConditionPasses("browser"), true);
  });

  it("a throwing condition counts as false (fail hidden, not crash)", () => {
    registerSkillCondition("flaky", () => {
      throw new Error("boom");
    });
    assert.equal(skillConditionPasses("flaky"), false);
  });

  it("reasons are optional and independent of the condition", () => {
    registerSkillCondition("browser", () => false);
    assert.equal(skillConditionReason("browser"), undefined);
    registerSkillConditionReason("browser", () => "the browser is off on this PC — turn it on in the UniPi app");
    assert.equal(skillConditionReason("browser"), "the browser is off on this PC — turn it on in the UniPi app");
  });

  it("a throwing reason function returns undefined, not a throw", () => {
    registerSkillConditionReason("x", () => {
      throw new Error("boom");
    });
    assert.equal(skillConditionReason("x"), undefined);
  });
});
