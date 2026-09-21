import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspaceIdentity,
  resetWorkspaceCache,
  workspaceId,
  WORKSPACE_MARKER_FILE,
} from "../identity.js";
import { pidFromSessionId, sessionId } from "../paths.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unipi-ws-"));
  resetWorkspaceCache();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetWorkspaceCache();
});

describe("workspace identity", () => {
  it("mints a marker with a uuid on first touch", () => {
    const id = resolveWorkspaceIdentity(root);
    assert.match(id.workspaceId, /^[0-9a-f-]{36}$/);
    const marker = JSON.parse(readFileSync(join(root, WORKSPACE_MARKER_FILE), "utf8"));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.workspaceId, id.workspaceId);
  });

  it("is authoritative: an existing marker is never rebound", () => {
    const first = resolveWorkspaceIdentity(root).workspaceId;
    resetWorkspaceCache();
    const second = resolveWorkspaceIdentity(root).workspaceId;
    assert.equal(first, second);
  });

  it("keeps identity across a simulated repo move (marker travels)", () => {
    const idA = workspaceId(root);
    const moved = `${root}-moved`;
    mkdirSync(moved, { recursive: true });
    writeFileSync(
      join(moved, WORKSPACE_MARKER_FILE),
      JSON.stringify({ schemaVersion: 1, workspaceId: idA }),
    );
    resetWorkspaceCache();
    assert.equal(workspaceId(moved), idA, "moved tree keeps its id");
    rmSync(moved, { recursive: true, force: true });
  });

  it("gives different ids to two distinct unmarked trees (no basename collision)", () => {
    const a = join(root, "a", "proj");
    const b = join(root, "b", "proj");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    assert.notEqual(workspaceId(a), workspaceId(b));
  });

  it("appends the marker to .git/info/exclude when under git", () => {
    execFileSync("git", ["-C", root, "init", "-q"], { timeout: 5000 });
    resolveWorkspaceIdentity(root);
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    assert.ok(exclude.split(/\r?\n/).includes(WORKSPACE_MARKER_FILE));
  });
});

describe("session id", () => {
  it("embeds the pid and parses back", () => {
    const sid = sessionId(root);
    assert.ok(sid.endsWith(`-${process.pid}`));
    assert.equal(pidFromSessionId(sid), process.pid);
  });

  it("returns undefined for an unparseable session id", () => {
    assert.equal(pidFromSessionId("garbage"), undefined);
  });
});
