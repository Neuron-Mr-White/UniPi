/**
 * @pi-unipi/utility — browser state (UNI-300): pure decision from a config
 * fixture + host-installed flag.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserEnabledFrom,
  hostConfigPath,
  hostDir,
  hostInstalled,
  readBrowserEnabled,
  readHostConfig,
} from "../src/browser/state.ts";

describe("browser state — pure decision", () => {
  it("no host installed → off, regardless of config", () => {
    assert.equal(browserEnabledFrom({ kind: "missing" }, false), false);
    assert.equal(browserEnabledFrom({ kind: "ok", config: { browser: { enabled: true } } }, false), false);
  });

  it("host installed, config missing → on (UNI-301 default)", () => {
    assert.equal(browserEnabledFrom({ kind: "missing" }, true), true);
  });

  it("host installed, config ok with no browser block → on", () => {
    assert.equal(browserEnabledFrom({ kind: "ok", config: {} }, true), true);
  });

  it("host installed, browser block without enabled → on", () => {
    assert.equal(browserEnabledFrom({ kind: "ok", config: { browser: { engine: "cloak" } } }, true), true);
  });

  it("explicit enabled:false → off", () => {
    assert.equal(browserEnabledFrom({ kind: "ok", config: { browser: { enabled: false } } }, true), false);
  });

  it("explicit enabled:true → on", () => {
    assert.equal(browserEnabledFrom({ kind: "ok", config: { browser: { enabled: true } } }, true), true);
  });

  it("malformed config → off, even though the host is installed (fail closed)", () => {
    assert.equal(browserEnabledFrom({ kind: "malformed" }, true), false);
  });
});

describe("browser state — host dir / config path", () => {
  it("defaults to ~/.unipi/app-host, honors UNIPI_HOST_DIR", () => {
    const d = hostDir({});
    assert.match(d, /\.unipi[/\\]app-host$/);
    assert.equal(hostDir({ UNIPI_HOST_DIR: "/custom/dir" }), "/custom/dir");
    assert.equal(hostConfigPath({ UNIPI_HOST_DIR: "/custom/dir" }), join("/custom/dir", "config.json"));
  });
});

describe("browser state — reading disk", () => {
  it("absent config file → missing (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    assert.deepEqual(readHostConfig(join(dir, "config.json")), { kind: "missing" });
  });

  it("malformed JSON → malformed (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    const file = join(dir, "config.json");
    writeFileSync(file, "{ not json");
    assert.deepEqual(readHostConfig(file), { kind: "malformed" });
  });

  it("valid JSON without a browser block parses fine", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ other: 1 }));
    assert.deepEqual(readHostConfig(file), { kind: "ok", config: { other: 1 } });
  });

  it("hostInstalled: true when the dir exists even without config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    assert.equal(hostInstalled(dir, {}), true);
  });

  it("hostInstalled: false when neither the dir nor the PATH binary exist", () => {
    const dir = join(tmpdir(), "unipi-nonexistent-host-dir-xyz");
    assert.equal(hostInstalled(dir, { PATH: "/nonexistent/bin" }), false);
  });

  it("end to end via readBrowserEnabled: no dir, no PATH binary → off (no host)", () => {
    const dir = join(tmpdir(), "unipi-nonexistent-host-dir-abc");
    assert.equal(readBrowserEnabled({ UNIPI_HOST_DIR: dir, PATH: "/nonexistent/bin" }), false);
  });

  it("end to end: dir exists, no config.json → on (dir existing counts as installed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    assert.equal(readBrowserEnabled({ UNIPI_HOST_DIR: dir }), true);
  });

  it("end to end: dir exists, config without browser block → on", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    assert.equal(readBrowserEnabled({ UNIPI_HOST_DIR: dir }), true);
  });

  it("end to end: explicit enabled:false → off", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ browser: { enabled: false } }));
    assert.equal(readBrowserEnabled({ UNIPI_HOST_DIR: dir }), false);
  });

  it("end to end: explicit enabled:true → on", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ browser: { enabled: true } }));
    assert.equal(readBrowserEnabled({ UNIPI_HOST_DIR: dir }), true);
  });

  it("end to end: malformed config.json → off (fail closed, even though the dir exists)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-host-"));
    writeFileSync(join(dir, "config.json"), "{ not json at all");
    assert.equal(readBrowserEnabled({ UNIPI_HOST_DIR: dir }), false);
  });
});
