/**
 * Project-scoped pages (memory, mcp, compactor) persist per workspace;
 * machine-wide pages persist globally; the session page never persists.
 * Project A's numbers must never show in project B.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "info-snap-"));
process.env.UNIPI_DIR = join(root, "unipi");
const projA = join(root, "a");
const projB = join(root, "b");
mkdirSync(projA);
mkdirSync(projB);

const { infoRegistry } = await import("../registry.ts");

const page = (id: string, value: string) =>
  infoRegistry.registerGroup({ id, name: id, icon: "", priority: 1, config: { showByDefault: true, stats: [] }, dataProvider: async () => ({ v: { value } }) });

describe("snapshot scope", () => {
  it("keeps project pages per workspace and global pages shared", async () => {
    infoRegistry.persist = true;
    infoRegistry.setWorkspace(projA);
    page("memory", "A-memories");
    page("usage", "machine-usage");
    page("session", "live-only");
    await infoRegistry.getGroupData("memory");
    await infoRegistry.getGroupData("usage");
    await infoRegistry.getGroupData("session");
    infoRegistry.writeSnapshot();

    // New process in project B: fresh memory, same disk.
    infoRegistry._reset();
    infoRegistry.setWorkspace(projB);
    page("memory", "B-memories");
    page("usage", "machine-usage-2");
    page("session", "x");
    assert.equal(infoRegistry.getCachedData("memory"), null, "project A memory must not leak into B");
    assert.equal(infoRegistry.getCachedData("usage")?.v?.value, "machine-usage", "global page restores");
    assert.equal(infoRegistry.getCachedData("session"), null, "session never persists");

    // Back in A: its project snapshot is still there.
    infoRegistry._reset();
    infoRegistry.setWorkspace(projA);
    page("memory", "A2");
    assert.equal(infoRegistry.getCachedData("memory")?.v?.value, "A-memories");

    const dir = join(process.env.UNIPI_DIR!, "cache");
    assert.ok(existsSync(join(dir, "info-screen.json")));
    assert.equal(readdirSync(join(dir, "info-screen")).length, 1);
  });

  it("switching workspace drops project data held in memory", async () => {
    infoRegistry._reset();
    infoRegistry.persist = false;
    infoRegistry.setWorkspace(projA);
    page("memory", "A");
    page("usage", "U");
    await infoRegistry.getGroupData("memory");
    await infoRegistry.getGroupData("usage");
    infoRegistry.setWorkspace(projB);
    assert.equal(infoRegistry.getCachedData("memory"), null);
    assert.equal(infoRegistry.getCachedData("usage")?.v?.value, "U");
  });
});
