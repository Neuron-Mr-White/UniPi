/**
 * Cross-platform clipboard read/write using child_process.
 * Detection order: xclip → xsel → pbcopy/pbpaste → clip/powershell.
 * Caches detected command on first use.
 */

import { execSync } from "node:child_process";

export interface ClipboardResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

type ClipboardTool = "xclip" | "xsel" | "pbcopy" | "clip" | "powershell" | null;

let cachedTool: ClipboardTool | undefined; // undefined = not yet detected

/**
 * Detect available clipboard command. Caches result.
 */
export function detectClipboard(): ClipboardTool {
  if (cachedTool !== undefined) return cachedTool;

  const tools: Array<{ name: ClipboardTool; test: string }> = [
    { name: "xclip", test: "xclip -selection clipboard -o" },
    { name: "xsel", test: "xsel --clipboard --output" },
    { name: "pbcopy", test: "pbpaste" },
    { name: "clip", test: "echo test | clip" },
    { name: "powershell", test: "powershell -command Get-Clipboard" },
  ];

  for (const tool of tools) {
    try {
      execSync(tool.test, { stdio: "ignore", timeout: 2000 });
      cachedTool = tool.name;
      return cachedTool;
    } catch {
      // Try next tool
    }
  }

  cachedTool = null;
  return null;
}

/**
 * Copy text to system clipboard.
 */
export function copyToClipboard(text: string): ClipboardResult {
  const tool = detectClipboard();
  if (!tool) return { ok: false, reason: "clipboard unavailable" };

  try {
    switch (tool) {
      case "xclip":
        execSync("xclip -selection clipboard", { input: text, timeout: 2000 });
        break;
      case "xsel":
        execSync("xsel --clipboard --input", { input: text, timeout: 2000 });
        break;
      case "pbcopy":
        execSync("pbcopy", { input: text, timeout: 2000 });
        break;
      case "clip":
        execSync("clip", { input: text, timeout: 2000 });
        break;
      case "powershell":
        execSync(`powershell -command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`, { timeout: 2000 });
        break;
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "clipboard write failed" };
  }
}

/**
 * Read text from system clipboard.
 */
export function pasteFromClipboard(): ClipboardResult {
  const tool = detectClipboard();
  if (!tool) return { ok: false, reason: "clipboard unavailable" };

  try {
    let text: string;
    switch (tool) {
      case "xclip":
        text = execSync("xclip -selection clipboard -o", { encoding: "utf-8", timeout: 2000 }).trimEnd();
        break;
      case "xsel":
        text = execSync("xsel --clipboard --output", { encoding: "utf-8", timeout: 2000 }).trimEnd();
        break;
      case "pbcopy":
        // pbcopy is write-only; use pbpaste for reading
        text = execSync("pbpaste", { encoding: "utf-8", timeout: 2000 }).trimEnd();
        break;
      case "clip":
        // clip is write-only on Windows; use powershell for reading
        text = execSync("powershell -command Get-Clipboard", { encoding: "utf-8", timeout: 2000 }).trimEnd();
        break;
      case "powershell":
        text = execSync("powershell -command Get-Clipboard", { encoding: "utf-8", timeout: 2000 }).trimEnd();
        break;
      default:
        return { ok: false, reason: "clipboard unavailable" };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "clipboard read failed" };
  }
}

/**
 * Reset cached tool detection (for testing).
 */
export function resetClipboardCache(): void {
  cachedTool = undefined;
}
