/**
 * @pi-unipi/mcp — Add server overlay TUI
 *
 * Vim-modal browser for the MCP catalog with split-pane editor.
 *
 * Modes:
 *   normal  — j/k navigate, Enter select, l/Tab → editor, / search, gg/G top/bottom,
 *             Ctrl+d/u half-page, Esc/q close
 *   search  — typing edits query, Enter accept, Esc cancel
 *   editor  — JSON editor active, Ctrl+S save, Esc/h back to browse
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
import { validateMcpConfig, DEFAULT_MCP_CONFIG, DEFAULT_METADATA } from "../config/schema.js";

type Mode = "normal" | "search" | "editor";

interface AddOverlayState {
  mode: Mode;
  searchQuery: string;
  pendingSearch: string;
  filteredServers: CatalogEntry[];
  allServers: CatalogEntry[];
  selectedIndex: number;
  scrollOffset: number;
  editorContent: string;
  validationError: string | null;
  scope: "global" | "project";
  saved: boolean;
  pendingG: boolean;
  status: string;
}

function generateConfigTemplate(server: CatalogEntry): string {
  const slug = server.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const config: Record<string, unknown> = {
    mcpServers: {
      [slug]: {
        command: server.install?.command ?? "npx",
        args: server.install?.args ?? ["-y", `@modelcontextprotocol/server-${slug}`],
        env: {},
      },
    },
  };
  if (server.install?.envVars) {
    const env: Record<string, string> = {};
    for (const v of server.install.envVars) env[v] = "";
    (config.mcpServers as any)[slug].env = env;
  }
  return JSON.stringify(config, null, 2);
}

function padVisible(content: string, targetWidth: number): string {
  const pad = Math.max(0, targetWidth - visibleWidth(content));
  return content + " ".repeat(pad);
}

/**
 * Strip characters that pi-tui's visibleWidth and the user's terminal may
 * disagree on (RGI emoji, variation selectors, ZWJ, regional indicators).
 * Keeps printable ASCII and standard Latin/box-drawing chars; replaces
 * problem chars with a single * so widths stay deterministic.
 */
