// Design families: each one renders EVERY UniPi surface in a single visual
// language. Picking a family = picking a consistent look for the whole suite.
import { box, card, type Color, type Ctx, fit, smoothBar, spin, spread } from "./kit.ts";

type Status = "running" | "completed" | "failed" | "cancelled";

// ── Sample data (taken from real sessions) ─────────────────────────────────
const AGENT = { profile: "General", title: "Run root scripts report", model: "ds/deepseek-flash" };
const TAIL = [
  { tool: "bash", arg: "npm run report", out: "step 3 of 5…" },
  { tool: "read", arg: "package.json", out: "" },
];
const BG = { title: "Subagent UX smoke artifact", elapsed: "50s", tools: 2 };
const FAIL = { profile: "Explore", title: "Map auth flow", reason: "provider rate limit (429)" };
const QUERY = "subagent test UX";
const HITS = [
  { name: "pi_test_kanboard_sanity_pass_state", room: "unipi_summary", score: 0.82 },
  { name: "pi_test_analytics_vendor_plausible", room: "unipi_summary", score: 0.74 },
  { name: "kanboard_pit_drag_fixture_tasks", room: "unipi_summary", score: 0.61 },
  { name: "project_topcoat_setup_state", room: "unipi_summary", score: 0.38 },
  { name: "env_no_c_toolchain_zig_cc_workaround", room: "unipi_summary", score: 0.31 },
];
const SAVED = { name: "subagent_ux_test_results_profiles_modes_resume", wing: "pi_test", room: "summary" };
const DOCK: Array<{ status: Status; profile: string; title: string; elapsed: string; tools: number; model: string }> = [
  { status: "running", profile: "General", title: "Run root scripts report", elapsed: "7s", tools: 2, model: "ds/deepseek-flash" },
  { status: "completed", profile: "Explore", title: "Map auth flow", elapsed: "41s", tools: 12, model: "ds/deepseek-flash" },
  { status: "cancelled", profile: "Explore", title: "Survey test fixtures", elapsed: "9s", tools: 3, model: "kimi-k2-0905" },
  { status: "failed", profile: "General", title: "Upgrade lockfile", elapsed: "1m02s", tools: 5, model: "ds/deepseek-flash" },
];

const STATUS_COLOR: Record<Status, Color> = { running: "accent", completed: "success", failed: "error", cancelled: "muted" };
const MEM: Color = "customMessageLabel";
const tools = (n: number) => `${String(n)} tool call${n === 1 ? "" : "s"}`;

export type Surface = "agentRunning" | "agentDone" | "agentFailed" | "bgNotice" | "waiting" | "recall" | "save" | "strip" | "dock";
export const SURFACES: Array<{ id: Surface; title: string; note: string }> = [
  { id: "agentRunning", title: "Subagent running", note: "Live card while a foreground subagent works (animated)." },
  { id: "agentDone", title: "Subagent completed", note: "The same card once it finishes." },
  { id: "agentFailed", title: "Subagent failed", note: "Error state." },
  { id: "bgNotice", title: "Background done", note: "Line posted in chat when a background subagent finishes." },
  { id: "waiting", title: "Waiting / collected", note: "read_subagent: the lead waiting on a result, then collecting it." },
  { id: "recall", title: "Memory recall", note: "MemPalace search results." },
  { id: "save", title: "Memory save", note: "A memory being filed." },
  { id: "strip", title: "Status strip", note: "Persistent one-liners under the editor: subagents, kanboard, goal." },
  { id: "dock", title: "Subagent dock", note: "The ↓ select list that replaces the editor." },
];

export interface Family {
  id: string;
  name: string;
  note: string;
  render: Record<Surface, (ctx: Ctx) => string[]>;
}

