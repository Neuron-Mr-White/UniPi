/**
 * @unipi/ralph — Argument completions for /unipi:ralph
 *
 * Pure, testable completion builder. index.ts wires it into
 * registerCommand via getArgumentCompletions.
 *
 * NOTE: pi passes the ENTIRE argument text (everything after the command
 * name, up to the cursor) and replaces ALL of it with item.value on accept.
 * Nested suggestions must therefore return the full replacement string,
 * e.g. "resume myloop" or "start mytask --max-iterations".
 */

import { RALPH_STATUS_ICONS } from "@pi-unipi/core";
import type { LoopStatus } from "./ralph-loop.js";

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/** Minimal loop shape the completion builder needs. */
export interface LoopSummary {
  name: string;
  status: LoopStatus;
  iteration: number;
  maxIterations: number;
}

/** Subcommands, shown when no subcommand has been typed yet. */
const SUBCOMMANDS: CompletionItem[] = [
  { value: "start", label: "start", description: "Start a new loop" },
  { value: "stop", label: "stop", description: "Stop the current loop" },
  { value: "resume", label: "resume", description: "Resume a paused loop" },
  { value: "status", label: "status", description: "Show all loops" },
  { value: "list", label: "list", description: "Show loops (--archived for archived)" },
  { value: "cancel", label: "cancel", description: "Delete loop state" },
  { value: "archive", label: "archive", description: "Move a loop to the archive" },
  {
    value: "clean",
    label: "clean",
    description: "Clean completed loops (--all also deletes task files)",
  },
  { value: "nuke", label: "nuke", description: "Delete all ralph data (--yes skips confirm)" },
];

/** Flags accepted by `start` that take a numeric value. */
const START_VALUE_FLAGS = ["--max-iterations", "--items-per-iteration", "--reflect-every"];

const START_FLAGS: CompletionItem[] = [
  {
    value: "--max-iterations",
    label: "--max-iterations",
    description: "Stop after N iterations (default 50)",
  },
  {
    value: "--items-per-iteration",
    label: "--items-per-iteration",
    description: "Process N items per iteration",
  },
  {
    value: "--reflect-every",
    label: "--reflect-every",
    description: "Reflection checkpoint every N iterations",
  },
];

function describeLoop(l: LoopSummary): string {
  const maxStr = l.maxIterations > 0 ? `/${l.maxIterations}` : "";
  const icon = RALPH_STATUS_ICONS[l.status] ?? "•";
  return `${icon} ${l.status} · iter ${l.iteration}${maxStr}`;
}

function suggestLoopNames(
  cmd: string,
  partial: string,
  listLoops: () => LoopSummary[],
): CompletionItem[] {
  return listLoops()
    .filter((l) => {
      if (cmd === "resume") return l.status !== "completed";
      if (cmd === "archive") return l.status !== "active";
      return true; // cancel: any non-archived loop
    })
    .filter((l) => l.name.startsWith(partial) && l.name !== partial)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => ({
      value: `${cmd} ${l.name}`,
      label: l.name,
      description: describeLoop(l),
    }));
}

/**
 * Build completion items for the argument text after `/unipi:ralph`.
 * `listLoops` supplies non-archived loop state (empty before session_start).
 * Returns null when there is nothing to suggest.
 */
export function buildRalphArgumentCompletions(
  argumentText: string,
  listLoops: () => LoopSummary[],
): CompletionItem[] | null {
  const endsWithSpace = /\s$/.test(argumentText);
  const tokens = argumentText.trim().split(/\s+/).filter((t) => t.length > 0);
  const complete = endsWithSpace ? tokens : tokens.slice(0, -1);
  const partial = endsWithSpace ? "" : (tokens[tokens.length - 1] ?? "");
  // Everything typed before the in-flight token — every suggestion must
  // preserve it, because pi replaces the whole argument text with item.value.
  const head = endsWithSpace
    ? argumentText
    : argumentText.slice(0, argumentText.length - partial.length);

  // No subcommand yet → suggest subcommands
  if (complete.length === 0) {
    const items = SUBCOMMANDS.filter((s) => s.value.startsWith(partial) && s.value !== partial).map(
      (s) => ({ ...s, value: head + s.value }),
    );
    return items.length > 0 ? items : null;
  }

  const cmd = complete[0];

  // Typing the numeric value of a start flag → no suggestions
  if (START_VALUE_FLAGS.includes(complete[complete.length - 1])) return null;

  switch (cmd) {
    case "resume":
    case "cancel":
    case "archive": {
      if (complete.length > 1) return null; // name chosen, nothing more
      const items = suggestLoopNames(cmd, partial, listLoops).map((i) => ({
        ...i,
        value: head + i.label,
      }));
      return items.length > 0 ? items : null;
    }

    case "start": {
      if (complete.length === 1) return null; // loop name is free-form
      const used = complete.slice(1).filter((t) => t.startsWith("--"));
      const items = START_FLAGS.filter(
        (f) => !used.includes(f.value) && f.value.startsWith(partial) && f.value !== partial,
      ).map((f) => ({
        value: head + f.value,
        label: f.label,
        description: f.description,
      }));
      return items.length > 0 ? items : null;
    }

    case "list":
    case "clean":
    case "nuke": {
      const flag = cmd === "list" ? "--archived" : cmd === "clean" ? "--all" : "--yes";
      const desc =
        cmd === "list"
          ? "Show archived loops"
          : cmd === "clean"
            ? "Also delete task files"
            : "Skip confirmation prompt";
      if (complete.slice(1).includes(flag) || flag === partial || !flag.startsWith(partial)) {
        return null;
      }
      return [{ value: head + flag, label: flag, description: desc }];
    }

    default:
      return null; // stop / status take no arguments
  }
}
