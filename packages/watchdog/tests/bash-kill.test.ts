/**
 * pid finder + process-group kill against REAL detached children of the test
 * process — mirroring how pi's bash tool spawns its shell.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { findBashChildren, killProcessGroup } from "../src/bash-kill.js";

const isWin = process.platform === "win32";

function spawnDetached(command: string): ChildProcess {
  const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("findBashChildren + killProcessGroup", () => {
  it("finds EXACTLY one detached child by command and kills its group", async () => {
    if (isWin) return;
    const cmd = "sleep 300; echo watchdog-target-alpha";
    const child = spawnDetached(cmd);
    await sleep(150); // let the shell materialize

    const candidates = findBashChildren(process.pid, cmd);
    const alive = candidates.pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    assert.ok(alive.length >= 1, "at least the shell matches");
    assert.equal(alive.length, 1, "exactly one match (shell; sleep is a grandchild)");

    const pgid = candidates.pgids[candidates.pids.indexOf(alive[0]!)]!;
    const outcome = killProcessGroup(pgid, alive[0]!, alive.length);
    assert.equal(outcome.killed, true);

    await sleep(300);
    let anyAlive = false;
    for (const pid of alive) {
      try { process.kill(pid, 0); anyAlive = true; } catch { /* exited */ }
    }
    assert.equal(anyAlive, false, "matched process killed");
  });

  it("two identical commands → ambiguity, no kill", async () => {
    if (isWin) return;
    const cmd = "sleep 300; echo watchdog-target-beta";
    const one = spawnDetached(cmd);
    const two = spawnDetached(cmd);
    await sleep(150);

    const candidates = findBashChildren(process.pid, cmd);
    assert.ok(candidates.pids.length >= 2, "both children found");
    const outcome = killProcessGroup(candidates.pgids[0]!, candidates.pids[0]!, candidates.pids.length);
    assert.equal(outcome.killed, false, "ambiguous → never guess");

    one.kill("SIGKILL");
    two.kill("SIGKILL");
    await sleep(100);
  });

  it("zero matches → empty candidates", () => {
    const candidates = findBashChildren(process.pid, "no-such-command-xyz-42");
    if (process.platform === "win32") {
      assert.equal(candidates.pids.length, 0);
    } else {
      assert.equal(candidates.pids.length, 0, "no child matches an unspawned command");
    }
  });
});
