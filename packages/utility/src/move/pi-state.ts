import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync, linkSync, renameSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MoveHandler } from "@pi-unipi/core";

export function agentDir(): string {
  const value = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

export function sessionDir(root: string): string {
  return join(agentDir(), "sessions", `--${resolve(root).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function header(file: string): { line: string; offset: number; cwd?: string } {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size < 1024 * 1024) {
      const chunk = Buffer.alloc(4096);
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) {
        const line = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(line.replace(/^\uFEFF/, ""));
        return { line, offset: size, cwd: parsed.type === "session" ? parsed.cwd : undefined };
      }
      const newline = chunk.subarray(0, count).indexOf(10);
      chunks.push(chunk.subarray(0, newline < 0 ? count : newline));
      size += newline < 0 ? count : newline;
      if (newline >= 0) {
        const line = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(line.replace(/^\uFEFF/, ""));
        return { line, offset: size + 1, cwd: parsed.type === "session" ? parsed.cwd : undefined };
      }
    }
    throw new Error(`Missing or oversized session header: ${file}`);
  } finally {
    closeSync(fd);
  }
}

export const piSessionsHandler: MoveHandler = {
  id: "pi-sessions",
  label: "Pi sessions",
  async discoverOrphans() {
    const base = join(agentDir(), "sessions");
    if (!existsSync(base)) return [];
    const roots = new Set<string>();
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const folder = join(base, dir.name);
      const files = readdirSync(folder).filter((f) => f.endsWith(".jsonl")).sort((a, b) => statSync(join(folder, b)).mtimeMs - statSync(join(folder, a)).mtimeMs);
      if (!files.length) continue;
      try {
        const cwd = header(join(folder, files[0])).cwd;
        if (cwd && !existsSync(cwd)) roots.add(cwd);
      } catch {}
    }
    return [...roots];
  },
  scan(ctx) {
    const sourceDir = sessionDir(ctx.oldRoot);
    const targetDir = sessionDir(ctx.newRoot);
    if (sourceDir === targetDir || !existsSync(sourceDir)) return [];
    return readdirSync(sourceDir).filter((f) => f.endsWith(".jsonl")).map((name) => {
      const from = join(sourceDir, name);
      const to = join(targetDir, name);
      const conflict = existsSync(to);
      const parsedHeader = JSON.parse(header(from).line.replace(/^\uFEFF/, ""));
      const lineageNotice = typeof parsedHeader.parentSession === "string" && parsedHeader.parentSession.startsWith(`${sourceDir}/`)
        ? "; parentSession lineage remains at the old path (only cwd is rewritten)" : "";
      return {
        area: "pi-sessions",
        description: conflict ? `Skip conflict: ${from} → ${to}` : `${from} → ${to}; rewrite header cwd ${ctx.oldRoot} → ${ctx.newRoot}${lineageNotice}`,
        async apply() {
          if (ctx.dryRun) return;
          if (existsSync(to)) {
            ctx.log({ area: "pi-sessions", action: "move", from, to, result: "skipped: same-name conflict" });
            return;
          }
          const original = header(from);
          mkdirSync(targetDir, { recursive: true });
          ctx.log({ area: "pi-sessions", action: "mkdir", from: "", to: targetDir, result: "ok" });
          const temporary = `${to}.move-${process.pid}-${Date.now()}`;
          try {
            if (original.cwd === ctx.oldRoot) {
              const parsed = JSON.parse(original.line.replace(/^\uFEFF/, ""));
              parsed.cwd = ctx.newRoot;
              writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, { flag: "wx", mode: statSync(from).mode });
              ctx.log({ area: "pi-sessions", action: "rewrite-header", from, to: temporary, result: "ok", originalHeader: original.line });
              await pipeline(createReadStream(from, { start: original.offset }), createWriteStream(temporary, { flags: "a" }));
            } else {
              copyFileSync(from, temporary, constants.COPYFILE_EXCL);
            }
            ctx.log({ area: "pi-sessions", action: "copy", from, to: temporary, result: "ok" });
            linkSync(temporary, to);
            ctx.log({ area: "pi-sessions", action: "link", from: temporary, to, result: "ok" });
          } finally {
            if (existsSync(temporary)) {
              unlinkSync(temporary);
              ctx.log({ area: "pi-sessions", action: "unlink-temporary", from: temporary, to, result: "ok" });
            }
          }
          unlinkSync(from);
          ctx.log({ area: "pi-sessions", action: "unlink", from, to, result: "ok" });
          if (lineageNotice) ctx.log({ area: "pi-sessions", action: "parent-session", from: parsedHeader.parentSession, to, result: "limitation: fork lineage keeps the original parentSession path; resume still works" });
          if (readdirSync(sourceDir).length === 0) {
            rmdirSync(sourceDir);
            ctx.log({ area: "pi-sessions", action: "rmdir", from: sourceDir, to: targetDir, result: "ok" });
          }
        },
      };
    });
  },
};

export const piTrustHandler: MoveHandler = {
  id: "pi-trust",
  label: "Pi trust",
  scan(ctx) {
    const file = join(agentDir(), "trust.json");
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Object.hasOwn(data, ctx.oldRoot)) return [];
    return [{
      area: "pi-trust",
      description: `${file}: replace key ${ctx.oldRoot} → ${ctx.newRoot}, preserving ${JSON.stringify(data[ctx.oldRoot])}`,
      apply() {
        if (ctx.dryRun) return;
        const lock = `${file}.lock`;
        mkdirSync(lock);
        ctx.log({ area: "pi-trust", action: "lock", from: "", to: lock, result: "ok" });
        const temporary = `${file}.move-${process.pid}`;
        try {
          const current = JSON.parse(readFileSync(file, "utf8"));
          if (!Object.hasOwn(current, ctx.oldRoot)) return;
          ctx.backup(file);
          current[ctx.newRoot] = current[ctx.oldRoot];
          delete current[ctx.oldRoot];
          writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx", mode: statSync(file).mode });
          ctx.log({ area: "pi-trust", action: "write", from: file, to: temporary, result: "ok" });
          renameSync(temporary, file);
          ctx.log({ area: "pi-trust", action: "replace-key", from: ctx.oldRoot, to: ctx.newRoot, result: "ok" });
        } finally {
          if (existsSync(temporary)) {
            unlinkSync(temporary);
            ctx.log({ area: "pi-trust", action: "unlink-temporary", from: temporary, to: "", result: "ok" });
          }
          rmdirSync(lock);
          ctx.log({ area: "pi-trust", action: "unlock", from: lock, to: "", result: "ok" });
        }
      },
    }];
  },
};
