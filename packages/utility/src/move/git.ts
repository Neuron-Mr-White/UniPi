import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MoveHandler } from "@pi-unipi/core";

export const gitWorktreesHandler: MoveHandler = {
  id: "git-worktrees",
  label: "Git worktrees",
  scan(ctx) {
    const worktrees = join(ctx.newRoot, ".git", "worktrees");
    if (!existsSync(worktrees)) return [];
    const stale = execFileSync("git", ["-C", ctx.newRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const common = execFileSync("git", ["-C", ctx.newRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
    const needsRepair = [...stale.matchAll(/^worktree (.+)$/gm)].some(([, root]) => root === ctx.oldRoot || root.startsWith(`${ctx.oldRoot}/`)) || (() => {
      try {
        const entries = execFileSync("git", ["-C", ctx.newRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" }).matchAll(/^worktree (.+)$/gm);
        for (const [, root] of entries) {
          const dotgit = join(root, ".git");
          if (existsSync(dotgit) && statSync(dotgit).isFile() && readFileSync(dotgit, "utf8").includes(`${ctx.oldRoot}/`)) return true;
        }
      } catch {
        return false;
      }
      return false;
    })();
    if (!needsRepair) return [];
    return [{
      area: "git-worktrees",
      description: `git -C ${ctx.newRoot} worktree repair (${common}); repair worktree links to moved repository`,
      apply() {
        if (ctx.dryRun) return;
        execFileSync("git", ["-C", ctx.newRoot, "worktree", "repair"], { encoding: "utf8" });
        ctx.log({ area: "git-worktrees", action: "repair", from: ctx.oldRoot, to: ctx.newRoot, result: "ok" });
      },
    }];
  },
};
