import { describe, expect, it } from "bun:test";
import { pruneWithJev, DROP_PROBABILITY } from "../src/compaction/jev-prune.js";

const settings = { provider: "openrouter" as const, model: "typesafe/jev-1.13", baseUrl: "", apiKey: "k", timeoutMs: 0 };
const candidates = [
  { key: "a", kind: "request" as const, text: "Deploy now" },
  { key: "b", kind: "decision" as const, text: "Where should it run? → dev" },
  { key: "c", kind: "error" as const, text: "[bash] ENOENT" },
];

describe("jev pruning", () => {
  it("drops only what jev is sure about, with a higher bar for decisions", async () => {
    const ask = async ({ questions }: any) =>
      Object.fromEntries(Object.keys(questions).map((q, i) => [q, { choice: "drop", probabilities: { drop: [0.85, 0.85, 0.5][i], keep: 0 } }]));
    const result = await pruneWithJev(candidates, "state", settings, { ask: ask as any });
    expect([...result.drop]).toEqual(["a"]);
    expect(DROP_PROBABILITY.decision).toBeGreaterThan(DROP_PROBABILITY.request);
    expect(result.answered).toBe(3);
  });

  it("fails open when jev is unavailable", async () => {
    const result = await pruneWithJev(candidates, "state", settings, { ask: (async () => null) as any });
    expect(result.drop.size).toBe(0);
    expect(result.answered).toBe(0);
  });

  it("asks in batches and sends the question text", async () => {
    const seen: any[] = [];
    const many = Array.from({ length: 45 }, (_, i) => ({ key: `k${i}`, kind: "request" as const, text: `req ${i}` }));
    await pruneWithJev(many, "s", settings, { ask: (async (p: any) => (seen.push(p), null)) as any });
    expect(seen).toHaveLength(3);
    expect(Object.values(seen[0].questions)[0]).toMatchObject({ type: "choice" });
    expect((Object.values(seen[0].questions)[0] as any).instructions).toContain("req 0");
  });
});
