/**
 * @pi-unipi/ask-user — TUI Components
 *
 * Interactive UI for single-select, multi-select, and freeform input.
 * Uses ctx.ui.custom() callback pattern following question.ts/questionnaire.ts.
 */

import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
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
  tui: any,
  theme: any,
  kb: any,
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
    let cachedLines: string[] | undefined;
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
      cachedLines = undefined;
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
        if (opt.isFreeform) {
          // Freeform option: toggle and enter edit mode if checking
          if (selected.has(val)) {
            // Unchecking: clear custom text
            selected.delete(val);
            customText = null;
          } else {
            // Checking: enter edit mode to get custom text
            selected.add(val);
            if (!customText) {
              editMode = true;
              editTarget = "freeform";
              editor.setText("");
            }
          }
        } else if (opt.allowCustom) {
          // allowCustom option: toggle and enter edit mode if checking
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

        if (opt.isFreeform) {
          // Freeform option: if already checked with text, submit; otherwise enter edit mode
          if (selected.has(opt.value) && customText) {
            // Already checked with text: submit the form
            cleanup();
            const regularSelections = Array.from(selected).filter(v => v !== "__freeform__");
            if (regularSelections.length > 0) {
              done({
                response: {
                  kind: "combined",
                  selections: regularSelections,
                  text: customText,
                },
              });
            } else {
              done({
                response: {
                  kind: "freeform",
                  text: customText,
                },
              });
            }
          } else {
            // Not checked or no text: check it and enter edit mode
            selected.add(opt.value);
            editMode = true;
            editTarget = "freeform";
            editor.setText("");
          }
          refresh();
          return;
        }

        if (allowMultiple) {
          // In multi-select, Enter submits current selection
          if (selected.size > 0) {
            cleanup();
            if (customText && selected.has("__freeform__")) {
              // Combined response with custom text
              const regularSelections = Array.from(selected).filter(v => v !== "__freeform__");
              done({
                response: {
                  kind: "combined",
                  selections: regularSelections,
                  text: customText,
                },
              });
            } else {
              // Regular selection — include any per-option custom texts
              const selections = Array.from(selected);
              const combinedTexts: string[] = [];
              for (const sel of selections) {
                const txt = optionCustomTexts.get(sel);
                if (txt) combinedTexts.push(`${sel}: ${txt}`);
              }
              if (combinedTexts.length > 0) {
                done({
                  response: {
                    kind: "combined",
                    selections,
                    text: combinedTexts.join("\n"),
                  },
                });
              } else {
                done({
                  response: {
                    kind: "selection",
                    selections,
                  },
                });
              }
            }
          }
          return;
        }

        // Single-select: check if option has allowCustom
        if (opt.allowCustom) {
          const existing = getOptionCustomText(optionIndex);
          if (existing) {
            // Already has custom text: submit as combined
            cleanup();
            done({
              response: {
                kind: "combined",
                selections: [opt.value],
                text: existing,
              },
            });
          } else {
            // Enter edit mode for this option
            editMode = true;
            editTarget = optionIndex;
            editor.setText("");
            refresh();
          }
          return;
        }

        // Single-select without allowCustom: return immediately
        cleanup();
        done({
          response: {
            kind: "selection",
            selections: [opt.value],
          },
        });
        return;
      }

      // Escape: cancel
      if (matchesKey(data, Key.escape)) {
        cleanup();
        done(null);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));

      // Context
      if (context) {
        add(theme.fg("muted", ` ${context}`));
        lines.push("");
      }

      // Question
      add(theme.fg("text", ` ${question}`));
      lines.push("");

      // Options (editor is now inline with freeform option)
      renderOptions(lines, add, theme, width);

      // Timeout countdown
      if (timeout && remainingMs !== undefined && remainingMs > 0) {
        lines.push("");
        const secs = Math.ceil(remainingMs / 1000);
        add(theme.fg("dim", ` ⏱ ${secs}s remaining`));
      }

      lines.push("");
      if (editMode) {
        add(theme.fg("dim", " Enter to confirm text • Esc to cancel text input"));
      } else if (allowMultiple) {
        // Check if current option has allowCustom
        const currentOpt = displayOptions[optionIndex];
        const hasCustom = currentOpt?.allowCustom && !optionCustomTexts.get(currentOpt.value);
        const base = " ↑↓ navigate • Space toggle • Enter submit • Esc cancel";
        const customHint = hasCustom ? " • Space to add note" : "";
        add(theme.fg("dim", base + customHint));
      } else {
        // Check if current option has allowCustom
        const currentOpt = displayOptions[optionIndex];
        const hasCustom = currentOpt?.allowCustom && !optionCustomTexts.get(currentOpt.value);
        if (hasCustom) {
          add(theme.fg("dim", " ↑↓ navigate • Enter to add note • Esc cancel"));
        } else {
          add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
        }
      }
      add(theme.fg("accent", "─".repeat(width)));

      cachedLines = lines;
      return lines;
    }

    function renderOptions(
      lines: string[],
      add: (s: string) => void,
      theme: any,
      width: number,
    ) {
      for (let i = 0; i < displayOptions.length; i++) {
        const opt = displayOptions[i];
        const isSelected = i === optionIndex;
        const prefix = isSelected ? theme.fg("> ", "accent") : "  ";

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
          
          add(
            prefix +
              theme.fg(color, `[${box}]`) +
              " " +
              theme.fg(isSelected ? "accent" : "text", label),
          );
          
          // Show edit indicator if in edit mode for this option
          if (editMode && editTarget === "freeform" && isSelected) {
            add(`   ${theme.fg("muted", "Type your response:")}`);
            for (const line of editor.render(width - 4)) {
              add(`   ${line}`);
            }
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
          
          add(
            prefix +
              theme.fg(color, `[${box}]`) +
              " " +
              theme.fg(isSelected ? "accent" : "text", label),
          );
          
          // Show edit indicator if in edit mode for this option
          if (editMode && editTarget === i && isSelected) {
            add(`   ${theme.fg("muted", "Type your response:")}`);
            for (const line of editor.render(width - 4)) {
              add(`   ${line}`);
            }
          }
        } else {
          // Single-select: option
          let label = opt.label;
          const optCustom = optionCustomTexts.get(opt.value);
          if (optCustom) {
            label = `${opt.label}: "${optCustom}"`;
          }
          
          // Show allowCustom indicator
          if (opt.allowCustom && !optCustom) {
            label += theme.fg("dim", " (add note)");
          }
          
          add(
            prefix +
              (isSelected
                ? theme.fg("accent", label)
                : theme.fg("text", label)),
          );
          
          // Show edit indicator if in edit mode for this option
          if (editMode && editTarget === i && isSelected) {
            add(`   ${theme.fg("muted", "Type your response:")}`);
            for (const line of editor.render(width - 4)) {
              add(`   ${line}`);
            }
          }
        }

        // Description
        if (opt.description) {
          add(`     ${theme.fg("muted", opt.description)}`);
        }
      }
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  };
}

