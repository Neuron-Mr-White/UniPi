import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryReader } from "../reader.js";

// Fake stdio MCP server: answers initialize + tools/call.
const FAKE_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
    return;
  }
  if (m.method === "tools/call") {
    const name = m.params.name;
    let payload = {};
    if (name === "mempalace_search") payload = { results: [{ drawer_id: "d1", text: "hi", score: 0.9, metadata: { wing: "w", room: "r" } }] };
    else if (name === "mempalace_list_drawers") payload = { drawers: [{ drawer_id: "d1", wing: "w", room: "r", content_preview: "x" }] };
    else if (name === "mempalace_get_drawer") payload = { drawer_id: m.params.arguments.drawer_id, content: "full" };
    else if (name === "mempalace_status") payload = { ok: true, drawers: 1 };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    return;
  }
});
`;

test("reader talks JSON-RPC over stdio", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reader-"));
  const venv = path.join(dir, "venv", "bin");
  fs.mkdirSync(venv, { recursive: true });
  const script = path.join(dir, "fake-mcp.cjs");
  fs.writeFileSync(script, FAKE_SERVER);
  // The reader resolves <dirname(python)>/mempalace-mcp — shim it to node.
  fs.writeFileSync(path.join(venv, "mempalace-mcp"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
  fs.chmodSync(path.join(venv, "mempalace-mcp"), 0o755);
  fs.writeFileSync(path.join(venv, "python"), "#!/bin/sh\nexec /bin/sh\n");
  fs.chmodSync(path.join(venv, "python"), 0o755);

  const reader = new MemoryReader({ python: path.join(venv, "python"), version: "x" }, "/palace");
  try {
    assert.equal(await reader.start(), true);
    const hits = await reader.search("q", 5);
    assert.equal(hits[0]?.drawer_id, "d1");
    assert.equal((await reader.listDrawers("w", "r", 10)).length, 1);
    assert.equal((await reader.getDrawer("d1"))?.content, "full");
    assert.equal((await reader.status())?.ok, true);
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getDrawers batches >500 ids into multiple calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reader2-"));
  const venv = path.join(dir, "venv", "bin");
  fs.mkdirSync(venv, { recursive: true });
  const script = path.join(dir, "fake-mcp2.cjs");
  fs.writeFileSync(script, `
const rl = require("readline").createInterface({ input: process.stdin });
let calls = 0;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
    return;
  }
  if (m.method === "tools/call") {
    calls += 1;
    const n = m.params.arguments.drawer_ids.length;
    const payload = { results: m.params.arguments.drawer_ids.map((id) => ({ drawer_id: id, content: "c" })) };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
  }
});
`);
  fs.writeFileSync(path.join(venv, "mempalace-mcp"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
  fs.chmodSync(path.join(venv, "mempalace-mcp"), 0o755);
  fs.writeFileSync(path.join(venv, "python"), "#!/bin/sh\nexec /bin/sh\n");
  fs.chmodSync(path.join(venv, "python"), 0o755);

  const reader = new MemoryReader({ python: path.join(venv, "python"), version: "x" }, "/palace");
  try {
    assert.equal(await reader.start(), true);
    const ids = Array.from({ length: 1200 }, (_, i) => `d_${i}`);
    const docs = await reader.getDrawers(ids);
    // 1200 ids → 3 calls of ≤500 → 1200 results total.
    assert.equal(docs.length, 1200);
    assert.equal(docs[0].drawer_id, "d_0");
    assert.equal(docs[1199].drawer_id, "d_1199");
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getDrawers falls back to per-id get_drawer when get_drawers is missing (MemPalace 3.10)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reader3-"));
  const venv = path.join(dir, "venv", "bin");
  fs.mkdirSync(venv, { recursive: true });
  const script = path.join(dir, "fake-mcp.cjs");
  fs.writeFileSync(script, FAKE_SERVER); // no mempalace_get_drawers → {} payload
  fs.writeFileSync(path.join(venv, "mempalace-mcp"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
  fs.chmodSync(path.join(venv, "mempalace-mcp"), 0o755);
  fs.writeFileSync(path.join(venv, "python"), "#!/bin/sh\nexec /bin/sh\n");
  fs.chmodSync(path.join(venv, "python"), 0o755);
  const reader = new MemoryReader({ python: path.join(venv, "python"), version: "x" }, "/palace");
  try {
    const docs = await reader.getDrawers(["a", "b"]);
    assert.deepEqual(docs.map((d) => [d.drawer_id, d.content]), [["a", "full"], ["b", "full"]]);
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reader respawns after the child is killed by a signal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reader4-"));
  const venv = path.join(dir, "venv", "bin");
  fs.mkdirSync(venv, { recursive: true });
  const script = path.join(dir, "fake-mcp.cjs");
  fs.writeFileSync(script, FAKE_SERVER);
  fs.writeFileSync(path.join(venv, "mempalace-mcp"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
  fs.chmodSync(path.join(venv, "mempalace-mcp"), 0o755);
  fs.writeFileSync(path.join(venv, "python"), "#!/bin/sh\nexec /bin/sh\n");
  fs.chmodSync(path.join(venv, "python"), 0o755);
  const reader = new MemoryReader({ python: path.join(venv, "python"), version: "x" }, "/palace");
  try {
    assert.equal(await reader.start(), true);
    for (let i = 0; i < 2; i++) {
      const proc = (reader as unknown as { proc: import("node:child_process").ChildProcess }).proc;
      const closed = new Promise((r) => proc.once("close", r));
      proc.kill("SIGKILL");
      await closed;
      assert.equal((await reader.status())?.ok, true, `status after kill #${i + 1}`);
    }
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── UNI-179: lazy start, idle unload, malloc arena cap ─────────────────────

