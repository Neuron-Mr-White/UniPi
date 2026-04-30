/**
 * @pi-unipi/utility — Shiki Highlighter
 *
 * Singleton Shiki ANSI highlighter with LRU cache, language detection,
 * and contrast normalization.
 */

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Maximum number of cached highlight results */
export const CACHE_LIMIT = 192;

/** Maximum characters to highlight (skip Shiki above this) */
export const MAX_HL_CHARS = 80_000;

// ─── LRU Cache ──────────────────────────────────────────────────────────────────

/**
 * Simple LRU cache with string keys.
 * Evicts oldest entries when capacity is reached.
 */
export class LruCache<V> {
  private map = new Map<string, V>();
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Evict oldest (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ─── Language Detection ─────────────────────────────────────────────────────────

/** File extension → Shiki language mapping */
export const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".json5": "json5",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".md": "markdown",
  ".mdx": "mdx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".php": "php",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".svg": "xml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".prisma": "prisma",
  ".dockerfile": "dockerfile",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".lua": "lua",
  ".r": "r",
  ".R": "r",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".hs": "haskell",
  ".elm": "elm",
  ".nim": "nim",
  ".zig": "zig",
  ".v": "v",
  ".jl": "julia",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".fsi": "fsharp",
};

/**
 * Detect the Shiki language from a file extension.
 * Returns "text" if the extension is unknown.
 */
export function detectLanguage(extension: string): string {
  const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return EXT_LANG[ext] ?? "text";
}

/**
 * Detect language from a file path.
 */
export function detectLanguageFromPath(filePath: string): string {
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.substring(filePath.lastIndexOf(".")) : "";
  return detectLanguage(ext);
}

// ─── Contrast Normalization ─────────────────────────────────────────────────────

/**
 * Calculate the relative luminance of a hex color.
 * Used for contrast ratio calculations.
 */
function relativeLuminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Calculate contrast ratio between two colors.
 */
function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Extract the foreground color from an ANSI 24-bit escape sequence.
 * Returns the hex color and the full match for replacement.
 */
function extractAnsiFg(ansi: string): { hex: string; match: string } | null {
  const match = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (!match) return null;
  const r = parseInt(match[1]);
  const g = parseInt(match[2]);
  const b = parseInt(match[3]);
  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  return { hex, match: match[0] };
}

/**
 * Normalize low-contrast Shiki foregrounds against a dark background.
 *
 * Shiki themes sometimes produce foreground colors with poor contrast
 * against diff backgrounds. This function bumps the brightness of any
 * foreground that falls below the minimum contrast ratio.
 *
 * @param ansi - ANSI string with 24-bit color codes
 * @param bgHex - Background hex color to test against (default: dark bg)
 * @param minRatio - Minimum contrast ratio (default: 3.0)
 */
export function normalizeShikiContrast(
  ansi: string,
  bgHex: string = "#1a1a2e",
  minRatio: number = 3.0,
): string {
  // Find all 24-bit foreground sequences
  const fgRegex = /\x1b\[38;2;\d+;\d+;\d+m/g;
  let result = ansi;
  let match: RegExpExecArray | null;

  while ((match = fgRegex.exec(ansi)) !== null) {
    const fgInfo = extractAnsiFg(match[0] + ansi.substring(match.index + match[0].length));
    if (!fgInfo) continue;

    const ratio = contrastRatio(fgInfo.hex, bgHex);
    if (ratio < minRatio) {
      // Brighten the foreground by mixing with white
      const [r, g, b] = [
        parseInt(fgInfo.hex.slice(1, 3), 16),
        parseInt(fgInfo.hex.slice(3, 5), 16),
        parseInt(fgInfo.hex.slice(5, 7), 16),
      ];
      const factor = minRatio / Math.max(ratio, 0.01);
      const nr = Math.min(255, Math.round(r + (255 - r) * Math.min(1, factor * 0.5)));
      const ng = Math.min(255, Math.round(g + (255 - g) * Math.min(1, factor * 0.5)));
      const nb = Math.min(255, Math.round(b + (255 - b) * Math.min(1, factor * 0.5)));
      const newFg = `\x1b[38;2;${nr};${ng};${nb}m`;
      result = result.replace(match[0], newFg);
    }
  }

  return result;
}

// ─── Shiki Highlighter ──────────────────────────────────────────────────────────

/** Shiki highlighter instance (lazy singleton) */
let shikiHighlighter: any = null;
let shikiInitPromise: Promise<any> | null = null;

/**
 * Initialize the Shiki highlighter (singleton).
 * Returns the highlighter instance.
 */
export async function getShikiHighlighter(): Promise<any> {
  if (shikiHighlighter) return shikiHighlighter;
  if (shikiInitPromise) return shikiInitPromise;

  shikiInitPromise = (async () => {
    try {
      const { createHighlighter } = await import("shiki");
      shikiHighlighter = await createHighlighter({
        themes: ["github-dark"],
        langs: [
          "typescript", "javascript", "tsx", "jsx", "json", "jsonc",
          "html", "css", "scss", "markdown", "python", "go", "rust",
          "java", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin",
          "bash", "yaml", "toml", "xml", "sql", "graphql", "vue", "svelte",
        ],
      });
      return shikiHighlighter;
    } catch (err) {
      // If Shiki fails to load, return null — we'll use plain text
      console.warn("[pi-diff] Shiki highlighter failed to load:", err);
      shikiInitPromise = null;
      return null;
    }
  })();

  return shikiInitPromise;
}

/**
 * Pre-warm the Shiki highlighter.
 * Call this early in the extension lifecycle to avoid first-render delay.
 */
export async function preWarmHighlighter(): Promise<void> {
  await getShikiHighlighter();
}

/** LRU cache for highlighted blocks */
const hlCache = new LruCache<string[]>(CACHE_LIMIT);

/**
 * Generate a cache key for a code block.
 */
function hlCacheKey(code: string, language: string): string {
  // Use first 200 chars + length + language for cache key
  const prefix = code.substring(0, 200);
  return `${language}:${code.length}:${prefix}`;
}

/**
 * Highlight a code block to ANSI using Shiki.
 * Results are cached in an LRU cache (192 entries).
 *
 * @param code - Code to highlight
 * @param language - Shiki language identifier
 * @returns Array of ANSI-highlighted lines, or plain lines if Shiki unavailable
 */
export async function hlBlock(code: string, language: string): Promise<string[]> {
  // Skip highlighting for very large content
  if (code.length > MAX_HL_CHARS) {
    return code.split("\n");
  }

  // Check cache
  const key = hlCacheKey(code, language);
  const cached = hlCache.get(key);
  if (cached) return cached;

  // Get highlighter
  const highlighter = await getShikiHighlighter();
  if (!highlighter) {
    // Shiki not available — return plain text
    return code.split("\n");
  }

  try {
    // Highlight with Shiki
    const ansi = highlighter.codeToANSI(code, {
      lang: language === "text" ? "text" : language,
      theme: "github-dark",
    });

    const lines = ansi.split("\n");

    // Normalize contrast
    const normalized = lines.map((line: string) => normalizeShikiContrast(line));

    // Cache result
    hlCache.set(key, normalized);

    return normalized;
  } catch {
    // Fallback on error
    return code.split("\n");
  }
}
