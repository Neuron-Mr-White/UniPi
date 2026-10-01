import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCompactionContext, UNIPI_EVENTS } from "@pi-unipi/core";
import { planLosslessCompaction, registerCompactionHooks, setPendingCompaction } from "../src/compaction/hooks.js";
import { loadConfig, translateLegacyConfig } from "../src/config/manager.js";
import { DEFAULT_COMPACTOR_CONFIG } from "../src/config/schema.js";
import { originKey } from "../src/compaction/source.js";
import { assistant, user, workingSession } from "./fixtures.js";

// Bun caches homedir(), so tests pin every value in the PROJECT scope (under a
// temp cwd), which overrides whatever the machine's global config says.
const cwd = mkdtempSync(join(tmpdir(), "compactor-cwd-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const BASE = { method: "vcc", piCompact: "follow", trigger: "pi", thresholdPercent: 80, notify: true, smartKeepTail: true, summaryBudgetTokens: 0, cooldownMs: 60_000, repeatMinGrowthTokens: 4_000 };
const configFile = join(cwd, ".unipi", "config", "compactor", "config.json");
const writeConfig = (config: Record<string, unknown>) => {
  mkdirSync(join(cwd, ".unipi", "config", "compactor"), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ ...BASE, ...config }));
};

function harness() {
  const handlers = new Map<string, Function[]>();
  const sent: unknown[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const pi: any = {
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    sendMessage: (...args: unknown[]) => sent.push(["message", ...args]),
    sendUserMessage: (...args: unknown[]) => sent.push(["user", ...args]),
    events: { emit: (name: string, payload: unknown) => events.push({ name, payload }), on: () => {} },
    getThinkingLevel: () => "off",
  };
  registerCompactionHooks(pi, { counters: { recallQueries: 0, compactions: 0 } });
  const fire = (name: string, event: unknown, ctx: unknown = {}) => handlers.get(name)![0](event, ctx);
  return { fire, sent, entries, events };
}

const notifyCtx = (extra: Record<string, unknown> = {}) => ({ cwd, ui: { notify: () => {} }, ...extra });

const beforeCompact = (reason: string, customInstructions?: string, branch = workingSession()) => ({
  type: "session_before_compact",
  reason,
  customInstructions,
  branchEntries: branch,
  preparation: { tokensBefore: 50_000, previousSummary: undefined, fileOps: undefined },
  signal: new AbortController().signal,
});

beforeEach(() => {
  writeConfig({});
  setPendingCompaction(null);
});

describe("routing", () => {
  it("summarizes Pi's automatic compactions losslessly by default and never re-triggers the agent", async () => {
    const h = harness();
    const result = await h.fire("session_before_compact", beforeCompact("threshold"), notifyCtx());
    expect(result.compaction.details.method).toBe("vcc");
    expect(result.compaction.summary).toContain("[Your Requests]");
    h.fire("session_compact", { compactionEntry: { details: result.compaction.details }, fromExtension: true, reason: "threshold" }, notifyCtx());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent).toEqual([]);
    expect(h.events.some((e) => e.name === UNIPI_EVENTS.COMPACTOR_COMPACTED)).toBe(true);
  });

  it("the compactor marker always means lossless, even when the method is model summary", async () => {
    writeConfig({ method: "llm" });
    const h = harness();
    const result = await h.fire("session_before_compact", beforeCompact("manual", "__compactor__\nPreparing for new task"), notifyCtx());
    expect(result.compaction.details.method).toBe("vcc");
  });

  it("model summaries fall back to Pi's own path when auth fails", async () => {
    writeConfig({ piCompact: "llm" });
    const h = harness();
    const ctx = notifyCtx({ model: { id: "m", provider: "p" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } });
    expect(await h.fire("session_before_compact", beforeCompact("manual"), ctx)).toBeUndefined();
  });

  it("a pending method from a command wins over settings", async () => {
    writeConfig({ method: "llm" });
    setPendingCompaction("vcc");
    const h = harness();
    const result = await h.fire("session_before_compact", beforeCompact("manual", "__compactor__"), notifyCtx());
    expect(result.compaction.details.method).toBe("vcc");
  });

  it("lets Pi recover an overflow it cannot cut", async () => {
    const h = harness();
    expect(await h.fire("session_before_compact", beforeCompact("overflow", undefined, []), notifyCtx())).toBeUndefined();
  });

  it("leads the summary with registered active work", async () => {
    const off = registerCompactionContext("test-loop", () => "Goal (active, turn 3/50): \"ship the login page\"");
    const h = harness();
    const result = await h.fire("session_before_compact", beforeCompact("threshold"), notifyCtx());
    off();
    expect(result.compaction.summary.startsWith("[Active Work]\nGoal (active, turn 3/50)")).toBe(true);
  });
});

