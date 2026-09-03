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
  apiState: string;
  toolCount: string;
  git: string;
  context: string;
  cost: string;
  tokens: string;
  tokensIn: string;
  tokensOut: string;
  session: string;
  hostname: string;
  time: string;
  tps: string;
  clock: string;
  duration: string;
  thinkingLevel: string;
  brand: string;
  directory: string;

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
  brand:           "",
  directory:       "\u{F1154}",
  model:           "\u{F06A9}", // 󰚩
  apiState:        "\u{F109B}", // 󱂛
  toolCount:       "\u{F1064}", // 󱁤
  git:             "\uEAFE", // 
  context:         "\u{F0077}", // 󰁷
  cost:            "\uF155", // 
  tokens:          "\uEDE8", // 
  tokensIn:        "\uEDE8", // 
  tokensOut:       "\uEDE8", // 
  session:         "\uF03A", // 
  hostname:        "\uEA7A", // 
  time:            "\uF017", // 
  tps:             "\u{F04C5}", // 󰓅
  clock:           "\uF017", // 
  duration:        "\u{F13AB}", // 󱎫
  thinkingLevel:   "\uF400", // 

  // Compactor
  sessionEvents:   "\uEA86", // 
  compactions:     "\u{F0C8F}", // 󰲏
  tokensSaved:     "\uF155", //  (kept — missing from customization)
  compressionRatio:"\u{F0C8F}", // 󰲏
  indexedDocs:     "\u{F0219}", // 󰈙
  sandboxRuns:     "\uF233", // 
  searchQueries:   "\uF002", // 

  // Memory
  projectCount:    "\uEE9C", // 
  totalCount:      "\uEE9C", // 
  consolidations:  "\uEE9C", // 

  // MCP
  serversTotal:    "\u{F05B7}", // 󰖷
  serversActive:   "\u{F05B7}", // 󰖷
  toolsTotal:      "\u{F05B7}", // 󰖷
  serversFailed:   "\u{F05B7}", // 󰖷

  // Ralph
  activeLoops:     "\u{F0709}", // 󰜉
  totalIterations: "\u{F0709}", // 󰜉
  loopStatus:      "\u{F0709}", // 󰜉

  // Workflow
  currentCommand:  "\uF124", // 
  sandboxLevel:    "\u{F07FE}", // 󰟾
  commandDuration: "\u{F13AB}", // 󱎫

  // Kanboard
  docsCount:       "\u{F09EE}", // 󰧮
  tasksDone:       "\u{F1A9A}", // 󱪚
  tasksTotal:      "\uF4A0", // 
  taskPct:         "\uF4A0", // 

  // Notify
  platformsEnabled:"\uEB9A", // 
  lastSent:        "\u{F13AB}", // 󱎫

  // Extension status
  extensionStatuses:"\u{F15AB}", // 󱖫

  separator:       "\uE0B1", // nf-pl-left_soft_divider
};

// ─── Emoji icons ─────────────────────────────────────────────────────────────

/** Unicode emoji / symbol icons — works on most modern terminals */
export const EMOJI_ICONS: IconSet = {
  // Core
  model:           "🤖",
  apiState:        "🔄",
  toolCount:       "🔧",
  git:             "🔀",
  context:         "🗄️",
  cost:            "💲",
  tokens:          "📊",
  tokensIn:        "⬇️",
  tokensOut:       "⬆️",
  session:         "📋",
  hostname:        "🏠",
  time:            "⏱",

  tps:             "⚡",
  clock:           "🕔",
  duration:        "⏱",
  thinkingLevel:   "💡",
  brand:           "",
  directory:       "📁",

  // Compactor
  sessionEvents:   "📈",
  compactions:     "🗜️",
  tokensSaved:     "💲",
  compressionRatio:"📐",
  indexedDocs:     "📑",
  sandboxRuns:     "▶️",
  searchQueries:   "🔍",

  // Memory
  projectCount:    "🧠",
  totalCount:      "🧠",
  consolidations:  "🔄",

  // MCP
  serversTotal:    "🖥️",
  serversActive:   "🟢",
  toolsTotal:      "🔧",
  serversFailed:   "⚠️",

  // Ralph
  activeLoops:     "🔁",
  totalIterations: "🔁",
  loopStatus:      "🔁",

  // Workflow
  currentCommand:  "▶️",
  sandboxLevel:    "🔒",
  commandDuration: "⏱",

  // Kanboard
  docsCount:       "📑",
  tasksDone:       "✅",
  tasksTotal:      "📋",
  taskPct:         "📊",

  // Notify
  platformsEnabled:"🔔",
  lastSent:        "⏱",

  // Extension status
  extensionStatuses:"🧩",

  separator:       "|",
};

// ─── Text icons ──────────────────────────────────────────────────────────────

/** Plain text labels — works everywhere, most compact */
export const TEXT_ICONS: IconSet = {
  // Core
  model:           "MDL",
  apiState:        "API",
  toolCount:       "TLS",
  git:             "GIT",
  context:         "CTX",
  cost:            "CST",
  tokens:          "TOK",
  tokensIn:        "TKI",
  tokensOut:       "TKO",
  session:         "SES",
  hostname:        "HST",
  time:            "TIM",

  tps:             "TPS",
  clock:           "CLK",
  duration:        "DUR",
  thinkingLevel:   "THK",
  brand:           "",
  directory:       "DIR",

  // Compactor
  sessionEvents:   "EVT",
  compactions:     "CMP",
  tokensSaved:     "SVD",
  compressionRatio:"RAT",
  indexedDocs:     "IDX",
  sandboxRuns:     "SBX",
  searchQueries:   "QRY",

  // Memory
  projectCount:    "MEM",
  totalCount:      "MEM",
  consolidations:  "CNS",

  // MCP
  serversTotal:    "SRV",
  serversActive:   "ACT",
  toolsTotal:      "TLS",
  serversFailed:   "ERR",

  // Ralph
  activeLoops:     "LPS",
  totalIterations: "ITR",
  loopStatus:      "STS",

  // Workflow
  currentCommand:  "CMD",
  sandboxLevel:    "SBX",
  commandDuration: "DUR",

  // Kanboard
  docsCount:       "DOC",
  tasksDone:       "DNE",
  tasksTotal:      "TSK",
  taskPct:         "PCT",

  // Notify
  platformsEnabled:"NTF",
  lastSent:        "LST",

  // Extension status
  extensionStatuses:"EXT",

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

/** Effective icon style in use — the current setting, or auto-detection. */
export function getResolvedIconStyle(): "nerd" | "emoji" | "text" {
  return currentIconStyle ?? resolveIconStyle();
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