// ── 1. Current: today's look, reproduced from your screenshots ─────────────
const current: Family = {
  id: "current",
  name: "Current",
  note: "What ships today. Pi's tinted tool box; memory nests a second tint + bar inside it; └ appears mid-line in read_subagent.",
  render: {
    agentRunning: (c) => card(c, "toolPendingBg", [
      `● ${c.t.bold(`${AGENT.profile} subagent`)} ${c.t.fg("accent", AGENT.title)}`,
      ...TAIL.map((s) => c.t.fg("dim", `  ${s.tool} ${s.arg}${s.out ? `  ${s.out}` : ""}`)),
      c.t.fg("dim", "└ Running · 7s · 2 tool calls"),
    ]),
    agentDone: (c) => card(c, "toolSuccessBg", [
      `● ${c.t.bold(`${AGENT.profile} subagent`)} ${c.t.fg("accent", AGENT.title)}`,
      `${c.t.fg("dim", "└ ")}${c.t.fg("success", "Completed")}${c.t.fg("dim", " · 10s · 3 tool calls")}`,
    ]),
    agentFailed: (c) => card(c, "toolErrorBg", [
      `● ${c.t.bold(`${FAIL.profile} subagent`)} ${c.t.fg("accent", FAIL.title)}`,
      `${c.t.fg("dim", "└ ")}${c.t.fg("error", "Failed")}${c.t.fg("dim", ` · ${FAIL.reason}`)}`,
    ]),
    bgNotice: (c) => [
      `${c.t.fg("success", "●")} Subagent "${BG.title}" ${c.t.fg("success", "completed")}`,
      c.t.fg("dim", `└ ${BG.elapsed} · ${tools(BG.tools)}`),
    ],
    waiting: (c) => card(c, "toolSuccessBg", [
      `● ${c.t.bold("read_subagent")}${c.t.fg("dim", " · waiting")}`,
      `${c.t.fg("accent", "●")}${c.t.fg("dim", ` Checked on subagent ${BG.title} └ completed`)}`,
    ]),
    recall: (c) => {
      const inner = (s: string) => `${c.t.fg("border", "▎")}${c.t.bg("customMessageBg", fit(` ${s}`, c.width - 5))}`;
      return card(c, "toolSuccessBg", [
        `${c.t.fg("border", "◈")} ${c.t.bold(c.t.fg("border", "memory"))} ${c.t.fg("dim", `searching "${QUERY}"`)}`,
        inner(c.t.bold(c.t.fg("border", `◈ recalled "${QUERY}" · 5 memories · 1 projects`))),
        ...HITS.map((h, i) => inner(`${i < 3 ? "▰▱▱▱▱" : "▱▱▱▱▱"} ${h.name}  pi_test › ${h.room} · pi`)),
      ]);
    },
    save: (c) => {
      const inner = (s: string) => `${c.t.fg("warning", "▎")}${c.t.bg("customMessageBg", fit(` ${s}`, c.width - 5))}`;
      return card(c, "toolSuccessBg", [
        `${c.t.fg("border", "◈")} ${c.t.bold(c.t.fg("border", "memory"))} ${c.t.fg("dim", `remembering ${SAVED.name}…`)}`,
        inner(c.t.bold(c.t.fg("border", `◈ remembered ${SAVED.name}`))),
        inner(c.t.fg("muted", `${SAVED.wing} › ${SAVED.room} · filed ✓`)),
      ]);
    },
    strip: (c) => [c.t.fg("dim", "2 subagents (1 running) · ↓ select"), c.t.fg("dim", "▣ T-3 · goal +plan")],
    dock: (c) => [
      c.t.bold("Subagents"),
      ...DOCK.map((r, i) => {
        const g = { running: "◐", completed: "✓", failed: "✗", cancelled: "⊘" }[r.status];
        const line = `${i === 0 ? "›" : " "} ${c.t.fg(STATUS_COLOR[r.status], g)} ${fit(r.profile, 8)} ${fit(r.title, 26)} ${fit(r.elapsed, 6)} ${fit(tools(r.tools), 13)} ${c.t.fg("dim", r.model)}`;
        return i === 0 ? c.t.bg("selectedBg", fit(line, c.width)) : line;
      }),
      c.t.fg("dim", "↑↓ navigate · ↵ view · f foreground · x cancel · esc close"),
    ],
  },
};

// ── 2. Cleaned: keeps Pi's box, fixes the inconsistencies ──────────────────
const icon = { agent: "◆", memory: "◈", board: "▣" };
const cleanHead = (c: Ctx, kind: keyof typeof icon, color: Color, label: string, rest: string) =>
  `${c.t.fg(color, icon[kind])} ${c.t.bold(label)} ${rest}`;
const cleanMeta = (c: Ctx, word: string, color: Color, meta: string) =>
  `${c.t.fg("dim", "└ ")}${c.t.fg(color, word)}${meta ? c.t.fg("dim", ` · ${meta}`) : ""}`;
