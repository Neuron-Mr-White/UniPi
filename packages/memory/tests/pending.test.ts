import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enqueuePending, pendingCount, readPending, replayPending } from "../pending.js";

function withHome(fn: (home: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-pending-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      await fn(home);
    } finally {
      process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

test("journal enqueue + read + dedupe", withHome(() => {
  enqueuePending({ kind: "store", file: "/a/m.md", project: "p", id: "m", enqueuedAt: "t" });
  enqueuePending({ kind: "store", file: "/a/m.md", project: "p", id: "m", enqueuedAt: "t2" });
  enqueuePending({ kind: "delete", file: "/a/n.md", project: "p", id: "n", enqueuedAt: "t" });
  const ops = readPending();
  assert.equal(ops.length, 2); // same (kind,file) dedupes
  assert.equal(ops[0].enqueuedAt, "t2");
}));

test("replay drops filed ops, keeps markdown-only", withHome(async () => {
  enqueuePending({ kind: "store", file: "/a/ok.md", project: "p", id: "ok", enqueuedAt: "t" });
  enqueuePending({ kind: "delete", file: "/a/bad.md", project: "p", id: "bad", enqueuedAt: "t" });
  const left = await replayPending(async (op) => op.id === "ok" ? "filed" : "markdown-only");
  assert.equal(left, 1);
  const ops = readPending();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, "bad");
}));
