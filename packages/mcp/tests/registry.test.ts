import assert from "node:assert/strict";
import test from "node:test";
import { ServerRegistry, type RegistryClient } from "../src/bridge/registry.js";
import type { McpTool, ResolvedServer } from "../src/types.js";

function resolved(name: string): ResolvedServer {
  return {
    name,
    def: { command: name, args: [] },
    enabled: true,
    source: "global",
  };
}

function tool(name: string): McpTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

function createHarness(
  toolsByServer: Record<string, McpTool[]>,
  delays: Record<string, number> = {},
  register?: (name: string) => void,
) {
  const registered: string[] = [];
  const disconnected: string[] = [];
  const createClient = (): RegistryClient => {
    let server = "";
    return {
      async connect(command) {
        server = command;
      },
      async listTools() {
        await new Promise((resolve) => setTimeout(resolve, delays[server] ?? 0));
        return toolsByServer[server] ?? [];
      },
      async callTool() {
        return { content: [] };
      },
      async disconnect() {
        disconnected.push(server);
      },
      get pid() {
        return undefined;
      },
    };
  };

  const registry = new ServerRegistry({
    emitEvent: () => {},
    registerTool: (definition) => {
      register?.(definition.name);
      registered.push(definition.name);
    },
    unregisterTool: () => {},
    createClient,
  });
  return { registry, registered, disconnected };
}

test("startServers waits for discovery and registers combined tools by final name", async () => {
  const { registry, registered } = createHarness(
    { zebra: [tool("a"), tool("z")], alpha: [tool("z"), tool("b")] },
    { zebra: 0, alpha: 25 },
  );

  await registry.startServers([resolved("zebra"), resolved("alpha")]);

  assert.deepEqual(registered, ["alpha__b", "alpha__z", "zebra__a", "zebra__z"]);
  assert.deepEqual(registry.getEntry("alpha")?.toolNames, ["alpha__b", "alpha__z"]);
  assert.deepEqual(registry.getEntry("zebra")?.toolNames, ["zebra__a", "zebra__z"]);
});

test("startServer sorts a single server's tools by final name", async () => {
  const { registry, registered } = createHarness({ server: [tool("z"), tool("A"), tool("a")] });
  await registry.startServer(resolved("server"));
  assert.deepEqual(registered, ["server__A", "server__a", "server__z"]);
});

test("duplicate final names across servers fail before any registration", async () => {
  const { registry, registered, disconnected } = createHarness({
    a: [tool("b__same")],
    a__b: [tool("same")],
  });

  await assert.rejects(
    registry.startServers([resolved("a"), resolved("a__b")]),
    /Duplicate final MCP tool name\(s\): a__b__same/,
  );
  assert.deepEqual(registered, []);
  assert.equal(registry.getServerState("a")?.status, "error");
  assert.equal(registry.getServerState("a__b")?.status, "error");
  assert.deepEqual(disconnected.sort(), ["a", "a__b"]);
});

test("registration errors reject startup and are not reported as running", async () => {
  const { registry, registered } = createHarness(
    { server: [tool("a"), tool("b")] },
    {},
    (name) => {
      if (name === "server__b") throw new Error("registration failed");
    },
  );

  await assert.rejects(registry.startServer(resolved("server")), /registration failed/);
  assert.deepEqual(registered, ["server__a"]);
  assert.equal(registry.getServerState("server")?.status, "error");
  assert.equal(registry.getServerState("server")?.toolCount, 0);
  assert.deepEqual(registry.getEntry("server")?.toolNames, []);
});

test("hosts without tool removal report a partial registration truthfully", async () => {
  const registered: string[] = [];
  const registry = new ServerRegistry({
    emitEvent: () => {},
    registerTool: (definition) => {
      if (definition.name === "server__b") throw new Error("registration failed");
      registered.push(definition.name);
    },
    unregisterTool: () => { throw new Error("must not be called"); },
    canUnregisterTools: false,
    createClient: () => ({
      async connect() {},
      async listTools() { return [tool("a"), tool("b")]; },
      async callTool() { return { content: [] }; },
      async disconnect() {},
      get pid() { return undefined; },
    }),
  });

  await assert.rejects(registry.startServer(resolved("server")), /registration failed/);
  assert.deepEqual(registered, ["server__a"]);
  assert.equal(registry.getServerState("server")?.status, "error");
  assert.equal(registry.getServerState("server")?.toolCount, 1);
  assert.deepEqual(registry.getEntry("server")?.toolNames, ["server__a"]);
  assert.match(registry.getServerState("server")?.error ?? "", /remain registered until Pi restarts/);
});

test("hosts without tool removal reject runtime stop without false state changes", async () => {
  const events: string[] = [];
  const client = {
    async connect() {},
    async listTools() { return [tool("a")]; },
    async callTool() { return { content: [] }; },
    async disconnect() {},
    get pid() { return undefined; },
  };
  const registry = new ServerRegistry({
    emitEvent: (event) => events.push(event),
    registerTool: () => {},
    unregisterTool: () => { throw new Error("must not be called"); },
    canUnregisterTools: false,
    createClient: () => client,
  });

  await registry.startServer(resolved("server"));
  await assert.rejects(registry.stopServer("server"), /restart Pi/);

  assert.equal(registry.getServerState("server")?.status, "running");
  assert.deepEqual(registry.getEntry("server")?.toolNames, ["server__a"]);
  assert.equal(events.includes("unipi:mcp-tools-unregistered"), false);
});
