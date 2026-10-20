/**
 * Pure helpers that decide what the bridge listens on: a unix socket file on
 * unix, a Windows named pipe on win32 (so unipi-host, which runs on
 * Windows, can connect). `platform` is injected so this is testable on
 * Linux without actually running on win32.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bridgeSocketPath, isBridgePipe } from "../src/bridge.js";

describe("bridgeSocketPath", () => {
  it("returns a unix socket file path on linux", () => {
    assert.equal(bridgeSocketPath("/home/u/.unipi/bridge", 4242, "linux"), "/home/u/.unipi/bridge/4242.sock");
  });

  it("returns a unix socket file path on darwin, same as linux", () => {
    assert.equal(bridgeSocketPath("/home/u/.unipi/bridge", 4242, "darwin"), "/home/u/.unipi/bridge/4242.sock");
  });

  it("returns a Windows named pipe path on win32, ignoring dir", () => {
    assert.equal(bridgeSocketPath("C:\\Users\\u\\.unipi\\bridge", 4242, "win32"), "\\\\.\\pipe\\unipi-bridge-4242");
  });
});

describe("isBridgePipe", () => {
  it("is true for a Windows named pipe path", () => {
    assert.equal(isBridgePipe("\\\\.\\pipe\\unipi-bridge-4242"), true);
  });

  it("is false for a unix socket file path", () => {
    assert.equal(isBridgePipe("/home/u/.unipi/bridge/4242.sock"), false);
  });
});
