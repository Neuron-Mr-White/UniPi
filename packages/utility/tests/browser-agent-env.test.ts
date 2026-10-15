import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentBrowserEnv, readAgentEndpoint, resetAgentBrowserEnv, browserSectionText } from "../src/browser/state.ts";

function hostWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "uni303-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

test("reads the host's stable agent address", () => {
  const dir = hostWith({ "browser-agent.json": { port: 4242, profile: "shop", pid: 7 } });
  assert.deepEqual(readAgentEndpoint({ UNIPI_HOST_DIR: dir }), { port: 4242, profile: "shop", pid: 7 });
  assert.equal(readAgentEndpoint({ UNIPI_HOST_DIR: hostWith({ "browser-agent.json": { port: "x" } }) }), undefined);
  assert.equal(readAgentEndpoint({ UNIPI_HOST_DIR: hostWith({}) }), undefined);
});

test("sets AGENT_BROWSER_CDP while on, removes it when off", () => {
  resetAgentBrowserEnv();
  const dir = hostWith({ "config.json": {}, "browser-agent.json": { port: 4242, profile: "default" } });
  const env: NodeJS.ProcessEnv = { UNIPI_HOST_DIR: dir };
  assert.equal(applyAgentBrowserEnv(env, true), "4242");
  assert.equal(env.AGENT_BROWSER_CDP, "4242");
  assert.equal(applyAgentBrowserEnv(env, false), undefined);
  assert.equal(env.AGENT_BROWSER_CDP, undefined);
});

test("no host address yet (host not running) → not set", () => {
  resetAgentBrowserEnv();
  const env: NodeJS.ProcessEnv = { UNIPI_HOST_DIR: hostWith({ "config.json": {} }) };
  assert.equal(applyAgentBrowserEnv(env, true), undefined);
  assert.equal("AGENT_BROWSER_CDP" in env, false);
});

test("a user's own AGENT_BROWSER_CDP is never touched", () => {
  resetAgentBrowserEnv();
  const dir = hostWith({ "browser-agent.json": { port: 4242, profile: "default" } });
  const env: NodeJS.ProcessEnv = { UNIPI_HOST_DIR: dir, AGENT_BROWSER_CDP: "9222" };
  assert.equal(applyAgentBrowserEnv(env, true), "9222");
  assert.equal(applyAgentBrowserEnv(env, false), "9222");
  assert.equal(env.AGENT_BROWSER_CDP, "9222");
});

test("the context line tells the agent there is no connect step", () => {
  const text = browserSectionText(["default"]);
  assert.match(text, /AGENT_BROWSER_CDP/);
  assert.match(text, /no start or connect step/);
});