/** Fake server that echoes its env + pid, and can sleep on a "slow" query. */
const ENV_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: {} });
  if (m.method !== "tools/call") return;
  const payload = { ok: true, pid: process.pid, arena: process.env.MALLOC_ARENA_MAX ?? null, results: [] };
  const text = JSON.stringify(payload);
  if (m.params.arguments && m.params.arguments.query === "slow") {
    setTimeout(() => reply({ content: [{ type: "text", text }] }), 250);
    return;
  }
  reply({ content: [{ type: "text", text }] });
});
`;

function envShim(): { dir: string; install: { python: string; version: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reader-env-"));
  const venv = path.join(dir, "venv", "bin");
  fs.mkdirSync(venv, { recursive: true });
  const script = path.join(dir, "env-mcp.cjs");
  fs.writeFileSync(script, ENV_SERVER);
  fs.writeFileSync(path.join(venv, "mempalace-mcp"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
  fs.chmodSync(path.join(venv, "mempalace-mcp"), 0o755);
  fs.writeFileSync(path.join(venv, "python"), "#!/bin/sh\nexec /bin/sh\n");
  fs.chmodSync(path.join(venv, "python"), 0o755);
  return { dir, install: { python: path.join(venv, "python"), version: "x" } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("reader is lazy: no process until the first call", async () => {
  const { dir, install } = envShim();
  const reader = new MemoryReader(install, "/palace");
  try {
    assert.equal(reader.pid, undefined);
    await sleep(50);
    assert.equal(reader.pid, undefined, "constructing a reader must not spawn");
    assert.equal((await reader.status())?.ok, true);
    assert.equal(typeof reader.pid, "number");
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reader caps glibc malloc arenas (MALLOC_ARENA_MAX=2) unless the user set one", async () => {
  const { dir, install } = envShim();
  const prev = process.env.MALLOC_ARENA_MAX;
  try {
    delete process.env.MALLOC_ARENA_MAX;
    const a = new MemoryReader(install, "/palace");
    assert.equal((await a.status())?.arena, "2");
    a.kill();
    process.env.MALLOC_ARENA_MAX = "4";
    const b = new MemoryReader(install, "/palace");
    assert.equal((await b.status())?.arena, "4");
    b.kill();
  } finally {
    if (prev === undefined) delete process.env.MALLOC_ARENA_MAX;
    else process.env.MALLOC_ARENA_MAX = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reader unloads after the idle window and respawns on the next call", async () => {
  const { dir, install } = envShim();
  const reader = new MemoryReader(install, "/palace", true, 120);
  try {
    const first = (await reader.status())?.pid as number;
    assert.equal(reader.pid, first);
    await sleep(300);
    assert.equal(reader.pid, undefined, "idle reader should be unloaded");
    assert.equal(reader.idleUnloads, 1);
    let alive = true;
    try { process.kill(first, 0); } catch { alive = false; }
    assert.equal(alive, false, "the unloaded server process must actually exit");
    // Many unload/respawn cycles must not eat the crash-respawn budget (5/10min).
    for (let i = 0; i < 7; i++) {
      const pid = (await reader.status())?.pid;
      assert.equal(typeof pid, "number", `respawn #${i + 1}`);
      await sleep(200);
    }
    assert.ok(reader.idleUnloads >= 7);
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reader never unloads under an in-flight call", async () => {
  const { dir, install } = envShim();
  const reader = new MemoryReader(install, "/palace", true, 60);
  try {
    await reader.start();
    const pid = reader.pid;
    // The slow call (250ms) outlasts the idle window (60ms) several times.
    const hits = await reader.search("slow", 5);
    assert.deepEqual(hits, []);
    assert.equal(reader.idleUnloads, 0);
    assert.equal(reader.pid, pid);
  } finally {
    reader.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idleMs=0 keeps the reader warm; kill() clears the idle timer", async () => {
  const { dir, install } = envShim();
  const warm = new MemoryReader(install, "/palace", true, 0);
  const idle = new MemoryReader(install, "/palace", true, 50);
  try {
    await warm.status();
    await idle.status();
    idle.kill();
    await sleep(150);
    assert.equal(typeof warm.pid, "number");
    assert.equal(warm.idleUnloads, 0);
    assert.equal(idle.idleUnloads, 0, "a killed reader's timer must not fire");
  } finally {
    warm.kill();
    idle.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