const cleaned: Family = {
  id: "cleaned",
  name: "Current, cleaned",
  note: "Same Pi tool box, one rule set: category icon + bold label on line 1, `└ status · meta` on the last line, no nested tints.",
  render: {
    agentRunning: (c) => card(c, "toolPendingBg", [
      cleanHead(c, "agent", "accent", `${AGENT.profile} subagent`, AGENT.title),
      ...TAIL.map((s) => `  ${c.t.fg("muted", s.tool)} ${c.t.fg("dim", s.arg)}${s.out ? c.t.fg("dim", `  ${s.out}`) : ""}`),
      cleanMeta(c, `${spin(c)} Running`, "accent", "7s · 2 tool calls · Ctrl+B background"),
    ]),
    agentDone: (c) => card(c, "toolSuccessBg", [
      cleanHead(c, "agent", "success", `${AGENT.profile} subagent`, AGENT.title),
      cleanMeta(c, "Completed", "success", "10s · 3 tool calls"),
    ]),
    agentFailed: (c) => card(c, "toolErrorBg", [
      cleanHead(c, "agent", "error", `${FAIL.profile} subagent`, FAIL.title),
      cleanMeta(c, "Failed", "error", FAIL.reason),
    ]),
    bgNotice: (c) => card(c, "toolSuccessBg", [
      cleanHead(c, "agent", "success", "Background subagent", BG.title),
      cleanMeta(c, "Completed", "success", `${BG.elapsed} · ${tools(BG.tools)} · result delivered`),
    ]),
    waiting: (c) => [
      ...card(c, "toolPendingBg", [cleanHead(c, "agent", "accent", "Waiting on", BG.title), cleanMeta(c, `${spin(c)} waiting`, "accent", "12s")]),
      "",
      ...card(c, "toolSuccessBg", [cleanHead(c, "agent", "success", "Collected", BG.title), cleanMeta(c, "Completed", "success", `${BG.elapsed} · ${tools(BG.tools)}`)]),
    ],
    recall: (c) => card(c, "toolSuccessBg", [
      cleanHead(c, "memory", MEM, "Recalled", `"${QUERY}"`),
      ...HITS.map((h) => `  ${c.t.fg(MEM, `${Math.round(h.score * 100)}%`.padStart(4))}  ${h.name}  ${c.t.fg("dim", `${h.room}`)}`),
      cleanMeta(c, "5 memories", MEM, "pi_test"),
    ]),
    save: (c) => card(c, "toolSuccessBg", [
      cleanHead(c, "memory", MEM, "Remembered", SAVED.name),
      cleanMeta(c, "Filed", "success", `${SAVED.wing} › ${SAVED.room}`),
    ]),
    strip: (c) => [
      `${c.t.fg("accent", icon.agent)} ${c.t.fg("muted", "2 subagents")} ${c.t.fg("accent", "(1 running)")} ${c.t.fg("dim", "· ↓ select")}`,
      `${c.t.fg("warning", icon.board)} ${c.t.fg("muted", "T-3 · goal +plan")}`,
    ],
    dock: current.render.dock,
  },
};