/**
 * Create a renderCall function for the ask_user tool.
 */
export function createRenderCall() {
  return (args: any, theme: any, _context: any) => {
    const question = args.question || "";
    const options = Array.isArray(args.options) ? args.options : [];
    const mode = args.allowMultiple ? "multi-select" : "single-select";
    const count = options.length;

    let text =
      theme.fg("toolTitle", theme.bold("ask_user ")) +
      theme.fg("muted", question);
    if (count > 0) {
      text += theme.fg("dim", ` (${count} option${count !== 1 ? "s" : ""}, ${mode})`);
    }
    return new Text(text, 0, 0);
  };
}

/**
 * Create a renderResult function for the ask_user tool.
 */
export function createRenderResult() {
  return (result: any, _options: any, theme: any, _context: any) => {
    const details = result.details;
    if (!details) {
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : "", 0, 0);
    }

    const response = details.response as AskUserResponse;
    if (!response) {
      return new Text(theme.fg("warning", "No response"), 0, 0);
    }

    switch (response.kind) {
      case "cancelled":
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      case "timed_out":
        return new Text(theme.fg("warning", "Timed out"), 0, 0);
      case "freeform":
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", response.text || ""),
          0,
          0,
        );
      case "selection": {
        const selections = response.selections || [];
        const display =
          selections.length === 1
            ? selections[0]
            : selections.join(", ");
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("accent", display),
          0,
          0,
        );
      }
      case "combined": {
        const selections = response.selections || [];
        const selDisplay = selections.length === 1
          ? selections[0]
          : selections.join(", ");
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("accent", selDisplay) +
            theme.fg("muted", " and wrote ") +
            theme.fg("accent", response.text || ""),
          0,
          0,
        );
      }
      default:
        return new Text(
          theme.fg("text", JSON.stringify(response)),
          0,
          0,
        );
    }
  };
}
