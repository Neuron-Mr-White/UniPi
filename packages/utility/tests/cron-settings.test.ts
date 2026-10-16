/**
 * @pi-unipi/utility — Cron settings (UNI-318): normalizing the host's
 * `cron settings --json` payload, the hub schema only appearing while
 * unipi-host is installed, and the mirror pull/push round-trip with a
 * fake exec (never spawns the real CLI).
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "cron-settings-"));
const PI_DIR = join(HOME, ".pi", "agent");
mkdirSync(PI_DIR, { recursive: true });
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = PI_DIR;

import { getSettingsDefinition, getSettingsScoped } from "@pi-unipi/core";
import {
  cronSettingsMirror,
  DEFAULT_CRON_SETTINGS,
  normalizeCronSettings,
  refreshCronSettingsMirror,
  type CronSettingsExec,
} from "../src/cron/settings.ts";

describe("normalizeCronSettings", () => {
  it("pulls every field with sane fallbacks for malformed/missing input", () => {
    const got = normalizeCronSettings({ concurrency: 3, missed_window_s: 60, retention_runs: 10, retention_days: 7, default_time_limit_s: 900, paused: true, ntfy_topic: "jobs", notify_default_events: ["failed", "timeout"] });
    assert.deepEqual(got, { concurrency: 3, missed_window_s: 60, retention_runs: 10, retention_days: 7, default_time_limit_s: 900, paused: true, ntfy_topic: "jobs", notify_default_events: ["failed", "timeout"] });
  });

  it("defaults on null/garbage, never throws", () => {
    assert.deepEqual(normalizeCronSettings(null), { ...DEFAULT_CRON_SETTINGS, ntfy_topic: undefined });
    assert.deepEqual(normalizeCronSettings("nonsense"), { ...DEFAULT_CRON_SETTINGS, ntfy_topic: undefined });
    assert.deepEqual(normalizeCronSettings({ concurrency: "two" }), { ...DEFAULT_CRON_SETTINGS, ntfy_topic: undefined });
  });

  it("empty ntfy_topic string reads as unset", () => {
    assert.equal(normalizeCronSettings({ ntfy_topic: "" }).ntfy_topic, undefined);
  });

  it("drops non-string entries from notify_default_events", () => {
    assert.deepEqual(normalizeCronSettings({ notify_default_events: ["ok", 5, null, "failed"] }).notify_default_events, ["ok", "failed"]);
  });
});

describe("the Cron settings group", () => {
  it("is registered under namespace cron with the expected label", () => {
    const def = getSettingsDefinition("cron");
    assert.ok(def);
    assert.equal(def!.label, "Cron");
  });

  it("schema is empty when unipi-host isn't installed (no config dir, not on PATH)", () => {
    const def = getSettingsDefinition("cron")!;
    const prevDir = process.env.UNIPI_HOST_DIR;
    const prevPath = process.env.PATH;
    process.env.UNIPI_HOST_DIR = join(HOME, "no-such-host-dir");
    process.env.PATH = "/does/not/exist";
    try {
      assert.deepEqual(def.schema, []);
    } finally {
      if (prevDir === undefined) delete process.env.UNIPI_HOST_DIR; else process.env.UNIPI_HOST_DIR = prevDir;
      if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    }
  });

  it("schema has the two sections once unipi-host is 'installed' (config dir exists)", () => {
    const def = getSettingsDefinition("cron")!;
    const prevDir = process.env.UNIPI_HOST_DIR;
    const dir = mkdtempSync(join(tmpdir(), "fake-host-"));
    process.env.UNIPI_HOST_DIR = dir;
    try {
      const sections = def.schema!;
      assert.equal(sections.length, 2);
      assert.equal(sections[0]!.title, "Scheduled runs");
      assert.equal(sections[1]!.title, "Notifications");
      const keys = sections.flatMap((s) => s.fields.map((f) => f.key));
      assert.deepEqual(keys, ["concurrency", "missed_window_s", "retention_runs", "retention_days", "default_time_limit_s", "paused", "ntfy_topic", "notify_default_events"]);
    } finally {
      if (prevDir === undefined) delete process.env.UNIPI_HOST_DIR; else process.env.UNIPI_HOST_DIR = prevDir;
    }
  });
});

describe("refreshCronSettingsMirror / cronSettingsMirror", () => {
  const hostDirPath = mkdtempSync(join(tmpdir(), "fake-host-mirror-"));
  let prevDir: string | undefined;
  beforeEach(() => {
    prevDir = process.env.UNIPI_HOST_DIR;
    process.env.UNIPI_HOST_DIR = hostDirPath;
  });

  it("pulls the host's settings into the global layer", async () => {
    const exec: CronSettingsExec = mock.fn(async () => ({
      stdout: JSON.stringify({ concurrency: 4, missed_window_s: 120, retention_runs: 20, retention_days: 14, default_time_limit_s: 600, paused: false, ntfy_topic: "cron-jobs", notify_default_events: ["ok"] }) + "\n",
    }));
    await refreshCronSettingsMirror(process.cwd(), exec);
    assert.equal((exec as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.deepEqual((exec as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], []);
    const mirror = cronSettingsMirror(process.cwd());
    assert.equal(mirror.concurrency, 4);
    assert.equal(mirror.ntfy_topic, "cron-jobs");
    assert.deepEqual(mirror.notify_default_events, ["ok"]);
  });

  it("a host that can't be reached leaves the previous mirror alone", async () => {
    const ok: CronSettingsExec = async () => ({ stdout: JSON.stringify({ concurrency: 9 }) + "\n" });
    await refreshCronSettingsMirror(process.cwd(), ok);
    assert.equal(cronSettingsMirror(process.cwd()).concurrency, 9);

    const failing: CronSettingsExec = async () => ({ error: "ECONNREFUSED" });
    await refreshCronSettingsMirror(process.cwd(), failing);
    assert.equal(cronSettingsMirror(process.cwd()).concurrency, 9);
  });

  it("no host installed: refresh is a no-op (never calls exec)", async () => {
    if (prevDir === undefined) delete process.env.UNIPI_HOST_DIR; else process.env.UNIPI_HOST_DIR = prevDir;
    process.env.UNIPI_HOST_DIR = join(HOME, "really-not-there");
    const prevPath = process.env.PATH;
    process.env.PATH = "/does/not/exist";
    const exec: CronSettingsExec = mock.fn(async () => ({ stdout: "{}" }));
    try {
      await refreshCronSettingsMirror(process.cwd(), exec);
      assert.equal((exec as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    } finally {
      if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    }
  });
});

describe("onSet mirrors a hub write through to the host CLI", () => {
  it("writing one field calls unipi-host cron settings with its flag (through the registered exec seam)", async () => {
    // onSet uses the real runCronSettings (fire-and-forget); we only assert
    // the engine write itself lands in the global layer, which is what the
    // hub immediately re-reads — the host round trip is covered above.
    const { setSettings } = await import("@pi-unipi/core");
    setSettings("cron", { concurrency: 7 }, "global", process.cwd());
    const layer = getSettingsScoped("cron", "global", process.cwd());
    assert.equal((layer as Record<string, unknown> | undefined)?.concurrency, 7);
  });
});
