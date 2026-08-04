/**
 * @pi-unipi/ask-user — TUI Components
 *
 * Interactive UI for single-select, multi-select, and freeform input.
 * Uses ctx.ui.custom() callback pattern following question.ts/questionnaire.ts.
 */

import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { adaptiveInnerWidth, contentWidth, normalizeWidth, safeRepeat, shouldRenderBorder, WidthKeyedCache } from "@pi-unipi/core";
import type { NormalizedOption, AskUserResponse } from "./types.js";

/** Result returned by the ask UI */
export interface AskUIResult {
  response: AskUserResponse;
}

/**
 * Render the ask_user interactive UI.
 *
 * Supports:
 * - Single-select: arrow keys + Enter
 * - Multi-select: Space to toggle, Enter to submit
 * - Freeform: text input via Editor
 * - Timeout: auto-dismiss after N ms
 * - Cancel: Escape key
 */
export function renderAskUI(params: {
  question: string;
  context?: string;
  options: NormalizedOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  timeout?: number;
}): (
  tui: TUI,
  theme: Theme,
  kb: import("@earendil-works/pi-coding-agent").KeybindingsManager,
  done: (result: AskUIResult | null) => void,
) => {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
} {
  return (tui, theme, _kb, done) => {
    const { question, context, options, allowMultiple, allowFreeform, timeout } = params;

    // Build display options — add "Custom response" if allowFreeform
    const displayOptions: (NormalizedOption & { isFreeform?: boolean })[] = [
      ...options,
    ];
    if (allowFreeform) {
      displayOptions.push({
        label: "Custom response",
        value: "__freeform__",
        isFreeform: true,
      });
    }

    // State
    let optionIndex = 0;
    let editMode = false;
    let editTarget: "freeform" | number = "freeform"; // which option is being edited
    // Width-keyed so a terminal resize can never serve stale, over-wide lines.
    const lineCache = new WidthKeyedCache();
    const selected = new Set<string>();
    let customText: string | null = null; // Store custom text (global freeform)
    const optionCustomTexts = new Map<string, string>(); // Per-option custom text for allowCustom
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let remainingMs = timeout;

    // Editor for freeform input
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

    function getOptionCustomText(optIndex: number): string | null {
      const opt = displayOptions[optIndex];
      return optionCustomTexts.get(opt.value) ?? null;
    }

    function setOptionCustomText(optIndex: number, text: string | null) {
      const opt = displayOptions[optIndex];
      if (text) {
        optionCustomTexts.set(opt.value, text);
      } else {
        optionCustomTexts.delete(opt.value);
      }
    }

    /** Get effective action for an option (allowCustom maps to input) */
    function getAction(opt: NormalizedOption & { isFreeform?: boolean }): string {
      if (opt.isFreeform) return "freeform";
      if (opt.action && opt.action !== "select") return opt.action;
      if (opt.allowCustom) return "input";
      return "select";
    }

    editor.onSubmit = (value: string) => {
      const trimmed = value.trim();
      if (editTarget === "freeform") {
        // Global freeform input
        if (trimmed) {
          customText = trimmed;
          editMode = false;
          editor.setText("");
          refresh();
        } else {
          // If empty and no previous custom text, uncheck freeform option
          if (!customText) {
            selected.delete("__freeform__");
          }
          editMode = false;
          editor.setText("");
          refresh();
        }
      } else {
        // Per-option custom input (allowCustom)
        if (trimmed) {
          setOptionCustomText(editTarget, trimmed);
          editMode = false;
          editor.setText("");
          // Auto-submit in single-select mode
          if (!allowMultiple) {
            cleanup();
            const opt = displayOptions[editTarget];
            done({
              response: {
                kind: "combined",
                selections: [opt.value],
                text: trimmed,
              },
            });
            return;
          }
          refresh();
        } else {
          // Empty: cancel edit mode, keep option selected but without custom text
          editMode = false;
          editor.setText("");
          refresh();
        }
      }
    };

    function cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    }

    function refresh() {
      lineCache.clear();
      tui.requestRender();
    }

    // Setup timeout if specified
    if (timeout && timeout > 0) {
      remainingMs = timeout;
      const startTime = Date.now();
      const tickInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        remainingMs = Math.max(0, timeout - elapsed);
        refresh();
        if (remainingMs <= 0) {
          clearInterval(tickInterval);
        }
      }, 1000);

      timeoutId = setTimeout(() => {
        clearInterval(tickInterval);
        cleanup();
        done({
          response: {
            kind: "timed_out",
            comment: `Timed out after ${timeout}ms`,
          },
        });
      }, timeout);
    }

    function handleInput(data: string) {
      // Edit mode: route to editor
      if (editMode) {
        if (matchesKey(data, Key.escape)) {
          // Cancel text input
          if (editTarget === "freeform") {
            // Global freeform: uncheck if no previous text
            if (!customText) {
              selected.delete("__freeform__");
            }
          }
          // For per-option: just cancel edit, keep option selected
          editMode = false;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      // Navigation
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(displayOptions.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      // Multi-select: Space to toggle
      if (allowMultiple && matchesKey(data, Key.space)) {
        const opt = displayOptions[optionIndex];
        const val = opt.value;
        const action = getAction(opt);

        if (action === "freeform") {
          // Freeform option: toggle and enter edit mode if checking
          if (selected.has(val)) {
            selected.delete(val);
            customText = null;
          } else {
            selected.add(val);
            if (!customText) {
              editMode = true;
              editTarget = "freeform";
              editor.setText("");
            }
          }
        } else if (action === "end_turn") {
          // End turn: immediate
          cleanup();
          done({ response: { kind: "end_turn", selections: [val] } });
          return;
        } else if (action === "new_session") {
          // New session: immediate
          cleanup();
          done({ response: { kind: "new_session", selections: [val], prefill: opt.prefill } });
          return;
        } else if (action === "input") {
          // Input action: toggle and enter edit mode if checking
          if (selected.has(val)) {
            selected.delete(val);
            optionCustomTexts.delete(val);
          } else {
            selected.add(val);
            if (!getOptionCustomText(optionIndex)) {
              editMode = true;
              editTarget = optionIndex;
              editor.setText("");
            }
          }
        } else {
          // Regular option: toggle
          if (selected.has(val)) {
            selected.delete(val);
          } else {
            selected.add(val);
          }
        }
        refresh();
        return;
      }

      // Enter: select or submit
      if (matchesKey(data, Key.enter)) {
        const opt = displayOptions[optionIndex];
        const action = getAction(opt);

        if (action === "freeform") {
          // Freeform option: if already checked with text, submit; otherwise enter edit mode
          if (selected.has(opt.value) && customText) {
            cleanup();
            const regularSelections = Array.from(selected).filter(v => v !== "__freeform__");
            if (regularSelections.length > 0) {
              done({ response: { kind: "combined", selections: regularSelections, text: customText } });
            } else {
              done({ response: { kind: "freeform", text: customText } });
            }
          } else {
            selected.add(opt.value);
            editMode = true;
            editTarget = "freeform";
            editor.setText("");
          }
          refresh();
          return;
        }

        if (action === "end_turn") {
          cleanup();
          done({ response: { kind: "end_turn", selections: [opt.value] } });
          return;
        }

        if (action === "new_session") {
          cleanup();
          done({ response: { kind: "new_session", selections: [opt.value], prefill: opt.prefill } });
          return;
        }

        if (allowMultiple) {
          // In multi-select, Enter submits current selection
          if (selected.size > 0) {
            cleanup();
            if (customText && selected.has("__freeform__")) {
              const regularSelections = Array.from(selected).filter(v => v !== "__freeform__");
              done({ response: { kind: "combined", selections: regularSelections, text: customText } });
            } else {
              const selections = Array.from(selected);
              const combinedTexts: string[] = [];
              for (const sel of selections) {
                const txt = optionCustomTexts.get(sel);
                if (txt) combinedTexts.push(`${sel}: ${txt}`);
              }
              if (combinedTexts.length > 0) {
                done({ response: { kind: "combined", selections, text: combinedTexts.join("\n") } });
              } else {
                done({ response: { kind: "selection", selections } });
              }
            }
          }
          return;
        }

        // Single-select: check if option has input action
        if (action === "input") {
          const existing = getOptionCustomText(optionIndex);
          if (existing) {
            cleanup();
            done({ response: { kind: "combined", selections: [opt.value], text: existing } });
          } else {
            editMode = true;
            editTarget = optionIndex;
            editor.setText("");
            refresh();
          }
          return;
        }

        // Single-select without special action: return immediately
        cleanup();
        done({ response: { kind: "selection", selections: [opt.value] } });
        return;
      }

      // Escape: cancel
      if (matchesKey(data, Key.escape)) {
        cleanup();
        done(null);
      }
    }

    function render(rawWidth: number): string[] {
      const width = normalizeWidth(rawWidth);
      const cached = lineCache.get(width);
      if (cached) return cached;

      const lines: string[] = [];
      // Never exceed the terminal width — pi-tui throws on over-wide lines.
      // On very narrow terminals the box border is dropped so the little
      // width available all goes to content.
      const innerWidth = adaptiveInnerWidth(width);
      const bordered = shouldRenderBorder(width);
      const border = (s: string) => theme.fg("accent", s);

      function padVisible(content: string, targetWidth: number): string {
        const vw = visibleWidth(content);
        return content + safeRepeat(" ", targetWidth - vw);
      }

      const frame = (content: string) => {
        const body = padVisible(truncateToWidth(content, innerWidth), innerWidth);
        return bordered ? border("│") + body + border("│") : body;
      };

      const add = (s: string) => lines.push(frame(s));
      const addWrapped = (s: string) => {
        for (const line of wrapTextWithAnsi(s, innerWidth)) {
          lines.push(frame(line));
        }
      };
      const addEmpty = () => lines.push(frame(""));

      // Top border
      if (bordered) lines.push(border(`╭${safeRepeat("─", innerWidth)}╮`));

      // Context
      if (context) {
        addWrapped(theme.fg("muted", ` ${context}`));
        addEmpty();
      }

      // Question
      addWrapped(theme.fg("text", ` ${question}`));
      addEmpty();

      // Options (editor is now inline with freeform option)
      renderOptions(lines, add, theme, innerWidth);

      // Timeout countdown
      if (timeout && remainingMs !== undefined && remainingMs > 0) {
        addEmpty();
        const secs = Math.ceil(remainingMs / 1000);
        add(theme.fg("dim", ` ⏱ ${secs}s remaining`));
      }

      addEmpty();
      if (editMode) {
        add(theme.fg("dim", " Enter to confirm text • Esc to cancel text input"));
      } else if (allowMultiple) {
        const currentOpt = displayOptions[optionIndex];
        const action = currentOpt ? getAction(currentOpt) : "select";
        const base = " ↑↓ navigate • Space toggle • Enter submit • Esc cancel";
        let hint = "";
        if (action === "input" && !optionCustomTexts.get(currentOpt.value)) {
          hint = " • Space to add note";
        } else if (action === "end_turn") {
          hint = " • Space to end turn";
        } else if (action === "new_session") {
          hint = " • Space to start new session";
        }
        add(theme.fg("dim", base + hint));
      } else {
        const currentOpt = displayOptions[optionIndex];
        const action = currentOpt ? getAction(currentOpt) : "select";
        if (action === "input" && !optionCustomTexts.get(currentOpt.value)) {
          add(theme.fg("dim", " ↑↓ navigate • Enter to add note • Esc cancel"));
        } else if (action === "end_turn") {
          add(theme.fg("dim", " ↑↓ navigate • Enter to end turn • Esc cancel"));
        } else if (action === "new_session") {
          add(theme.fg("dim", " ↑↓ navigate • Enter to start new session • Esc cancel"));
        } else {
          add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
        }
      }

      // Bottom border
      if (bordered) lines.push(border(`╰${safeRepeat("─", innerWidth)}╯`));

      return lineCache.set(width, lines);
    }

    function renderOptions(
      lines: string[],
      add: (s: string) => void,
      theme: Theme,
      width: number,
    ) {
      const addWrappedOptionLine = (prefix: string, content: string) => {
        const prefixWidth = visibleWidth(prefix);
        const wrapWidth = contentWidth(width, prefixWidth);
        const continuationPrefix = safeRepeat(" ", prefixWidth);
        const wrapped = wrapTextWithAnsi(content, wrapWidth);
        for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex++) {
          add((lineIndex === 0 ? prefix : continuationPrefix) + wrapped[lineIndex]);
        }
      };

      // Indent descriptions under the option label, but give up the indent
      // entirely when the terminal is too narrow to afford it.
      const descriptionIndent = safeRepeat(" ", width > 10 ? 5 : 0);
      const addWrappedDescription = (description: string) => {
        addWrappedOptionLine(descriptionIndent, theme.fg("muted", description));
      };

      // Inline editor, inset by 3 columns where there is room for it.
      const editorIndent = safeRepeat(" ", width > 8 ? 3 : 0);
      const addInlineEditor = () => {
        add(`${editorIndent}${theme.fg("muted", "Type your response:")}`);
        for (const line of editor.render(contentWidth(width, visibleWidth(editorIndent) + 1))) {
          add(`${editorIndent}${line}`);
        }
      };

      for (let i = 0; i < displayOptions.length; i++) {
        const opt = displayOptions[i];
        const isSelected = i === optionIndex;
        const prefix = isSelected ? theme.fg("accent", "> ") : "  ";

        if (opt.isFreeform) {
          // Freeform option: show checkbox like regular option
          const checked = selected.has(opt.value);
          const box = checked ? "✓" : " ";
          const color = checked ? "success" : isSelected ? "accent" : "text";
          
          let label = opt.label;
          if (checked && customText) {
            // Show custom text next to label
            label = `${opt.label}: "${customText}"`;
          }
          
          addWrappedOptionLine(
            prefix + theme.fg(color, `[${box}]`) + " ",
            theme.fg(isSelected ? "accent" : "text", label),
          );
          
          // Show edit indicator if in edit mode for this option
          if (editMode && editTarget === "freeform" && isSelected) {
            addInlineEditor();
          }
        } else if (allowMultiple) {
          // Multi-select: show checkbox
          const checked = selected.has(opt.value);
          const box = checked ? "✓" : " ";
          const color = checked ? "success" : isSelected ? "accent" : "text";
          
          let label = opt.label;
          const optCustom = optionCustomTexts.get(opt.value);
          if (optCustom) {
            label = `${opt.label}: "${optCustom}"`;
          }
          
          addWrappedOptionLine(
            prefix + theme.fg(color, `[${box}]`) + " ",
            theme.fg(isSelected ? "accent" : "text", label),
          );
          
          // Show edit indicator if in edit mode for this option
          if (editMode && editTarget === i && isSelected) {
            addInlineEditor();
          }
        } else {
          // Single-select: option
          let label = opt.label;
          const optCustom = optionCustomTexts.get(opt.value);
          if (optCustom) {
            label = `${opt.label}: "${optCustom}"`;
          }
          
          // Show action indicator
          const action = getAction(opt);
          if (action === "input" && !optCustom) {
            label += theme.fg("dim", " (add note)");
          } else if (action === "end_turn") {
            label += theme.fg("dim", " ↵");
          } else if (action === "new_session") {
            label += theme.fg("dim", " ↗");
          }
          
          addWrappedOptionLine(
            prefix,
            isSelected
              ? theme.fg("accent", label)
              : theme.fg("text", label),
          );
          
          // Show edit indicator if in edit mode for this option
          if (editMode && editTarget === i && isSelected) {
            addInlineEditor();
          }
        }

        // Description
        if (opt.description) {
          addWrappedDescription(opt.description);
        }
      }
    }

    return {
      render,
      invalidate: () => {
        lineCache.clear();
      },
      handleInput,
    };
  };
}

