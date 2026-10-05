/**
 * @unipi/memory — /unipi:move handler: relocate markdown + palace drawers
 * when projectName(oldRoot) !== projectName(newRoot).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MoveContext, MoveHandler, MoveItem } from "@pi-unipi/core";
import { MEMORY_TYPES, memoryFilePath, projectDir, projectName } from "./paths.js";
import { ensureMempalaceYaml, parseMemoryFile, scanProjectMemories, writeMemoryFile, type MemoryRecord } from "./files.js";
import { ensureMempalace, DEFAULT_PALACE, type MempalaceInstall } from "./mempalace.js";
import { fileThroughDaemon, mineDirect, deleteThroughDaemon, deleteViaWriteMcp } from "./daemon.js";

export interface MoveDeps {
  ensureMempalace: () => MempalaceInstall | null;
  fileThroughDaemon: typeof fileThroughDaemon;
  mineDirect: typeof mineDirect;
  deleteThroughDaemon: typeof deleteThroughDaemon;
  deleteViaWriteMcp: typeof deleteViaWriteMcp;
  palacePath: string;
}

const defaultDeps: MoveDeps = {
  ensureMempalace,
  fileThroughDaemon,
  mineDirect,
  deleteThroughDaemon,
  deleteViaWriteMcp,
  palacePath: DEFAULT_PALACE,
};

export const MOVE_AREA = "memory";

export interface PlannedFileMove {
  oldPath: string;
  newPath: string;
  record: MemoryRecord;
  conflict: boolean;
}

export function listTypedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const type of MEMORY_TYPES) {
    const typeDir = path.join(dir, type);
    try {
      for (const name of fs.readdirSync(typeDir).filter((f) => f.endsWith(".md"))) {
        out.push(path.join(typeDir, name));
      }
    } catch { /* type dir absent */ }
  }
  return out;
}

export function planFileMoves(oldProject: string, newProject: string): PlannedFileMove[] {
  const oldDir = projectDir(oldProject);
  if (!fs.existsSync(oldDir)) return [];
  const existingIds = new Set(scanProjectMemories(newProject).map((r) => r.id));
  const plans: PlannedFileMove[] = [];
  for (const filePath of listTypedFiles(oldDir)) {
    const record = parseMemoryFile(filePath);
    if (!record) continue;
    const newPath = memoryFilePath(newProject, record.type, record.id);
    plans.push({ oldPath: filePath, newPath, record, conflict: existingIds.has(record.id) || fs.existsSync(newPath) });
  }
  return plans;
}

