import assert from "node:assert/strict";
import test from "node:test";
import { TrajectoryServer } from "../src/server.js";

test("serves only localhost page and live snapshot endpoint", async () => {
  let generatedAt = 1;
  const server = new TrajectoryServer({
    port: 18176,
    maxPort: 18186,
    snapshot: () => ({ sessionId: "s", generatedAt: generatedAt++, records: [] }),
  });
  const url = await server.start();
  try {
    const page = await (await fetch(url)).text();
    assert.match(page, /Trajectory toolbar/);
    assert.match(page, /Trajectory timeline/);
    assert.match(page, /Event details/);
    assert.match(await (await fetch(`${url}/app.js`)).text(), /setInterval\(update,500\)/);
    assert.match((await fetch(`${url}/style.css`)).headers.get("content-type") ?? "", /text\/css/);
    const first = await (await fetch(`${url}/api/snapshot`)).json() as { generatedAt: number };
    const second = await (await fetch(`${url}/api/snapshot`)).json() as { generatedAt: number };
    assert.equal(first.generatedAt, 1);
    assert.equal(second.generatedAt, 2);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
  } finally {
    server.stop();
  }
});
