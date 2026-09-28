/**
 * @pi-unipi/ask-user — read an image from the system clipboard into a temp file
 *
 * pi's own clipboard reader is not exported, so Ctrl+V inside "Other" uses the
 * usual tools: wl-paste (Wayland), xclip (X11), pngpaste (macOS). Returns the
 * file path, or undefined when there is no image (or no clipboard — e.g. SSH).
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cmd: string, args: string[]): Buffer | undefined {
  try {
    const r = spawnSync(cmd, args, { timeout: 3000, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 && r.stdout && r.stdout.length > 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export function readClipboardImageFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let data: Buffer | undefined;
  let type = "image/png";
  if (process.platform === "darwin") {
    data = run("pngpaste", ["-"]);
  } else {
    const wayland = !!env.WAYLAND_DISPLAY;
    const listed = wayland
      ? run("wl-paste", ["--list-types"])?.toString()
      : run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"])?.toString();
    const found = TYPES.find((t) => listed?.split(/\s+/).includes(t));
    if (!found) return undefined;
    type = found;
    data = wayland ? run("wl-paste", ["--type", found]) : run("xclip", ["-selection", "clipboard", "-t", found, "-o"]);
  }
  if (!data) return undefined;
  const file = join(tmpdir(), `unipi-ask-${randomUUID()}${EXT[type] ?? ".png"}`);
  try {
    writeFileSync(file, data);
    return file;
  } catch {
    return undefined;
  }
}
