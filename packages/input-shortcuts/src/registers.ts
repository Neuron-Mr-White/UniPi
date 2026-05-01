/**
 * Register store with JSON file persistence.
 * 10 numbered registers (0-9) + 1 stash register (S).
 * File: .unipi/config/input-shortcuts.json
 * Atomic writes (write to .tmp then rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RegisterData } from "./types.js";
import { REGISTERS_FILE } from "./types.js";

const EMPTY_DATA: RegisterData = {
  stash: "",
  registers: ["", "", "", "", "", "", "", "", "", ""],
};

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

  /** Get a numbered register (0-9). */
  getRegister(index: number): string {
    if (index < 0 || index > 9) return "";
    this.ensureLoaded();
    return this.data!.registers[index] ?? "";
  }

  /** Set a numbered register (0-9) and persist. */
  setRegister(index: number, text: string): void {
    if (index < 0 || index > 9) return;
    this.ensureLoaded();
    this.data!.registers[index] = text;
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
        this.data = {
          stash: typeof parsed.stash === "string" ? parsed.stash : "",
          registers: Array.isArray(parsed.registers) && parsed.registers.length === 10
            ? parsed.registers.map((r) => (typeof r === "string" ? r : ""))
            : [...EMPTY_DATA.registers],
        };
      } else {
        this.data = { ...EMPTY_DATA, registers: [...EMPTY_DATA.registers] };
      }
    } catch {
      this.data = { ...EMPTY_DATA, registers: [...EMPTY_DATA.registers] };
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
