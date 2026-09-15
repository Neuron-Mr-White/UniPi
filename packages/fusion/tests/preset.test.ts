import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortLabel,
  loadPreset,
  parsePreset,
  pushRecent,
  saveCuration,
  saveRuntimeState,
  stepEffort,
  globalPresetPath,
  projectPresetPath,
} from "../src/preset.js";

test("parsePreset drops junk and keeps qualified keys", () => {
  const p = parsePreset({
    lead: ["a/b", "nope", 3, "a/b"],
    sidekick: ["c/d"],
    default: { lead: "a/b", sidekick: 7 },
    effort: { "a/b": "high", "c/d": "bogus" },
    recent: ["x/1", "x/2", "x/3", "x/4", "x/5", "x/6"],
    active: { kind: "fusion", lead: "a/b", sidekick: "c/d" },
  });
  assert.deepEqual(p.lead, ["a/b"]);
  assert.deepEqual(p.sidekick, ["c/d"]);
  assert.deepEqual(p.default, { lead: "a/b" });
  assert.deepEqual(p.effort, { "a/b": "high" });
  assert.equal(p.recent?.length, 5);
  assert.deepEqual(p.active, { kind: "fusion", lead: "a/b", sidekick: "c/d" });
});

test("project layer overrides lists but merges effort", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fusion-cwd-"));
  mkdirSync(join(home, ".unipi", "config", "fusion"), { recursive: true });
  writeFileSync(
    globalPresetPath(home),
    JSON.stringify({ lead: ["g/lead"], sidekick: ["g/side"], effort: { "g/lead": "low" }, recent: ["g/lead"] }),
  );
  mkdirSync(join(cwd, ".unipi"), { recursive: true });
  writeFileSync(projectPresetPath(cwd), JSON.stringify({ lead: ["p/lead"], effort: { "p/lead": "high" } }));
  const { preset, hasProjectLayer } = loadPreset(cwd, home);
  assert.equal(hasProjectLayer, true);
  assert.deepEqual(preset.lead, ["p/lead"]);
  assert.deepEqual(preset.sidekick, ["g/side"]);
  assert.deepEqual(preset.effort, { "g/lead": "low", "p/lead": "high" });
  assert.deepEqual(preset.recent, ["g/lead"]);
});

test("saveCuration + saveRuntimeState round-trip without clobbering each other", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-home-"));
  const path = globalPresetPath(home);
  saveCuration(path, { lead: ["a/b"], sidekick: ["c/d"], default: { lead: "a/b", sidekick: "c/d" } });
  saveRuntimeState(path, { effort: { "a/b": "xhigh" }, recent: ["a/b"], active: { kind: "single", model: "a/b" } });
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw["lead"], ["a/b"]);
  assert.deepEqual(raw["effort"], { "a/b": "xhigh" });
  assert.deepEqual(raw["active"], { kind: "single", model: "a/b" });
  saveCuration(path, { lead: ["a/b", "e/f"], sidekick: ["c/d"], default: { lead: "e/f" } });
  const { preset } = loadPreset(mkdtempSync(join(tmpdir(), "cwd-")), home);
  assert.deepEqual(preset.lead, ["a/b", "e/f"]);
  assert.deepEqual(preset.effort, { "a/b": "xhigh" });
  assert.deepEqual(preset.active, { kind: "single", model: "a/b" });
});

test("effort helpers", () => {
  assert.equal(stepEffort("off", -1), "off");
  assert.equal(stepEffort("off", 1), "minimal");
  assert.equal(stepEffort("xhigh", 1), "xhigh");
  assert.equal(stepEffort("medium", 1), "high");
  assert.equal(effortLabel("off"), "None");
  assert.equal(effortLabel("xhigh"), "XHigh");
  assert.equal(effortLabel("medium"), "Medium");
  assert.deepEqual(pushRecent(["b", "a"], "a"), ["a", "b"]);
  assert.deepEqual(pushRecent(["1", "2", "3", "4", "5"], "6"), ["6", "1", "2", "3", "4"]);
});
