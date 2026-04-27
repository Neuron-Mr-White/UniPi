/**
 * @pi-unipi/mcp — Add server overlay TUI
 *
 * Split-pane overlay for adding MCP servers:
 * Left: browsable/searchable catalog list
 * Right: JSON config editor for selected server
 */

import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { CatalogEntry, CatalogData, McpConfig, McpMetadata } from "../types.js";
import { loadCatalog } from "../config/sync.js";
import {
  loadMcpConfig,
  saveMcpConfig,
  loadMetadata,
  saveMetadata,
  getGlobalConfigDir,
} from "../config/manager.js";
import { validateMcpConfig, createServerTemplate, DEFAULT_MCP_CONFIG, DEFAULT_METADATA } from "../config/schema.js";

/** State for the add overlay */
interface AddOverlayState {
  mode: "browse" | "custom";
  searchQuery: string;
  filteredServers: CatalogEntry[];
  allServers: CatalogEntry[];
  selectedIndex: number;
  editorContent: string;
  focusPane: "browse" | "editor";
  validationError: string | null;
  scope: "global" | "project";
  saved: boolean;
}

/**
 * Generate a pre-filled JSON config template from a catalog entry.
 */
function generateConfigTemplate(server: CatalogEntry): string {
  const name = server.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  const config: Record<string, unknown> = {
    mcpServers: {
      [name]: {
        command: server.install?.command ?? "npx",
        args: server.install?.args ?? ["-y", `@modelcontextprotocol/server-${name}`],
        env: {},
      },
    },
  };

  // Pre-fill env vars with placeholders
  if (server.install?.envVars) {
    const env: Record<string, string> = {};
    for (const v of server.install.envVars) {
      env[v] = "";
    }
    (config.mcpServers as any)[name].env = env;
  }

  return JSON.stringify(config, null, 2);
}

/**
 * Render the MCP add overlay.
 *
 * Returns a callback compatible with ctx.ui.custom():
 * (tui, theme, kb, done) => { render, invalidate, handleInput }
 */
