/**
 * Dashboard — the command center shown when no project is open (UNI-67):
 * a needs-you inbox, live agents, up-next, throughput, activity and the
 * project grid. Read-only except for moves, which go through the same
 * rules/comment-dialog/undo path the board uses.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  api,
  displayTitle,
  needsComment,
  type DashboardData,
  type ProjectSummary,
  type Task,
} from "./api.js";
import { Icon, PriorityGlyph, StatusGlyph } from "./icons.js";
import { hue, ProjectTile } from "./paint.js";
import {
  describe,
  elapsed,
  loadProjects,
  openTaskId,
  openProject,
  projects,
  rules,
  setCommentRequest,
  setSelectedId,
  setOpenTaskId,
  slug,
  toast,
} from "./state.js";
import { Avatar, Kbd, MenuItem, Popover } from "./ui.js";

type SortMode = "attention" | "recent" | "name";
const SORT_KEY = "kb.dashboard.sort";
const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const loadSort = (): SortMode => {
  const stored = localStorage.getItem(SORT_KEY);
  return stored === "recent" || stored === "name" ? stored : "attention";
};

/** "3h"/"2d" age for the waiting chip; true once it is worth amber. */
function waitAge(iso: string, now: number): { label: string; old: boolean } {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  const old = minutes >= 24 * 60;
  if (minutes < 60) return { label: `${minutes}m`, old };
  if (minutes < 24 * 60) return { label: `${Math.floor(minutes / 60)}h`, old };
  return { label: `${Math.floor(minutes / (24 * 60))}d`, old };
}

