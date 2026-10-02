/** App shell: sidebar + inset sheet (breadcrumb, toolbar, board/list), overlays, global keys. */

import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { api, displayTitle, LANES, PRIORITIES, type ProjectSummary } from "./api.js";
import { Board } from "./Board.js";
import { BoardSummarizeDialog, CommandPalette, CommentDialog, NewTaskDialog, SettingsDialog, ShortcutsDialog, SummarizeDialog, Toasts } from "./Dialogs.js";
import { Icon, PRIORITY_LABEL, PriorityGlyph, StatusGlyph } from "./icons.js";
import { Dashboard } from "./dashboard.js";
import { ListView } from "./List.js";
import { hue, ProjectTile } from "./paint.js";
import { TaskPanel } from "./TaskPanel.js";
import {
  allLabels,
  applyTheme,
  board,
  globalRunning,
  setBoardSummarizeOpen,
  clearFilters,
  conn,
  currentProject,
  describe,
  display,
  elapsed,
  filterCount,
  filters,
  laneLabel,
  loadProjects,
  loadRules,
  matches,
  moveSelection,
  openProject,
  openTaskId,
  paletteOpen,
  projects,
  query,
  scope,
  selectedId,
  setSelectedId,
  setDisplay,
  setFilters,
  setNewTaskLane,
  setOpenTaskId,
  setPaletteOpen,
  setQuery,
  setSettingsOpen,
  setShortcutsOpen,
  setSidebarCollapsed,
  setView,
  sidebarCollapsed,
  slug,
  theme,
  toast,
  toggleLane,
  toggleTheme,
  view,
} from "./state.js";
import { drawerDirty } from "./TaskPanel.js";
import { ContextMenu, Kbd, MenuItem, MenuLabel, MenuSeparator, MOD, Popover } from "./ui.js";

/** Shared sidebar project actions — the … popover and right-click menu both
 *  render these (UNI-51). */
function projectMenuItems(
  project: ProjectSummary,
  archived: boolean,
  close: () => void,
  setArchived: (project: ProjectSummary, archived: boolean) => void,
): JSX.Element {
  return (
    <>
      <MenuItem
        icon={<Icon.board size={14} />}
        label="Open"
        onSelect={() => {
          close();
          void openProject(project.slug);
        }}
      />
      <MenuItem
        icon={<Icon.archive size={14} />}
        label={archived ? "Unarchive" : "Archive"}
        onSelect={() => {
          close();
          setArchived(project, !archived);
        }}
      />
    </>
  );
}

/** Active vs archived split — sidebar, switcher and overview all use it. */
const activeProjects = createMemo(() => projects.items.filter((project) => !project.archived));
const archivedProjects = createMemo(() => projects.items.filter((project) => project.archived));

