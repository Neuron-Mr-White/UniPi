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
  model:           "\uDB81\uDE5B", // 󰚩 custom model icon
  apiState:        "\uF725", // 󱂛 api state icon
  toolCount:       "\uF0AD", //  tool count icon
  git:             "\uF0E8", //  git icon
  context:         "\uF8D8", //  context icon
  cost:            "\uF155", //  cost icon
  tokens:          "\uF07B", //  tokens icon
  tokensIn:        "\uF07B", //  tokens in icon
  tokensOut:       "\uF07B", //  tokens out icon
  session:         "\uF550", // nf-md-identifier
  hostname:        "\uF109", // nf-fa-laptop
  time:            "\uF017", // nf-fa-clock_o
  tps:             "\uF062", // \u2191 up arrow
  clock:           "\uF017", // nf-fa-clock_o
  duration:        "\uF49B", // nf-md-timer_outline
  thinkingLevel:   "\uF4D8", // nf-fa-lightbulb_o

  // Compactor
  sessionEvents:   "\uDBB1\uDECF", // 󰲏 session events icon
  compactions:     "\uDBB1\uDECF", // 󰲏 compactions icon
  tokensSaved:     "\uF155", //  tokens saved icon
  compressionRatio:"\uDBB1\uDECF", // 󰲏 compression ratio icon
  indexedDocs:     "\uDB81\uDE19", // 󰈙 indexed docs icon
  sandboxRuns:     "\uF121", //  sandbox runs icon
  searchQueries:   "\uF002", //  search queries icon

  // Memory
  projectCount:    "\uDB81\uDED4", // 󰍚 memory icon
  totalCount:      "\uEB9C", //  total count icon
  consolidations:  "\uDB81\uDED4", // 󰍚 consolidations icon

  // MCP
  serversTotal:    "\uF0F6", //  servers total icon
  serversActive:   "\uF058", //  servers active icon
  toolsTotal:      "\uF0AD", //  tools total icon
  serversFailed:   "\uF467", //  servers failed icon

  // Ralph
  activeLoops:     "\udb81\udf09", // 󰼉 ralph loop icon
  totalIterations: "\udb81\udf09", // 󰼉 ralph loop icon
  loopStatus:      "\udb81\udf09", // 󰼉 ralph loop icon

  // Workflow
  currentCommand:  "\uF0E8", //  current command icon
  sandboxLevel:    "\uDBB1\uDDFE", // 󰟾 sandbox level icon
  commandDuration: "\uDBB9\uDEAB", // 󱎫 command duration icon

  // Kanboard
  docsCount:       "\uDB81\uDE19", // 󰈙 docs count icon
  tasksDone:       "\uF0E8", //  tasks done icon
  tasksTotal:      "\uF0E8", //  tasks total icon
  taskPct:         "\uF0E8", //  task pct icon

  // Notify
  platformsEnabled:"\uF0E0", // nf-fa-envelope
  lastSent:        "\uF017", // nf-fa-clock_o

  // Extension status
  extensionStatuses:"\uDBB5\uDEAB", // 󱖫 extension statuses icon

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
