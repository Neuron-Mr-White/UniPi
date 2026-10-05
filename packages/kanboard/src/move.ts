import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectSettingsPath, setSettings, type MoveContext, type MoveHandler } from "@pi-unipi/core";
import { createCli, resolveBinary } from "./bin.js";

export function kanboardHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNIPI_KANBOARD_HOME?.trim() || join(homedir(), ".unipi", "kanboard");
}

function projects(): Array<{ slug: string; root: string }> {
  const root = join(kanboardHome(), "projects");
  if (!existsSync(root)) return [];
  const result: Array<{ slug: string; root: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(root, entry.name, "project.json"), "utf8"));
      if (typeof parsed.slug === "string" && typeof parsed.root === "string") result.push(parsed);
    } catch {}
  }
  return result;
}

function updateSettings(ctx: MoveContext, slug: string): void {
  const file = projectSettingsPath(ctx.newRoot, "kanboard");
  ctx.backup(file);
  setSettings("kanboard", { slug, root: ctx.newRoot }, "project", ctx.newRoot);
  ctx.log({ area: "kanboard", action: "settings-cache", from: ctx.oldRoot, to: file, result: "ok" });
}

export const kanboardMoveHandler: MoveHandler = {
  id: "kanboard",
  label: "Kanboard",
  async discoverOrphans() {
    return [...new Set(projects().filter((p) => !existsSync(p.root)).map((p) => p.root))];
  },
  scan(ctx) {
    const match = projects().find((p) => p.root === ctx.oldRoot);
    if (!match) return [];
    const binary = resolveBinary();
    return [{
      area: "kanboard",
      description: `project ${match.slug}: rebind root ${ctx.oldRoot} → ${ctx.newRoot} via unipi-kanboard project rebind; update ${projectSettingsPath(ctx.newRoot, "kanboard")}` + (!binary ? "; binary unavailable (will fail without changing project.json)" : ""),
      async apply() {
        if (ctx.dryRun) return;
        if (!binary) throw new Error("kanboard binary unavailable — update kanboard binary or build the dev binary");
        ctx.backup(join(kanboardHome(), "projects", match.slug, "project.json"));
        const client = createCli(binary, { ...process.env, UNIPI_KANBOARD_HOME: kanboardHome(), UNIPI_KANBOARD_ACTOR: "user" });
        try {
          await client.run(["project", "rebind", match.slug, "--root", ctx.newRoot], { cwd: ctx.newRoot });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reason = /unrecognized subcommand|unknown.*rebind|unexpected argument.*rebind/i.test(message) ? `${message}; update kanboard binary` : message;
          ctx.log({ area: "kanboard", action: "rebind", from: ctx.oldRoot, to: ctx.newRoot, result: `failed: ${reason}` });
          throw new Error(reason);
        }
        ctx.log({ area: "kanboard", action: "rebind", from: ctx.oldRoot, to: ctx.newRoot, result: "ok" });
        updateSettings(ctx, match.slug);
      },
    }];
  },
};
