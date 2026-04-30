/**
 * @pi-unipi/footer — Icon system with Nerd Font / ASCII fallback
 *
 * Provides icon mapping for each segment with auto-detection
 * of Nerd Font support.
 */

import { detectNerdFontSupport } from "./separators.js";

// ─── Icon definitions ───────────────────────────────────────────────────────

/** Icon set mapping segment IDs to glyph strings */
export interface IconSet {
  // Core segments
  model: string;
  thinking: string;
  path: string;
  git: string;
  context: string;
  cost: string;
  tokens: string;
  tokensIn: string;
  tokensOut: string;
  session: string;
  hostname: string;
  time: string;

  // Compactor segments
  sessionEvents: string;
  compactions: string;
  tokensSaved: string;
  compressionRatio: string;
  indexedDocs: string;
  sandboxRuns: string;
  searchQueries: string;

  // Memory segments
  projectCount: string;
  totalCount: string;
  consolidations: string;

  // MCP segments
  serversTotal: string;
  serversActive: string;
  toolsTotal: string;
  serversFailed: string;

  // Ralph segments
  activeLoops: string;
  totalIterations: string;
  loopStatus: string;

  // Workflow segments
  currentCommand: string;
  sandboxLevel: string;
  commandDuration: string;

  // Kanboard segments
  docsCount: string;
  tasksDone: string;
  tasksTotal: string;
  taskPct: string;

  // Notify segments
  platformsEnabled: string;
  lastSent: string;

  // Status extension
  extensionStatuses: string;

  // Separator/group markers
  separator: string;
}

/** Nerd Font icons */
export const NERD_ICONS: IconSet = {
  model: "\uEC19",          // nf-md-chip
  thinking: "\uE22C",       // nf-oct-pi
  path: "\uF115",           // nf-fa-folder_open
  git: "\uF126",            // nf-fa-code_fork
  context: "\uE70F",        // nf-dev-database
  cost: "\uF155",           // nf-fa-dollar
  tokens: "\uE26B",         // nf-seti-html
  tokensIn: "\uF090",       // nf-fa-sign_in
  tokensOut: "\uF08B",      // nf-fa-sign_out
  session: "\uF550",        // nf-md-identifier
  hostname: "\uF109",       // nf-fa-laptop
  time: "\uF017",           // nf-fa-clock_o

  sessionEvents: "\uF0C0",  // nf-fa-users
  compactions: "\uF1C0",    // nf-fa-database
  tokensSaved: "\uF155",    // nf-fa-dollar
  compressionRatio: "\uE70F", // nf-dev-database
  indexedDocs: "\uF02D",    // nf-fa-book
  sandboxRuns: "\uF121",    // nf-fa-terminal
  searchQueries: "\uF002",  // nf-fa-search

  projectCount: "\uF07B",   // nf-fa-folder
  totalCount: "\uF1C0",     // nf-fa-database
  consolidations: "\uF0E7", // nf-fa-bolt

  serversTotal: "\uF233",   // nf-fa-server
  serversActive: "\uF058",  // nf-fa-check_circle
  toolsTotal: "\uF0AD",     // nf-fa-wrench
  serversFailed: "\uF071",  // nf-fa-warning

  activeLoops: "\uF04B",    // nf-fa-play
  totalIterations: "\uF01E", // nf-fa-repeat
  loopStatus: "\uF144",     // nf-fa-circle_play

  currentCommand: "\uF120",  // nf-fa-terminal
  sandboxLevel: "\uF023",   // nf-fa-lock
  commandDuration: "\uF017", // nf-fa-clock_o

  docsCount: "\uF15C",      // nf-fa-file_text
  tasksDone: "\uF058",      // nf-fa-check_circle
  tasksTotal: "\uF0AE",     // nf-fa-tasks
  taskPct: "\uF200",        // nf-fa-pie_chart

  platformsEnabled: "\uF0E0", // nf-fa-envelope
  lastSent: "\uF017",       // nf-fa-clock_o

  extensionStatuses: "\uF1E6", // nf-fa-plug

  separator: "\uE0B1",      // nf-pl-left_soft_divider
};

/** ASCII/Unicode fallback icons */
export const ASCII_ICONS: IconSet = {
  model: "",
  thinking: "π",
  path: "dir",
  git: "⎇",
  context: "ctx",
  cost: "$",
  tokens: "⊛",
  tokensIn: "→",
  tokensOut: "←",
  session: "#",
  hostname: "⌂",
  time: "⏱",

  sessionEvents: "evt",
  compactions: "cmp",
  tokensSaved: "svd",
  compressionRatio: "rat",
  indexedDocs: "idx",
  sandboxRuns: "sbx",
  searchQueries: "qry",

  projectCount: "prj",
  totalCount: "ttl",
  consolidations: "cns",

  serversTotal: "srv",
  serversActive: "act",
  toolsTotal: "tls",
  serversFailed: "err",

  activeLoops: "▶",
  totalIterations: "iter",
  loopStatus: "ralph",

  currentCommand: "cmd",
  sandboxLevel: "sbx",
  commandDuration: "dur",

  docsCount: "doc",
  tasksDone: "✓",
  tasksTotal: "tasks",
  taskPct: "pct",

  platformsEnabled: "ntf",
  lastSent: "sent",

  extensionStatuses: "ext",

  separator: "|",
};

// ─── Icon lookup ────────────────────────────────────────────────────────────

/**
 * Get the icon for a segment by ID.
 * Returns Nerd Font glyph if available, ASCII fallback otherwise.
 */
export function getIcon(segmentId: string): string {
  const icons = detectNerdFontSupport() ? NERD_ICONS : ASCII_ICONS;
  const key = segmentId as keyof IconSet;
  return icons[key] ?? segmentId;
}

/**
 * Get the full icon set based on terminal capabilities.
 */
export function getIcons(): IconSet {
  return detectNerdFontSupport() ? NERD_ICONS : ASCII_ICONS;
}
