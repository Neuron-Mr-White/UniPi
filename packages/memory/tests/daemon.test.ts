import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { submitJob, waitJob } from "../daemon.js";

// Fake daemon: POST /jobs -> {job:{id,kind,state:"queued"}}, GET /jobs/<id> -> queued then succeeded.
let server: http.Server;
let port = 0;
const jobs = new Map<string, { state: string; kind: string; payload: unknown }>();
let jobSeq = 0;

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = req.headers.authorization;
  if (auth !== "Bearer tok123") {
    res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (req.method === "POST" && req.url === "/jobs") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { kind, payload } = JSON.parse(body);
      const id = `job-${++jobSeq}`;
      jobs.set(id, { state: kind === "refused" ? "failed" : "queued", kind, payload });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ job: { id, kind, state: "queued" } }));
    });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/jobs/")) {
    const id = req.url.split("/").pop()!;
    const job = jobs.get(id);
    if (!job) {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (job.state === "queued") job.state = "running";
    else if (job.state === "running") job.state = "succeeded";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ job: { id, kind: job.kind, state: job.state, result: { success: job.state === "succeeded" } } }));
    return;
  }
  res.writeHead(404).end("{}");
}

function writeEndpoint(home: string, palace: string): string {
  const canonical = fs.realpathSync(palace);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  const dir = path.join(home, ".mempalace", "daemon", key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "endpoint.json"), JSON.stringify({ host: "127.0.0.1", port }));
  fs.writeFileSync(path.join(dir, "token"), "tok123");
  return palace;
}

let home: string;
let palace: string;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-daemon-"));
  palace = path.join(home, ".mempalace", "palace");
  fs.mkdirSync(palace, { recursive: true });
  server = http.createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  writeEndpoint(home, palace);
});

after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("submit + wait succeeds", async () => {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const sub = await submitJob("mine", { source: "/x", files: ["/x/a.md"], wing: "x" }, palace);
    assert.equal(sub.ok, true);
    assert.equal(sub.job?.kind, "mine");
    const waited = await waitJob(sub.job!.id, 5_000, palace);
    assert.equal(waited.done, true);
    assert.equal(waited.job?.state, "succeeded");
    // payload round-tripped
    const stored = [...jobs.values()].find((j) => j.kind === "mine");
    assert.deepEqual((stored?.payload as { wing?: string })?.wing, "x");
  } finally {
    process.env.HOME = prev;
  }
});

test("waitJob reports refused/failed jobs", async () => {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const sub = await submitJob("refused", {}, palace);
    assert.equal(sub.ok, true);
    const waited = await waitJob(sub.job!.id, 5_000, palace);
    assert.equal(waited.done, true);
    assert.equal(waited.job?.state, "failed");
  } finally {
    process.env.HOME = prev;
  }
});

test("submit with no endpoint fails cleanly", async () => {
  const prev = process.env.HOME;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "mem-nodaemon-"));
  process.env.HOME = emptyHome;
  try {
    const res = await submitJob("mine", {}, palace);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /endpoint/);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});
