/**
 * @pi-unipi/subagents — `/unipi:agents`: manage custom agents without
 * hand-writing frontmatter. List built-ins + customs, create one step by step
 * (name → scope → description → model → tools → prompt), edit the file in
 * pi's editor, copy between global and project, delete.
 *
 * Files: ~/.unipi/config/agents/<name>.md (global) and
 * <workspace>/.unipi/config/agents/<name>.md (project, wins).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { bus, UNIPI_EVENTS, registerCommandRunner } from "@pi-unipi/core";
import { EXPLORE_TOOLS, builtinProfiles, loadProfiles, type AgentProfile } from "./profiles.js";
import { resolveModel } from "./model-resolver.js";

export const AGENTS_COMMAND = "unipi:agents";
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const NEW_LABEL = "＋ New agent…";

export function agentsDir(scope: "global" | "project", cwd: string, home = homedir()): string {
  return join(scope === "global" ? home : cwd, ".unipi", "config", "agents");
}

/** Where a custom profile's file lives (flat file or directory layout). */
export function agentFile(profile: Pick<AgentProfile, "id" | "source">, cwd: string, home = homedir()): string | undefined {
  if (profile.source === "builtin") return undefined;
  const dir = agentsDir(profile.source, cwd, home);
  for (const candidate of [join(dir, `${profile.id}.md`), ...["AGENT.md", "AGENTS.md", "agent.md", "agents.md"].map((f) => join(dir, profile.id, f))]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface AgentDraft {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  thinking?: string;
  prompt: string;
}

/** Render a draft as the Devin/Claude-compatible markdown file. */
export function agentMarkdown(d: AgentDraft): string {
  const fm = [`name: ${d.name}`, `description: ${JSON.stringify(d.description)}`];
  if (d.model) fm.push(`model: ${d.model}`);
  if (d.thinking) fm.push(`thinking: ${d.thinking}`);
  if (d.tools && d.tools.length > 0) fm.push("allowed-tools:", ...d.tools.map((t) => `  - ${t}`));
  return `---\n${fm.join("\n")}\n---\n\n${d.prompt.trim()}\n`;
}

export function validateName(name: string, existing: readonly string[]): string | null {
  if (!NAME_RE.test(name)) return "Use lowercase letters, digits, - or _ (max 48).";
  if (builtinProfiles().some((b) => b.id === name)) return `${name} is a built-in profile name.`;
  if (existing.includes(name)) return `An agent named ${name} already exists.`;
  return null;
}

function promptTemplate(name: string, description: string): string {
  return `You are the ${name} subagent: ${description}\n\nWork only on the task you are given. You do not see the parent conversation; everything you need is in the task.\n\nFinish with a concise report for the parent agent: what you found or did, with file paths and line numbers, and anything you could not determine.`;
}

function describe(p: AgentProfile): string {
  const tools = p.tools === undefined ? "all tools" : p.tools.length <= 4 ? p.tools.join(", ") : `${String(p.tools.length)} tools`;
  const model = p.model ?? (p.id === "subagent_general" ? "your model" : "default subagent model");
  return `${p.id} · ${p.source} · ${model} · ${tools} — ${p.description}`;
}

type UI = ExtensionContext["ui"];

/** Short list + "Other…" with a fuzzy name match (hundreds of models don't
 *  fit a plain select). undefined = default subagent model; null = cancelled. */
async function pickModel(ui: UI, ctx: ExtensionContext): Promise<string | undefined | null> {
  const DEFAULT = "Default subagent model (recommended)";
  const OTHER = "Other… (type a name — fuzzy match)";
  const cur = ctx.model as { provider?: string; id?: string } | undefined;
  const choices = new Map<string, string>();
  if (cur?.provider && cur.id) choices.set(`Your current model — ${cur.provider}/${cur.id}`, `${cur.provider}/${cur.id}`);
  const sidekick = bus.get(UNIPI_EVENTS.FUSION_STATUS)?.sidekickKey;
  if (sidekick) choices.set(`Fusion sidekick — ${sidekick}`, sidekick);
  const choice = await ui.select("Model", [DEFAULT, ...choices.keys(), OTHER]);
  if (choice === undefined) return null;
  if (choice === DEFAULT) return undefined;
  if (choice !== OTHER) return choices.get(choice);
  while (true) {
    const raw = (await ui.input("Model name (e.g. deepseek-flash, sonnet, openrouter/…)", ""))?.trim();
    if (!raw) return null;
    const found = ctx.modelRegistry ? resolveModel(raw, ctx.modelRegistry as never) : raw;
    if (typeof found !== "string") return `${found.provider}/${found.id}`;
    if (!ctx.modelRegistry) return raw;
    ui.notify(`No model matches "${raw}".`, "warning");
  }
}

async function pickTools(ui: UI): Promise<string[] | undefined | null> {
  const READ = `Read-only (${EXPLORE_TOOLS.join(", ")})`;
  const ALL = "All tools (like subagent_general)";
  const CUSTOM = "Custom list…";
  const choice = await ui.select("Tools", [READ, ALL, CUSTOM]);
  if (choice === undefined) return null;
  if (choice === READ) return [...EXPLORE_TOOLS];
  if (choice === ALL) return undefined;
  const raw = await ui.input("Tools (comma-separated)", "read, grep, find, ls, bash");
  if (raw === undefined) return null;
  const list = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

async function createAgent(ctx: ExtensionContext, existing: readonly string[], onChange: () => void): Promise<void> {
  const ui = ctx.ui;
  let name: string | undefined;
  while (name === undefined) {
    const raw = await ui.input("New agent — name (e.g. reviewer)", "");
    if (raw === undefined) return;
    const err = validateName(raw.trim(), existing);
    if (err) ui.notify(err, "warning");
    else name = raw.trim();
  }
  const scopeChoice = await ui.select(`Save ${name} for`, ["This project (.unipi/config/agents)", "All projects (~/.unipi/config/agents)"]);
  if (scopeChoice === undefined) return;
  const scope = scopeChoice.startsWith("This") ? "project" : "global";
  const description = (await ui.input("Description — the parent agent reads this to pick the profile", ""))?.trim();
  if (!description) return;
  const model = await pickModel(ui, ctx);
  if (model === null) return;
  const tools = await pickTools(ui);
  if (tools === null) return;
  const prompt = await ui.editor(`${name} — system prompt (enter saves)`, promptTemplate(name, description));
  if (prompt === undefined || !prompt.trim()) return;
  const file = join(agentsDir(scope, ctx.cwd), `${name}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, agentMarkdown({ name, description, model, tools, prompt }), "utf8");
  onChange();
  ui.notify(`Agent ${name} saved to ${file}. The agent can use it from the next turn.`, "info");
}

async function editAgent(ctx: ExtensionContext, file: string, onChange: () => void): Promise<void> {
  const before = readFileSync(file, "utf8");
  const after = await ctx.ui.editor(`Edit ${file}`, before);
  if (after === undefined || after === before) return;
  try {
    parseFrontmatter(after);
  } catch (e) {
    ctx.ui.notify(`Not saved — frontmatter doesn't parse: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  writeFileSync(file, after, "utf8");
  onChange();
  ctx.ui.notify(`Saved ${file}.`, "info");
}

async function manageCustom(ctx: ExtensionContext, profile: AgentProfile, onChange: () => void): Promise<void> {
  const file = agentFile(profile, ctx.cwd);
  if (file === undefined) {
    ctx.ui.notify(`Can't find the file for ${profile.id}.`, "error");
    return;
  }
  const other = profile.source === "project" ? "global" : "project";
  const EDIT = "Edit file";
  const COPY = `Copy to ${other === "global" ? "all projects (global)" : "this project"}`;
  const DELETE = "Delete";
  const choice = await ctx.ui.select(`${profile.id} (${profile.source}) — ${file}`, [EDIT, COPY, DELETE]);
  if (choice === EDIT) return editAgent(ctx, file, onChange);
  if (choice === COPY) {
    const target = join(agentsDir(other, ctx.cwd), `${profile.id}.md`);
    if (existsSync(target) && !(await ctx.ui.confirm("Overwrite?", `${target} already exists.`))) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file, "utf8"), "utf8");
    onChange();
    ctx.ui.notify(`Copied to ${target}.`, "info");
    return;
  }
  if (choice === DELETE && (await ctx.ui.confirm(`Delete ${profile.id}?`, file))) {
    rmSync(file);
    onChange();
    ctx.ui.notify(`Deleted ${file}.`, "info");
  }
}

export async function agentsManager(ctx: ExtensionContext, onChange: () => void): Promise<void> {
  if (!ctx.hasUI) return;
  while (true) {
    const { profiles, warnings } = loadProfiles(ctx.cwd);
    for (const w of warnings) ctx.ui.notify(`subagents: ${w}`, "warning");
    const labels = profiles.map(describe);
    const choice = await ctx.ui.select("Subagent profiles — pick one to manage, or create a new agent", [...labels, NEW_LABEL]);
    if (choice === undefined) return;
    if (choice === NEW_LABEL) {
      await createAgent(ctx, profiles.map((p) => p.id), onChange);
      continue;
    }
    const profile = profiles[labels.indexOf(choice)];
    if (profile === undefined) return;
    if (profile.source === "builtin") {
      ctx.ui.notify(`${profile.id} is built in and can't be edited. Create a custom agent to change the model, tools or prompt.`, "info");
      continue;
    }
    await manageCustom(ctx, profile, onChange);
  }
}

export function registerAgentsCommand(pi: ExtensionAPI, deps: { onChange: (cwd: string) => void }): void {
  const run = (ctx: ExtensionContext) => agentsManager(ctx, () => deps.onChange(ctx.cwd));
  pi.registerCommand("unipi:agents", {
    description: "Manage subagent profiles: list, create, edit, copy, delete custom agents",
    handler: async (_args, ctx) => run(ctx),
  });
  registerCommandRunner(AGENTS_COMMAND, async (rawCtx) => run(rawCtx as ExtensionContext));
}
