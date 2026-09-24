/** App shell: top bar, project picker, board, panels, toasts, repair banner. */

import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { LANES, type ProjectSummary, type Task } from "./api.js";
import { Board } from "./Board.js";
import { Icon } from "./icons.js";
import { CommentModal, NewTaskDialog, TaskPanel, Toasts } from "./TaskPanel.js";
import {
  applyTheme,
  board,
  conn,
  loadBoard,
  loadProjects,
  loadRules,
  projects,
  query,
  setOpenTaskId,
  setQuery,
  setShowArchive,
  showArchive,
  watchBoard,
  theme,
  toast,
} from "./state.js";

const LANE_COLORS: Record<string, string> = {
  backlog: "#8b93a1",
  todo: "#60a5fa",
  in_progress: "#fbbf24",
  in_review: "#a78bfa",
  blocked: "#f87171",
  done: "#4ade80",
  cancelled: "#6b7280",
  archived: "#4b5563",
};

export function App(): JSX.Element {
  const [slug, setSlug] = createSignal<string | null>(new URLSearchParams(location.search).get("project"));
  const [commentRequest, setCommentRequest] = createSignal<{ task: Task; to: string; hint: string } | null>(null);
  const [newTaskLane, setNewTaskLane] = createSignal<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = createSignal(false);

  onMount(() => {
    applyTheme(theme());
    void (async () => {
      await Promise.all([loadProjects(), loadRules()]);
      const requested = slug() ?? projects.items[0]?.slug ?? null;
      if (requested) await openProject(requested);
    })();
  });

  async function openProject(next: string): Promise<void> {
    setSlug(next);
    history.replaceState(null, "", `?project=${encodeURIComponent(next)}`);
    await loadBoard(next);
    watchBoard(next);
    const missing = board.problems.length;
    if (missing > 0) toast(`${missing} task file(s) need repair — run unipi-kanboard validate --fix`, "warning");
  }

  async function refresh(): Promise<void> {
    const current = slug();
    if (current) await loadBoard(current);
    await Promise.all([loadProjects(), loadRules()]);
  }

  const currentProject = (): ProjectSummary | undefined => projects.items.find((project) => project.slug === slug());

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <Icon.board size={18} />
          <span>kanboard</span>
        </div>

        <Show when={slug() !== null}>
          <div style={{ position: "relative" }}>
            <button aria-haspopup="listbox" aria-expanded={switcherOpen()} onClick={() => setSwitcherOpen(!switcherOpen())}>
              {currentProject()?.name ?? slug()}
              <Icon.chevron size={14} />
            </button>
            <Show when={switcherOpen()}>
              <ul
                role="listbox"
                class="stack"
                style={{
                  position: "absolute", top: "calc(100% + 6px)", left: 0, "z-index": 30, margin: 0, padding: "6px",
                  "list-style": "none", background: "var(--surface)", border: "1px solid var(--border)",
                  "border-radius": "10px", "box-shadow": "var(--shadow)", "min-width": "260px",
                }}
              >
                <For each={projects.items}>
                  {(project) => (
                    <li>
                      <button
                        class="ghost"
                        style={{ width: "100%", "text-align": "left" }}
                        onClick={() => {
                          setSwitcherOpen(false);
                          void openProject(project.slug);
                        }}
                      >
                        <span class="grow">{project.name}</span>
                        <span class="meta">{project.total ?? 0}</span>
                      </button>
                    </li>
                  )}
                </For>
                <li>
                  <button class="ghost" style={{ width: "100%", "text-align": "left" }} onClick={() => { setSwitcherOpen(false); setSlug(null); history.replaceState(null, "", location.pathname); }}>
                    All projects
                  </button>
                </li>
              </ul>
            </Show>
          </div>
        </Show>

        <Show when={slug() !== null}>
          <label class="search">
            <Icon.search size={14} />
            <span class="sr-only">Filter tasks</span>
            <input placeholder="Filter tasks…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
          </label>
        </Show>

        <span class="spacer" />

        <Show when={slug() !== null}>
          <button onClick={() => setShowArchive(!showArchive())} title="Toggle the archive lane">
            <Icon.arch size={14} />
            {showArchive() ? "Hide archive" : "Archive"}
          </button>
          <button class="primary" onClick={() => setNewTaskLane("backlog")}>
            <Icon.plus size={14} />
            New task
          </button>
          <button class="ghost icon" aria-label="Refresh" title="Refresh" onClick={() => void refresh()}>
            <Icon.dot size={12} />
          </button>
        </Show>

        <span class={`conn ${conn() === "live" ? "live" : conn() === "reconnecting" ? "down" : ""}`} title={`live updates: ${conn()}`}>
          <span class="led" />
          {conn()}
        </span>
        <button class="ghost icon" aria-label="Toggle theme" title="Toggle light/dark" onClick={() => applyTheme(theme() === "dark" ? "light" : "dark")}>
          <Show when={theme() === "dark"} fallback={<Icon.moon size={15} />}>
            <Icon.sun size={15} />
          </Show>
        </button>
      </header>

      <Show
        when={slug() !== null}
        fallback={<ProjectPicker onPick={(target: string) => void openProject(target)} />}
      >
        <Show when={board.problems.length > 0}>
          <div class="banner" role="alert">
            <Icon.warn size={16} />
            <div>
              <strong>
                {board.problems.length} task file{board.problems.length === 1 ? "" : "s"} need repair
              </strong>
              <ul>
                <For each={board.problems.slice(0, 6)}>
                  {(problem) => (
                    <li>
                      <span class="mono">{problem.file}:{problem.line}</span> {problem.error}
                    </li>
                  )}
                </For>
              </ul>
              <div class="meta">
                Run <code>unipi-kanboard validate --fix</code> — the rest of the board keeps working.
              </div>
            </div>
          </div>
        </Show>
        <Board
          slug={slug()!}
          onOpenTask={(id) => setOpenTaskId(id)}
          onNeedsComment={(task, to, hint) => setCommentRequest({ task, to, hint })}
          onNewTask={(lane) => setNewTaskLane(lane)}
        />
      </Show>

      <TaskPanel slug={slug() ?? ""} onClose={() => setOpenTaskId(null)} />
      <CommentModal request={commentRequest()} slug={slug() ?? ""} onClose={() => setCommentRequest(null)} />
      <NewTaskDialog slug={slug() ?? ""} lane={newTaskLane()} onClose={() => setNewTaskLane(null)} />
      <Toasts />
    </div>
  );
}

