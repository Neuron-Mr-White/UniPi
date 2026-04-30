/**
 * @unipi/ralph — Ralph loop state management
 *
 * Manages loop state, file I/O, and loop lifecycle.
 * Adapted from pi-ralph-wiggum.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  RALPH_DIR,
  RALPH_COMPLETE_MARKER,
  RALPH_DEFAULTS,
  RALPH_STATUS_ICONS,
  UNIPI_EVENTS,
  type UnipiRalphLoopEvent,
  sanitize,
  ensureDir,
  tryDelete,
  tryRead,
  safeMtimeMs,
  tryRemoveDir,
  readJson,
  writeJson,
  now,
} from "@pi-unipi/core";

/** Loop status */
export type LoopStatus = "active" | "paused" | "completed";

/** Loop state persisted to disk */
export interface LoopState {
  name: string;
  taskFile: string;
  iteration: number;
  maxIterations: number;
  itemsPerIteration: number;
  reflectEvery: number;
  reflectInstructions: string;
  active: boolean; // Backwards compat
  status: LoopStatus;
  startedAt: string;
  completedAt?: string;
  lastReflectionAt: number;
}

/** Default reflection instructions */
export const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

/** Default task template */
export const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Notes
(Update this as you work)
`;

/** Ralph loop manager */
export class RalphLoopManager {
  private currentLoop: string | null = null;
  private ctx: ExtensionContext;
  private emitFn: (event: string, payload: unknown) => void;

  constructor(ctx: ExtensionContext, emitFn: (event: string, payload: unknown) => void) {
    this.ctx = ctx;
    this.emitFn = emitFn;
  }

  // --- File helpers ---

  private ralphDir(): string {
    return path.resolve(this.ctx.cwd, RALPH_DIR);
  }

  private archiveDir(): string {
    return path.join(this.ralphDir(), "archive");
  }

  private getPath(name: string, ext: string, archived = false): string {
    const dir = archived ? this.archiveDir() : this.ralphDir();
    return path.join(dir, `${sanitize(name)}${ext}`);
  }

  // --- State management ---

  private migrateState(raw: Partial<LoopState> & { name: string }): LoopState {
    if (!raw.status) raw.status = raw.active ? "active" : "paused";
    raw.active = raw.status === "active";
    return raw as LoopState;
  }

  loadState(name: string, archived = false): LoopState | null {
    const content = tryRead(this.getPath(name, ".state.json", archived));
    return content ? this.migrateState(JSON.parse(content)) : null;
  }

  saveState(state: LoopState, archived = false): void {
    state.active = state.status === "active";
    const filePath = this.getPath(state.name, ".state.json", archived);
    ensureDir(filePath);
    writeJson(filePath, state);
  }

  listLoops(archived = false): LoopState[] {
    const dir = archived ? this.archiveDir() : this.ralphDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".state.json"))
      .map((f) => {
        const content = tryRead(path.join(dir, f));
        return content ? this.migrateState(JSON.parse(content)) : null;
      })
      .filter((s): s is LoopState => s !== null);
  }

  // --- Loop state transitions ---

  pauseLoop(state: LoopState, message?: string): void {
    state.status = "paused";
    state.active = false;
    this.saveState(state);
    this.currentLoop = null;
    this.updateUI();
    if (message && this.ctx.hasUI) this.ctx.ui.notify(message, "info");
  }

  completeLoop(state: LoopState, banner: string): void {
    state.status = "completed";
    state.completedAt = now();
    state.active = false;
    this.saveState(state);

    // Emit event
    this.emitFn(UNIPI_EVENTS.RALPH_LOOP_END, {
      name: state.name,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      status: "completed",
      reason: "completed",
    } satisfies UnipiRalphLoopEvent);

    this.currentLoop = null;
    this.updateUI();
  }

  stopLoop(state: LoopState, message?: string): void {
    state.status = "completed";
    state.completedAt = now();
    state.active = false;
    this.saveState(state);

    // Emit event
    this.emitFn(UNIPI_EVENTS.RALPH_LOOP_END, {
      name: state.name,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      status: "completed",
      reason: "cancelled",
    } satisfies UnipiRalphLoopEvent);

    this.currentLoop = null;
    this.updateUI();
    if (message && this.ctx.hasUI) this.ctx.ui.notify(message, "info");
  }

  // --- UI ---

  formatLoop(l: LoopState): string {
    const status = `${RALPH_STATUS_ICONS[l.status]} ${l.status}`;
    const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
    return `${l.name}: ${status} (iteration ${iter})`;
  }

  updateUI(): void {
    if (!this.ctx.hasUI) return;

    const state = this.currentLoop ? this.loadState(this.currentLoop) : null;
    if (!state) {
      this.ctx.ui.setStatus("ralph", undefined);
      this.ctx.ui.setWidget("ralph", undefined);
      return;
    }

    const { theme } = this.ctx.ui;
    const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";

    this.ctx.ui.setStatus("ralph", theme.fg("accent", `rl:${state.name} ${state.iteration}${maxStr}`));

    const lines = [
      theme.fg("accent", theme.bold("Ralph Loop")),
      theme.fg("muted", `Loop: ${state.name}`),
      theme.fg("dim", `Status: ${RALPH_STATUS_ICONS[state.status]} ${state.status}`),
      theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
      theme.fg("dim", `Task: ${state.taskFile}`),
    ];
    if (state.reflectEvery > 0) {
      const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
      lines.push(theme.fg("dim", `Next reflection in: ${next} iterations`));
    }
    lines.push("");
    lines.push(theme.fg("warning", "ESC pauses the assistant"));
    lines.push(theme.fg("warning", "Send a message to resume; /unipi:ralph-stop ends the loop"));
    this.ctx.ui.setWidget("ralph", lines);
  }

  // --- Prompt building ---

  buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
    const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
    const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

    const parts = [header, ""];
    if (isReflection) parts.push(state.reflectInstructions, "\n---\n");

    parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
    parts.push(`\n## Instructions\n`);
    parts.push("User controls: ESC pauses the assistant. Send a message to resume. Run /unipi:ralph-stop when idle to stop the loop.\n");
    parts.push(
      `You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
    );

    if (state.itemsPerIteration > 0) {
      parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`);
      parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
    } else {
      parts.push(`1. Continue working on the task`);
    }
    parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
    parts.push(`3. When FULLY COMPLETE, respond with: ${RALPH_COMPLETE_MARKER}`);
    parts.push(`4. Otherwise, call the ralph_done tool to proceed to next iteration`);

    return parts.join("\n");
  }

  // --- Public API ---

  getCurrentLoop(): string | null {
    return this.currentLoop;
  }

  setCurrentLoop(name: string | null): void {
    this.currentLoop = name;
  }

  getTaskFilePath(state: LoopState): string {
    return path.resolve(this.ctx.cwd, state.taskFile);
  }

  tryReadTask(state: LoopState): string | null {
    return tryRead(this.getTaskFilePath(state));
  }

  rehydrate(): void {
    const active = this.listLoops().filter((l) => l.status === "active");
    if (!this.currentLoop && active.length > 0) {
      const mostRecent = active.reduce((best, candidate) => {
        const bestMtime = safeMtimeMs(this.getPath(best.name, ".state.json"));
        const candidateMtime = safeMtimeMs(this.getPath(candidate.name, ".state.json"));
        return candidateMtime > bestMtime ? candidate : best;
      });
      this.currentLoop = mostRecent.name;
    }

    if (active.length > 0 && this.ctx.hasUI) {
      const lines = active.map(
        (l) => `  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`,
      );
      this.ctx.ui.notify(`Active Ralph loops:\n${lines.join("\n")}\n\nUse /unipi:ralph-resume <name> to continue`, "info");
    }
    this.updateUI();
  }

  // --- Loop operations ---

  startLoop(name: string, taskFile: string, taskContent: string, options: {
    maxIterations?: number;
    itemsPerIteration?: number;
    reflectEvery?: number;
    reflectInstructions?: string;
  } = {}): LoopState {
    const loopName = sanitize(name);
    const fullPath = path.resolve(this.ctx.cwd, taskFile);
    ensureDir(fullPath);
    fs.writeFileSync(fullPath, taskContent, "utf-8");

    const state: LoopState = {
      name: loopName,
      taskFile,
      iteration: 1,
      maxIterations: options.maxIterations ?? RALPH_DEFAULTS.MAX_ITERATIONS,
      itemsPerIteration: options.itemsPerIteration ?? RALPH_DEFAULTS.ITEMS_PER_ITERATION,
      reflectEvery: options.reflectEvery ?? RALPH_DEFAULTS.REFLECT_EVERY,
      reflectInstructions: options.reflectInstructions ?? DEFAULT_REFLECT_INSTRUCTIONS,
      active: true,
      status: "active",
      startedAt: now(),
      lastReflectionAt: 0,
    };

    this.saveState(state);
    this.currentLoop = loopName;
    this.updateUI();

    // Emit event
    this.emitFn(UNIPI_EVENTS.RALPH_LOOP_START, {
      name: loopName,
      iteration: 1,
      maxIterations: state.maxIterations,
      status: "active",
    } satisfies UnipiRalphLoopEvent);

    return state;
  }

  resumeLoop(name: string): LoopState | null {
    const state = this.loadState(name);
    if (!state) return null;
    if (state.status === "completed") return null;

    // Pause current loop if different
    if (this.currentLoop && this.currentLoop !== name) {
      const curr = this.loadState(this.currentLoop);
      if (curr) this.pauseLoop(curr);
    }

    state.status = "active";
    state.active = true;
    state.iteration++;
    this.saveState(state);
    this.currentLoop = name;
    this.updateUI();

    return state;
  }

  advanceIteration(): { state: LoopState; needsReflection: boolean } | null {
    if (!this.currentLoop) return null;

    const state = this.loadState(this.currentLoop);
    if (!state || state.status !== "active") return null;

    state.iteration++;

    // Check max iterations
    if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
      this.completeLoop(
        state,
        `───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
      );
      return null;
    }

    const needsReflection =
      state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
    if (needsReflection) state.lastReflectionAt = state.iteration;

    this.saveState(state);
    this.updateUI();

    return { state, needsReflection };
  }

  archiveLoop(name: string): boolean {
    const state = this.loadState(name);
    if (!state) return false;
    if (state.status === "active") return false;

    if (this.currentLoop === name) this.currentLoop = null;

    const srcState = this.getPath(name, ".state.json");
    const dstState = this.getPath(name, ".state.json", true);
    ensureDir(dstState);
    if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

    const srcTask = path.resolve(this.ctx.cwd, state.taskFile);
    if (srcTask.startsWith(this.ralphDir()) && !srcTask.startsWith(this.archiveDir())) {
      const dstTask = this.getPath(name, ".md", true);
      if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
    }

    this.updateUI();
    return true;
  }

  cleanCompleted(all = false): string[] {
    const completed = this.listLoops().filter((l) => l.status === "completed");
    const cleaned: string[] = [];

    for (const loop of completed) {
      tryDelete(this.getPath(loop.name, ".state.json"));
      if (all) tryDelete(this.getPath(loop.name, ".md"));
      if (this.currentLoop === loop.name) this.currentLoop = null;
      cleaned.push(loop.name);
    }

    this.updateUI();
    return cleaned;
  }

  nukeAll(): boolean {
    const dir = this.ralphDir();
    if (!fs.existsSync(dir)) return false;
    this.currentLoop = null;
    this.updateUI();
    return tryRemoveDir(dir);
  }
}
