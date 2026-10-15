/**
 * @pi-unipi/utility — the PC's browser state (UNI-300)
 *
 * Cheap, robust, no process spawn per prompt: read the host's
 * `~/.unipi/app-host/config.json` (`UNIPI_HOST_DIR` override) for
 * `browser.enabled`. An ABSENT `browser` block, or an absent `enabled`
 * key, means ON for this PC's own agent (UNI-301 is changing the host's
 * own default — the agent here does not second-guess it). Only an
 * explicit `enabled: false` means OFF. No host installed at all (no
 * config dir and `unipi-host` not on PATH) means OFF.
 *
 * Profiles: optionally, `unipi-host browser profiles --json` (2s timeout)
 * tells us which profiles are currently running, for the context line.
 * This is the only thing that ever spawns a process, and it is cached
 * (default: at most once a minute) and best-effort (failure → no profiles,
 * never thrown).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

export interface BrowserHostConfig {
  browser?: {
    enabled?: boolean;
    engine?: string;
    [key: string]: unknown;
  };
}

/** `${UNIPI_HOST_DIR:-~/.unipi/app-host}`. */
export function hostDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNIPI_HOST_DIR || join(homedir(), ".unipi", "app-host");
}

export function hostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "config.json");
}

/** Config-read outcome: distinguishes "no file" from "file there but unreadable/malformed" —
 * the latter fails closed (off) rather than falling back to the on-by-default rule. */
export type HostConfigRead =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "ok"; config: BrowserHostConfig };

/** Reads and parses the host config; never throws. */
export function readHostConfig(path: string): HostConfigRead {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { kind: "malformed" };
    return { kind: "ok", config: parsed as BrowserHostConfig };
  } catch {
    return { kind: "malformed" };
  }
}

/** Whether `unipi-host` looks installed at all — the config dir exists, or the binary is on PATH. */
export function hostInstalled(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(dir)) return true;
  const pathEnv = env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exe = process.platform === "win32" ? "unipi-host.exe" : "unipi-host";
  return pathEnv.split(sep).some((dir0) => dir0 && existsSync(join(dir0, exe)));
}

/**
 * Pure decision from a config read + whether the host is installed at all.
 * No host → off. Host installed, config missing or present with no browser
 * block / no `enabled` key → on (UNI-301 default). Malformed config → off
 * (fail closed — can't tell what the user wants). Explicit `enabled: false`
 * → off; explicit `enabled: true` → on.
 */
export function browserEnabledFrom(read: HostConfigRead, installed: boolean): boolean {
  if (!installed) return false;
  if (read.kind === "malformed") return false;
  if (read.kind === "missing") return true;
  const enabled = read.config.browser?.enabled;
  return enabled !== false;
}

/** Reads disk state right now (cheap: one stat + one small read, never throws). */
export function readBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = hostDir(env);
  const read = readHostConfig(join(dir, "config.json"));
  return browserEnabledFrom(read, hostInstalled(dir, env));
}

// ---- profiles (optional, cached, spawns a process) -------------------------

export interface BrowserProfileInfo {
  name: string;
  running: boolean;
}

interface ProfilesCache {
  at: number;
  profiles: string[];
}

let cache: ProfilesCache | undefined;

const PROFILES_TIMEOUT_MS = 2000;
const PROFILES_CACHE_MS = 60_000;

/** Names of running profiles, at most once per `maxAgeMs` (default 60s); best-effort, never throws, never blocks beyond the timeout. */
export function runningProfiles(now = Date.now(), maxAgeMs = PROFILES_CACHE_MS): string[] {
  if (cache && now - cache.at < maxAgeMs) return cache.profiles;
  return cache?.profiles ?? [];
}