// ── 3. Quiet: Devin-style, no boxes ────────────────────────────────────────
const dot = (c: Ctx, color: Color) => c.t.fg(color, "●");
const tree = (c: Ctx, s: string) => `  ${c.t.fg("dim", "└")} ${s}`;
const quiet: Family = {
  id: "quiet",
  name: "Quiet (Devin-like)",
  note: "No tinted boxes (renderShell: self). A colored ● carries the state; everything else is dim. Lets the transcript breathe.",
  render: {
    agentRunning: (c) => [
      `${c.t.fg("accent", spin(c, "pulse", 2))} ${c.t.bold(`${AGENT.profile} subagent`)} ${AGENT.title}`,
      ...TAIL.map((s) => `  ${c.t.fg("dim", "│")} ${c.t.fg("muted", s.tool)} ${c.t.fg("dim", `${s.arg}${s.out ? `  ${s.out}` : ""}`)}`),
      tree(c, c.t.fg("dim", "Running · 7s · 2 tool calls")),
    ],
    agentDone: (c) => [`${dot(c, "success")} ${c.t.bold(`${AGENT.profile} subagent`)} ${AGENT.title}`, tree(c, c.t.fg("dim", "Completed · 10s · 3 tool calls"))],
    agentFailed: (c) => [`${dot(c, "error")} ${c.t.bold(`${FAIL.profile} subagent`)} ${FAIL.title}`, tree(c, `${c.t.fg("error", "Failed")} ${c.t.fg("dim", `· ${FAIL.reason}`)}`)],
    bgNotice: (c) => [`${dot(c, "success")} ${c.t.bold("Subagent finished")} ${BG.title}`, tree(c, c.t.fg("dim", `${BG.elapsed} · ${tools(BG.tools)} · result delivered`))],
    waiting: (c) => [
      `${c.t.fg("accent", spin(c, "pulse", 2))} ${c.t.bold("Waiting on")} ${BG.title}`,
      tree(c, c.t.fg("dim", "12s")),
      "",
      `${dot(c, "success")} ${c.t.bold("Collected")} ${BG.title}`,
      tree(c, c.t.fg("dim", `Completed · ${BG.elapsed} · ${tools(BG.tools)}`)),
    ],
    recall: (c) => [
      `${dot(c, MEM)} ${c.t.bold("Recalled")} "${QUERY}"`,
      ...HITS.map((h, i) => `  ${c.t.fg("dim", i === HITS.length - 1 ? "└" : "├")} ${h.name} ${c.t.fg("dim", `${h.room} · ${h.score.toFixed(2)}`)}`),
    ],
    save: (c) => [`${dot(c, MEM)} ${c.t.bold("Remembered")} ${SAVED.name}`, tree(c, c.t.fg("dim", `${SAVED.wing} › ${SAVED.room}`))],
    strip: (c) => [c.t.fg("dim", `2 subagents ${c.t.fg("accent", "(1 running)")} · ↓ select`), c.t.fg("dim", "T-3 · goal +plan")],
    dock: (c) => [
      c.t.fg("dim", "Subagents"),
      ...DOCK.map((r, i) => {
        const line = spread(
          `${i === 0 ? c.t.fg("accent", "›") : " "} ${dot(c, STATUS_COLOR[r.status])} ${c.t.bold(r.profile)} ${r.title}`,
          c.t.fg("dim", `${r.elapsed} · ${String(r.tools)} tools · ${r.status} · ${r.model}`),
          c.width,
        );
        return line;
      }),
      c.t.fg("dim", "↑↓ navigate · ↵ view · f foreground · x cancel · esc close"),
    ],
  },
};

// ── 4. Rail: colored left bar, meta right-aligned ──────────────────────────
const rail = (c: Ctx, color: Color, left: string, right = "") => spread(`${c.t.fg(color, "▌")} ${left}`, right, c.width);
const railFam: Family = {
  id: "rail",
  name: "Rail",
  note: "A colored bar on the left groups the lines and encodes the state; timing and counts sit right-aligned so titles line up.",
  render: {
    agentRunning: (c) => [
      rail(c, "accent", `${c.t.bold(AGENT.profile)} ${AGENT.title}`, c.t.fg("accent", `${spin(c)} 7s`)),
      ...TAIL.map((s) => rail(c, "accent", `${c.t.fg("muted", s.tool.padEnd(5))}${c.t.fg("dim", s.arg)}`, c.t.fg("dim", s.out))),
      rail(c, "accent", c.t.fg("dim", "ctrl+b background · esc cancel"), c.t.fg("dim", "2 tools")),
    ],
    agentDone: (c) => [rail(c, "success", `${c.t.bold(AGENT.profile)} ${AGENT.title}`, `${c.t.fg("success", "✓")} ${c.t.fg("dim", "10s · 3 tools")}`)],
    agentFailed: (c) => [
      rail(c, "error", `${c.t.bold(FAIL.profile)} ${FAIL.title}`, `${c.t.fg("error", "✗")} ${c.t.fg("dim", "4s")}`),
      rail(c, "error", c.t.fg("error", FAIL.reason)),
    ],
    bgNotice: (c) => [rail(c, "success", `${c.t.bold("Background")} ${BG.title}`, `${c.t.fg("success", "✓ done")} ${c.t.fg("dim", `${BG.elapsed} · ${String(BG.tools)} tools`)}`)],
    waiting: (c) => [
      rail(c, "accent", `${c.t.bold("Waiting")} ${BG.title}`, c.t.fg("accent", `${spin(c)} 12s`)),
      "",
      rail(c, "success", `${c.t.bold("Collected")} ${BG.title}`, `${c.t.fg("success", "✓")} ${c.t.fg("dim", BG.elapsed)}`),
    ],
    recall: (c) => [
      rail(c, MEM, `${c.t.bold("Memory")} "${QUERY}"`, c.t.fg("dim", "5 hits · pi_test")),
      ...HITS.map((h) => {
        const bar = smoothBar(h.score, 8);
        return rail(c, MEM, `${c.t.fg(MEM, bar.full)}${c.t.fg("borderMuted", "░".repeat(bar.rest.length))} ${h.name}`, c.t.fg("dim", h.room));
      }),
    ],
    save: (c) => [rail(c, MEM, `${c.t.bold("Memory")} ${SAVED.name}`, `${c.t.fg("success", "✓ filed")} ${c.t.fg("dim", `${SAVED.wing} › ${SAVED.room}`)}`)],
    strip: (c) => [
      spread(`${c.t.fg("accent", "▌")} ${c.t.fg("muted", "2 subagents")} ${c.t.fg("accent", "1 running")}`, c.t.fg("dim", "↓ select"), c.width),
      spread(`${c.t.fg("warning", "▌")} ${c.t.fg("muted", "T-3")} goal +plan`, c.t.fg("dim", "kanboard"), c.width),
    ],
    dock: (c) => [
      ...DOCK.map((r, i) => {
        const line = rail(c, STATUS_COLOR[r.status], `${c.t.bold(r.profile.padEnd(8))}${r.title}`, c.t.fg("dim", `${r.elapsed.padStart(5)} · ${String(r.tools).padStart(2)} tools · ${r.model}`));
        return i === 0 ? c.t.bg("selectedBg", fit(line, c.width)) : line;
      }),
      c.t.fg("dim", "  ↑↓ · ↵ view · f foreground · x cancel · esc"),
    ],
  },
};