export function App(): JSX.Element {
  let searchInput: HTMLInputElement | undefined;

  onMount(() => {
    applyTheme(theme());
    void (async () => {
      await Promise.all([loadProjects(), loadRules()]);
      const requested = slug() ?? (projects.items.length === 1 ? projects.items[0]!.slug : null);
      await openProject(requested && projects.items.some((project) => project.slug === requested) ? requested : requested ?? null);
      if (board.problems.length > 0) toast(`${board.problems.length} task file(s) need repair`, "warning");
    })();

    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(!paletteOpen());
        return;
      }
      if (typing || mod || event.altKey) return;
      if (document.querySelector(".overlay, .popover")) return;
      const drawerOpen = openTaskId() !== null;
      switch (event.key) {
        case "c":
          if (slug()) {
            event.preventDefault();
            setNewTaskLane("backlog");
          }
          break;
        case "[":
          event.preventDefault();
          setSidebarCollapsed(!sidebarCollapsed());
          break;
        case "/":
          if (slug()) {
            event.preventDefault();
            searchInput?.focus();
          }
          break;
        case "j":
        case "ArrowDown":
          if (!drawerOpen && slug()) {
            event.preventDefault();
            moveSelection(1);
          }
          break;
        case "k":
        case "ArrowUp":
          if (!drawerOpen && slug()) {
            event.preventDefault();
            moveSelection(-1);
          }
          break;
        case "Enter":
          if (!drawerOpen && selectedId() && !(target instanceof HTMLButtonElement)) {
            event.preventDefault();
            setOpenTaskId(selectedId());
          }
          break;
        case "b":
          setView("board");
          break;
        case "l":
          setView("list");
          break;
        case "?":
          setShortcutsOpen(true);
          break;
        case "Escape":
          // UNI-61: a dirty drawer is protected — Esc on it opens the discard
          // prompt instead of silently throwing the drafts away.
          if (drawerOpen) {
            if (!drawerDirty()) setOpenTaskId(null);
          } else if (query()) setQuery("");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const shown = createMemo(() => board.tasks.filter((task) => matches(task) && !display.hidden.includes(task.status)).length);

  return (
    <div class={`app${sidebarCollapsed() ? " collapsed" : ""}`}>
      <Sidebar />

      <main class={`sheet density-${display.density}`}>
        <header class="sheet-head">
          <MobileMenu />
          <nav class="crumbs" aria-label="Breadcrumb">
            <Show when={sidebarCollapsed()}>
              <button class="icon-btn" aria-label="Expand sidebar" title="Expand sidebar  [" onClick={() => setSidebarCollapsed(false)}>
                <Icon.sidebar />
              </button>
            </Show>
            <Show when={slug()} fallback={<span class="crumb here">All projects</span>}>
              <button class="crumb" onClick={() => void openProject(null)}>
                Projects
              </button>
              <Icon.chevronRight size={14} />
              <button
                class="crumb crumb-link"
                title="Back to the board"
                onClick={() => {
                  setOpenTaskId(null);
                  setSelectedId(null);
                  clearFilters();
                  setView("board");
                }}
              >
                {currentProject()?.name ?? slug()}
              </button>
              <Icon.chevronRight size={14} class="crumb-sep" />
              <span class="crumb here">
                {scope() === "in_review" ? "Review queue" : scope() === "blocked" ? "Blocked" : view() === "list" ? "List" : "Board"}
              </span>
            </Show>
          </nav>
          <span class="spacer" />
          <Show when={slug()}>
            <span class="total num">
              {shown()} {shown() === 1 ? "task" : "tasks"}
            </span>
            <button
              class="btn"
              aria-label="Summarize board"
              title="Summarize the whole board"
              onClick={() => setBoardSummarizeOpen(true)}
            >
              <Icon.sparkle size={14} />
              <span class="label-txt">Summarize</span>
            </button>
            <button class="btn primary" onClick={() => setNewTaskLane("backlog")} title="New task  C" aria-label="New task">
              <Icon.plus size={14} />
              <span class="label-txt">New task</span>
            </button>
          </Show>
        </header>

        <Show when={slug()} fallback={<Dashboard />}>
          <div class="toolbar">
            <div class="segmented" role="group" aria-label="View">
              <button class="btn" aria-pressed={view() === "board" && scope() === "all"} onClick={() => setView("board")}>
                <Icon.board size={14} />
                Board
              </button>
              <button class="btn" aria-pressed={view() === "list" && scope() === "all"} onClick={() => setView("list")}>
                <Icon.list size={14} />
                List
              </button>
            </div>
            <label class="search">
              <Icon.search size={14} />
              <span class="sr-only">Filter tasks</span>
              <input
                ref={searchInput}
                class="input"
                placeholder="Search tasks"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    event.currentTarget.blur();
                  }
                }}
              />
              <Show when={!query()}>
                <kbd>/</kbd>
              </Show>
            </label>
            <FilterMenu />
            <DisplayMenu />
            <Show when={filterCount() > 0 || query()}>
              <button class="btn" onClick={clearFilters}>
                Clear
              </button>
            </Show>
          </div>

          <Show when={board.problems.length > 0}>
            <div class="banner" role="alert">
              <Icon.warn size={16} />
              <div>
                <strong>
                  {board.problems.length} task file{board.problems.length === 1 ? "" : "s"} can't be read
                </strong>{" "}
                — the rest of the board keeps working.
                <ul>
                  <For each={board.problems.slice(0, 4)}>
                    {(problem) => (
                      <li>
                        <code>
                          {problem.file}:{problem.line}
                        </code>{" "}
                        {problem.error}
                      </li>
                    )}
                  </For>
                </ul>
                Repair with <code>unipi-kanboard validate --fix</code>
              </div>
            </div>
          </Show>

          <Show when={view() === "board"} fallback={<ListView />}>
            <Board />
          </Show>
        </Show>
      </main>

      <TaskPanel />
      <CommentDialog />
      <NewTaskDialog />
      <SummarizeDialog />
      <BoardSummarizeDialog />
      <SettingsDialog />
      <CommandPalette />
      <ShortcutsDialog />
      <Toasts />
    </div>
  );
}

