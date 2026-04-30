/**
 * @pi-unipi/footer — Icon system with 3 styles: Nerd Font, Emoji, Text
 *
 * Each icon set maps segment IDs to glyph strings.
 * The active set is determined by the `iconStyle` setting:
 *   - "nerd"  → Nerd Font glyphs (requires Nerd Font installed)
 *   - "emoji" → Unicode emoji / symbols (works on most terminals)
 *   - "text"  → Plain text labels (works everywhere, most compact)
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

// ─── Nerd Font icons ────────────────────────────────────────────────────────

/** Nerd Font glyphs — requires a Nerd Font installed in the terminal */
export const NERD_ICONS: IconSet = {
  // Core
  model:           "\uEC19", // nf-md-chip
  thinking:        "\uE22C", // nf-oct-pi
  path:            "\uF115", // nf-fa-folder_open
  git:             "\uF126", // nf-fa-code_fork
  context:         "\uE70F", // nf-dev-database
  cost:            "\uF155", // nf-fa-dollar
  tokens:          "\uE26B", // nf-seti-html
  tokensIn:        "\uF090", // nf-fa-sign_in
  tokensOut:       "\uF08B", // nf-fa-sign_out
  session:         "\uF550", // nf-md-identifier
  hostname:        "\uF109", // nf-fa-laptop
  time:            "\uF017", // nf-fa-clock_o

  // Compactor
  sessionEvents:   "\uF0C0", // nf-fa-users
  compactions:     "\uF1C0", // nf-fa-database
  tokensSaved:     "\uF155", // nf-fa-dollar
  compressionRatio:"\uE70F", // nf-dev-database
  indexedDocs:     "\uF02D", // nf-fa-book
  sandboxRuns:     "\uF121", // nf-fa-terminal
  searchQueries:   "\uF002", // nf-fa-search

  // Memory
  projectCount:    "\uee9c", //  memory icon
  totalCount:      "\uee9c", //  memory icon
  consolidations:  "\uee9c", //  memory icon

  // MCP
  serversTotal:    "\uF233", // nf-fa-server
  serversActive:   "\uF058", // nf-fa-check_circle
  toolsTotal:      "\uF0AD", // nf-fa-wrench
  serversFailed:   "\uF071", // nf-fa-warning

  // Ralph
  activeLoops:     "\udb81\udf09", // 󰼉 ralph loop icon
  totalIterations: "\udb81\udf09", // 󰼉 ralph loop icon
  loopStatus:      "\udb81\udf09", // 󰼉 ralph loop icon

  // Workflow
  currentCommand:  "\uf52e", //  workflow icon
  sandboxLevel:    "\uf023", // nf-fa-lock
  commandDuration: "\uf017", // nf-fa-clock_o

  // Kanboard
  docsCount:       "\uF15C", // nf-fa-file_text
  tasksDone:       "\uF058", // nf-fa-check_circle
  tasksTotal:      "\uF0AE", // nf-fa-tasks
  taskPct:         "\uF200", // nf-fa-pie_chart

  // Notify
  platformsEnabled:"\uF0E0", // nf-fa-envelope
  lastSent:        "\uF017", // nf-fa-clock_o

  // Extension status
  extensionStatuses:"\uF1E6", // nf-fa-plug

  separator:       "\uE0B1", // nf-pl-left_soft_divider
};

// ─── Emoji icons ─────────────────────────────────────────────────────────────