/**
 * Create a renderCall function for the ask_user tool.
 */
export function createRenderCall() {
  return (args: Record<string, unknown>, theme: Theme, _context: unknown) => {
    const question = (args.question as string) || "";
    const context = (args.context as string | undefined) || "";
    const options = Array.isArray(args.options)
      ? (args.options as Array<Record<string, unknown>>)
      : [];
    const mode = args.allowMultiple ? "multi-select" : "single-select";
    const allowFreeform = args.allowFreeform !== false;
    const count = options.length;

    const lines: string[] = [];
    lines.push(
      theme.fg("toolTitle", theme.bold("ask_user")) +
        theme.fg("dim", ` (${count} option${count !== 1 ? "s" : ""}, ${mode}${allowFreeform ? ", freeform" : ""})`),
    );
    if (context) {
      lines.push(theme.fg("muted", "Context: ") + theme.fg("text", context));
    }
    lines.push(theme.fg("muted", "Question: ") + theme.fg("text", question));

    if (count > 0) {
      lines.push(theme.fg("muted", "Options:"));
      options.forEach((option, index) => {
        const label = String(option.label ?? option.value ?? `Option ${index + 1}`);
        const action = typeof option.action === "string" && option.action !== "select"
          ? theme.fg("dim", ` [${option.action}]`)
          : "";
        lines.push(
          theme.fg("dim", `  ${index + 1}. `) +
            theme.fg("text", label) +
            action,
        );
        if (typeof option.description === "string" && option.description.trim()) {
          lines.push(theme.fg("muted", `     ${option.description}`));
        }
        if (typeof option.prefill === "string" && option.prefill.trim()) {
          lines.push(theme.fg("dim", `     prefill: ${option.prefill}`));
        }
      });
    }

    return new Text(lines.join("\n"), 0, 0);
  };
}

