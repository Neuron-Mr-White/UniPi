/**
 * Snapshot builder — converts stored SessionEvents into XML resume snapshot
 */

import type { StoredEvent } from "../types.js";

export interface BuildSnapshotOpts {
  compactCount?: number;
  searchTool?: string;
}

const MAX_ACTIVE_FILES = 10;

function escapeXML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildQueries(items: string[], maxQueries = 4): string[] {
  const unique = [...new Set(items.filter((s) => s.length > 0))];
  const selected = unique.slice(0, maxQueries);
  return selected.map((s) => (s.length > 80 ? s.slice(0, 80) : s));
}

function toolCall(toolName: string, queries: string[]): string {
  if (queries.length === 0) return "";
  const escaped = queries.map((q) => `"${escapeXML(q)}"`).join(", ");
  return `\n    For full details:\n    ${escapeXML(toolName)}(\n      queries: [${escaped}],\n      source: "session-events"\n    )`;
}

function buildFilesSection(fileEvents: StoredEvent[], searchTool: string): string {
  if (fileEvents.length === 0) return "";
  const fileMap = new Map<string, { ops: Map<string, number> }>();
  for (const ev of fileEvents) {
    const path = ev.data;
    let entry = fileMap.get(path);
    if (!entry) {
      entry = { ops: new Map() };
      fileMap.set(path, entry);
    }
    let op: string;
    if (ev.type === "file_write") op = "write";
    else if (ev.type === "file_edit") op = "edit";
    else if (ev.type === "file_read") op = "read";
    else op = ev.type;
    entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1);
  }

  const entries = Array.from(fileMap.entries());
  const limited = entries.slice(-MAX_ACTIVE_FILES);
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const [path, { ops }] of limited) {
    const opsStr = Array.from(ops.entries()).map(([k, v]) => `${k}×${v}`).join(", ");
    const fileName = path.split("/").pop() ?? path;
    summaryLines.push(`    ${escapeXML(fileName)} (${escapeXML(opsStr)})`);
    queryTerms.push(`${fileName} ${Array.from(ops.keys()).join(" ")}`);
  }

  const queries = buildQueries(queryTerms);
  return [
    `  <files count="${fileMap.size}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </files>`,
  ].join("\n");
}

function buildErrorsSection(errorEvents: StoredEvent[], searchTool: string): string {
  if (errorEvents.length === 0) return "";
  const summaryLines = errorEvents.map((ev) => `    ${escapeXML(ev.data)}`);
  const queries = buildQueries(errorEvents.map((ev) => ev.data));
  return [
    `  <errors count="${errorEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </errors>`,
  ].join("\n");
}

function buildDecisionsSection(decisionEvents: StoredEvent[], searchTool: string): string {
  if (decisionEvents.length === 0) return "";
  const seen = new Set<string>();
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];
  for (const ev of decisionEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }
  if (summaryLines.length === 0) return "";
  const queries = buildQueries(queryTerms);
  return [
    `  <decisions count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </decisions>`,
  ].join("\n");
}

function buildRulesSection(ruleEvents: StoredEvent[], searchTool: string): string {
  if (ruleEvents.length === 0) return "";
  const seen = new Set<string>();
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];
  for (const ev of ruleEvents) {
    if (seen.has(ev.data)) continue;
    seen.add(ev.data);
    summaryLines.push(`    ${escapeXML(ev.data)}`);
    queryTerms.push(ev.data);
  }
  if (summaryLines.length === 0) return "";
  const queries = buildQueries(queryTerms);
  return [
    `  <rules count="${summaryLines.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </rules>`,
  ].join("\n");
}

function buildGitSection(gitEvents: StoredEvent[], searchTool: string): string {
  if (gitEvents.length === 0) return "";
  const summaryLines = gitEvents.map((ev) => `    ${escapeXML(ev.data)}`);
  const queries = buildQueries(gitEvents.map((ev) => ev.data));
  return [
    `  <git count="${gitEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </git>`,
  ].join("\n");
}

export function renderTaskState(taskEvents: StoredEvent[]): string {
  if (taskEvents.length === 0) return "";
  const creates: string[] = [];
  const updates: Record<string, string> = {};
  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") creates.push(parsed.subject);
      else if (typeof parsed.taskId === "string" && typeof parsed.status === "string") {
        updates[parsed.taskId] = parsed.status;
      }
    } catch { /* not JSON */ }
  }
  if (creates.length === 0) return "";
  const DONE = new Set(["completed", "deleted", "failed"]);
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));
  const pending: string[] = [];
  for (let i = 0; i < creates.length; i++) {
    const matchedId = sortedIds[i];
    const status = matchedId ? (updates[matchedId] ?? "pending") : "pending";
    if (!DONE.has(status)) pending.push(creates[i]);
  }
  if (pending.length === 0) return "";
  return pending.map((task) => `    [pending] ${escapeXML(task)}`).join("\n");
}

function buildTaskSection(taskEvents: StoredEvent[], searchTool: string): string {
  const taskContent = renderTaskState(taskEvents);
  if (!taskContent) return "";
  const queryTerms: string[] = [];
  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") queryTerms.push(parsed.subject);
    } catch { /* not JSON */ }
  }
  const queries = buildQueries(queryTerms);
  const pendingCount = taskContent.split("\n").length;
  return [
    `  <task_state count="${pendingCount}">`,
    taskContent,
    toolCall(searchTool, queries),
    `  </task_state>`,
  ].join("\n");
}

