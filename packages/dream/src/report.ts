/**
 * @pi-unipi/dream — report reading + proposal approval.
 *
 * Proposals are whatever the dream actually left on disk under
 * <staging>/proposals/: skill directories (contain SKILL.md) and check
 * files (*.md). Decisions live in state.json; approved skills are copied
 * into the configured skills target and must pass craft-skill's check.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { stateDir } from "@pi-unipi/core";

export interface Proposal {
  id: string;
  staging: string;
  name: string;
  kind: "skill" | "check";
  path: string;
  decision: "pending" | "approved" | "rejected";
}

export interface ParsedReport {
  staging: string;
  memoryEdits: string;
  proposalsSection: string;
  skipped: string;
}

export function listStagingDirs(cwd: string): string[] {
  const root = stateDir("dream", "state", cwd);
  try {
    return fs
      .readdirSync(root)
      .filter((d) => d.startsWith("staging-"))
      .map((d) => path.join(root, d))
      .filter((d) => fs.existsSync(path.join(d, "DREAM_REPORT.md")))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function parseReport(staging: string): ParsedReport | null {
  try {
    const md = fs.readFileSync(path.join(staging, "DREAM_REPORT.md"), "utf8");
    const section = (heading: string): string => {
      const re = new RegExp(`^##+ ${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##+ |$)`, "mi");
      return re.exec(md)?.[1]?.trim() ?? "";
    };
    return {
      staging,
      memoryEdits: section("Memory edits"),
      proposalsSection: section("Proposals"),
      skipped: section("Skipped"),
    };
  } catch {
    return null;
  }
}

export function listProposals(staging: string, decisions: Record<string, "approved" | "rejected">): Proposal[] {
  const dir = path.join(staging, "proposals");
  const out: Proposal[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(path.join(p, "SKILL.md"))) continue;
        out.push({
          id: path.basename(staging) + "/" + entry.name,
          staging,
          name: entry.name.replace(/^skill-/, ""),
          kind: "skill",
          path: p,
          decision: decisions[path.basename(staging) + "/" + entry.name] ?? "pending",
        });
      } else if (entry.name.endsWith(".md")) {
        out.push({
          id: path.basename(staging) + "/" + entry.name,
          staging,
          name: entry.name.replace(/\.md$/, ""),
          kind: "check",
          path: p,
          decision: decisions[path.basename(staging) + "/" + entry.name] ?? "pending",
        });
      }
    }
  } catch {
    // no proposals dir or unreadable — empty list
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ApproveResult {
  ok: boolean;
  detail: string;
  target?: string;
}

/** Approve a skill proposal: copy into the skills target, then run craft-skill's check. */
export function approveSkill(proposal: Proposal, skillsTarget: string, craftSkillScripts: string): ApproveResult {
  try {
    const target = path.resolve(process.cwd(), skillsTarget, proposal.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(proposal.path, target, { recursive: true });
    const check = spawnSync("bash", [path.join(craftSkillScripts, "check"), target], { encoding: "utf8" });
    const output = `${check.stdout ?? ""}${check.stderr ?? ""}`.trim();
    return {
      ok: check.status === 0,
      detail: output || `copied to ${target} (check script unavailable)`,
      target,
    };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

/** Approve a check proposal: checks are pi-hook ideas — surface the file for manual wiring. */
export function approveCheck(proposal: Proposal): ApproveResult {
  try {
    const md = fs.readFileSync(proposal.path, "utf8");
    const head = md.split("\n").slice(0, 12).join("\n");
    return { ok: true, detail: `approved. Wire it as a pi hook/extension yourself:\n${head}`, target: proposal.path };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