/** Compact relative time ("2h ago") for project cards. */
function relative(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Compact duration ("30s", "45m", "14h 56m", "2d 3h") — the same family the
 *  waiting-age chips use; drives the median review wait tile. */
function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 24 * 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / (24 * 3600));
  const hours = Math.round((seconds % (24 * 3600)) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Client mirror of the backend's `entered_status` vocabulary, plus a short
 *  verb for the activity step trail. */
function stepOf(text: string): { label: string; status: string | null } {
  const t = text.trim();
  if (t.startsWith("finished:")) return { label: "finished", status: "in_review" };
  if (t.startsWith("released to ")) {
    const status = t.slice(12).split(":")[0]?.trim() ?? "";
    return { label: status === "in_review" ? "reviewed" : status, status: status || null };
  }
  if (t === "blocked" || t.startsWith("blocked:")) return { label: "blocked", status: "blocked" };
  if (t.startsWith("unblocked:")) return { label: "unblocked", status: "todo" };
  if (t.startsWith("rework:")) return { label: "rework", status: "todo" };
  if (t === "cancelled" || t.startsWith("cancelled:")) return { label: "cancelled", status: "cancelled" };
  if (t === "archived" || t.startsWith("archived")) return { label: "archived", status: "archived" };
  if (t.startsWith("moved ")) {
    const status = t.slice(6).split(" → ")[1]?.split(/[: (]/)[0]?.trim() ?? "";
    return { label: status || "moved", status: status || null };
  }
  if (t.startsWith("undo:")) {
    const status = t.slice(5).split(" → ")[1]?.split(" (")[0]?.trim() ?? "";
    return { label: "undo", status: status || null };
  }
  if (t.startsWith("created in ")) {
    const status = t.slice(11).split(" ")[0] ?? "";
    return { label: "created", status: status || null };
  }
  if (t.startsWith("started (")) return { label: "started", status: "in_progress" };
  if (t.startsWith("edited ")) return { label: "edited", status: null };
  return { label: t.split(/[: (]/)[0]?.slice(0, 12) || "note", status: null };
}

const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** Count-up number: animates once on first appearance, then tracks directly. */
function CountUp(props: { value: number }): JSX.Element {
  let animated = false;
  const [display, setDisplay] = createSignal(0);
  createEffect(() => {
    const target = props.value;
    if (REDUCE_MOTION || animated) {
      animated = true;
      setDisplay(target);
      return;
    }
    animated = true;
    if (target === 0) return;
    const started = performance.now();
    const duration = 750;
    const step = (tick: number): void => {
      const progress = Math.min(1, (tick - started) / duration);
      setDisplay(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return <>{display()}</>;
}

export function Dashboard(): JSX.Element {
  const [data, setData] = createSignal<DashboardData | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [running, setRunning] = createSignal<Array<{ slug: string; project: string; task: Task }>>([]);
  const [filter, setFilter] = createSignal<"all" | "review" | "blocked">("all");
  const [sort, setSortSignal] = createSignal<SortMode>(loadSort());
  const [showAllGroups, setShowAllGroups] = createSignal(false);
  const [focused, setFocused] = createSignal(-1);
  const [leaving, setLeaving] = createSignal<Set<string>>(new Set());
  /** Rows whose entrance already played — keyed by task, never re-triggered
   *  by refetches or ticks (UNI-67 rework). */
  const enteredRows = new Set<string>();
  const [now, setNow] = createSignal(Date.now());

  setNow(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  const load = async (): Promise<void> => {
    try {
      const [dash, agents] = await Promise.all([api.dashboard(), api.running().catch(() => ({ running: [] }))]);
      setData(dash);
      setRunning(agents.running);
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void load());

  // Live updates: subscribe to every active project's revision stream (the
  // per-project EventSource the board uses), debounced.
  let sources: EventSource[] = [];
  let debounce: number | undefined;
  const scheduleReload = (): void => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void load(), 400);
  };
  createEffect(() => {
    for (const source of sources) source.close();
    sources = [];
    const slugs = (data()?.projects ?? []).map((project) => project.slug).slice(0, 12);
    for (const project of slugs) {
      const source = new EventSource(`/events?project=${encodeURIComponent(project)}`);
      source.addEventListener("revision", scheduleReload);
      sources.push(source);
    }
  });
  onCleanup(() => {
    for (const source of sources) source.close();
    window.clearTimeout(debounce);
  });
  // Test hook: the fixture daemons may run without the file watcher, in which
  // case the SSE sources above stay silent (same escape the daemon documents).
  (window as unknown as { __kbDashReload?: () => void }).__kbDashReload = () => void load();

  const setSort = (next: SortMode): void => {
    setSortSignal(next);
    localStorage.setItem(SORT_KEY, next);
  };

  // Inbox grouping preferences (UNI-67 rework): collapsed project groups,
  // groups expanded past the 3-row default, and the show-all footer toggle.
  const INBOX_KEY = "kb.dashboard.inbox";
  interface InboxPrefs {
    collapsed: string[];
    expanded: string[];
    all: boolean;
  }
  const loadInboxPrefs = (): InboxPrefs => {
    try {
      const parsed = JSON.parse(localStorage.getItem(INBOX_KEY) ?? "null") as Partial<InboxPrefs> | null;
      if (parsed && Array.isArray(parsed.collapsed) && Array.isArray(parsed.expanded)) {
        return { collapsed: parsed.collapsed, expanded: parsed.expanded, all: parsed.all === true };
      }
    } catch { /* corrupt prefs → defaults */ }
    return { collapsed: [], expanded: [], all: false };
  };
  const [inboxPrefs, setInboxPrefsSignal] = createSignal<InboxPrefs>(loadInboxPrefs());
  const setInboxPrefs = (next: InboxPrefs): void => {
    animateInbox(() => setInboxPrefsSignal(next));
    localStorage.setItem(INBOX_KEY, JSON.stringify(next));
  };
  /** Every inbox prefs change (chevron, +N / Show fewer, Expand/Collapse all,
   *  Show N more / less) goes through here so rows never pop in or out
   *  instantly. `inboxGroups()` rebuilds group objects on each change, so
   *  <For> recreates the group DOM: measure by data-project before, look the
   *  new elements up after, and transition each group's height between the
   *  two. Rows that were not rendered before fade in, staggered. */
  const animateActivity = (mutate: () => void): void =>
    animateHeights(".dash-activity[data-panel]", "panel", ".dash-activity .dash-activity-row[data-row-key]", mutate);
  const animateInbox = (mutate: () => void): void =>
    animateHeights(".dash-inbox-group[data-project]", "project", ".dash-inbox-group .dash-row[data-row-key]", mutate);
  const toggleGroupCollapsed = (project: string): void => {
    const prefs = inboxPrefs();
    setInboxPrefs({
      ...prefs,
      collapsed: prefs.collapsed.includes(project) ? prefs.collapsed.filter((s) => s !== project) : [...prefs.collapsed, project],
    });
  };
  const toggleGroupExpanded = (project: string): void => {
    const prefs = inboxPrefs();
    setInboxPrefs({
      ...prefs,
      expanded: prefs.expanded.includes(project) ? prefs.expanded.filter((s) => s !== project) : [...prefs.expanded, project],
    });
  };
  const setInboxAll = (all: boolean): void => setInboxPrefs({ ...inboxPrefs(), all });

  /** Open a task in its project — the same navigation the sidebar's global
   *  agent list uses. */
  const openTask = (project: string, id: string): void => {
    void openProject(project).then(() => {
      setSelectedId(id);
      setOpenTaskId(id);
    });
  };

  /** Moves go through the shared client path: needsComment → CommentDialog
   *  (with the row's project slug), rules and undo toast identical to the
   *  board (UNI-67). */
  const moveTask = (project: string, task: Task, to: string): void => {
    const leavingId = `${project}/${task.id}`;
    setLeaving((current) => new Set(current).add(leavingId));
    window.setTimeout(() => {
      setLeaving((current) => {
        const next = new Set(current);
        next.delete(leavingId);
        return next;
      });
      const hint = needsComment(rules, task.status, to);
      if (hint) {
        setCommentRequest({ task: { ...task }, to, hint, slug: project, after: () => load() });
        return;
      }
      void (async () => {
        try {
          const moved = await api.move(project, task.id, to);
          toast(`Moved ${task.id} to ${to === "done" ? "Done" : to}`, "success", moved.undoToken ? {
            label: "Undo",
            run: async () => {
              try {
                await api.undoMove(project, task.id, moved.undoToken!);
              } catch (error) {
                toast(describe(error), "error");
              } finally {
                await load();
              }
            },
          } : undefined);
          await load();
        } catch (error) {
          toast(describe(error), "error");
        }
      })();
    }, 220);
  };

  const filteredInbox = createMemo(() => {
    const items = data()?.inbox ?? [];
    const mode = filter();
    return mode === "all" ? items : items.filter((item) => item.task.status === mode);
  });
  const counts = createMemo(() => {
    const items = data()?.inbox ?? [];
    return {
      all: items.length,
      review: items.filter((item) => item.task.status === "in_review").length,
      blocked: items.filter((item) => item.task.status === "blocked").length,
    };
  });

  interface InboxGroup {
    project: string;
    items: Array<{ slug: string; project: string; task: Task; waitingSince: string; excerpt: string | null }>;
    oldest: number;
    review: number;
    blocked: number;
  }
  /** Groups ordered by their oldest wait; visibility applies the 3-row
   *  per-group default (+N expands), the collapsed groups, and the global
   *  10-row cap lifted by the show-all footer (UNI-67 rework). */
  const inboxGroups = createMemo(() => {
    const groups = new Map<string, InboxGroup>();
    for (const item of filteredInbox()) {
      const group = groups.get(item.project) ?? {
        project: item.project,
        items: [],
        oldest: Date.parse(item.waitingSince),
        review: 0,
        blocked: 0,
      };
      group.items.push(item);
      group.oldest = Math.min(group.oldest, Date.parse(item.waitingSince));
      if (item.task.status === "in_review") group.review += 1;
      if (item.task.status === "blocked") group.blocked += 1;
      groups.set(item.project, group);
    }
    const ordered = [...groups.values()].sort((a, b) => a.oldest - b.oldest);
    const prefs = inboxPrefs();
    let budget = prefs.all ? Number.POSITIVE_INFINITY : 10;
    const out: Array<InboxGroup & { visible: InboxGroup["items"]; hidden: number; capHidden: number; collapsed: boolean; userExpanded: boolean }> = [];
    for (const group of ordered) {
      const collapsed = prefs.collapsed.includes(group.project);
      // A group the user expanded (+N) always shows every row — the global
      // cap only trims groups left at their default.
      const userExpanded = prefs.expanded.includes(group.project);
      const perGroupCap = prefs.all || userExpanded ? Number.POSITIVE_INFINITY : 3;
      const take = collapsed
        ? 0
        : userExpanded
          ? group.items.length
          : Math.min(group.items.length, perGroupCap, Math.max(0, budget));
      budget -= take;
      out.push({
        ...group,
        visible: group.items.slice(0, Math.max(0, take)),
        hidden: group.items.length - take,
        // Rows hidden by the caps (not by the user collapsing the group) —
        // the only rows the "Show N more" footer can reveal.
        capHidden: collapsed ? 0 : group.items.length - take,
        collapsed,
        userExpanded,
      });
    }
    return out;
  });
  const visibleRowCount = createMemo(() => inboxGroups().reduce((sum, group) => sum + group.visible.length, 0));
  const capHiddenCount = createMemo(() => inboxGroups().reduce((sum, group) => sum + group.capHidden, 0));
  /** "Show less" only makes sense when lifting the caps revealed rows. */
  const capsLifted = createMemo(
    () => inboxPrefs().all && inboxGroups().some((group) => !group.collapsed && group.visible.length > 3) || (inboxPrefs().all && visibleRowCount() > 10),
  );
  const allCollapsed = createMemo(() => inboxGroups().length > 0 && inboxGroups().every((group) => group.collapsed));
  const setAllCollapsed = (collapse: boolean): void =>
    setInboxPrefs({ ...inboxPrefs(), collapsed: collapse ? inboxGroups().map((group) => group.project) : [] });
  // Flat view of the rendered rows — drives j/k/Enter over what is visible.
  const inbox = createMemo(() => inboxGroups().flatMap((group) => group.visible));
  const hasStaleWait = createMemo(() =>
    (data()?.inbox ?? []).some((item) => waitAge(item.waitingSince, now()).old),
  );

  const focusInbox = (): void => {
    document.querySelector(".dash-inbox")?.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" });
    setFocused(0);
  };
  const scrollAgents = (): void => {
    document.querySelector(".dash-agents")?.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" });
  };

  const dashBySlug = createMemo(() => {
    const map = new Map<string, DashboardData["projects"][number]>();
    for (const project of data()?.projects ?? []) map.set(project.slug, project);
    return map;
  });

  const sortedProjects = createMemo(() => {
    const dash = dashBySlug();
    const mode = sort();
    const list = projects.items.filter((project) => !project.archived);
    const info = (project: ProjectSummary) => dash.get(project.slug);
    if (mode === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (mode === "recent") {
      return [...list].sort((a, b) => (Date.parse(info(b)?.lastActivity ?? "") || 0) - (Date.parse(info(a)?.lastActivity ?? "") || 0));
    }
    return [...list].sort((a, b) => {
      const weight = (project: ProjectSummary) => {
        const entry = info(project);
        return (entry ? entry.blocked * 2 + entry.review : 0) * 1000 + (project.running ?? 0);
      };
      return weight(b) - weight(a) || a.name.localeCompare(b.name);
    });
  });

  const throughput = createMemo(() => {
    const stamps = (data()?.doneAt ?? []).map((value) => {
      const date = new Date(value);
      const local = new Date(date);
      local.setHours(0, 0, 0, 0);
      return local.getTime();
    });
    const days: Array<{ start: number; label: string; weekday: string; count: number; today: boolean }> = [];
    for (let offset = 13; offset >= 0; offset -= 1) {
      const day = new Date(now());
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - offset);
      days.push({
        start: day.getTime(),
        label: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        weekday: WEEKDAY_INITIALS[day.getDay()]!,
        count: stamps.filter((stamp) => stamp === day.getTime()).length,
        today: offset === 0,
      });
    }
    return days;
  });
  const bestDay = createMemo(() => {
    const days = throughput();
    if (days.length === 0) return -1;
    let best = -1;
    let bestCount = 0;
    days.forEach((day, index) => {
      if (day.count > bestCount) {
        bestCount = day.count;
        best = index;
      }
    });
    return bestCount > 0 ? best : -1;
  });

  const stats = createMemo(() => {
    const dash = data();
    const weekAgo = now() - 7 * 24 * 3600_000;
    return {
      done7d: (dash?.doneAt ?? []).filter((value) => Date.parse(value) >= weekAgo).length,
      medianWait: median(dash?.reviewWaits ?? []),
      hasWaits: (dash?.reviewWaits ?? []).length > 0,
      blocked: (dash?.projects ?? []).reduce((sum, project) => sum + project.blocked, 0),
      repairs: (dash?.projects ?? []).reduce((sum, project) => sum + project.problems, 0),
    };
  });

  /** Activity clustered: consecutive entries for the same task within 10
   *  minutes become one row with a step trail; identical texts collapse. */
  interface ActivityRow {
    slug: string;
    project: string;
    taskId: string;
    title: string;
    at: string;
    steps: Array<{ label: string; status: string | null; at: string; actor: string }>;
    lastText: string;
    repeats: number;
  }
  const activityRows = createMemo(() => {
    const rows: ActivityRow[] = [];
    for (const entry of data()?.activity ?? []) {
      const step = stepOf(entry.text);
      const last = rows[rows.length - 1];
      if (
        last &&
        last.slug === entry.slug &&
        last.taskId === entry.taskId &&
        Math.abs(Date.parse(last.at) - Date.parse(entry.at)) <= 10 * 60_000
      ) {
        if (last.steps[0]?.label === step.label && step.label === "edited") {
          last.repeats += 1;
          continue;
        }
        last.steps.unshift({ label: step.label, status: step.status, at: entry.at, actor: entry.actor });
        continue;
      }
      rows.push({
        slug: entry.slug,
        project: entry.project,
        taskId: entry.taskId,
        title: entry.title,
        at: entry.at,
        lastText: entry.text,
        repeats: 1,
        steps: [{ label: step.label, status: step.status, at: entry.at, actor: entry.actor }],
      });
    }
    return rows;
  });
  const activityGroups = createMemo(() => {
    const rows = activityRows();
    const visible = showAllGroups() ? rows : rows.slice(0, 8);
    const groups: Array<{ key: string; label: string; items: typeof visible }> = [];
    const today = new Date(now());
    today.setHours(0, 0, 0, 0);
    const yesterday = today.getTime() - 24 * 3600_000;
    for (const row of visible) {
      const day = new Date(row.at);
      day.setHours(0, 0, 0, 0);
      const key = String(day.getTime());
      const label = day.getTime() === today.getTime() ? "Today" : day.getTime() === yesterday ? "Yesterday" : day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const group = groups.find((candidate) => candidate.key === key);
      if (group) group.items.push(row);
      else groups.push({ key, label, items: [row] });
    }
    return groups;
  });

  // Keyboard: j/k focus the inbox, Enter opens — only when the dashboard is
  // the active view and nothing else holds the keys.
  createEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (slug() !== null || openTaskId() !== null) return;
      if (document.querySelector(".overlay, .popover")) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const rows = inbox();
      if (rows.length === 0) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const delta = event.key === "j" ? 1 : -1;
        setFocused((current) => {
          if (current === -1) return delta > 0 ? 0 : rows.length - 1;
          return Math.max(0, Math.min(rows.length - 1, current + delta));
        });
        const index = focused();
        document.querySelector(`[data-inbox-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && focused() >= 0 && focused() < rows.length && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        const row = rows[focused()]!;
        openTask(row.slug, row.task.id);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const summaryLine = createMemo(() => {
    const countsValue = counts();
    const agents = running().length;
    if (countsValue.all === 0 && agents === 0) return "All clear — nothing waiting on you.";
    const parts: string[] = [];
    if (countsValue.review > 0) parts.push(`${countsValue.review} review${countsValue.review === 1 ? "" : "s"}`);
    if (countsValue.blocked > 0) parts.push(`${countsValue.blocked} blocked task${countsValue.blocked === 1 ? "" : "s"}`);
    const waiting = parts.length > 0 ? `${parts.join(" and ")} waiting` : "nothing waiting";
    return `${waiting} · ${agents} agent${agents === 1 ? "" : "s"} running`;
  });

  return (
    <div class="dashboard" role="main" aria-label="Dashboard">
      <header class="dash-head">
        <div class="dash-head-top">
          <span class="dash-date">{new Date(now()).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
          <span class="dash-live">
            <span class="dash-live-dot" aria-hidden="true" /> live
          </span>
        </div>
        <div class="dash-head-text">
          <h1>{greeting()}</h1>
          <p class="dash-summary" classList={{ calm: counts().all === 0 && running().length === 0 }}>
            {loading() ? "Loading the boards…" : summaryLine()}
          </p>
        </div>
        <div class="dash-kpis" role="group" aria-label="Key numbers">
          <button class="dash-kpi" classList={{ amber: hasStaleWait() }} onClick={focusInbox} aria-label="Waiting on you — jump to the inbox">
            <span class="dash-kpi-value num"><CountUp value={counts().all} /></span>
            <span class="dash-kpi-label">Waiting on you</span>
          </button>
          <button class="dash-kpi" onClick={scrollAgents} aria-label="Agents running — jump to the agents panel">
            <span class="dash-kpi-value num">
              <CountUp value={running().length} />
              <Show when={running().length > 0}>
                <span class="dash-live-dot" aria-hidden="true" />
              </Show>
            </span>
            <span class="dash-kpi-label">Agents running</span>
          </button>
          <button class="dash-kpi" onClick={() => document.querySelector(".dash-next")?.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" })} aria-label="Ready to pick — jump to up next">
            <span class="dash-kpi-value num"><CountUp value={data()?.readyTotal ?? 0} /></span>
            <span class="dash-kpi-label">Ready to pick</span>
          </button>
          <div class="dash-kpi static">
            <span class="dash-kpi-value num"><CountUp value={stats().done7d} /></span>
            <span class="dash-kpi-label">Done 7d</span>
            <span class="dash-spark" aria-hidden="true">
              <For each={throughput()}>
                {(day) => <span class="dash-spark-bar" classList={{ filled: day.count > 0 }} style={{ "--h": `${day.count === 0 ? 12 : Math.max(30, (day.count / Math.max(1, Math.max(...throughput().map((d) => d.count)))) * 100)}%` }} />}
              </For>
            </span>
          </div>
        </div>
      </header>

      <div class="dashboard-grid">
        <section class="sec-inbox" aria-label="Needs you">
          <div class="dash-panel-head">
            <h2>Needs you</h2>
            <Show when={inboxGroups().length > 1}>
              <button class="dash-text-btn dash-collapse-all" onClick={() => setAllCollapsed(!allCollapsed())}>
                {allCollapsed() ? "Expand all" : "Collapse all"}
              </button>
            </Show>
            <div class="dash-chips" role="group" aria-label="Filter inbox">
              <For each={[["all", "All"], ["review", "Review"], ["blocked", "Blocked"]] as const}>
                {([mode, label]) => (
                  <button class={`dash-chip${filter() === mode ? " on" : ""}`} onClick={() => { setFilter(mode); setFocused(-1); }}>
                    {label}
                    <span class="num">{counts()[mode]}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="dash-inbox">
            <Show when={!loading()} fallback={<div class="skeleton" style={{ height: "120px" }} />}>
              <Show
                when={counts().all > 0}
                fallback={
                  <div class="dash-inbox-zero">
                    <Icon.sparkle size={22} />
                    <b>Inbox zero</b>
                    <span>Everything is moving. Go build something.</span>
                  </div>
                }
              >
                <For each={inboxGroups()}>
                  {(group) => (
                    <div class="dash-inbox-group" data-project={group.project}>
                      <button
                        class="dash-group-head"
                        aria-expanded={!group.collapsed}
                        onClick={(event) => { event.stopPropagation(); toggleGroupCollapsed(group.project); }}
                      >
                        <span class={`dash-group-chev${group.collapsed ? " collapsed" : ""}`}>
                          <Icon.chevronDown size={13} />
                        </span>
                        <ProjectTile name={group.project} size={16} />
                        <span class="dash-group-name">{group.project}</span>
                        <span class="dash-group-counts">
                          <Show when={group.review > 0}>
                            <span class="tag pc-badge review"><StatusGlyph status="in_review" size={10} /> {group.review}</span>
                          </Show>
                          <Show when={group.blocked > 0}>
                            <span class="tag pc-badge blocked"><StatusGlyph status="blocked" size={10} /> {group.blocked}</span>
                          </Show>
                          <Show when={group.collapsed}>
                            <span class="dash-group-oldest">oldest {waitAge(new Date(group.oldest).toISOString(), now()).label}</span>
                          </Show>
                        </span>
                      </button>
                      <Show when={!group.collapsed}>
                        <For each={group.visible}>
                          {(item, index) => {
                            const leavingId = `${item.slug}/${item.task.id}`;
                            const rowKey = leavingId;
                            const enters = !enteredRows.has(rowKey);
                            if (enters) enteredRows.add(rowKey);
                            const age = () => waitAge(item.waitingSince, now());
                            const review = () => item.task.status === "in_review";
                            return (
                              <div
                                class={`dash-row status-${item.task.status}${leaving().has(leavingId) ? " leaving" : ""}${focused() === index() ? " focused" : ""}`}
                                classList={{ "dash-row-enter": enters }}
                                data-inbox-index={index()}
                                data-row-key={rowKey}
                                tabindex="0"
                                style={{ "--enter-delay": `${Math.min(index() * 40, 120)}ms` }}
                                onFocus={() => setFocused(index())}
                                onClick={() => openTask(item.slug, item.task.id)}
                                onKeyDown={(event) => event.key === "Enter" && openTask(item.slug, item.task.id)}
                              >
                                <div class="dash-row-line">
                                  <ProjectTile name={item.project} size={20} />
                                  <span class="mono muted">{item.task.id}</span>
                                  <span class="dash-row-title" title={displayTitle(item.task)}>{displayTitle(item.task)}</span>
                                  <StatusGlyph status={item.task.status} size={13} />
                                  <span class={`dash-age${age().old ? " amber" : ""}`} title={`waiting since ${item.waitingSince}`}>{age().label}</span>
                                  <span class="row-actions">
                                    <Show when={review()}>
                                      <button
                                        class="btn approve"
                                        aria-label={`Approve ${item.task.id}`}
                                        onClick={(event) => { event.stopPropagation(); moveTask(item.slug, item.task, "done"); }}
                                      >
                                        <Icon.check size={13} /> Approve
                                      </button>
                                      <button
                                        class="btn"
                                        aria-label={`Send ${item.task.id} back to todo`}
                                        onClick={(event) => { event.stopPropagation(); moveTask(item.slug, item.task, "todo"); }}
                                      >
                                        Rework
                                      </button>
                                    </Show>
                                    <Show when={item.task.status === "blocked"}>
                                      <button class="btn" aria-label={`Answer ${item.task.id}`} onClick={(event) => { event.stopPropagation(); openTask(item.slug, item.task.id); }}>
                                        Answer
                                      </button>
                                    </Show>
                                  </span>
                                </div>
                                <Show when={item.excerpt}>
                                  <div class="dash-row-excerpt" title={item.excerpt ?? undefined}>{item.excerpt}</div>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                        <Show when={group.hidden > 0}>
                          <button class="dash-more" onClick={(event) => { event.stopPropagation(); toggleGroupExpanded(group.project); }}>
                            +{group.hidden} more in {group.project}
                          </button>
                        </Show>
                        <Show when={group.hidden === 0 && group.userExpanded && group.items.length > 3}>
                          <button class="dash-more" onClick={(event) => { event.stopPropagation(); toggleGroupExpanded(group.project); }}>
                            Show fewer in {group.project}
                          </button>
                        </Show>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={capHiddenCount() > 0}>
                  <button class="dash-show-all" onClick={() => setInboxAll(true)}>
                    Show {capHiddenCount()} more
                  </button>
                </Show>
                <Show when={capHiddenCount() === 0 && capsLifted()}>
                  <button class="dash-show-all" onClick={() => setInboxAll(false)}>Show less</button>
                </Show>
              </Show>
            </Show>
            <p class="dash-keys hint">
              <Kbd keys={["j"]} /> <Kbd keys={["k"]} /> move · <Kbd keys={["↵"]} /> open
            </p>
          </div>
        </section>

        <aside class="sec-side">
          <section class="dash-agents" aria-label="Agents running">
            <h2>Agents</h2>
            <Show when={running().length > 0} fallback={<div class="dash-empty"><Icon.sparkle size={16} /> No agents running.</div>}>
              <For each={running()}>
                {(item) => (
                  <button class="dash-agent" onClick={() => openTask(item.slug, item.task.id)} title={`${item.project} · ${item.task.id}`}>
                    <span class="dash-agent-line">
                      <span class="running-tile is-running">
                        <ProjectTile name={item.project} size={18} />
                      </span>
                      <span class="dash-agent-project">{item.project}</span>
                      <span class="dash-agent-time mono">{elapsed(item.task.run?.started)}</span>
                    </span>
                    <span class="dash-agent-line">
                      <span class="mono muted">{item.task.id}</span>
                      <span class="dash-agent-title">{displayTitle(item.task)}</span>
                      <Show when={item.task.run?.mode && item.task.run.mode !== "none"}>
                        <span class="tag">{item.task.run?.mode}</span>
                      </Show>
                      <Show when={item.task.staleness === "stale"}>
                        <span class="tag stale">stale</span>
                      </Show>
                    </span>
                    <span class="dash-shimmer" aria-hidden="true" />
                  </button>
                )}
              </For>
            </Show>
          </section>

          <section class="dash-next" aria-label="Up next">
            <h2>Up next</h2>
            <Show when={(data()?.upNext.length ?? 0) > 0} fallback={<div class="dash-empty">No ready tasks.</div>}>
              <For each={data()?.upNext}>
                {(item) => (
                  <button class="dash-next-row" onClick={() => openTask(item.slug, item.task.id)} title={`${item.project} · ${item.task.id}`}>
                    <PriorityGlyph priority={item.task.priority} />
                    <ProjectTile name={item.project} size={16} />
                    <span class="mono muted">{item.task.id}</span>
                    <span class="dash-next-title">{displayTitle(item.task)}</span>
                  </button>
                )}
              </For>
            </Show>
          </section>
        </aside>

        <section class="sec-mid">
          <div class="dash-throughput" aria-label="Throughput and health">
            <h2>Last 14 days</h2>
            <div class="dash-bars" role="img" aria-label="Done tasks per day, last 14 days">
              <For each={throughput()}>
                {(day, index) => (
                  <span class="dash-bar-col">
                    <Show when={bestDay() === index()}>
                      <span class="dash-best" title={`Best day · ${day.label}`}>▲</span>
                    </Show>
                    <span
                      class={`dash-bar${day.today ? " today" : ""}${day.count > 0 ? " filled" : ""}`}
                      style={{ "--h": `${day.count === 0 ? 8 : Math.max(14, Math.round((day.count / Math.max(1, Math.max(...throughput().map((d) => d.count)))) * 100))}%` }}
                      title={`${day.label} · ${day.count} done`}
                    />
                  </span>
                )}
              </For>
            </div>
            <div class="dash-bar-days" aria-hidden="true">
              <For each={throughput()}>
                {(day) => (
                  <span class="dash-bar-day" classList={{ today: day.today }} title={day.label}>
                    {day.weekday}
                  </span>
                )}
              </For>
            </div>
            <div class="dash-tiles">
              <div class="dash-tile">
                <b class="num"><CountUp value={stats().done7d} /></b>
                <span>done this week</span>
              </div>
              <div class="dash-tile">
                <b>{stats().hasWaits ? formatDuration(stats().medianWait) : "—"}</b>
                <span>{stats().hasWaits ? "median review wait" : "no completed reviews yet"}</span>
              </div>
              <div class="dash-tile">
                <b class="num"><CountUp value={stats().blocked} /></b>
                <span>blocked</span>
              </div>
              <div class="dash-tile">
                <b class="num"><CountUp value={stats().repairs} /></b>
                <span>files need repair</span>
              </div>
            </div>
          </div>

          <section class="sec-projects" aria-label="Projects">
            <div class="dash-panel-head">
              <h2>Projects</h2>
              <div class="dash-chips" role="group" aria-label="Sort projects">
                <For each={[["attention", "Needs attention"], ["recent", "Recently active"], ["name", "Name"]] as const}>
                  {([mode, label]) => (
                    <button class={`dash-chip${sort() === mode ? " on" : ""}`} aria-pressed={sort() === mode} onClick={() => setSort(mode)}>
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={projects.loaded} fallback={<div class="project-grid"><div class="skeleton" style={{ height: "136px" }} /><div class="skeleton" style={{ height: "136px" }} /></div>}>
              <Show when={projects.items.length > 0} fallback={<EmptyProjects />}>
                <div class="project-grid compact">
                  <For each={sortedProjects()}>{(project) => <ProjectCard project={project} dash={dashBySlug().get(project.slug)} />}</For>
                </div>
              </Show>
            </Show>
            <Show when={archivedProjects().length > 0}>
              <ArchivedSection />
            </Show>
          </section>
        </section>

        <section class="sec-activity dash-activity" aria-label="Activity" data-panel="activity">
          <h2>Activity</h2>
          <Show when={!loading()} fallback={<div class="skeleton" style={{ height: "80px" }} />}>
            <Show when={activityGroups().length > 0} fallback={<div class="dash-empty">Nothing in the last two days.</div>}>
              <For each={activityGroups()}>
                {(group) => (
                  <div class="dash-activity-group">
                    <div class="dash-day">{group.label}</div>
                    <div class="dash-rail">
                      <For each={group.items}>
                        {(row) => (
                          <div class="dash-activity-row" data-row-key={`${row.slug}/${row.taskId}/${row.at}`}>
                            <Avatar actor={row.steps[0]?.actor ?? "user"} />
                            <div class="dash-activity-main">
                              <div class="dash-activity-line">
                                <ProjectTile name={row.project} size={15} />
                                <button class="dash-link" onClick={() => openTask(row.slug, row.taskId)}>
                                  <span class="mono muted">{row.taskId}</span>
                                  <span class="dash-activity-title">{row.title}</span>
                                </button>
                                <span class="dash-activity-text" title={row.lastText}>
                                  {row.lastText.replace(/!\[[^\]]*\]\([^)]*\)/g, "").split("\n").find((line) => line.trim()) ?? ""}
                                </span>
                                <Show when={row.repeats > 1}>
                                  <span class="tag dash-times">×{row.repeats}</span>
                                </Show>
                                <span class="dash-when">{relative(row.at, now())}</span>
                              </div>
                              <Show when={row.steps.length > 1 || row.steps[0]?.label !== row.lastText.split(/[: (]/)[0]}>
                                <div class="dash-steps">
                                  <For each={row.steps}>
                                    {(step, index) => (
                                      <>
                                        <Show when={index() > 0}>
                                          <span class="dash-step-arrow" aria-hidden="true">→</span>
                                        </Show>
                                        <span class="dash-step" classList={{ plain: !step.status }} data-status={step.status ?? "note"}>
                                          {step.label}
                                        </span>
                                      </>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
              <Show when={(activityRows().length ?? 0) > 8 && !showAllGroups()}>
                <button class="btn" onClick={() => animateActivity(() => setShowAllGroups(true))}>
                  Show more ({activityRows().length - 8} more)
                </button>
              </Show>
              <Show when={showAllGroups()}>
                <button class="btn" onClick={() => animateActivity(() => setShowAllGroups(false))}>Show less</button>
              </Show>
            </Show>
          </Show>
        </section>
      </div>
    </div>
  );
}

/** Height FLIP for expand/collapse (UNI-67). Containers matching
 *  `containerSel` are measured by `data-<keyAttr>` before `mutate`, looked up
 *  again after (Solid may recreate them), and transitioned between the two
 *  heights. Rows matching `rowSel` whose data-row-key was not rendered before
 *  fade in, staggered. No-op animation under prefers-reduced-motion. */
function animateHeights(containerSel: string, keyAttr: string, rowSel: string, mutate: () => void): void {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    mutate();
    return;
  }
  const before = new Map<string, number>();
  for (const el of document.querySelectorAll<HTMLElement>(containerSel)) {
    before.set(el.dataset[keyAttr] ?? "", el.getBoundingClientRect().height);
  }
  const seenRows = new Set([...document.querySelectorAll<HTMLElement>(rowSel)].map((el) => el.dataset.rowKey));
  mutate();
  let revealIndex = 0;
  for (const row of document.querySelectorAll<HTMLElement>(rowSel)) {
    if (seenRows.has(row.dataset.rowKey)) continue;
    row.classList.remove("dash-row-enter");
    row.style.setProperty("--reveal-delay", `${Math.min(revealIndex * 30, 180)}ms`);
    row.classList.add("dash-row-reveal");
    row.addEventListener("animationend", () => row.classList.remove("dash-row-reveal"), { once: true });
    revealIndex += 1;
  }
  for (const el of document.querySelectorAll<HTMLElement>(containerSel)) {
    const from = before.get(el.dataset[keyAttr] ?? "");
    if (from === undefined) continue;
    const to = el.getBoundingClientRect().height;
    if (Math.abs(from - to) <= 1) continue;
    el.style.overflow = "hidden";
    el.style.height = `${from}px`;
    void el.offsetHeight;
    el.style.transition = "height 220ms cubic-bezier(.2,.8,.2,1)";
    el.style.height = `${to}px`;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      el.style.height = "";
      el.style.overflow = "";
      el.style.transition = "";
    };
    el.addEventListener("transitionend", (event) => event.target === el && finish());
    setTimeout(finish, 320);
  }
}

/** Active vs archived split — dashboard and overview both use it. */
const archivedProjects = () => projects.items.filter((project) => project.archived);

function EmptyProjects(): JSX.Element {
  return (
    <div class="empty-state">
      <div class="art">
        <Icon.board size={24} />
      </div>
      <h2>No projects yet</h2>
      <p>
        Register one with <code>/unipi:kanboard onboard</code> in pi, or <code>unipi-kanboard project add</code>.
      </p>
    </div>
  );
}

const SEGMENTS = ["backlog", "todo", "in_progress", "blocked", "in_review", "done"];
function laneLabelClient(id: string): string {
  return ({ backlog: "Backlog", todo: "Todo", in_progress: "In Progress", blocked: "Blocked", in_review: "In Review", done: "Done", cancelled: "Cancelled", archived: "Archive" })[id] ?? id;
}

function ProjectCard(props: { project: ProjectSummary; dash?: DashboardData["projects"][number]; archived?: boolean }): JSX.Element {
  const project = props.project;
  return (
    <div class="project-card" role="group" style={{ "--project-hue": hue(project.name) }}>
      <button class="pc-open" onClick={() => void openProject(project.slug)}>
        <div class="pc-head">
          <span class="running-tile" classList={{ "is-running": (project.running ?? 0) > 0 }}>
            <ProjectTile name={project.name} size={28} />
          </span>
          <div style={{ "min-width": 0 }}>
            <div class="pc-name">{project.name}</div>
            <div class="pc-path">{project.root ?? project.slug}</div>
          </div>
          <span class="pc-updated">{relative(project.updatedAt, Date.now())}</span>
        </div>
        <Show when={props.dash}>
          {(dash) => (
            <div class="pc-badges">
              <Show when={dash().review > 0}>
                <span class="tag pc-badge review"><StatusGlyph status="in_review" size={11} /> {dash().review} review</span>
              </Show>
              <Show when={dash().blocked > 0}>
                <span class="tag pc-badge blocked"><StatusGlyph status="blocked" size={11} /> {dash().blocked} blocked</span>
              </Show>
              <Show when={dash().ready > 0}>
                <span class="tag pc-badge ready"><StatusGlyph status="todo" size={11} /> {dash().ready} ready</span>
              </Show>
            </div>
          )}
        </Show>
        <div class="stack-bar" aria-hidden="true">
          <For each={SEGMENTS}>
            {(status) => (
              <Show when={(project.counts?.[status] ?? 0) > 0}>
                <span style={{ flex: String(project.counts?.[status] ?? 0), background: `var(--s-${status})` }} />
              </Show>
            )}
          </For>
        </div>
        <div class="pc-stats">
          <For each={SEGMENTS.filter((status) => (project.counts?.[status] ?? 0) > 0)}>
            {(status) => (
              <span>
                <StatusGlyph status={status} size={12} />
                <span class="num">{project.counts?.[status]}</span> {laneLabelClient(status)}
              </span>
            )}
          </For>
          <Show when={(project.total ?? 0) === 0}>
            <span>No tasks yet</span>
          </Show>
        </div>
        <Show when={(project.problems ?? []).length > 0}>
          <span class="tag stale">{(project.problems ?? []).length} file(s) need repair</span>
        </Show>
      </button>
      <Popover
        width={180}
        align="end"
        label={`${project.name} options`}
        trigger={(api) => (
          <button class="icon-btn sm pc-menu" ref={api.ref} aria-expanded={api.open} aria-label={`${project.name} options`} onClick={api.toggle}>
            <Icon.more size={14} />
          </button>
        )}
      >
        {(close) => (
          <MenuItem
            icon={<Icon.archive size={14} />}
            label={props.archived ? "Unarchive" : "Archive"}
            onSelect={() => {
              close();
              void api
                .updateProject(project.slug, { archived: !props.archived })
                .then(loadProjects)
                .catch((error) => toast(describe(error), "error"));
            }}
          />
        )}
      </Popover>
    </div>
  );
}

function ArchivedSection(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="archived-section">
      <button class="archived-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Show when={open()} fallback={<Icon.chevronRight size={14} />}>
          <Icon.chevronDown size={14} />
        </Show>
        Archived ({archivedProjects().length})
      </button>
      <Show when={open()}>
        <div class="project-grid">
          <For each={archivedProjects()}>{(project) => <ProjectCard project={project} archived />}</For>
        </div>
      </Show>
    </div>
  );
}