export function renderMcpAddOverlay(params?: {
  scope?: "global" | "project";
  onComplete?: () => void;
}) {
  return (
    tui: any,
    theme: any,
    _kb: any,
    done: (result: { saved: boolean } | null) => void,
  ) => {
    const scope = params?.scope ?? "global";

    // State
    const state: AddOverlayState = {
      mode: "browse",
      searchQuery: "",
      filteredServers: [],
      allServers: [],
      selectedIndex: 0,
      editorContent: "{}",
      focusPane: "browse",
      validationError: null,
      scope,
      saved: false,
    };

    // Load catalog
    let catalog: CatalogData;
    try {
      catalog = loadCatalog();
      state.allServers = catalog.servers;
      state.filteredServers = catalog.servers;
    } catch {
      catalog = { lastUpdated: "", source: "", totalServers: 0, servers: [] };
      state.allServers = [];
      state.filteredServers = [];
    }

    // Editor theme
    const editorTheme: EditorTheme = {
      borderColor: (s: any) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: any) => theme.fg("accent", t),
        selectedText: (t: any) => theme.fg("accent", t),
        description: (t: any) => theme.fg("muted", t),
        scrollInfo: (t: any) => theme.fg("dim", t),
        noMatch: (t: any) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.setText(state.editorContent);

    let cachedLines: string[] | undefined;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function searchServers(query: string) {
      if (!query.trim()) {
        state.filteredServers = state.allServers;
      } else {
        const q = query.toLowerCase();
        state.filteredServers = state.allServers.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.categories.some((c) => c.toLowerCase().includes(q)),
        );
      }
      state.selectedIndex = 0;
    }

    function selectServer(index: number) {
      if (index < 0 || index >= state.filteredServers.length) return;
      state.selectedIndex = index;
      const server = state.filteredServers[index];
      state.editorContent = generateConfigTemplate(server);
      editor.setText(state.editorContent);
      state.validationError = null;
      state.focusPane = "editor";
      state.mode = "browse";
    }

    function validateAndSave(): boolean {
      try {
        const parsed = JSON.parse(state.editorContent);
        const validation = validateMcpConfig(parsed);
        if (!validation.valid) {
          state.validationError = validation.errors[0];
          return false;
        }

        // Determine target directory
        const configDir = getGlobalConfigDir();

        // Load existing config and merge — handle corrupt existing config
        let existing: McpConfig;
        try {
          existing = loadMcpConfig(configDir);
        } catch {
          // Existing config is corrupt — start fresh
          existing = { ...DEFAULT_MCP_CONFIG };
        }

        const newServers = parsed.mcpServers ?? {};

        for (const [name, def] of Object.entries(newServers)) {
          existing.mcpServers[name] = def as any;
        }

        saveMcpConfig(configDir, existing);

        // Update metadata
        let meta: McpMetadata;
        try {
          meta = loadMetadata(configDir);
        } catch {
          meta = { ...DEFAULT_METADATA, servers: {}, sync: { ...DEFAULT_METADATA.sync } };
        }
        for (const name of Object.keys(newServers)) {
          meta.servers[name] = {
            enabled: true,
            addedAt: new Date().toISOString(),
          };
        }
        saveMetadata(configDir, meta);

        state.saved = true;
        state.validationError = null;
        return true;
      } catch (err) {
        state.validationError =
          err instanceof Error ? err.message : "Invalid JSON";
        return false;
      }
    }

    function handleInput(data: string) {
      // Editor pane focused: delegate to editor
      if (state.focusPane === "editor") {
        if (matchesKey(data, Key.escape)) {
          // Cancel editing, go back to browse
          state.focusPane = "browse";
          state.validationError = null;
          refresh();
          return;
        }

        // Ctrl+S or Enter in editor: validate and save
        if (
          (data === "\x13" || data === "\r") &&
          state.editorContent.trim() !== "{}"
        ) {
          if (validateAndSave()) {
            done({ saved: true });
            params?.onComplete?.();
          } else {
            refresh();
          }
          return;
        }

        // Delegate to editor
        editor.handleInput(data);
        state.editorContent = editor.getText();
        refresh();
        return;
      }

      // Browse pane focused
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }

      // Navigation
      if (matchesKey(data, Key.up)) {
        if (state.selectedIndex > 0) {
          state.selectedIndex--;
          refresh();
        }
        return;
      }

      if (matchesKey(data, Key.down)) {
        if (state.selectedIndex < state.filteredServers.length - 1) {
          state.selectedIndex++;
          refresh();
        }
        return;
      }

      // Enter: select server and move to editor
      if (data === "\r" || data === "\n") {
        selectServer(state.selectedIndex);
        refresh();
        return;
      }

      // Tab: toggle focus between panes
      if (data === "\t") {
        state.focusPane = state.focusPane === "browse" ? "editor" : "browse";
        refresh();
        return;
      }

      // 'c': switch to custom mode (empty editor)
      if (data === "c") {
        state.editorContent = JSON.stringify(
          { mcpServers: { "": { command: "", args: [], env: {} } } },
          null,
          2,
        );
        editor.setText(state.editorContent);
        state.focusPane = "editor";
        state.mode = "custom";
        refresh();
        return;
      }

      // '/' or typing: start search
      if (data === "/" || (data.length === 1 && data >= " ")) {
        if (data === "/") {
          state.searchQuery = "";
        } else {
          state.searchQuery += data;
        }
        searchServers(state.searchQuery);
        refresh();
        return;
      }

      // Backspace: delete from search
      if (data === "\x7f" || data === "\b") {
        if (state.searchQuery.length > 0) {
          state.searchQuery = state.searchQuery.slice(0, -1);
          searchServers(state.searchQuery);
          refresh();
        }
        return;
      }
    }

    /** Pad content to exact visible width, accounting for ANSI codes and emoji */
    function padVisible(content: string, targetWidth: number): string {
      const vw = visibleWidth(content);
      const pad = Math.max(0, targetWidth - vw);
      return content + " ".repeat(pad);
    }

    /** Render a single split-pane row: │ left │ right │ */
    function splitRow(left: string, right: string, halfW: number): string {
      return (
        theme.fg("accent", "│") +
        padVisible(left, halfW) +
        theme.fg("accent", "│") +
        padVisible(right, halfW) +
        theme.fg("accent", "│")
      );
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const innerWidth = Math.max(22, width - 2);
      const halfW = Math.floor(innerWidth / 2) - 1; // -1 for the middle │

      // ── Header ──────────────────────────────────────────────────────
      const header = " Add MCP Server ";
      const modeLabel = state.mode === "browse" ? "[Browse]" : "[Custom]";
      const headerPad = Math.max(0, innerWidth - visibleWidth(header) - visibleWidth(modeLabel));
      lines.push(theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        theme.fg("accent", "│") +
        theme.bold(header) +
        theme.fg("muted", " ".repeat(headerPad) + modeLabel) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

      // ── Content area — split pane ──────────────────────────────────
      const browseServers = state.filteredServers;
      const CONTENT_HEIGHT = 16;
      const editorLines = state.editorContent.split("\n");

      // Build left pane lines (one string per row, no embedded newlines)
      const leftLines: string[] = [];

      // Row 0: search bar
      const searchDisplay = state.searchQuery || "search...";
      leftLines.push(theme.fg("muted", ` 🔍 ${searchDisplay}`));

      // Row 1: blank separator
      leftLines.push("");

      // Rows 2+: server list
      for (let i = 0; i < browseServers.length && leftLines.length < CONTENT_HEIGHT; i++) {
        const server = browseServers[i];
        const selected = i === state.selectedIndex;
        const scopeIcon = server.scope === "cloud" ? "☁️" : "🏠";
        const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
        const name = selected
          ? theme.bold(server.name)
          : theme.fg("text", server.name);
        leftLines.push(` ${prefix}${scopeIcon} ${name}`);

        // Show description below selected item (takes its own row)
        if (selected && server.description) {
          const desc = truncateToWidth(server.description, halfW - 5);
          leftLines.push(`    ${theme.fg("muted", desc)}`);
        }
      }

      // Build right pane lines
      const rightLines: string[] = [];

      // Row 0: editor header
      rightLines.push(theme.fg("muted", " Config Editor "));

      // Row 1: blank separator
      rightLines.push("");

      // Rows 2+: editor content
      for (let i = 0; i < editorLines.length && rightLines.length < CONTENT_HEIGHT; i++) {
        rightLines.push(theme.fg("text", truncateToWidth(editorLines[i], halfW - 2)));
      }

      // Combine into split-pane rows
      for (let row = 0; row < CONTENT_HEIGHT; row++) {
        const left = leftLines[row] ?? "";
        const right = rightLines[row] ?? "";
        lines.push(splitRow(left, right, halfW));
      }

      // ── Validation error ───────────────────────────────────────────
      if (state.validationError) {
        const errText = ` ⚠ ${truncateToWidth(state.validationError, innerWidth - 4)}`;
        lines.push(
          theme.fg("accent", "│") +
          padVisible(theme.fg("error", errText), innerWidth) +
          theme.fg("accent", "│"),
        );
      }

      // ── Footer ─────────────────────────────────────────────────────
      const scopeLabel = state.scope === "global" ? "● Global" : "● Project";
      lines.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("muted", ` ${scopeLabel}`), innerWidth) +
        theme.fg("accent", "│"),
      );

      const binds = " ↑↓ navigate  Enter select  Tab pane  c custom  q/Esc close";
      lines.push(
        theme.fg("accent", "│") +
        padVisible(theme.fg("muted", truncateToWidth(binds, innerWidth)), innerWidth) +
        theme.fg("accent", "│"),
      );
      lines.push(theme.fg("accent", `╰${"─".repeat(innerWidth)}╯`));

      cachedLines = lines;
      return lines;
    }

    return { render, invalidate: refresh, handleInput };
  };
}
