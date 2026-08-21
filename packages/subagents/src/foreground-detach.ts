/**
 * @pi-unipi/subagents — Foreground detach shortcut
 *
 * Ported from pi-subagents foregroundDetachShortcut (config) +
 * foregroundSingleHintText (render.ts). Optionally binds a shortcut that
 * detaches the active foreground single-agent run WITHOUT terminating it:
 * the parent stops waiting, the child keeps running, and the completion
 * arrives later as a normal task-notification.
 */

export interface DetachShortcutConfig {
  /** Shortcut string like "ctrl+b". Empty/unset disables the feature. */
  shortcut?: string;
}

/** Parse a shortcut string into normalized parts ("ctrl+b" → ["ctrl","b"]). */
export function parseDetachShortcut(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return undefined;
  const parts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !part)) return undefined;
  // Must include at least one modifier to avoid stealing plain keys.
  const modifiers = new Set(["ctrl", "alt", "shift", "meta", "super"]);
  if (!parts.slice(0, -1).some((part) => modifiers.has(part))) return undefined;
  return parts;
}

/** Human-readable label ("ctrl+b" → "Ctrl+B"). */
export function formatDetachHint(parts: string[] | undefined): string | undefined {
  if (!parts) return undefined;
  const label = parts
    .map((part) => {
      if (part === "ctrl") return "Ctrl";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      if (part === "escape") return "Esc";
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
  return `${label} detaches (run continues in background)`;
}

/**
 * Whether a raw terminal input matches the configured shortcut.
 * Matches pi-tui-style control sequences for ctrl+<letter> plus literal text
 * for other combos.
 */
export function matchesDetachInput(data: string, parts: string[] | undefined): boolean {
  if (!parts) return false;
  const hasCtrl = parts.includes("ctrl");
  const key = parts[parts.length - 1]!;
  if (hasCtrl && parts.length === 2 && key.length === 1) {
    // Control sequence: C0 codes 0x01–0x1a map to ctrl+a–z.
    const expected = String.fromCharCode(key.charCodeAt(0) - 96);
    return data === expected;
  }
  return data === parts.join("+");
}