// ─── sidebar ────────────────────────────────────────────────────────────────

function Sidebar(): JSX.Element {
  const counts = (status: string): number => board.tasks.filter((task) => task.status === status).length;
  const isHere = (target: "board" | "list" | "dashboard", targetScope: "all" | "in_review" | "blocked" = "all"): boolean => {
    if (target === "dashboard") return slug() === null;
    return !!slug() && view() === target && scope() === targetScope;
  };
  const openCount = (project: ProjectSummary): number =>
    ["backlog", "todo", "in_progress", "in_review", "blocked"].reduce((sum, status) => sum + (project.counts?.[status] ?? 0), 0);

  /** Archive/unarchive from the sidebar (UNI-51). */
  const setArchived = (project: ProjectSummary, archived: boolean): void => {
    void api
      .updateProject(project.slug, { archived })
      .then(() => loadProjects())
      .then(() => toast(archived ? `Archived ${project.name}` : `Unarchived ${project.name}`, "success"))
      .catch((error) => toast(describe(error), "error"));
  };
  /** Right-click menu state for sidebar project rows (UNI-51). */
  const [rowMenu, setRowMenu] = createSignal<{ x: number; y: number; project: ProjectSummary } | null>(null);

  return (
    <aside class="sidebar" aria-label="Sidebar">
      <div class="sb-head">
        <Popover
          width={260}
          label="Switch project"
          trigger={(api) => (
            <button class="workspace" ref={api.ref} aria-expanded={api.open} aria-haspopup="menu" onClick={api.toggle} title={currentProject()?.root}>
              <Show when={currentProject()} fallback={<Icon.logo size={22} />}>
                {(project) => (
                  <RunningTile project={project()} size={22}>
                    <ProjectTile name={project().name} size={22} />
                  </RunningTile>
                )}
              </Show>
              <span class="ws-name">{currentProject()?.name ?? "kanboard"}</span>
              <Icon.chevronDown size={14} class="ws-chevron" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuLabel>Projects</MenuLabel>
              <For each={activeProjects()}>
                {(project) => (
                  <MenuItem
                    role="option"
                    icon={<ProjectTile name={project.name} size={16} />}
                    label={project.name}
                    hint={<span class="num">{openCount(project)}</span>}
                    checked={project.slug === slug()}
                    onSelect={() => {
                      close();
                      void openProject(project.slug);
                    }}
                  />
                )}
              </For>
              <MenuSeparator />
              <MenuItem
                icon={<Icon.folder size={14} />}
                label="All projects"
                onSelect={() => {
                  close();
                  void openProject(null);
                }}
              />
            </>
          )}
        </Popover>
        <button class="icon-btn" aria-label="Collapse sidebar" title="Collapse sidebar  [" onClick={() => setSidebarCollapsed(true)}>
          <Icon.sidebar />
        </button>
      </div>

      <button class="search-trigger" onClick={() => setPaletteOpen(true)} title={`Search  ${MOD}K`}>
        <Icon.search size={14} />
        <span>Search…</span>
        <Kbd keys={[MOD, "K"]} />
      </button>

      <div class="sb-scroll">
        <button
          class="nav-item dashboard-nav"
          aria-current={isHere("dashboard") ? "page" : undefined}
          onClick={() => void openProject(null)}
          title="Dashboard — every project at a glance"
        >
          <Icon.folder />
          <span class="label">Dashboard</span>
          <Show when={projects.loaded}>
            <span class="count">{activeProjects().length}</span>
          </Show>
        </button>
        <Show when={slug()}>
          <button class="nav-item" aria-current={isHere("board") ? "page" : undefined} onClick={() => setView("board")} title="Board">
            <Icon.board />
            <span class="label">Board</span>
          </button>
          <button class="nav-item" aria-current={isHere("list") ? "page" : undefined} onClick={() => setView("list")} title="List">
            <Icon.list />
            <span class="label">List</span>
          </button>
          <button
            class="nav-item"
            aria-current={isHere("list", "in_review") ? "page" : undefined}
            onClick={() => setView("list", "in_review")}
            title="Review queue"
          >
            <Icon.review />
            <span class="label">Review queue</span>
            <Show when={counts("in_review") > 0}>
              <span class="count">{counts("in_review")}</span>
            </Show>
          </button>
          <button
            class="nav-item"
            aria-current={isHere("list", "blocked") ? "page" : undefined}
            onClick={() => setView("list", "blocked")}
            title="Blocked"
          >
            <Icon.blocked />
            <span class="label">Blocked</span>
            <Show when={counts("blocked") > 0}>
              <span class="count">{counts("blocked")}</span>
            </Show>
          </button>
        </Show>

        <div class="sb-section">
          Projects
          <span class="count num">{activeProjects().length}</span>
        </div>
        <For each={activeProjects()}>
          {(project) => (
            <div
              class="nav-row"
              onContextMenu={(event) => {
                event.preventDefault();
                setRowMenu({ x: event.clientX, y: event.clientY, project });
              }}
            >
              <button
                class="nav-item"
                aria-current={project.slug === slug() ? "page" : undefined}
                onClick={() => void openProject(project.slug)}
                title={project.name}
              >
                <RunningTile project={project} size={18}>
                  <ProjectTile name={project.name} size={18} />
                </RunningTile>
                <span class="label">{project.name}</span>
                <span class="count">{openCount(project)}</span>
              </button>
            </div>
          )}
        </For>
        <ContextMenu
          at={rowMenu() ? { x: rowMenu()!.x, y: rowMenu()!.y } : null}
          label="Project actions"
          onClose={() => setRowMenu(null)}
        >
          <Show when={rowMenu()}>
            {(menu) => projectMenuItems(menu().project, false, () => setRowMenu(null), setArchived)}
          </Show>
        </ContextMenu>
        <Show when={projects.loaded && activeProjects().length === 0}>
          <div class="sb-empty">No projects registered.</div>
        </Show>

        <Show when={archivedProjects().length > 0}>
          <ArchivedProjectsSection onUnarchive={(project) => setArchived(project, false)} />
        </Show>

        <div class="agents">
          <div class="sb-section">
            Agents
            <Show when={globalRunning.items.length > 0}>
              <span class="count num">{globalRunning.items.length} running</span>
            </Show>
          </div>
          <For each={globalRunning.items} fallback={<div class="sb-empty">No agents running.</div>}>
            {(item) => (
              <button
                class="agent-row"
                title={`${item.project} · ${item.task.id}`}
                onClick={() => {
                  void openProject(item.slug).then(() => setOpenTaskId(item.task.id));
                }}
              >
                <span class="agent-dot">
                  <span class="pulse" />
                </span>
                <span class="agent-title">
                  <span class="agent-project">{item.project}</span>
                  <span class="mono muted">{item.task.id}</span> {displayTitle(item.task)}
                </span>
                <span class="agent-time">{elapsed(item.task.run?.started)}</span>
                <span class="agent-meta">agent · session {item.task.run?.session ?? "?"}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="sb-foot">
        <img class="sb-logo" src="/icon-32.png" width="18" height="18" alt="" />
        <div class="daemon" title={`Live updates: ${conn()}`}>
          <span class={`led ${slug() ? conn() : ""}`} />
          <span class="where">{location.host}</span>
        </div>
        <button class="icon-btn keep" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
          <Icon.gear />
        </button>
        <button class="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts  ?" onClick={() => setShortcutsOpen(true)}>
          <Icon.keyboard />
        </button>
        <button class="icon-btn keep" aria-label="Toggle theme" title="Toggle theme" onClick={toggleTheme}>
          <Show when={theme() === "dark"} fallback={<Icon.moon />}>
            <Icon.sun />
          </Show>
        </button>
      </div>
    </aside>
  );
}

/** Project tile with the rotating yellow ring while agents run (UNI-51);
 *  the ring sits still under prefers-reduced-motion. */
function RunningTile(props: { project: ProjectSummary; size: number; children: JSX.Element }): JSX.Element {
  return (
    <span
      class="running-tile"
      classList={{ "is-running": (props.project.running ?? 0) > 0 }}
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      title={(props.project.running ?? 0) > 0 ? `${props.project.running} agent(s) running` : undefined}
    >
      {props.children}
    </span>
  );
}

/** Collapsed list of archived projects in the sidebar (UNI-51). */
function ArchivedProjectsSection(props: { onUnarchive: (project: ProjectSummary) => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [rowMenu, setRowMenu] = createSignal<{ x: number; y: number; project: ProjectSummary } | null>(null);
  return (
    <div class="sb-archived">
      <button class="sb-section as-button" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Show when={open()} fallback={<Icon.chevronRight size={12} />}>
          <Icon.chevronDown size={12} />
        </Show>
        Archived
        <span class="count num">{archivedProjects().length}</span>
      </button>
      <Show when={open()}>
        <For each={archivedProjects()}>
          {(project) => (
            <div
              class="nav-row archived"
              onContextMenu={(event) => {
                event.preventDefault();
                setRowMenu({ x: event.clientX, y: event.clientY, project });
              }}
            >
              <button class="nav-item" onClick={() => void openProject(project.slug)} title={`${project.name} (archived)`}>
                <ProjectTile name={project.name} size={16} />
                <span class="label">{project.name}</span>
              </button>
            </div>
          )}
        </For>
        <ContextMenu
          at={rowMenu() ? { x: rowMenu()!.x, y: rowMenu()!.y } : null}
          label="Project actions"
          onClose={() => setRowMenu(null)}
        >
          <Show when={rowMenu()}>
            {(menu) => projectMenuItems(menu().project, true, () => setRowMenu(null), (project) => props.onUnarchive(project))}
          </Show>
        </ContextMenu>
      </Show>
    </div>
  );
}

// ─── toolbar menus ──────────────────────────────────────────────────────────

function FilterMenu(): JSX.Element {
  const togglePriority = (priority: string): void =>
    setFilters("priorities", (current) => (current.includes(priority) ? current.filter((item) => item !== priority) : [...current, priority]));
  const toggleLabel = (label: string): void =>
    setFilters("labels", (current) => (current.includes(label) ? current.filter((item) => item !== label) : [...current, label]));
  return (
    <Popover
      width={236}
      label="Filter"
      trigger={(api) => (
        <button class={`btn${filterCount() > 0 ? " on" : ""}`} ref={api.ref} aria-expanded={api.open} onClick={api.toggle}>
          <Icon.filter size={14} />
          Filter
          <Show when={filterCount() > 0}>
            <span class="count-badge">{filterCount()}</span>
          </Show>
        </button>
      )}
    >
      {() => (
        <>
          <MenuLabel>Priority</MenuLabel>
          <For each={[...PRIORITIES].reverse()}>
            {(priority) => (
              <MenuItem
                role="menuitemcheckbox"
                icon={<PriorityGlyph priority={priority} />}
                label={PRIORITY_LABEL[priority]}
                checked={filters.priorities.includes(priority)}
                onSelect={() => togglePriority(priority)}
              />
            )}
          </For>
          <MenuSeparator />
          <MenuLabel>Agent</MenuLabel>
          <MenuItem
            role="menuitemcheckbox"
            icon={<Icon.sparkle size={14} />}
            label="Running now"
            checked={filters.running}
            onSelect={() => setFilters("running", !filters.running)}
          />
          <MenuItem
            role="menuitemcheckbox"
            icon={<Icon.lock size={14} />}
            label="Waiting on dependencies"
            checked={filters.waiting}
            onSelect={() => setFilters("waiting", !filters.waiting)}
          />
          <Show when={allLabels().length > 0}>
            <MenuSeparator />
            <MenuLabel>Labels</MenuLabel>
            <For each={allLabels()}>
              {(label) => (
                <MenuItem
                  role="menuitemcheckbox"
                  icon={<span class="label-dot" style={{ width: "8px", height: "8px", "border-radius": "50%", background: hue(label) }} />}
                  label={label}
                  checked={filters.labels.includes(label)}
                  onSelect={() => toggleLabel(label)}
                />
              )}
            </For>
          </Show>
        </>
      )}
    </Popover>
  );
}

function DisplayMenu(): JSX.Element {
  return (
    <Popover
      width={280}
      label="Display options"
      trigger={(api) => (
        <button class="btn" ref={api.ref} aria-expanded={api.open} onClick={api.toggle}>
          <Icon.sliders size={14} />
          Display
        </button>
      )}
    >
      {() => (
        <>
          <MenuLabel>Columns</MenuLabel>
          <div class="lane-toggles">
            <For each={LANES}>
              {(lane) => (
                <button class="lane-toggle" aria-pressed={!display.hidden.includes(lane.id)} onClick={() => toggleLane(lane.id)}>
                  <StatusGlyph status={lane.id} size={12} />
                  {laneLabel(lane.id)}
                </button>
              )}
            </For>
          </div>
          <MenuSeparator />
          <div class="display-row">
            Group linked tasks
            <button class="switch" role="switch" aria-checked={display.chains} aria-label="Group linked tasks" onClick={() => setDisplay("chains", !display.chains)} />
          </div>
          <div class="display-row">
            Show description excerpt
            <button class="switch" role="switch" aria-checked={display.excerpt} aria-label="Show description excerpt" onClick={() => setDisplay("excerpt", !display.excerpt)} />
          </div>
          <div class="display-row">
            Compact cards
            <button
              class="switch"
              role="switch"
              aria-checked={display.density === "compact"}
              aria-label="Compact cards"
              onClick={() => setDisplay("density", display.density === "compact" ? "comfortable" : "compact")}
            />
          </div>
        </>
      )}
    </Popover>
  );
}

// ─── all projects ───────────────────────────────────────────────────────────

/** ≤720px: the rail collapses into a logo button that opens this menu. */
function MobileMenu(): JSX.Element {
  const counts = (status: string): number => board.tasks.filter((task) => task.status === status).length;
  return (
    <div class="mobile-menu">
      <Popover
        width={280}
        label="Menu"
        trigger={(api) => (
          <button class="mobile-logo" ref={api.ref} aria-expanded={api.open} aria-label="Menu" onClick={api.toggle}>
            <img src="/icon-32.png" width="22" height="22" alt="UniPi" />
            <span class={`led ${slug() ? conn() : ""}`} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuLabel>Projects</MenuLabel>
            <For each={activeProjects()}>
              {(project) => (
                <MenuItem
                  icon={<ProjectTile name={project.name} size={16} />}
                  label={project.name}
                  checked={project.slug === slug()}
                  onSelect={() => {
                    close();
                    void openProject(project.slug);
                  }}
                />
              )}
            </For>
            <MenuItem
              icon={<Icon.folder size={14} />}
              label="All projects"
              onSelect={() => {
                close();
                void openProject(null);
              }}
            />
            <MenuSeparator />
            <Show when={slug()}>
              <MenuItem
                icon={<Icon.review size={14} />}
                label={`Review queue${counts("in_review") > 0 ? ` (${counts("in_review")})` : ""}`}
                onSelect={() => {
                  close();
                  setView("list", "in_review");
                }}
              />
              <MenuItem
                icon={<Icon.blocked size={14} />}
                label={`Blocked${counts("blocked") > 0 ? ` (${counts("blocked")})` : ""}`}
                onSelect={() => {
                  close();
                  setView("list", "blocked");
                }}
              />
            </Show>
            <MenuItem
              icon={<Icon.search size={14} />}
              label="Search…"
              onSelect={() => {
                close();
                setPaletteOpen(true);
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Icon.gear size={14} />}
              label="Settings"
              onSelect={() => {
                close();
                setSettingsOpen(true);
              }}
            />
            <MenuItem
              icon={theme() === "dark" ? <Icon.sun size={14} /> : <Icon.moon size={14} />}
              label={theme() === "dark" ? "Light theme" : "Dark theme"}
              onSelect={() => {
                close();
                toggleTheme();
              }}
            />
            <MenuSeparator />
            <MenuLabel>Live updates: {conn()}</MenuLabel>
          </>
        )}
      </Popover>
    </div>
  );
}