/** Kicks off a refresh of the running-profiles cache (fire and forget; safe to call every prompt). */
export function refreshRunningProfiles(now = Date.now(), maxAgeMs = PROFILES_CACHE_MS): void {
  if (cache && now - cache.at < maxAgeMs) return;
  try {
    execFile("unipi-host", ["browser", "profiles", "--json"], { timeout: PROFILES_TIMEOUT_MS }, (err, stdout) => {
      if (err) return;
      try {
        const list = JSON.parse(stdout) as Array<{ name?: string; running?: boolean }>;
        const names = list.filter((p) => p && p.running && typeof p.name === "string").map((p) => p.name as string);
        cache = { at: now, profiles: names };
      } catch {
        // malformed output: leave the previous cache alone
      }
    });
  } catch {
    // execFile itself never throws synchronously in practice, but be safe
  }
}

/** Test hook. */
export function resetBrowserProfilesCache(): void {
  cache = undefined;
}

// ---- the context line (UNI-300) --------------------------------------------

/** "default[, other, running, profiles]" — default always listed first. */
export function profileList(running: readonly string[]): string {
  const rest = running.filter((p) => p !== "default");
  return ["default", ...rest].join(", ");
}

/** The exact line set in `systemPromptOptions.sections["unipi-browser"]` while the browser is on. */
export function browserSectionText(running: readonly string[]): string {
  return `The PC's browser is on (CloakBrowser, shown in the UniPi app; the user may be watching). \`agent-browser\` is already pointed at it (AGENT_BROWSER_CDP): just run \`agent-browser open <url>\`, \`snapshot\`, \`click @e1\`… — no start or connect step. See skill:browser. Profiles: ${profileList(running)}.`;
}

/** UNI-303: the host's stable agent address, from `<host dir>/browser-agent.json`. */
export interface AgentEndpointFile {
  port: number;
  profile: string;
  pid?: number;
}

export function readAgentEndpoint(env: NodeJS.ProcessEnv = process.env): AgentEndpointFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(hostDir(env), "browser-agent.json"), "utf8")) as Partial<AgentEndpointFile>;
    if (typeof raw.port !== "number" || raw.port <= 0 || raw.port > 65535) return undefined;
    return { port: raw.port, profile: typeof raw.profile === "string" ? raw.profile : "default", ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * UNI-303: point agent-browser at the browser the user sees. While the
 * browser is on and the host has published its stable address,
 * `AGENT_BROWSER_CDP` is set in THIS process's env — pi's bash tool spreads
 * `process.env` into every command, so a plain `agent-browser open …` drives
 * the in-app browser. Off (or no host) → the variable is removed again, but
 * only if we set it (a user's own value is never touched). Never throws.
 */
let managedCdp: string | undefined;
export function applyAgentBrowserEnv(env: NodeJS.ProcessEnv = process.env, enabled = readBrowserEnabled(env)): string | undefined {
  try {
    const endpoint = enabled ? readAgentEndpoint(env) : undefined;
    const ours = endpoint ? String(endpoint.port) : undefined;
    const current = env.AGENT_BROWSER_CDP;
    if (current !== undefined && current !== managedCdp) return current; // the user's own setting wins
    if (ours) {
      env.AGENT_BROWSER_CDP = ours;
      managedCdp = ours;
    } else if (managedCdp !== undefined) {
      delete env.AGENT_BROWSER_CDP;
      managedCdp = undefined;
    }
    return env.AGENT_BROWSER_CDP;
  } catch {
    return env.AGENT_BROWSER_CDP;
  }
}

/** Tests only. */
export function resetAgentBrowserEnv(): void {
  managedCdp = undefined;
}

/**
 * before_agent_start's whole browser-section decision, as one pure-ish
 * function (testable without a fake pi/ctx): on → sets the section with
 * the running profiles; off → removes it. Never throws.
 */
export function applyBrowserSection(sections: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!readBrowserEnabled(env)) {
      delete sections["unipi-browser"];
      return;
    }
    refreshRunningProfiles();
    sections["unipi-browser"] = browserSectionText(runningProfiles());
  } catch {
    // never block a turn over the browser line
  }
}
