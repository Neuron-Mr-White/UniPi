/**
 * @pi-unipi/mcp — Catalog sync
 *
 * Fetches MCP server catalog from GitHub's punkpeye/awesome-mcp-servers README,
 * parses markdown into structured entries, caches to servers.json.
 * Falls back to bundled seed-servers.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CatalogEntry, CatalogData } from "../types.js";
import { loadMetadata, saveMetadata, getGlobalConfigDir } from "./manager.js";

/** GitHub raw URL for awesome-mcp-servers README */
const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";

/** Path to seed data bundled with the package */
function getSeedPath(): string {
  // Resolve relative to this file's location
  return path.join(import.meta.dirname ?? __dirname, "..", "..", "data", "seed-servers.json");
}

/** Path to cached catalog */
function getCatalogPath(): string {
  return path.join(getGlobalConfigDir(), "servers.json");
}

/**
 * Fetch the awesome-mcp-servers README from GitHub.
 */
async function fetchCatalogFromGitHub(): Promise<string> {
  const response = await fetch(GITHUB_RAW_URL, {
    headers: { "User-Agent": "@pi-unipi/mcp" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch catalog: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

/**
 * Parse markdown from awesome-mcp-servers into structured catalog entries.
 *
 * The README has sections like:
 * ```
 * ## Category Name
 * - [Server Name](github-url) - Description
 * - [Server Name](github-url) ⭐ - Description
 * ```
 */
function parseMarkdownServers(markdown: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const lines = markdown.split("\n");
  let currentCategory = "uncategorized";
  const seen = new Set<string>();

  for (const line of lines) {
    // Track current category (## headers)
    const categoryMatch = line.match(/^##\s+(.+)/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1].trim().toLowerCase();
      continue;
    }

    // Parse server entries: - [Name](url) - Description or - [Name](url) ⭐ - Description
    const serverMatch = line.match(
      /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*(⭐)?\s*[-–—]?\s*(.*)/,
    );
    if (!serverMatch) continue;

    const [, name, githubUrl, officialStar, rawDesc] = serverMatch;

    // Only include entries that link to GitHub
    if (!githubUrl.includes("github.com")) continue;

    // Deduplicate by URL
    if (seen.has(githubUrl)) continue;
    seen.add(githubUrl);

    // Extract repo path for ID
    const repoMatch = githubUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    const id = repoMatch ? repoMatch[1] : githubUrl;

    // Clean description
    const description = rawDesc
      .replace(/\s*\(.*?\)\s*/g, "") // Remove parenthetical
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Extract link text
      .trim()
      .slice(0, 200);

    // Detect scope from description/name
    const isLocal =
      /\b(local|filesystem|sqlite|postgres|docker)\b/i.test(
        name + " " + description,
      );

    entries.push({
      id,
      name,
      description: description || `MCP server: ${name}`,
      github: githubUrl,
      categories: [currentCategory],
      language: guessLanguage(name, description),
      scope: isLocal ? "local" : "cloud",
      official: !!officialStar,
    });
  }

  return entries;
}

/**
 * Guess the primary language from name/description heuristics.
 */
function guessLanguage(name: string, desc: string): string {
  const text = `${name} ${desc}`.toLowerCase();
  if (/\bpython\b|\buvx\b|\bpip\b/.test(text)) return "python";
  if (/\bgo\b|\bgolang\b/.test(text)) return "go";
  if (/\brust\b|\bcargo\b/.test(text)) return "rust";
  if (/\bdocker\b|\bcontainer\b/.test(text)) return "docker";
  return "typescript"; // Most MCP servers are TypeScript/Node
}

/**
 * Known install patterns for popular MCP servers.
 * Maps server name patterns to install configs.
 */
const KNOWN_INSTALLS: Record<
  string,
  { command: string; args: string[]; envVars?: string[] }
> = {
  github: {
    command: "docker",
    args: [
      "run", "-i", "--rm",
      "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server",
    ],
    envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  },
  playwright: {
    command: "npx",
    args: ["-y", "@playwright/mcp"],
  },
  "brave-search": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envVars: ["BRAVE_API_KEY"],
  },
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
  },
  postgres: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    envVars: ["POSTGRES_CONNECTION_STRING"],
  },
  sqlite: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite"],
  },
  memory: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  fetch: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
  puppeteer: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  supabase: {
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase"],
    envVars: ["SUPABASE_ACCESS_TOKEN"],
  },
  docker: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-docker"],
  },
  gitlab: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    envVars: ["GITLAB_PERSONAL_ACCESS_TOKEN"],
  },
  linear: {
    command: "npx",
    args: ["-y", "mcp-linear"],
    envVars: ["LINEAR_API_KEY"],
  },
  notion: {
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    envVars: ["NOTION_API_KEY"],
  },
  slack: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envVars: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
  },
  sentry: {
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    envVars: ["SENTRY_AUTH_TOKEN"],
  },
  "google-maps": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    envVars: ["GOOGLE_MAPS_API_KEY"],
  },
  "google-drive": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    envVars: ["GOOGLE_DRIVE_CREDENTIALS"],
  },
  "aws-kb-retrieval": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-aws-kb-retrieval"],
    envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  },
  "everything": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  },
  "sequential-thinking": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  "computer-use": {
    command: "npx",
    args: ["-y", "@anthropic/mcp-computer-use"],
  },
  figma: {
    command: "npx",
    args: ["-y", "mcp-figma"],
    envVars: ["FIGMA_ACCESS_TOKEN"],
  },
  discord: {
    command: "npx",
    args: ["-y", "mcp-discord"],
    envVars: ["DISCORD_BOT_TOKEN"],
  },
  tavily: {
    command: "npx",
    args: ["-y", "mcp-tavily"],
    envVars: ["TAVILY_API_KEY"],
  },
  firecrawl: {
    command: "npx",
    args: ["-y", "mcp-server-firecrawl"],
    envVars: ["FIRECRAWL_API_KEY"],
  },
  cloudflare: {
    command: "npx",
    args: ["-y", "@cloudflare/mcp-server-cloudflare"],
    envVars: ["CLOUDFLARE_API_TOKEN"],
  },
  vercel: {
    command: "npx",
    args: ["-y", "mcp-vercel"],
    envVars: ["VERCEL_API_TOKEN"],
  },
  neon: {
    command: "npx",
    args: ["-y", "mcp-server-neon"],
    envVars: ["NEON_API_KEY"],
  },
  railway: {
    command: "npx",
    args: ["-y", "mcp-server-railway"],
    envVars: ["RAILWAY_API_TOKEN"],
  },
  "time-mcp": {
    command: "npx",
    args: ["-y", "time-mcp"],
  },
  "weather-mcp": {
    command: "npx",
    args: ["-y", "weather-mcp"],
  },
  exa: {
    command: "npx",
    args: ["-y", "mcp-server-exa"],
    envVars: ["EXA_API_KEY"],
  },
};

