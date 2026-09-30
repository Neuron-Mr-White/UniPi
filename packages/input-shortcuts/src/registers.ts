/**
 * Stash store with JSON file persistence.
 * The file lives at .unipi/config/input-shortcuts.json. Older versions stored
 * ten numbered registers (0-9) next to the stash; those keys are ignored on
 * load and dropped on the next save.
 * Atomic writes (write to .tmp then rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RegisterData } from "./types.ts";
import { REGISTERS_FILE } from "./types.ts";

export class RegisterStore {
  private data: RegisterData | null = null;
  private filePath: string;
  private loaded = false;

  constructor(baseDir?: string) {
    this.filePath = baseDir ? join(baseDir, REGISTERS_FILE) : REGISTERS_FILE;
  }

  /** Get the stash register contents. */
  getStash(): string {
    this.ensureLoaded();
    return this.data!.stash;
  }

  /** Set the stash register contents and persist. */
  setStash(text: string): void {
    this.ensureLoaded();
    this.data!.stash = text;
    this.save();
  }

  /** Lazy load from disk on first access. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<RegisterData>;
        // Extra keys (the old numbered registers) are ignored, not an error.
        this.data = { stash: typeof parsed.stash === "string" ? parsed.stash : "" };
      } else {
        this.data = { stash: "" };
      }
    } catch {
      this.data = { stash: "" };
    }
  }

  /** Atomic write: write to .tmp then rename. */
  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this.filePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch {
      // Silent fail — register persistence is best-effort
    }
  }
}
