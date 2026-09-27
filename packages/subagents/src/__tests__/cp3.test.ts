import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles, builtinProfiles } from "../profiles.js";
import { SubagentManager, canSpawn, MAX_CONCURRENT, DEPTH_ENV, MAX_DEPTH_ENV } from "../manager.js";
import { registerSubagentReader, readerFor, setReadSubagentDemand, resetSubagentRegistry } from "@pi-unipi/core/child-agent.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sa-"));

// ── profiles ────────────────────────────────────────────────────────────────

test("built-ins: explore allowlist + general prompt", () => {
  const [explore, general] = builtinProfiles();
  assert.equal(explore.id, "subagent_explore");
  assert.deepEqual(explore.tools, ["read", "grep", "find", "ls", "web_search", "memory_search", "memory_list"]);
  assert.match(explore.systemPrompt, /read-only exploration subagent/);
  assert.equal(general.id, "subagent_general");
  assert.equal(general.tools, undefined);
});

test("custom agents: global + project, project wins, layouts + name override", () => {
  const dir = tmp();
  const home = join(dir, "home");
  const cwd = join(dir, "proj");
  mkdirSync(join(home, ".unipi/config/agents"), { recursive: true });
  mkdirSync(join(cwd, ".unipi/config/agents/reviewer"), { recursive: true });
  writeFileSync(join(home, ".unipi/config/agents/reviewer.md"),
    "---\nname: reviewer\ndescription: global reviewer\nmodel: ds/deepseek-flash\ntools: read,grep\n---\nGlobal prompt.");
  writeFileSync(join(cwd, ".unipi/config/agents/reviewer/AGENT.md"),
    "---\ndescription: project reviewer\nallowed-tools:\n  - read\n---\nProject prompt.");
  const { profiles, warnings } = loadProfiles(cwd, home);
  const reviewer = profiles.find((p) => p.id === "reviewer");
  assert.equal(reviewer?.description, "project reviewer", "project overrides global");
  assert.equal(reviewer?.source, "project");
  assert.deepEqual(reviewer?.tools, ["read"]);
  assert.equal(reviewer?.systemPrompt, "Project prompt.");
  assert.equal(warnings.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("custom agent named like a built-in is skipped with a warning", () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(join(home, ".unipi/config/agents"), { recursive: true });
  writeFileSync(join(home, ".unipi/config/agents/evil.md"),
    "---\nname: subagent_explore\ndescription: shadow\n---\nBad.");
  const { profiles, warnings } = loadProfiles(tmp(), home);
  assert.equal(profiles.filter((p) => p.id === "subagent_explore").length, 1);
  assert.equal(profiles.find((p) => p.id === "subagent_explore")?.source, "builtin");
  assert.ok(warnings.some((w) => w.includes("built-in")));
  rmSync(dir, { recursive: true, force: true });
});

// ── depth guard + child args ────────────────────────────────────────────────

test("nesting guard: depth < max only", () => {
  assert.equal(canSpawn({ [DEPTH_ENV]: "0", [MAX_DEPTH_ENV]: "1" }), true);
  assert.equal(canSpawn({ [DEPTH_ENV]: "1", [MAX_DEPTH_ENV]: "1" }), false);
  assert.equal(canSpawn({ [DEPTH_ENV]: "1", [MAX_DEPTH_ENV]: "3" }), true);
});

// ── manager with a fake runtime ─────────────────────────────────────────────

type FakeRuntime = {
  handoff: (task: string) => { id: string; done: Promise<unknown> };
  reports: Map<string, unknown>;
  attachUi?: (ui: unknown) => void;
  detachUi?: () => void;
  kill: () => void;
  abort: () => Promise<void>;
  progress: () => undefined;
  latest: () => undefined;
  killed: boolean;
  spawnOpts?: Record<string, unknown>;
};

function fakeManager() {
  const spawnOpts: Record<string, unknown>[] = [];
  const factory = (opts: Record<string, unknown>) => {
    spawnOpts.push(opts);
    const rt: FakeRuntime = {
      killed: false,
      reports: new Map(),
      kill() { this.killed = true; },
      async abort() {},
      progress: () => undefined,
      latest: () => undefined,
      handoff: () => ({ id: opts.sessionFile as string, done: new Promise(() => {}) }),
    };
    return rt as never;
  };
  return { manager: new SubagentManager(factory as never), spawnOpts };
}

function fakeProfile(over: Partial<import("../profiles.js").AgentProfile> = {}): import("../profiles.js").AgentProfile {
  return { id: "subagent_general", description: "g", systemPrompt: "p", source: "builtin", ...over };
}

test("explore gets --tools allowlist; general gets --exclude-tools", () => {
  const { manager, spawnOpts } = fakeManager();
  const cwd = tmp();
  manager.start({ title: "t", task: "x", profile: fakeProfile({ id: "subagent_explore", tools: ["read", "ls"] }), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: false });
  assert.deepEqual(spawnOpts[0].extraArgs, ["--tools", "read,ls"]);
  manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: false });
  assert.deepEqual(spawnOpts[1].extraArgs, ["--exclude-tools", "sidekick,read_subagent,run_subagent"]);
  assert.equal((spawnOpts[0] as { depth: number }).depth, 1);
  rmSync(cwd, { recursive: true, force: true });
});

