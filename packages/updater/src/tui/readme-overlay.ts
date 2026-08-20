/**
 * @pi-unipi/updater — Readme TUI Overlay
 *
 * Package list with versions, Enter opens content view.
 * No-arg /unipi:readme opens directly to root README content.
 * With arg, opens directly to that package's content.
 */

import { readFileSync } from "fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { discoverReadmes, resolveReadmePath } from "../readme.js";
import { renderMarkdown } from "../markdown.js";
import { createListDetailOverlay } from "./list-detail-overlay.js";
import type { ReadmeEntry } from "../../types.js";

interface ReadmeParams {
  openDirect?: string;
}

/**
 * Render the readme overlay.
 */
export function renderReadmeOverlay(params?: ReadmeParams) {
  // Cache for rendered markdown content (keyed by entry path)
  const contentCache = new Map<string, string[]>();
  let openDirectIndex: number | undefined;

  return createListDetailOverlay<ReadmeEntry>({
    title: " 📖 README Browser ",
    emptyMessage: "No README files found.",
    listFooter: " j/k navigate  Enter read  q/Esc close",
    detailFooter: " j/k scroll  q/Esc back to list",

    loadEntries: () => {
      const entries = discoverReadmes();
      if (params?.openDirect) {
        const readmePath = resolveReadmePath(params.openDirect);
        if (readmePath) {
          const idx = entries.findIndex((e) => e.path === readmePath);
          if (idx >= 0) {
            openDirectIndex = idx;
            // Pre-load the content
            const content = readFileSync(readmePath, "utf-8");
            const lines = renderMarkdown(content, (process.stdout.columns ?? 80) - 4, undefined as any);
            contentCache.set(readmePath, lines);
          }
        }
      }
      return entries;
    },

    openDirectIndex,
    closeOnDetailBack: !!params?.openDirect,

    renderItem: (entry, selected, theme) => {
      const name = selected ? theme.bold(entry.name) : theme.fg("text", entry.name);
      const version = theme.fg("muted", `v${entry.version}`);
      const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
      return ` ${prefix}${name}  ${version}`;
    },

    renderDetailTitle: (entry, theme) =>
      `${theme.bold(entry.name)} — ${theme.fg("muted", `v${entry.version}`)}`,

    renderDetailBody: (entry, _innerWidth, theme) => {
      // Return cached content if available
      if (contentCache.has(entry.path)) {
        return contentCache.get(entry.path)!;
      }
      try {
        const content = readFileSync(entry.path, "utf-8");
        const lines = renderMarkdown(content, (process.stdout.columns ?? 80) - 4, theme);
        contentCache.set(entry.path, lines);
        return lines;
      } catch {
        return ["  Error reading README file."];
      }
    },
  });
}
