import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The paths module keys everything off homedir(); point HOME at a temp dir so
// the test never touches the real ~/.unipi tree.
let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "unipi-home-"));
  origHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(home, { recursive: true, force: true });
});

async function freshPaths() {
  // Re-import with the patched HOME. Node caches modules, but homedir() reads
  // the env at call time, so a single import is fine.
  return import("../paths.js");
}

describe("state paths", () => {
  it("routes each scope to its canonical root", async () => {
    const p = await freshPaths();
    const cwd = mkdtempSync(join(tmpdir(), "unipi-cwd-"));
    try {
      assert.ok(p.stateDir("fusion", "global").startsWith(join(home, ".unipi", "global")));
      assert.ok(p.stateDir("memory", "state", cwd).includes(join(".unipi", "workspace")));
      assert.ok(p.stateDir("memory", "state", cwd).endsWith(join("state", "memory")));
      assert.ok(p.stateDir("goal", "config", cwd).endsWith(join("config", "goal")));
      assert.ok(p.stateDir("lh", "session", cwd).includes(join("sessions", "")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sweepOrphanSessions removes dead-pid session dirs, keeps live ones", async () => {
    const p = await freshPaths();
    const wsDir = join(home, ".unipi", "workspace", "ws-uuid", "sessions");
    // A dead-pid orphan and a live (current-pid) session.
    const dead = join(wsDir, `ws-uuid-2147480000`);
    const live = join(wsDir, `ws-uuid-${process.pid}`);
    mkdirSync(join(dead, "fusion"), { recursive: true });
    mkdirSync(join(live, "fusion"), { recursive: true });

    const removed = p.sweepOrphanSessions();
    assert.ok(removed >= 1);
    assert.equal(existsSync(dead), false, "dead session reaped");
    assert.equal(existsSync(live), true, "live session kept");
  });
});