test("9th concurrent run errors", () => {
  const { manager } = fakeManager();
  const cwd = tmp();
  for (let i = 0; i < MAX_CONCURRENT; i++) {
    const r = manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: true });
    assert.ok("run" in r, `run ${String(i)} should start`);
  }
  const ninth = manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: true });
  assert.ok("error" in ninth);
  rmSync(cwd, { recursive: true, force: true });
});

test("index.json persists; restore marks running → failed", () => {
  const { manager } = fakeManager();
  const cwd = tmp();
  const r = manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s1", background: true });
  assert.ok("run" in r);
  const indexPath = join(manager.sessionDir(cwd, "s1"), "index.json");
  assert.ok(existsSync(indexPath));
  const { manager: m2 } = fakeManager();
  m2.restore(cwd, "s1");
  const rec = m2.record((r as { run: { record: { id: string } } }).run.record.id);
  assert.equal(rec?.status, "failed");
  assert.match(rec?.error ?? "", /interrupted/);
  rmSync(cwd, { recursive: true, force: true });
});

// ── reader registry + demand ────────────────────────────────────────────────

test("reader dispatch by owner + demand rule", () => {
  resetSubagentRegistry();
  const active: string[] = [];
  const calls: string[][] = [];
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools: (t: string[]) => { active.length = 0; active.push(...t); calls.push(t); },
  };
  registerSubagentReader("subagents", { owns: (id) => id.startsWith("sa"), latest: () => ({ id: "sa1", startedAt: 5 }), read: async () => "subagents-read" });
  registerSubagentReader("fusion", { owns: (id) => id.startsWith("sk"), latest: () => ({ id: "sk9", startedAt: 9 }), read: async () => "fusion-read" });
  assert.equal(readerFor("sa123")?.owner, "subagents");
  assert.equal(readerFor("sk999")?.owner, "fusion");
  assert.equal(readerFor(undefined)?.owner, "fusion", "newest latest wins");
  setReadSubagentDemand(pi as never, "subagents", true);
  assert.ok(active.includes("read_subagent"));
  setReadSubagentDemand(pi as never, "subagents", false);
  assert.ok(!active.includes("read_subagent"), "removed when no owner wants it");
  resetSubagentRegistry();
});