describe("percentage trigger", () => {
  const turnEnd = { type: "turn_end", entries: [], outcome: "completed", continue: false };
  const ctx = (percent: number) =>
    notifyCtx({
      getContextUsage: () => ({ tokens: percent * 1000, percent, contextWindow: 100_000 }),
      sessionManager: { getBranch: () => workingSession() },
    });

  it("with Notifications off, the boundary draft carries no card", async () => {
    writeConfig({ trigger: "percent", thresholdPercent: 70, notify: false });
    const result = await harness().fire("turn_end", turnEnd, ctx(85));
    expect(result.entries).toHaveLength(1);
  });

  it("compacts at the turn boundary with a draft instead of aborting the run", async () => {
    writeConfig({ trigger: "percent", thresholdPercent: 70 });
    const h = harness();
    const result = await h.fire("turn_end", turnEnd, ctx(85));
    // The compaction, then its card (a custom entry: shown, never sent to the model).
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].type).toBe("compaction");
    expect(result.entries[0].details.reason).toBe("percent");
    expect(result.entries[1]).toMatchObject({ type: "custom", customType: "unipi-compaction", data: { trigger: "percent", percent: 85, threshold: 70 } });
    expect(h.events.some((e) => e.name === UNIPI_EVENTS.COMPACTOR_COMPACTED)).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("does nothing below the threshold or when Pi owns the trigger", async () => {
    writeConfig({ trigger: "percent", thresholdPercent: 70 });
    expect(await harness().fire("turn_end", turnEnd, ctx(40))).toBeUndefined();
    writeConfig({ trigger: "pi" });
    expect(await harness().fire("turn_end", turnEnd, ctx(95))).toBeUndefined();
  });
});

describe("bookkeeping", () => {
  it("marks user messages that extensions send", () => {
    const h = harness();
    h.fire("input", { type: "input", text: "loop prompt", source: "extension" });
    h.fire("input", { type: "input", text: "my words", source: "interactive" });
    expect(h.entries).toEqual([{ type: "compactor-origin", data: { key: originKey("loop prompt") } }]);
  });

  it("keeps the removed continuity snapshot and auto-continue marker out of context", () => {
    const h = harness();
    const result = h.fire("context", {
      messages: [
        { role: "user", content: "hi" },
        { role: "custom", customType: "unipi-compactor-resume", content: "x".repeat(1000) },
        { role: "custom", customType: "compactor-auto-continue", content: [] },
        { role: "custom", customType: "other", content: "keep" },
      ],
    });
    expect(result.messages.map((m: any) => m.customType ?? m.role)).toEqual(["user", "other"]);
  });
});

describe("config", () => {
  it("defaults: lossless, Pi's trigger, Pi's /compact follows the method", () => {
    const config = DEFAULT_COMPACTOR_CONFIG;
    expect(config.method).toBe("vcc");
    expect(config.trigger).toBe("pi");
    expect(config.piCompact).toBe("follow");
    expect(Object.values(config.sections).every(Boolean)).toBe(true);
  });

  it("translates the pre-rework keys", () => {
    expect(translateLegacyConfig({ overrideDefaultCompaction: false })).toMatchObject({ method: "llm" });
    expect(translateLegacyConfig({ autoCompaction: { enabled: true, thresholdPercent: 65 } })).toMatchObject({ trigger: "percent", thresholdPercent: 65 });
    expect(translateLegacyConfig({ overrideDefaultCompaction: true, autoCompaction: { enabled: false } })).not.toHaveProperty("method");
    expect(translateLegacyConfig({ method: "vcc", overrideDefaultCompaction: false })).toMatchObject({ method: "vcc" });
  });

  it("loadConfig applies a legacy file", () => {
    mkdirSync(join(cwd, ".unipi", "config", "compactor"), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ overrideDefaultCompaction: false, autoCompaction: { enabled: true, thresholdPercent: 60 }, sessionGoals: { enabled: false } }));
    const config = loadConfig(cwd);
    expect(config.method).toBe("llm");
    expect(config.trigger).toBe("percent");
    expect(config.thresholdPercent).toBe(60);
    expect((config as any).sessionGoals).toBeUndefined();
  });
});

describe("fits the model window", () => {
  // 12 turns of ~4k tokens each (16k chars): ~48k tokens of history.
  const big = () => {
    const out: any[] = [];
    for (let i = 0; i < 12; i++) {
      out.push(user(`turn ${i}: please continue the work`));
      out.push(assistant(`working on step ${i} ` + "x".repeat(16_000)));
    }
    return out;
  };

  it("an explicit keep that would overflow a 32k window is recut to fit", () => {
    const plan = planLosslessCompaction({ branchEntries: big(), tokensBefore: 48_000, config: { ...DEFAULT_COMPACTOR_CONFIG }, cwd, keepUserTurns: 10, keepExplicit: true, contextWindow: 32_000 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.stats.keptTokensEst).toBeLessThanOrEqual(32_000 * 0.4);
    expect(plan.summary.length / 4).toBeLessThanOrEqual(32_000 * 0.08 + 50);
  });

  it("a large window keeps the requested tail", () => {
    const plan = planLosslessCompaction({ branchEntries: big(), tokensBefore: 48_000, config: { ...DEFAULT_COMPACTOR_CONFIG }, cwd, keepUserTurns: 3, keepExplicit: true, contextWindow: 1_000_000 });
    expect(plan.ok && plan.stats.keptUserTurns).toBe(3);
  });
});
