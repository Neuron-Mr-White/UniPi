import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Gate } from "../gate.js";
import { OwnerCoordinator } from "../owner.js";
import { DEFAULT_SETTINGS, loadSettings, resetSettingsCache, saveSettings } from "../settings.js";

const originalHome = process.env.HOME;

function sandboxHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-badge-"));
  process.env.HOME = dir;
  resetSettingsCache();
  return dir;
}

test("showDecisionBadge defaults on, repairs, and toggles", () => {
  const dir = sandboxHome();
  assert.equal(loadSettings(true).showDecisionBadge, true);
  saveSettings({ showDecisionBadge: false });
  assert.equal(loadSettings(true).showDecisionBadge, false);
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("gate skips the badge entry when showDecisionBadge is false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-badge2-"));
  const appended: unknown[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry: (_type: string, data: unknown) => {
      appended.push(data);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    emit: () => undefined,
  } as never;
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const off = { ...DEFAULT_SETTINGS, showDecisionBadge: false };
  const gate = new Gate({ owner, loadSettings: () => off, env: {} });
  gate.register(pi);
  const handler = handlers.get("before_agent_start")?.[0];
  assert.ok(handler);
  await handler({ prompt: "hello", systemPrompt: "BASE" }, {});
  assert.equal(appended.length, 0);

  const on = { ...DEFAULT_SETTINGS, showDecisionBadge: true };
  const gate2 = new Gate({ owner, loadSettings: () => on, env: {} });
  gate2.register(pi);
  const handler2 = [...(handlers.get("before_agent_start") ?? [])].at(-1);
  assert.ok(handler2);
  await handler2({ prompt: "hello", systemPrompt: "BASE" }, {});
  assert.equal(appended.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