/**
 * Enrich parsed entries with install info for known servers.
 */
function enrichWithInstallInfo(entries: CatalogEntry[]): CatalogEntry[] {
  return entries.map((entry) => {
    if (entry.install) return entry; // Already has install info

    // Try to match by ID or name
    const lowerName = entry.name.toLowerCase().replace(/\s+/g, "-");
    const lowerId = entry.id.toLowerCase();

    for (const [pattern, install] of Object.entries(KNOWN_INSTALLS)) {
      if (
        lowerName.includes(pattern) ||
        lowerId.includes(pattern) ||
        lowerName.replace(/-/g, "").includes(pattern.replace(/-/g, ""))
      ) {
        return { ...entry, install };
      }
    }

    return entry;
  });
}

/**
 * Check if enough time has passed since last sync.
 */
function shouldSync(lastSyncAt: string | null, intervalMs: number): boolean {
  if (!lastSyncAt) return true;
  const elapsed = Date.now() - new Date(lastSyncAt).getTime();
  return elapsed >= intervalMs;
}

/**
 * Sync the MCP server catalog from GitHub.
 * Parses the awesome-mcp-servers README, enriches with install info,
 * and caches to servers.json.
 */
export async function syncCatalog(): Promise<CatalogData> {
  const markdown = await fetchCatalogFromGitHub();
  const rawEntries = parseMarkdownServers(markdown);
  const entries = enrichWithInstallInfo(rawEntries);

  const catalog: CatalogData = {
    lastUpdated: new Date().toISOString(),
    source: "github:punkpeye/awesome-mcp-servers",
    totalServers: entries.length,
    servers: entries,
  };

  // Write to cache
  const catalogPath = getCatalogPath();
  const dir = path.dirname(catalogPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf-8");

  // Update metadata with sync timestamp
  const configDir = getGlobalConfigDir();
  const meta = loadMetadata(configDir);
  meta.sync.lastSyncAt = catalog.lastUpdated;
  saveMetadata(configDir, meta);

  return catalog;
}

/**
 * Load the cached catalog, falling back to seed data.
 */
export function loadCatalog(): CatalogData {
  const catalogPath = getCatalogPath();

  // Try cached version first
  try {
    const content = fs.readFileSync(catalogPath, "utf-8");
    const data = JSON.parse(content) as CatalogData;
    if (data.servers && data.servers.length > 0) {
      return data;
    }
  } catch {
    // Cache doesn't exist or is invalid — fall through to seed
  }

  // Fall back to seed data
  const seedPath = getSeedPath();
  try {
    const content = fs.readFileSync(seedPath, "utf-8");
    return JSON.parse(content) as CatalogData;
  } catch {
    // Return empty catalog if seed is also missing
    return {
      lastUpdated: new Date().toISOString(),
      source: "seed",
      totalServers: 0,
      servers: [],
    };
  }
}

/**
 * Sync if enough time has passed since last sync.
 * Returns null if no sync was needed, or the catalog data if synced.
 */
export async function syncIfNeeded(): Promise<CatalogData | null> {
  const configDir = getGlobalConfigDir();
  const meta = loadMetadata(configDir);

  if (!shouldSync(meta.sync.lastSyncAt, meta.sync.syncIntervalMs)) {
    return null;
  }

  try {
    return await syncCatalog();
  } catch {
    // Sync failed — return null, will use cached/seed data
    return null;
  }
}