function ProjectPicker(props: { onPick: (slug: string) => void }): JSX.Element {
  return (
    <div class="picker">
      <h1>Projects</h1>
      <p class="muted">Every project registered on this machine. Pick one to open its board.</p>
      <Show when={!projects.loaded}>
        <div class="projects">
          <div class="skeleton" style={{ height: "120px" }} />
          <div class="skeleton" style={{ height: "120px" }} />
        </div>
      </Show>
      <Show when={projects.loaded && projects.items.length === 0}>
        <div class="empty">
          <Icon.board size={24} />
          <p>
            No projects yet. Register one from a terminal: <code>unipi-kanboard project add</code>, or run{" "}
            <code>/unipi:kanboard onboard</code> in pi.
          </p>
        </div>
      </Show>
      <div class="projects">
        <For each={projects.items}>
          {(project) => (
            <button class="project-card" onClick={() => props.onPick(project.slug)}>
              <span class="name">{project.name}</span>
              <span class="path">{project.root ?? project.slug}</span>
              <span class="bar" aria-hidden="true">
                <For each={LANES}>
                  {(lane) => (
                    <span
                      style={{
                        width: `${project.total ? ((project.counts?.[lane.id] ?? 0) / project.total) * 100 : 0}%`,
                        background: LANE_COLORS[lane.id],
                      }}
                    />
                  )}
                </For>
              </span>
              <span class="bar-legend">
                <span>{project.total ?? 0} tasks</span>
                <For each={LANES.filter((lane) => (project.counts?.[lane.id] ?? 0) > 0)}>
                  {(lane) => (
                    <span>
                      {lane.label} {project.counts?.[lane.id]}
                    </span>
                  )}
                </For>
              </span>
              <Show when={(project.problems ?? []).length > 0}>
                <span class="chip stale">{(project.problems ?? []).length} file(s) need repair</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
