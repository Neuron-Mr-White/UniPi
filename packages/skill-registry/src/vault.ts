/**
 * @pi-unipi/skill-registry — the skill vault
 *
 * `~/.unipi/skill-vault/` holds skills the user keeps but does not want
 * everywhere. With the proxy on, pi discovers the vault (resources_discover)
 * and the registry keeps vault skills OFF until a scope turns them on.
 * Layout: any directory containing SKILL.md, up to three levels deep
 * (`vault/<skill>/SKILL.md` or `vault/<pack>/<skill>/SKILL.md`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function vaultDir(): string {
  return process.env.UNIPI_SKILL_VAULT || join(homedir(), ".unipi", "skill-vault");
}

export interface VaultSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

/** Minimal frontmatter reader: `name:` and `description:` (plain, `>`, `|`). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1]!.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    let value = m[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = block.join(" ").trim();
    }
    out[key] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function listVaultSkills(dir: string = vaultDir()): VaultSkill[] {
  const out: VaultSkill[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || !existsSync(d)) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    if (names.includes("SKILL.md") && d !== dir) {
      const filePath = join(d, "SKILL.md");
      try {
        const fm = parseFrontmatter(readFileSync(filePath, "utf-8"));
        const name = fm.name || d.split("/").pop()!;
        if (fm.description) out.push({ name, description: fm.description, filePath, baseDir: d });
      } catch {
        // unreadable skill — skip
      }
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        // skip
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