// ── 5. Badge: inverse chips, dense one-liners ──────────────────────────────
const chip = (c: Ctx, color: Color, label: string) => c.t.inverse(c.t.fg(color, ` ${label} `));
const leader = (c: Ctx, left: string, right: string) => spread(left, right, c.width, "·", (s) => c.t.fg("borderMuted", s));
const badge: Family = {
  id: "badge",
  name: "Badge",
  note: "Small inverse chips name the kind (AGENT / MEMORY); each event fits on one dotted line. Densest; strongest scanning.",
  render: {
    agentRunning: (c) => [
      leader(c, `${chip(c, "accent", "AGENT")} ${c.t.bold(AGENT.profile)} ${AGENT.title}`, c.t.fg("accent", `${spin(c)} 7s`)),
      ...TAIL.map((s) => `        ${c.t.fg("muted", s.tool)} ${c.t.fg("dim", `${s.arg}${s.out ? `  ${s.out}` : ""}`)}`),
    ],
    agentDone: (c) => [leader(c, `${chip(c, "success", "AGENT")} ${c.t.bold(AGENT.profile)} ${AGENT.title}`, `${c.t.fg("dim", "10s · 3 tools")} ${c.t.fg("success", "✓")}`)],
    agentFailed: (c) => [
      leader(c, `${chip(c, "error", "AGENT")} ${c.t.bold(FAIL.profile)} ${FAIL.title}`, `${c.t.fg("dim", "4s")} ${c.t.fg("error", "✗")}`),
      `        ${c.t.fg("error", FAIL.reason)}`,
    ],
    bgNotice: (c) => [leader(c, `${chip(c, "success", "DONE")} ${BG.title}`, `${c.t.fg("dim", `${BG.elapsed} · ${String(BG.tools)} tools`)} ${c.t.fg("success", "✓")}`)],
    waiting: (c) => [
      leader(c, `${chip(c, "accent", "WAIT")} ${BG.title}`, c.t.fg("accent", `${spin(c)} 12s`)),
      leader(c, `${chip(c, "success", "GOT ")} ${BG.title}`, `${c.t.fg("dim", BG.elapsed)} ${c.t.fg("success", "✓")}`),
    ],
    recall: (c) => [
      leader(c, `${chip(c, MEM, "MEMORY")} recalled "${QUERY}"`, c.t.fg("dim", "5 hits")),
      ...HITS.map((h) => leader(c, `         ${h.name}`, c.t.fg(MEM, h.score.toFixed(2)))),
    ],
    save: (c) => [leader(c, `${chip(c, MEM, "MEMORY")} ${SAVED.name}`, `${c.t.fg("dim", `${SAVED.wing} › ${SAVED.room}`)} ${c.t.fg("success", "✓")}`)],
    strip: (c) => [`${chip(c, "accent", "2 AGENTS")} ${c.t.fg("accent", "1 running")} ${c.t.fg("dim", "↓")}  ${chip(c, "warning", "T-3")} ${c.t.fg("muted", "goal +plan")}`],
    dock: (c) => [
      ...DOCK.map((r, i) => {
        const g = { running: "RUN ", completed: "DONE", failed: "FAIL", cancelled: "STOP" }[r.status];
        const line = leader(c, `${i === 0 ? "›" : " "} ${chip(c, STATUS_COLOR[r.status], g)} ${c.t.bold(r.profile)} ${r.title}`, c.t.fg("dim", `${r.elapsed} · ${String(r.tools)} tools · ${r.model}`));
        return line;
      }),
      c.t.fg("dim", "  ↑↓ · ↵ view · f foreground · x cancel · esc"),
    ],
  },
};

