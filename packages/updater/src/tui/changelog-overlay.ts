/**
 * @pi-unipi/updater — Changelog TUI Overlay
 *
 * Version list with Current/New labels, Enter opens detail view.
 */

import { existsSync } from "fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseChangelog, resolveChangelogPath } from "../changelog.js";
import { renderMarkdown } from "../markdown.js";
import { getInstalledPackageVersion } from "@pi-unipi/core";
import { createListDetailOverlay } from "./list-detail-overlay.js";
import type { ChangelogEntry } from "../../types.js";

/**
 * Render the changelog overlay.
 */
export function renderChangelogOverlay() {
  const installedVersion = getInstalledPackageVersion(
    new URL("..", import.meta.url).pathname,
    "@pi-unipi/unipi",
  );

  return createListDetailOverlay<ChangelogEntry>({
    title: " 📋 Changelog ",
    emptyMessage: "No changelog available.",
    listFooter: " j/k navigate  Enter view details  q/Esc close",
    detailFooter: " j/k scroll  q/Esc back to list",

    loadEntries: () => {
      const changelogPath = resolveChangelogPath();
      return existsSync(changelogPath) ? parseChangelog(changelogPath) : [];
    },

    renderItem: (entry, selected, theme) => {
      let label: string;
      if (entry.version === "Unreleased") {
        label = theme.fg("muted", "Unreleased");
      } else if (entry.version === installedVersion) {
        label = theme.fg("success", "✓ Current");
      } else {
        const pa = entry.version.split(".").map(Number);
        const pb = installedVersion.split(".").map(Number);
        const isNewer =
          pa[0]! > pb[0]! ||
          (pa[0] === pb[0] && pa[1]! > pb[1]!) ||
          (pa[0] === pb[0] && pa[1] === pb[1] && pa[2]! > pb[2]!);
        label = isNewer ? theme.fg("warning", "↑ New") : "";
      }

      const version = selected ? theme.bold(entry.version) : theme.fg("text", entry.version);
      const date = entry.date ? ` — ${theme.fg("muted", entry.date)}` : "";
      const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
      return ` ${prefix}${version}${date}  ${label}`;
    },

    renderDetailTitle: (entry, theme) =>
      entry.date
        ? `${theme.bold(entry.version)} — ${theme.fg("muted", entry.date)}`
        : `${theme.bold(entry.version)} — ${theme.fg("muted", "Unreleased")}`,

    renderDetailBody: (entry, innerWidth, theme) =>
      renderMarkdown(entry.body, innerWidth - 2, theme),
  });
}