/**
 * Create a renderResult function for the ask_user tool.
 */
export function createRenderResult() {
  return (result: AgentToolResult<unknown>, options: unknown, theme: Theme, _context: unknown) => {
    const details = result.details as Record<string, unknown> | undefined;
    if (!details) {
      const content = result.content as unknown as Array<Record<string, unknown>> | undefined;
      const text = content?.[0];
      return new Text(text?.type === "text" ? (text.text as string) : "", 0, 0);
    }

    const response = (details as { response: AskUserResponse }).response;
    if (!response) {
      return new Text(theme.fg("warning", "No response"), 0, 0);
    }

    const renderOptionSummary = (): string[] => {
      const rawOptions = (details as { options?: unknown }).options;
      if (!Array.isArray(rawOptions) || rawOptions.length === 0) return [];
      return rawOptions.map((opt, index) => {
        if (typeof opt === "string") {
          return theme.fg("dim", `  ${index + 1}. `) + theme.fg("text", opt);
        }
        const record = opt as Record<string, unknown>;
        const label = String(record.label ?? record.value ?? `Option ${index + 1}`);
        const value = typeof record.value === "string" && record.value !== label
          ? theme.fg("dim", ` (${record.value})`)
          : "";
        const action = typeof record.action === "string" && record.action !== "select"
          ? theme.fg("dim", ` [${record.action}]`)
          : "";
        const description = typeof record.description === "string" && record.description.trim()
          ? `\n${theme.fg("muted", `     ${record.description}`)}`
          : "";
        return theme.fg("dim", `  ${index + 1}. `) + theme.fg("text", label) + value + action + description;
      });
    };

    const answerText = (() => {
      switch (response.kind) {
        case "cancelled":
          return theme.fg("warning", "Cancelled");
        case "timed_out":
          return theme.fg("warning", "Timed out");
        case "freeform":
          return theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", response.text || "");
        case "selection": {
          const selections = response.selections || [];
          const display = selections.length === 1 ? selections[0] : selections.join(", ");
          return theme.fg("success", "✓ ") + theme.fg("accent", display);
        }
        case "combined": {
          const selections = response.selections || [];
          const selDisplay = selections.length === 1
            ? selections[0]
            : selections.join(", ");
          return theme.fg("success", "✓ ") +
            theme.fg("accent", selDisplay) +
            theme.fg("muted", " and wrote ") +
            theme.fg("accent", response.text || "");
        }
        case "end_turn":
          return theme.fg("success", "✓ ") + theme.fg("muted", "end turn");
        case "new_session": {
          const prefill = response.prefill || "";
          if (response.launchStatus === "editor_prefill") {
            const label = response.launchedWith === "compact"
              ? "⚠ compact editor prefill → "
              : "⚠ direct editor prefill → ";
            return theme.fg("warning", label) + theme.fg("accent", prefill);
          }
          if (response.launchStatus === "failed") {
            const label = response.launchedWith === "compact"
              ? "handoff failed (compact) → "
              : "handoff failed (direct) → ";
            return theme.fg("error", label) + theme.fg("accent", prefill);
          }
          if (response.launchedWith === "compact") {
            return theme.fg("success", "✓ queued compact → ") + theme.fg("accent", prefill);
          }
          if (response.launchedWith === "direct") {
            return theme.fg("success", "✓ queued direct → ") + theme.fg("accent", prefill);
          }
          return theme.fg("success", "✓ ") +
            theme.fg("muted", "new session") +
            (prefill ? theme.fg("accent", `: ${prefill}`) : "");
        }
        default:
          return theme.fg("text", JSON.stringify(response));
      }
    })();

    const expanded = typeof options === "object" && options !== null && "expanded" in options
      ? Boolean((options as { expanded?: boolean }).expanded)
      : false;
    if (!expanded) {
      const question = typeof (details as { question?: unknown }).question === "string"
        ? (details as { question: string }).question
        : "";
      const expandHint = question
        ? theme.fg("dim", "  · Ctrl+O question/options")
        : "";
      return new Text(answerText + expandHint, 0, 0);
    }

    const lines = [answerText];
    const question = (details as { question?: unknown }).question;
    const context = (details as { context?: unknown }).context;
    if (typeof question === "string" && question.trim()) {
      lines.push(theme.fg("muted", "Question: ") + theme.fg("text", question));
    }
    if (typeof context === "string" && context.trim()) {
      lines.push(theme.fg("muted", "Context: ") + theme.fg("text", context));
    }
    const optionLines = renderOptionSummary();
    if (optionLines.length > 0) {
      lines.push(theme.fg("muted", "Options:"), ...optionLines);
    }
    return new Text(lines.join("\n"), 0, 0);
  };
}
