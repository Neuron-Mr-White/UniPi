/**
 * @pi-unipi/subagents — Guide topics (action: "guide")
 *
 * Bundled quick-reference for the spawn_helper guide action. Adapted from
 * pi-subagents docs/ (condensed to agent-facing essentials, our tool names).
 */

import { SUBAGENT_ACTIONS } from "./parity-types.js";

const TOPICS: Record<string, string> = {
  overview: `# Subagents overview

spawn_helper delegates work to focused child agents; get_helper_result waits on
or inspects them. Builtins: explore/work (unipi) + scout/researcher/worker/
reviewer/oracle/delegate (parity). Custom agents live in
~/.unipi/config/agents/*.md and <workspace>/.unipi/config/agents/*.md.

Execution modes:
- single child: { agent, task } (foreground or run_in_background)
- workflow: { workflowScript } — runs.run/runs.all/runs.steer in a sandbox
- management: { action } for list/get/status/children.list/resume/doctor/...

Rule of thumb: scout before you understand code, researcher before you trust
external facts, worker to implement, reviewer to check, oracle when the
decision itself feels risky.`,

  workflows: `# Workflows

All orchestration is code-driven through workflowScript:

  // sequential
  const scan = await runs.run("scan", { agent: "scout", task: "Analyze auth" });
  const fix = await runs.run("fix", { agent: "worker", task: "Implement: " + scan.output });
  return fix.output;

  // parallel fanout (await it; do not read .output from unawaited launches)
  const reviews = await runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness" },
    { key: "tests", agent: "reviewer", task: "Review tests" }
  ]);
  return reviews.map((r) => r.output);

Steering: await runs.steer(key, message, { mode: "auto" }) after a launch.
Plain helper functions returning runs.run(...) are fine; nested async helpers
are rejected. Recommended loop: clarify → scout → worker → fresh reviewers → worker.`,

  agents: `# Agents

An agent is a markdown file: YAML frontmatter + system prompt.

Fields: name, description, tools (comma list), model, thinking, aliases,
systemPromptMode (replace|append), inheritProjectContext, inheritSkills,
defaultContext (fresh|fork), timeoutMs, toolTimeoutMs, maxSubagentDepth,
memory ({ scope: user|project, path: role-name }), enabled.

Discovery priority: project .unipi/config/agents > global ~/.unipi/config/agents
> builtin files > code builtins. agentOverrides in the subagents.json
"subagents" block can override any builtin field per agent; disableBuiltins
disables all builtins while custom agents keep working.`,

  observability: `# Observability

FleetView (persistent panel): active work from both transports — in-process
agents and child-process runs. ↓/← activates; j/k navigate; enter inspects
(live transcript for local agents, result tail for process runs); esc closes.

spawn_helper({ action: "status" }) reports active work + spawn budgets.
children.list shows retained (completed) children with resumability.
Async completions arrive as <task-notification> follow-ups automatically.`,

  "tool-reference": `# spawn_helper reference

Execution: { agent, task, async?, context?, timeoutMs?, maxTurns?, turnBudget?,
toolBudget?, usageBudget?, model?, thinking?, worktree? }
Legacy aliases: type (= agent), prompt (= task), run_in_background (= async),
max_turns (= maxTurns).

workflowScript: { workflowScript, async?, timeoutMs?, maxOutput? }

Management actions: ${SUBAGENT_ACTIONS.slice(0, 12).join(", ")}, ...

get_helper_result: { id, wait?, nonBlocking?, all?, timeoutMs?, stopOnAttention? }
- blocking wait returns when a run needs attention (default) or completes
- nonBlocking: persist a subscription and return immediately; the session is
  woken on completion/failure/attention`,

  configuration: `# Configuration

~/.unipi/config/subagents.json (global) + <workspace>/.unipi/config/subagents.json
(workspace overrides global). The "subagents" block carries parity settings:

{ "subagents": { "defaultModel", "defaultThinking", "agentOverrides",
"disableBuiltins", "asyncByDefault", "defaultSubagentContext", "timeoutMs",
"toolTimeoutMs", "maxSubagentSpawnsPerRun" (64), "maxSubagentSpawnsPerSession",
"maxActiveAsyncRunsPerSession", "maxSubagentDepth" (2), "parallel",
"fleetView", "fleetViewPlacement", "inlineToolDisplay", "resultScanLogging" } }

Env overrides: UNIPI_SUBAGENT_PI_BINARY, UNIPI_SUBAGENT_TASK_DELIVERY,
UNIPI_SUBAGENT_TOOL_TIMEOUT_MS, UNIPI_SUBAGENTS_WORKTREE_DIR, UNIPI_SUBAGENT_MAX_DEPTH.`,

  missions: `# Missions (planned phase)

Durable mission records with delivery receipts, timed and recurring runs.
Not yet wired in this build — see the roadmap in the package README.`,

  models: `# Models

Children inherit the parent model by default. Override per call ({ model }),
per agent (frontmatter model), or globally (subagents.defaultModel).
Thinking: per call ({ thinking }), per agent, or subagents.defaultThinking.
Fallback models: agent frontmatter fallbackModels (ordered).`,

  watchdog: `# Watchdog (planned phase)

Opt-in adversarial change reviewer, scope monitoring, LSP diagnostics, child
tool permissions. Not yet wired in this build.`,

  "extension-api": `# Extension API (planned phase)

Runtime agent registration (AgentManager.registerRuntimeAgent) exists; the
full RPC bridge for external hosts lands in a later phase.`,
};

export function buildGuideText(topic: string): string {
  const normalized = topic.toLowerCase().trim();
  const doc = TOPICS[normalized];
  if (doc) return doc;
  return `Unknown guide topic "${topic}". Available topics: ${Object.keys(TOPICS).join(", ")}.`;
}
