/**
 * @pi-unipi/utility — image & file attachments
 *
 * After a paste, drag-and-drop or Ctrl+V, any image/document path that lands
 * in the editor is swapped for a token — [Image #1], [File #2] — and listed
 * in a chip row above the editor (with small inline previews in Kitty,
 * Ghostty, iTerm2 and WezTerm). On submit, images are sent as real image
 * content and file tokens expand to their paths. Deleting a token drops the
 * attachment. After the message is sent, a user-only transcript line shows
 * what was attached (the model never sees it).
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { readUtilSettings } from "../settings.js";
import { expandForSubmit, formatBytes, stillReferenced, tokenFor, tokenize, type Attachment } from "./detect.js";

export const ATTACHMENTS_ENTRY = "unipi:attachments";
const WIDGET = "unipi-attachments";
const SCAN_AFTER_PASTE_MS = [80, 400, 1200];
const PREVIEW_ROWS = 5;
const PREVIEW_MAX = 3;

type Theme = { fg: (color: string, text: string) => string; bold?: (t: string) => string };

function isPaste(data: string): boolean {
  return data.includes("\x1b[200~") || matchesKey(data, Key.ctrl("v")) || matchesKey(data, Key.alt("v"));
}

function canPreview(): boolean {
  try {
    return Boolean(getCapabilities().images);
  } catch {
    return false;
  }
}

function chip(theme: Theme, a: Pick<Attachment, "kind" | "id" | "name" | "bytes">): string {
  return `${theme.fg("accent", tokenFor(a))} ${a.name}${a.bytes ? theme.fg("muted", ` · ${formatBytes(a.bytes)}`) : ""}`;
}

/** Chip line + optional inline previews, shared by the widget and the transcript line. */
function attachmentView(items: ReadonlyArray<Pick<Attachment, "kind" | "id" | "name" | "bytes" | "path" | "mimeType">>, theme: Theme, preview: boolean, hint: string): Component {
  const images: Image[] = [];
  if (preview && canPreview()) {
    for (const a of items.filter((i) => i.kind === "image").slice(0, PREVIEW_MAX)) {
      try {
        images.push(new Image(readFileSync(a.path).toString("base64"), a.mimeType ?? "image/png", { fallbackColor: (s) => theme.fg("muted", s) }, { maxHeightCells: PREVIEW_ROWS, maxWidthCells: 32, filename: a.name }));
      } catch {
        // file gone — chip only
      }
    }
  }
  return {
    invalidate() {
      for (const i of images) i.invalidate();
    },
    render(width: number): string[] {
      const bar = theme.fg("accent", "▌ ");
      const chips = items.map((a) => chip(theme, a)).join(theme.fg("muted", "  ·  "));
      const lines = [truncateToWidth(`${bar}${chips}${hint ? theme.fg("muted", `   ${hint}`) : ""}`, width, "…")];
      for (const img of images) lines.push(...img.render(Math.min(width, 34)));
      return lines;
    },
  };
}

export function registerAttachments(pi: ExtensionAPI): void {
  let attachments: Attachment[] = [];
  let sent: Attachment[] = [];
  let ui: ExtensionContext["ui"] | null = null;
  let unsub: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const refreshWidget = () => {
    if (!ui) return;
    const settings = readUtilSettings().attachments;
    if (attachments.length === 0) {
      ui.setWidget(WIDGET, undefined);
      return;
    }
    const items = [...attachments];
    ui.setWidget(WIDGET, (_tui, theme) => attachmentView(items, theme as unknown as Theme, settings.preview, "attached to your next message"), { placement: "aboveEditor" });
  };

  const scan = () => {
    if (!ui) return;
    try {
      const text = ui.getEditorText();
      const { text: next, added } = tokenize(text, attachments);
      if (next !== text) ui.setEditorText(next);
      if (added.length > 0) {
        attachments = [...attachments, ...added];
        refreshWidget();
      }
    } catch {
      // editor unavailable — leave the text alone
    }
  };

  const sync = () => {
    if (!ui || attachments.length === 0) return;
    try {
      const kept = stillReferenced(ui.getEditorText(), attachments);
      if (kept.length !== attachments.length) {
        attachments = kept;
        refreshWidget();
      }
    } catch {
      // ignore
    }
  };

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timers.add(t);
  };

  try {
    pi.registerEntryRenderer<{ items: Attachment[] }>(ATTACHMENTS_ENTRY, (entry, _opts, theme) => {
      const items = entry.data?.items;
      if (!Array.isArray(items) || items.length === 0) return undefined;
      return attachmentView(items, theme as unknown as Theme, readUtilSettings().attachments.preview, "");
    });
  } catch {
    // UI-dependent
  }

  pi.on("session_start", (_e, ctx) => {
    unsub?.();
    unsub = undefined;
    attachments = [];
    sent = [];
    ui = ctx.hasUI ? ctx.ui : null;
    if (!ui || !readUtilSettings(ctx.cwd).attachments.enabled) return;
    ui.setWidget(WIDGET, undefined);
    unsub = ui.onTerminalInput((data) => {
      if (isPaste(data)) for (const ms of SCAN_AFTER_PASTE_MS) later(scan, ms);
      else if (attachments.length > 0) later(sync, 60);
      return undefined;
    });
  });

  pi.on("input", (event) => {
    try {
      if (event.source === "extension" || attachments.length === 0) return undefined;
      const text = event.text ?? "";
      const used = stillReferenced(text, attachments);
      if (used.length === 0 || text.trimStart().startsWith("/")) return undefined;
      const out = expandForSubmit(text, used);
      sent = used;
      attachments = [];
      refreshWidget();
      return { action: "transform" as const, text: out.text, images: [...(event.images ?? []), ...out.images] };
    } catch {
      return undefined;
    }
  });

  // The user message is in the session by now: show what went with it.
  pi.on("agent_start", () => {
    if (sent.length === 0) return;
    const items = sent.map(({ id, kind, name, path, bytes, mimeType }) => ({ id, kind, name, path, bytes, mimeType }));
    sent = [];
    try {
      pi.appendEntry(ATTACHMENTS_ENTRY, { items });
    } catch {
      // ignore
    }
  });

  pi.on("session_shutdown", () => {
    unsub?.();
    unsub = undefined;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    ui = null;
  });
}
