/**
 * @pi-unipi/updater — Changelog parser
 *
 * Parses CHANGELOG.md (Keep a Changelog format) into structured ChangelogEntry[].
 * Handles: ## [Unreleased], ## [x.y.z] — YYYY-MM-DD, ### Added/Fixed/etc.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot, compareVersions } from "@pi-unipi/core";
import { isNewerVersion } from "./version.js";
import type { ChangelogEntry } from "../types.js";

/**
 * Locate the shipped CHANGELOG.md.
 *
 * Resolving from `process.cwd()` only works when pi happens to be running
 * inside the UniPi checkout — for everyone else the update prompt and
 * `/unipi:changelog` came up empty. Resolve from this module's own location
 * instead, and fall back to the working directory so a repo checkout still
 * shows its local (possibly unreleased) notes.
 */
export function resolveChangelogPath(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const root = findPackageRoot(dir, "@pi-unipi/unipi");
    if (root) {
      const packaged = join(root, "CHANGELOG.md");
      if (existsSync(packaged)) return packaged;
    }
  } catch {
    // Fall through to the working directory.
  }
  return join(process.cwd(), "CHANGELOG.md");
}

/** Regex for version headers: ## [x.y.z] — YYYY-MM-DD or ## [Unreleased] */
const VERSION_HEADER_RE = /^## \[(.+?)\](?:\s*[-—–]\s*(.+))?$/;

/** Regex for section headers: ### Added, ### Fixed, etc. */
const SECTION_HEADER_RE = /^### (.+)$/;

/**
 * Parse a CHANGELOG.md file into structured entries.
 * Returns empty array if file doesn't exist or is empty.
 */
export function parseChangelog(filePath: string): ChangelogEntry[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const lines = content.split("\n");
  const entries: ChangelogEntry[] = [];

  let currentEntry: ChangelogEntry | null = null;
  let currentSection: string | null = null;
  let currentItems: string[] = [];

  for (const line of lines) {
    const versionMatch = line.match(VERSION_HEADER_RE);
    if (versionMatch) {
      // Save previous entry
      if (currentEntry) {
        if (currentSection && currentItems.length > 0) {
          currentEntry.sections[currentSection] = currentItems;
        }
        entries.push(currentEntry);
      }

      // Start new entry
      const version = versionMatch[1].trim();
      const date = (versionMatch[2] ?? "").trim();
      currentEntry = {
        version,
        date,
        sections: {},
        body: "",
      };
      currentSection = null;
      currentItems = [];
      continue;
    }

    if (!currentEntry) continue;

    const sectionMatch = line.match(SECTION_HEADER_RE);
    if (sectionMatch) {
      // Save previous section
      if (currentSection && currentItems.length > 0) {
        currentEntry.sections[currentSection] = currentItems;
      }
      currentSection = sectionMatch[1].trim();
      currentItems = [];
      continue;
    }

    // Collect section items (lines starting with - or *)
    const trimmed = line.trim();
    if (currentSection && (trimmed.startsWith("- ") || trimmed.startsWith("* "))) {
      currentItems.push(trimmed.slice(2).trim());
    } else if (trimmed && currentSection) {
      // Continuation of previous item
      if (currentItems.length > 0) {
        currentItems[currentItems.length - 1] += " " + trimmed;
      }
    }
  }

  // Save last entry
  if (currentEntry) {
    if (currentSection && currentItems.length > 0) {
      currentEntry.sections[currentSection] = currentItems;
    }
    entries.push(currentEntry);
  }

  // Build body text for each entry (for rendering)
  for (const entry of entries) {
    const lines: string[] = [];
    for (const [section, items] of Object.entries(entry.sections)) {
      lines.push(`### ${section}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }
    entry.body = lines.join("\n").trim();
  }

  return entries;
}

/**
 * Get changelog entries for versions newer than the given version.
 * Returns entries in newest-first order, excluding the given version.
 */
export function getNewerVersions(
  entries: ChangelogEntry[],
  installedVersion: string,
): ChangelogEntry[] {
  const result: ChangelogEntry[] = [];
  for (const entry of entries) {
    if (entry.version === "Unreleased") {
      result.push(entry);
      continue;
    }
    // Compare rather than test for equality. Stopping only on an exact match
    // meant that when the installed version was absent from the changelog
    // (a local build, a yanked release, or simply a newer version) every
    // historical entry was reported as "new".
    if (!isNewerVersion(entry.version, installedVersion)) break;
    result.push(entry);
  }
  return result;
}