function rmdirIfEmpty(dir: string): boolean {
  try {
    if (fs.readdirSync(dir).length > 0) return false;
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

async function reindexWing(
  deps: MoveDeps, install: MempalaceInstall, newProject: string, files: string[],
): Promise<{ status: "filed" | "queued" | "failed"; error?: string }> {
  const res = await deps.fileThroughDaemon(install, projectDir(newProject), files, newProject, deps.palacePath, 30_000);
  if (res.outcome === "filed") return { status: "filed" };
  if (res.outcome === "queued") return { status: "queued", error: res.error };
  const direct = await deps.mineDirect(install, projectDir(newProject), newProject, deps.palacePath);
  if (direct.ok) return { status: "filed" };
  return { status: "failed", error: direct.error ?? res.error };
}

export function createMemoryMoveHandler(deps: MoveDeps = defaultDeps): MoveHandler {
  return {
    id: "memory",
    label: "Memory",
    async discoverOrphans() {
      return [];
    },
    scan(ctx: MoveContext): MoveItem[] {
      const oldProject = projectName(ctx.oldRoot);
      const newProject = projectName(ctx.newRoot);
      if (oldProject === newProject) return [];
      const plans = planFileMoves(oldProject, newProject);
      if (plans.length === 0) return [];

      const lines = plans.map((p) => p.conflict
        ? `skip (same-id conflict): ${p.oldPath} → ${p.newPath}`
        : `${p.oldPath} → ${p.newPath}`);

      return [{
        area: MOVE_AREA,
        description: `memory: ${oldProject} → ${newProject}\n${lines.map((l) => `  • ${l}`).join("\n")}`,
        async apply() {
          if (ctx.dryRun) return;
          const moved: Array<{ oldPath: string; newPath: string }> = [];
          for (const plan of plans) {
            if (plan.conflict) {
              ctx.log({ area: MOVE_AREA, action: "move", from: plan.oldPath, to: plan.newPath, result: "skipped: same-id conflict" });
              continue;
            }
            ctx.backup(plan.oldPath);
            const typeDir = path.dirname(plan.newPath);
            const dirExisted = fs.existsSync(typeDir);
            const written = writeMemoryFile({ ...plan.record, project: newProject, filePath: undefined });
            if (!dirExisted) ctx.log({ area: MOVE_AREA, action: "mkdir", from: "", to: typeDir, result: "ok" });
            ctx.log({ area: MOVE_AREA, action: "write", from: plan.oldPath, to: written, result: "ok" });
            try {
              fs.unlinkSync(plan.oldPath);
              ctx.log({ area: MOVE_AREA, action: "unlink", from: plan.oldPath, to: written, result: "ok" });
            } catch (error) {
              ctx.log({ area: MOVE_AREA, action: "unlink", from: plan.oldPath, to: written, result: `failed: ${String(error)}` });
              continue;
            }
            moved.push({ oldPath: plan.oldPath, newPath: written });
          }

          const oldDir = projectDir(oldProject);
          for (const type of MEMORY_TYPES) {
            const typeDir = path.join(oldDir, type);
            if (fs.existsSync(typeDir) && rmdirIfEmpty(typeDir)) {
              ctx.log({ area: MOVE_AREA, action: "rmdir", from: typeDir, to: "", result: "ok" });
            }
          }
          if (fs.existsSync(oldDir) && rmdirIfEmpty(oldDir)) {
            ctx.log({ area: MOVE_AREA, action: "rmdir", from: oldDir, to: "", result: "ok" });
          }

          if (moved.length === 0) return;

          const yamlPath = path.join(projectDir(newProject), "mempalace.yaml");
          const gitignorePath = path.join(projectDir(newProject), ".gitignore");
          const yamlExisted = fs.existsSync(yamlPath);
          const gitignoreExisted = fs.existsSync(gitignorePath);
          ensureMempalaceYaml(newProject);
          if (!yamlExisted) ctx.log({ area: MOVE_AREA, action: "write", from: "", to: yamlPath, result: "ok" });
          if (!gitignoreExisted) ctx.log({ area: MOVE_AREA, action: "write", from: "", to: gitignorePath, result: "ok" });

          const install = deps.ensureMempalace();
          if (!install) {
            ctx.log({ area: MOVE_AREA, action: "reindex", from: oldProject, to: newProject, result: "skipped: not installed" });
            ctx.log({ area: MOVE_AREA, action: "delete-old-source", from: oldProject, to: newProject, result: "skipped: not installed" });
            return;
          }

          const reindex = await reindexWing(deps, install, newProject, moved.map((m) => m.newPath));
          ctx.log({
            area: MOVE_AREA, action: "reindex", from: oldProject, to: newProject,
            result: reindex.status + (reindex.error ? `: ${reindex.error}` : ""),
          });

          if (reindex.status !== "filed") {
            ctx.log({
              area: MOVE_AREA, action: "delete-old-source", from: oldProject, to: newProject,
              result: `skipped: reindex ${reindex.status}`,
            });
            return;
          }

          for (const { oldPath } of moved) {
            const del = await deps.deleteThroughDaemon(install, oldPath, deps.palacePath);
            if (del.outcome === "filed" || del.outcome === "queued") {
              ctx.log({ area: MOVE_AREA, action: "delete-old-source", from: oldPath, to: "", result: del.outcome });
              continue;
            }
            const direct = await deps.deleteViaWriteMcp(install, oldPath, deps.palacePath);
            ctx.log({
              area: MOVE_AREA, action: "delete-old-source", from: oldPath, to: "",
              result: direct.ok ? "filed (direct)" : `failed: ${direct.error}`,
            });
          }
        },
      }];
    },
  };
}

export const memoryMoveHandler: MoveHandler = createMemoryMoveHandler();