function widthSafe(s: string): string {
  return s
    .replace(/[\u200D\uFE00-\uFE0F\uFEFF]/g, "")
    .replace(/[\u2600-\u27BF]/g, "*")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "*")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "*");
}

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

    const state: AddOverlayState = {
      mode: "normal",
      searchQuery: "",
      pendingSearch: "",
      filteredServers: [],
      allServers: [],
      selectedIndex: 0,
      scrollOffset: 0,
      editorContent: "{}",
      validationError: null,
      scope,
      saved: false,
      pendingG: false,
      status: "",
    };

    let catalog: CatalogData;
    try {
      catalog = loadCatalog();
      state.allServers = catalog.servers;
      state.filteredServers = catalog.servers;
    } catch {
      catalog = { lastUpdated: "", source: "", totalServers: 0, servers: [] };
    }

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
    let lastListHeight = 12;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function setStatus(msg: string) {
      state.status = msg;
      // Auto-clear status after a few renders by using a timer
      setTimeout(() => {
        if (state.status === msg) {
          state.status = "";
          refresh();
        }
      }, 1500);
    }

    function ensureVisible() {
      const h = lastListHeight;
      if (state.selectedIndex < state.scrollOffset) {
        state.scrollOffset = state.selectedIndex;
      } else if (state.selectedIndex >= state.scrollOffset + h) {
        state.scrollOffset = state.selectedIndex - h + 1;
      }
      const max = Math.max(0, state.filteredServers.length - h);
      if (state.scrollOffset > max) state.scrollOffset = max;
      if (state.scrollOffset < 0) state.scrollOffset = 0;
    }

    function applySearch(query: string) {
      state.searchQuery = query;
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
      state.scrollOffset = 0;
    }

    function loadSelectedIntoEditor() {
      if (state.selectedIndex < 0 || state.selectedIndex >= state.filteredServers.length) return;
      const server = state.filteredServers[state.selectedIndex];
      state.editorContent = generateConfigTemplate(server);
      editor.setText(state.editorContent);
      state.validationError = null;
    }

    function validateAndSave(): boolean {
      try {
        const parsed = JSON.parse(state.editorContent);
        const validation = validateMcpConfig(parsed);
        if (!validation.valid) {
          state.validationError = validation.errors[0];
          return false;
        }
        const configDir = getGlobalConfigDir();
        let existing: McpConfig;
        try {
          existing = loadMcpConfig(configDir);
        } catch {
          existing = { ...DEFAULT_MCP_CONFIG };
        }
        const newServers = parsed.mcpServers ?? {};
        for (const [name, def] of Object.entries(newServers)) {
          existing.mcpServers[name] = def as any;
        }
        saveMcpConfig(configDir, existing);

        let meta: McpMetadata;
        try {
          meta = loadMetadata(configDir);
        } catch {
          meta = { ...DEFAULT_METADATA, servers: {}, sync: { ...DEFAULT_METADATA.sync } };
        }
        for (const name of Object.keys(newServers)) {
          meta.servers[name] = { enabled: true, addedAt: new Date().toISOString() };
        }
        saveMetadata(configDir, meta);

        state.saved = true;
        state.validationError = null;
        return true;
      } catch (err) {
        state.validationError = err instanceof Error ? err.message : "Invalid JSON";
        return false;
      }
    }

    // ─── Input handling ───────────────────────────────────────────────

    function handleEditorMode(data: string) {
      if (matchesKey(data, Key.escape)) {
        state.mode = "normal";
        state.validationError = null;
        refresh();
        return;
      }
      // Ctrl+S to save
      if (data === "\x13") {
        if (validateAndSave()) {
          done({ saved: true });
          params?.onComplete?.();
        } else {
          refresh();
        }
        return;
      }
      // Delegate everything else to the editor
      editor.handleInput(data);
      state.editorContent = editor.getText();
      refresh();
    }

    function handleSearchMode(data: string) {
      if (matchesKey(data, Key.escape)) {
        // Cancel search — restore previous query
        applySearch(state.searchQuery);
        state.pendingSearch = state.searchQuery;
        state.mode = "normal";
        refresh();
        return;
      }
      if (data === "\r" || data === "\n") {
        // Accept search
        applySearch(state.pendingSearch);
        state.mode = "normal";
        refresh();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (state.pendingSearch.length > 0) {
          state.pendingSearch = state.pendingSearch.slice(0, -1);
          applySearch(state.pendingSearch);
          refresh();
        }
        return;
      }
      // Regular printable input
      if (data.length === 1 && data >= " ") {
        state.pendingSearch += data;
        applySearch(state.pendingSearch);
        refresh();
        return;
      }
    }

    function handleNormalMode(data: string) {
      // Close
      if (matchesKey(data, Key.escape) || data === "q") {
        done(null);
        return;
      }

      const listLen = state.filteredServers.length;
      const half = Math.max(1, Math.floor(lastListHeight / 2));

      // Movement
      if (matchesKey(data, Key.down) || data === "j") {
        if (state.selectedIndex < listLen - 1) {
          state.selectedIndex++;
          ensureVisible();
          refresh();
        }
        state.pendingG = false;
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        if (state.selectedIndex > 0) {
          state.selectedIndex--;
          ensureVisible();
          refresh();
        }
        state.pendingG = false;
        return;
      }
      // gg → top, G → bottom
      if (data === "g") {
        if (state.pendingG) {
          state.selectedIndex = 0;
          state.scrollOffset = 0;
          state.pendingG = false;
          refresh();
        } else {
          state.pendingG = true;
        }
        return;
      }
      if (data === "G") {
        state.selectedIndex = Math.max(0, listLen - 1);
        ensureVisible();
        state.pendingG = false;
        refresh();
        return;
      }
      // Ctrl+d / Ctrl+u — half-page
      if (data === "\x04") {
        state.selectedIndex = Math.min(listLen - 1, state.selectedIndex + half);
        ensureVisible();
        state.pendingG = false;
        refresh();
        return;
      }
      if (data === "\x15") {
        state.selectedIndex = Math.max(0, state.selectedIndex - half);
        ensureVisible();
        state.pendingG = false;
        refresh();
        return;
      }
      // PageDown / PageUp
      if (data === "\x1b[6~") {
        state.selectedIndex = Math.min(listLen - 1, state.selectedIndex + lastListHeight);
        ensureVisible();
        refresh();
        return;
      }
      if (data === "\x1b[5~") {
        state.selectedIndex = Math.max(0, state.selectedIndex - lastListHeight);
        ensureVisible();
        refresh();
        return;
      }

      state.pendingG = false;

      // Search
      if (data === "/") {
        state.mode = "search";
        state.pendingSearch = state.searchQuery;
        refresh();
        return;
      }

      // Enter or l/Tab → load into editor and switch focus
      if (data === "\r" || data === "\n") {
        loadSelectedIntoEditor();
        state.mode = "editor";
        refresh();
        return;
      }
      if (data === "l" || data === "\t") {
        if (state.editorContent.trim() === "{}") loadSelectedIntoEditor();
        state.mode = "editor";
        refresh();
        return;
      }

      // c → custom JSON skeleton
      if (data === "c") {
        state.editorContent = JSON.stringify(
          { mcpServers: { "": { command: "", args: [], env: {} } } },
          null,
          2,
        );
        editor.setText(state.editorContent);
        state.mode = "editor";
        refresh();
        return;
      }

      // ? → show help (status flash)
      if (data === "?") {
        setStatus("j/k=move · gg/G=top/bot · Ctrl+d/u=half-page · /=search · Enter=edit · q=quit");
        refresh();
        return;
      }
    }

    function handleInput(data: string) {
      if (state.mode === "editor") return handleEditorMode(data);
      if (state.mode === "search") return handleSearchMode(data);
      return handleNormalMode(data);
    }

    // ─── Rendering ────────────────────────────────────────────────────

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const innerWidth = Math.max(40, width - 2);

      // Pane widths: account for left │, middle │, right │ borders
      const leftW = Math.floor((innerWidth - 1) / 2);
      const rightW = innerWidth - 1 - leftW;

      const browseFocused = state.mode !== "editor";
      const editorFocused = state.mode === "editor";

      // Border + active-pane accent helpers
      const border = (s: string) => theme.fg("accent", s);
      const dimBorder = (s: string) => theme.fg("muted", s);

      // ── Top header ──────────────────────────────────────────────────
      const title = " Add MCP Server ";
      const modeTag =
        state.mode === "search"
          ? "[SEARCH]"
          : state.mode === "editor"
            ? "[EDITOR]"
            : "[NORMAL]";
      const headerPad = Math.max(0, innerWidth - visibleWidth(title) - visibleWidth(modeTag));
      lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
      lines.push(
        border("│") +
          theme.bold(title) +
          " ".repeat(headerPad) +
          theme.fg("accent", modeTag) +
          border("│"),
      );

      // Pane headers row: ├──── search bar ────┬──── Config Editor ────┤
      lines.push(
        border("├") +
          border("─".repeat(leftW)) +
          border("┬") +
          border("─".repeat(rightW)) +
          border("┤"),
      );

      // Search bar / list header on left, editor title on right
      const searchBar = (() => {
        if (state.mode === "search") {
          const cursor = state.pendingSearch.length > 0 ? "" : "█";
          return ` ${theme.fg("accent", "/")}${theme.fg("text", state.pendingSearch)}${theme.fg("accent", cursor)}`;
        }
        if (state.searchQuery) return ` ${theme.fg("muted", "/")}${theme.fg("text", state.searchQuery)}`;
        return ` ${theme.fg("muted", "/ press / to search")}`;
      })();

      const editorHeader = editorFocused
        ? theme.bold(theme.fg("accent", " Config Editor "))
        : theme.fg("muted", " Config Editor ");

      const total = state.allServers.length;
      const shown = state.filteredServers.length;
      const counter =
        shown < total
          ? theme.fg("dim", `${shown}/${total} `)
          : theme.fg("dim", `${total} `);
      const leftHeaderRight = padVisible(searchBar, leftW - visibleWidth(counter)) + counter;

      lines.push(
        border("│") +
          padVisible(leftHeaderRight, leftW) +
          (browseFocused ? border("│") : dimBorder("│")) +
          padVisible(editorHeader, rightW) +
          border("│"),
      );

      lines.push(
        border("├") +
          border("─".repeat(leftW)) +
          border("┼") +
          border("─".repeat(rightW)) +
          border("┤"),
      );

      // ── List + editor body ─────────────────────────────────────────
      const LIST_HEIGHT = 14;
      lastListHeight = LIST_HEIGHT;
      ensureVisible();

      // Drive the real Editor: focus reflects mode, render gives lines that
      // already contain the reverse-video cursor when focused. We strip the
      // editor's top/bottom horizontal borders since our pane has its own.
      editor.focused = editorFocused;
      const editorRendered: string[] = (() => {
        try {
          return editor.render(rightW);
        } catch {
          return [];
        }
      })();
      const editorBody =
        editorRendered.length >= 2
          ? editorRendered.slice(1, -1)
          : editorRendered;

      for (let row = 0; row < LIST_HEIGHT; row++) {
        // Left: server list
        let left = "";
        const serverIdx = state.scrollOffset + row;
        if (serverIdx < state.filteredServers.length) {
          const server = state.filteredServers[serverIdx];
          const selected = serverIdx === state.selectedIndex;
          const scopeTag = server.scope === "cloud" ? "[c]" : "[l]";
          const officialMark = server.official ? theme.fg("success", "*") : " ";
          const prefix = selected
            ? (browseFocused ? theme.fg("accent", "> ") : theme.fg("muted", "> "))
            : "  ";
          // Reserved cells: " " + prefix(2) + officialMark(1) + " " + scopeTag(3) + " " = 8
          const nameRaw = widthSafe(truncateToWidth(server.name, leftW - 8));
          const scope = server.scope === "cloud"
            ? theme.fg("accent", scopeTag)
            : theme.fg("warning", scopeTag);
          const name = selected
            ? (browseFocused ? theme.bold(theme.fg("accent", nameRaw)) : theme.bold(nameRaw))
            : theme.fg("text", nameRaw);
          left = ` ${prefix}${officialMark} ${scope} ${name}`;
        } else if (state.filteredServers.length === 0 && row === 1) {
          left = ` ${theme.fg("warning", "no matches")}`;
        }

        // Right: editor content (lines already contain cursor + ANSI)
        let right = "";
        if (row < editorBody.length) {
          right = editorBody[row];
        }

        const midBorder = browseFocused && !editorFocused ? border("│") : dimBorder("│");
        lines.push(
          (browseFocused ? border("│") : dimBorder("│")) +
            padVisible(left, leftW) +
            midBorder +
            padVisible(right, rightW) +
            (editorFocused ? border("│") : dimBorder("│")),
        );
      }

      // ── Description / status row ──────────────────────────────────
      lines.push(
        border("├") +
          border("─".repeat(leftW)) +
          border("┴") +
          border("─".repeat(rightW)) +
          border("┤"),
      );

      const sel = state.filteredServers[state.selectedIndex];
      let descContent: string;
      if (sel) {
        const idSafe = widthSafe(sel.id);
        const idVis = visibleWidth(idSafe);
        const descBudget = Math.max(0, innerWidth - idVis - 4);
        const descSafe = widthSafe(sel.description);
        const desc = truncateToWidth(descSafe, descBudget);
        descContent = ` ${theme.fg("accent", idSafe)}  ${theme.fg("muted", desc)}`;
      } else {
        descContent = ` ${theme.fg("dim", "no server selected")}`;
      }
      lines.push(border("│") + padVisible(descContent, innerWidth) + border("│"));

      // ── Validation error ───────────────────────────────────────────
      if (state.validationError) {
        const errText = ` ⚠ ${truncateToWidth(state.validationError, innerWidth - 4)}`;
        lines.push(border("│") + padVisible(theme.fg("error", errText), innerWidth) + border("│"));
      }

      // ── Status line ────────────────────────────────────────────────
      if (state.status) {
        lines.push(
          border("│") +
            padVisible(` ${theme.fg("warning", state.status)}`, innerWidth) +
            border("│"),
        );
      }

      // ── Footer ─────────────────────────────────────────────────────
      lines.push(border(`├${"─".repeat(innerWidth)}┤`));
      const scopeLabel = state.scope === "global" ? "● Global" : "● Project";
      lines.push(
        border("│") +
          padVisible(theme.fg("muted", ` ${scopeLabel}`), innerWidth) +
          border("│"),
      );

      const binds =
        state.mode === "editor"
          ? " Ctrl+S save · Esc back · Tab pane "
          : state.mode === "search"
            ? " Type to filter · Enter accept · Esc cancel "
            : " j/k move · gg/G top/bot · Ctrl+d/u page · / search · Enter edit · c custom · q close ";
      lines.push(
        border("│") +
          padVisible(theme.fg("muted", truncateToWidth(binds, innerWidth)), innerWidth) +
          border("│"),
      );
      lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

      cachedLines = lines;
      return lines;
    }

    return { render, invalidate: refresh, handleInput };
  };
}
