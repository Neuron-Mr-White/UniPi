/**
 * @pi-unipi/utility — the pi settings that shape the built-in tools
 *
 * pi builds read/bash with `images.autoResize`, `shellCommandPrefix` and
 * `shellPath`. Re-registered tools must behave identically, so the same
 * values are read here (global ~/.pi/agent/settings.json, then the project's
 * .pi/settings.json on top).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface PiToolOptions {
  read: { autoResizeImages?: boolean };
  bash: { commandPrefix?: string; shellPath?: string };
}

export function readPiToolOptions(cwd: string, agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent")): PiToolOptions {
  const merged = { ...readJson(join(agentDir, "settings.json")), ...readJson(join(cwd, ".pi", "settings.json")) };
  const images = merged.images as { autoResize?: unknown } | undefined;
  const shellPath = typeof merged.shellPath === "string" ? merged.shellPath.replace(/^~(?=\/|$)/, homedir()) : undefined;
  return {
    read: typeof images?.autoResize === "boolean" ? { autoResizeImages: images.autoResize } : {},
    bash: {
      ...(typeof merged.shellCommandPrefix === "string" ? { commandPrefix: merged.shellCommandPrefix } : {}),
      ...(shellPath ? { shellPath } : {}),
    },
  };
}