// ── 6. Panel: rounded boxes with the title in the border ───────────────────
const panel: Family = {
  id: "panel",
  name: "Panel",
  note: "Rounded frame; title sits in the top border, state on the right. Most structured; costs 2 extra lines per event.",
  render: {
    agentRunning: (c) => box(c, [AGENT.title, ...TAIL.map((s) => c.t.fg("dim", `${s.tool} ${s.arg}${s.out ? `  ${s.out}` : ""}`))], {
      title: c.t.bold(`${AGENT.profile} subagent`), right: c.t.fg("accent", `${spin(c)} 7s`), color: "accent",
    }),
    agentDone: (c) => box(c, [AGENT.title, c.t.fg("dim", `3 tool calls · ${AGENT.model}`)], { title: c.t.bold(`${AGENT.profile} subagent`), right: c.t.fg("success", "✓ 10s") }),
    agentFailed: (c) => box(c, [FAIL.title, c.t.fg("error", FAIL.reason)], { title: c.t.bold(`${FAIL.profile} subagent`), right: c.t.fg("error", "✗ failed"), color: "error" }),
    bgNotice: (c) => box(c, [BG.title], { title: c.t.bold("Background subagent"), right: c.t.fg("success", `✓ ${BG.elapsed} · ${String(BG.tools)} tools`) }),
    waiting: (c) => [
      ...box(c, [BG.title], { title: c.t.bold("Waiting"), right: c.t.fg("accent", `${spin(c)} 12s`), color: "accent" }),
      ...box(c, [BG.title], { title: c.t.bold("Collected"), right: c.t.fg("success", `✓ ${BG.elapsed}`) }),
    ],
    recall: (c) => box(c, HITS.map((h) => spread(h.name, c.t.fg("dim", `${h.room} ${c.t.fg(MEM, h.score.toFixed(2))}`), c.width - 4)), {
      title: `${c.t.fg(MEM, "◈")} ${c.t.bold("Memory")} "${QUERY}"`, right: c.t.fg("dim", "5 hits"),
    }),
    save: (c) => box(c, [SAVED.name], { title: `${c.t.fg(MEM, "◈")} ${c.t.bold("Remembered")}`, right: c.t.fg("success", `✓ ${SAVED.wing} › ${SAVED.room}`) }),
    strip: (c) => [c.t.fg("borderMuted", "─".repeat(c.width)), `${c.t.fg("accent", "◆")} 2 subagents ${c.t.fg("accent", "1 running")} ${c.t.fg("dim", "↓")}   ${c.t.fg("warning", "▣")} T-3 goal +plan`],
    dock: (c) =>
      box(
        c,
        DOCK.map((r, i) => {
          const g = { running: "◐", completed: "✓", failed: "✗", cancelled: "⊘" }[r.status];
          const line = spread(`${c.t.fg(STATUS_COLOR[r.status], g)} ${c.t.bold(r.profile.padEnd(8))}${r.title}`, c.t.fg("dim", `${r.elapsed} · ${String(r.tools)} tools`), c.width - 4);
          return i === 0 ? c.t.bg("selectedBg", fit(line, c.width - 4)) : line;
        }),
        { title: c.t.bold("Subagents"), right: c.t.fg("dim", "↵ view · f · x · esc") },
      ),
  },
};

export const FAMILIES: Family[] = [current, cleaned, quiet, railFam, badge, panel];

/** Used by the "whole look" section: every surface stacked, in one family. */
export function wholeLook(f: Family, c: Ctx): string[] {
  const out: string[] = [];
  for (const s of SURFACES) {
    out.push(c.t.fg("dim", `  ${s.title}`), ...f.render[s.id](c), "");
  }
  return out;
}