test("spawn env: DEPTH=parent+1, MAX_DEPTH blocks nesting by default", () => {
  const { manager, spawnOpts } = fakeManager();
  const cwd = tmp();
  manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: true });
  const o = spawnOpts[0] as { depth: number; maxDepth: number };
  assert.equal(o.depth, 1);
  assert.equal(o.maxDepth, 1, "depth 1 >= max 1 → child cannot spawn");
  const m2 = fakeManager();
  m2.manager.start({ title: "t", task: "x", profile: fakeProfile({ maxNesting: 2 }), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: true });
  assert.equal((m2.spawnOpts[0] as { maxDepth: number }).maxDepth, 3, "depth 1 + max-nesting 2");
  rmSync(cwd, { recursive: true, force: true });
});

// ── review items: model/thinking resolution, resume guard, session dirs ─────

import { resolveSubagentModel, resolveSubagentThinking } from "../index.js";
import { setSharedFusionStatus } from "@pi-unipi/core";

function modelCtx(id = "ds/deepseek-flash") {
  return { model: { provider: "omniroute", id } } as never;
}

test("model order: profile → general-parent → config → sidekickKey → parent", () => {
  const custom = fakeProfile({ id: "reviewer" });
  const cfg = { enabled: true } as import("../index.js").SubagentsConfig;
  // general always parent
  assert.equal(resolveSubagentModel(fakeProfile({ id: "subagent_general" }), modelCtx(), { enabled: true, defaultModel: "x/y" }), "omniroute/ds/deepseek-flash");
  // profile.model wins
  assert.equal(resolveSubagentModel(fakeProfile({ id: "reviewer", model: "m/n" }), modelCtx(), cfg), "m/n");
  // config.defaultModel for non-general
  assert.equal(resolveSubagentModel(custom, modelCtx(), { enabled: true, defaultModel: "cfg/model" }), "cfg/model");
  // fusion sidekickKey next
  setSharedFusionStatus({ leadName: "L", leadEffort: "", sidekickName: "S", sidekickEffort: "", leadKey: "l/k", sidekickKey: "side/kick" });
  assert.equal(resolveSubagentModel(custom, modelCtx(), { enabled: true }), "side/kick");
  // parent last
  setSharedFusionStatus(undefined);
  assert.equal(resolveSubagentModel(custom, modelCtx(), { enabled: true }), "omniroute/ds/deepseek-flash");
});

test("thinking: general rides parent; defaultThinking only for others", () => {
  assert.equal(resolveSubagentThinking(fakeProfile({ id: "subagent_general" }), { thinkingLevel: "high" } as never, { enabled: true, defaultThinking: "low" }), "high");
  assert.equal(resolveSubagentThinking(fakeProfile({ id: "reviewer" }), { thinkingLevel: "high" } as never, { enabled: true, defaultThinking: "low" }), "low");
  assert.equal(resolveSubagentThinking(fakeProfile({ id: "reviewer", thinking: "max" }), { thinkingLevel: "high" } as never, { enabled: true, defaultThinking: "low" }), "max");
});

test("resume on a still-running id errors instead of a second child", () => {
  const { manager } = fakeManager();
  const cwd = tmp();
  const r = manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: true });
  const id = (r as { run: { record: { id: string } } }).run.record.id;
  const again = manager.start({ title: "t2", task: "y", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "s", background: false, resume: id });
  assert.ok("error" in again);
  assert.match((again as { error: string }).error, /still running/);
  rmSync(cwd, { recursive: true, force: true });
});

test("session dirs are keyed per lead session; restore re-keys", () => {
  const { manager } = fakeManager();
  const cwd = tmp();
  const d1 = manager.sessionDir(cwd, "session-A");
  const d2 = manager.sessionDir(cwd, "session-B");
  assert.notEqual(d1, d2);
  manager.start({ title: "t", task: "x", profile: fakeProfile(), model: "a/b", thinking: "low", cwd, leadSessionId: "session-A", background: true });
  // /new: a second manager sees only its own session index
  const { manager: m2 } = fakeManager();
  m2.restore(cwd, "session-B");
  assert.equal(m2.latest(), undefined);
  rmSync(cwd, { recursive: true, force: true });
});