/** Unicode emoji / symbol icons — works on most modern terminals */
export const EMOJI_ICONS: IconSet = {
  // Core
  model:           "",
  thinking:        "π",
  path:            "",
  git:             "⎇",
  context:         "",
  cost:            "$",
  tokens:          "⊛",
  tokensIn:        "→",
  tokensOut:       "←",
  session:         "#",
  hostname:        "⌂",
  time:            "⏱",

  // Compactor
  sessionEvents:   "⚡",
  compactions:     "◧",
  tokensSaved:     "$",
  compressionRatio:"⇄",
  indexedDocs:     "☰",
  sandboxRuns:     "▶",
  searchQueries:   "⊗",

  // Memory
  projectCount:    "\uee9c",
  totalCount:      "\uee9c",
  consolidations:  "\uee9c",

  // MCP
  serversTotal:    "srv",
  serversActive:   "●",
  toolsTotal:      "🔧",
  serversFailed:   "⚠",

  // Ralph
  activeLoops:     "\udb81\udf09",
  totalIterations: "\udb81\udf09",
  loopStatus:      "\udb81\udf09",

  // Workflow
  currentCommand:  "\uf52e",
  sandboxLevel:    "◧",
  commandDuration: "⏱",

  // Kanboard
  docsCount:       "☰",
  tasksDone:       "✓",
  tasksTotal:      "☐",
  taskPct:         "%",

  // Notify
  platformsEnabled:"♮",
  lastSent:        "⏱",

  // Extension status
  extensionStatuses:"▦",

  separator:       "|",
};

// ─── Text icons ──────────────────────────────────────────────────────────────

/** Plain text labels — works everywhere, most compact */
export const TEXT_ICONS: IconSet = {
  // Core
  model:           "",
  thinking:        "",
  path:            "",
  git:             "",
  context:         "",
  cost:            "",
  tokens:          "",
  tokensIn:        "",
  tokensOut:       "",
  session:         "",
  hostname:        "",
  time:            "",

  // Compactor
  sessionEvents:   "evt",
  compactions:     "cmp",
  tokensSaved:     "svd",
  compressionRatio:"rat",
  indexedDocs:     "idx",
  sandboxRuns:     "sbx",
  searchQueries:   "qry",

  // Memory
  projectCount:    "mem",
  totalCount:      "mem",
  consolidations:  "cns",

  // MCP
  serversTotal:    "srv",
  serversActive:   "act",
  toolsTotal:      "tls",
  serversFailed:   "err",

  // Ralph
  activeLoops:     "rlp",
  totalIterations: "itr",
  loopStatus:      "rlp",

  // Workflow
  currentCommand:  "wf",
  sandboxLevel:    "sbx",
  commandDuration: "dur",

  // Kanboard
  docsCount:       "doc",
  tasksDone:       "✓",
  tasksTotal:      "tsk",
  taskPct:         "pct",

  // Notify
  platformsEnabled:"ntf",
  lastSent:        "lst",

  // Extension status
  extensionStatuses:"ext",

  separator:       "|",
};

// ─── Icon lookup ─────────────────────────────────────────────────────────────

/** Current icon style — updated by the renderer when settings change */
let currentIconStyle: "nerd" | "emoji" | "text" | undefined;

/** Set the active icon style (called by renderer when settings change) */
export function setIconStyle(style: "nerd" | "emoji" | "text" | undefined): void {
  currentIconStyle = style;
}

/** Resolve the effective icon style from settings + terminal detection */
export function resolveIconStyle(configured?: string): "nerd" | "emoji" | "text" {
  // Explicit setting wins
  if (configured === "nerd" || configured === "emoji" || configured === "text") {
    return configured;
  }

  // Auto-detect: use Nerd Font if terminal supports it, emoji otherwise
  return detectNerdFontSupport() ? "nerd" : "emoji";
}

/**
 * Get the icon for a segment by ID.
 * Uses the configured icon style, falling back to auto-detection.
 */
export function getIcon(segmentId: string, overrideStyle?: "nerd" | "emoji" | "text"): string {
  const style = overrideStyle ?? currentIconStyle ?? resolveIconStyle();
  const sets: Record<string, IconSet> = {
    nerd: NERD_ICONS,
    emoji: EMOJI_ICONS,
    text: TEXT_ICONS,
  };
  const icons = sets[style];
  const key = segmentId as keyof IconSet;
  return icons[key] ?? "";
}

/**
 * Get the full icon set based on the configured style.
 */
export function getIcons(iconStyle?: "nerd" | "emoji" | "text"): IconSet {
  const style = iconStyle ?? currentIconStyle ?? resolveIconStyle();
  const sets: Record<string, IconSet> = {
    nerd: NERD_ICONS,
    emoji: EMOJI_ICONS,
    text: TEXT_ICONS,
  };
  return sets[style];
}