function buildEnvironmentSection(cwdEvents: StoredEvent[], envEvents: StoredEvent[], searchTool: string): string {
  if (cwdEvents.length === 0 && envEvents.length === 0) return "";
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];
  if (cwdEvents.length > 0) {
    summaryLines.push(`    cwd: ${escapeXML(cwdEvents[cwdEvents.length - 1].data)}`);
    queryTerms.push("working directory");
  }
  for (const env of envEvents) {
    summaryLines.push(`    ${escapeXML(env.data)}`);
    queryTerms.push(env.data);
  }
  const queries = buildQueries(queryTerms);
  return [
    `  <environment>`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </environment>`,
  ].join("\n");
}

function buildSubagentsSection(subagentEvents: StoredEvent[], searchTool: string): string {
  if (subagentEvents.length === 0) return "";
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];
  for (const ev of subagentEvents) {
    const status = ev.type === "subagent_completed" ? "completed"
      : ev.type === "subagent_launched" ? "launched"
      : "unknown";
    summaryLines.push(`    [${status}] ${escapeXML(ev.data)}`);
    queryTerms.push(`subagent ${ev.data}`);
  }
  const queries = buildQueries(queryTerms);
  return [
    `  <subagents count="${subagentEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </subagents>`,
  ].join("\n");
}

function buildSkillsSection(skillEvents: StoredEvent[], searchTool: string): string {
  if (skillEvents.length === 0) return "";
  const skillCounts = new Map<string, number>();
  for (const ev of skillEvents) {
    const name = ev.data.split(":")[0].trim();
    skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
  }
  const summaryLines: string[] = [];
  const queryTerms: string[] = [];
  for (const [name, count] of skillCounts) {
    summaryLines.push(`    ${escapeXML(name)} (${count}×)`);
    queryTerms.push(`skill ${name} invocation`);
  }
  const queries = buildQueries(queryTerms);
  return [
    `  <skills count="${skillEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </skills>`,
  ].join("\n");
}

function buildIntentSection(intentEvents: StoredEvent[]): string {
  if (intentEvents.length === 0) return "";
  return `  <intent mode="${escapeXML(intentEvents[intentEvents.length - 1].data)}"/>`;
}

export function buildResumeSnapshot(
  events: StoredEvent[],
  opts?: BuildSnapshotOpts,
): string {
  const compactCount = opts?.compactCount ?? 1;
  const searchTool = opts?.searchTool ?? "ctx_search";
  const now = new Date().toISOString();

  const fileEvents: StoredEvent[] = [];
  const taskEvents: StoredEvent[] = [];
  const ruleEvents: StoredEvent[] = [];
  const decisionEvents: StoredEvent[] = [];
  const cwdEvents: StoredEvent[] = [];
  const errorEvents: StoredEvent[] = [];
  const envEvents: StoredEvent[] = [];
  const gitEvents: StoredEvent[] = [];
  const subagentEvents: StoredEvent[] = [];
  const intentEvents: StoredEvent[] = [];
  const skillEvents: StoredEvent[] = [];

  for (const ev of events) {
    switch (ev.category) {
      case "file": fileEvents.push(ev); break;
      case "task": taskEvents.push(ev); break;
      case "rule": ruleEvents.push(ev); break;
      case "decision": decisionEvents.push(ev); break;
      case "cwd": cwdEvents.push(ev); break;
      case "error": errorEvents.push(ev); break;
      case "env": envEvents.push(ev); break;
      case "git": gitEvents.push(ev); break;
      case "subagent": subagentEvents.push(ev); break;
      case "intent": intentEvents.push(ev); break;
      case "skill": skillEvents.push(ev); break;
    }
  }

  const sections: string[] = [];
  sections.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries — use the ones provided.
  </how_to_search>`);

  const files = buildFilesSection(fileEvents, searchTool);
  if (files) sections.push(files);
  const errors = buildErrorsSection(errorEvents, searchTool);
  if (errors) sections.push(errors);
  const decisions = buildDecisionsSection(decisionEvents, searchTool);
  if (decisions) sections.push(decisions);
  const rules = buildRulesSection(ruleEvents, searchTool);
  if (rules) sections.push(rules);
  const git = buildGitSection(gitEvents, searchTool);
  if (git) sections.push(git);
  const tasks = buildTaskSection(taskEvents, searchTool);
  if (tasks) sections.push(tasks);
  const environment = buildEnvironmentSection(cwdEvents, envEvents, searchTool);
  if (environment) sections.push(environment);
  const subagents = buildSubagentsSection(subagentEvents, searchTool);
  if (subagents) sections.push(subagents);
  const skills = buildSkillsSection(skillEvents, searchTool);
  if (skills) sections.push(skills);
  const intent = buildIntentSection(intentEvents);
  if (intent) sections.push(intent);

  const header = `<session_resume events="${events.length}" compact_count="${compactCount}" generated_at="${now}">`;
  const footer = `</session_resume>`;
  const body = sections.join("\n\n");
  if (body) {
    return `${header}\n\n${body}\n\n${footer}`;
  }
  return `${header}\n${footer}`;
}
