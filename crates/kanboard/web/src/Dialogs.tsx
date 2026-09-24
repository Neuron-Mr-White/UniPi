/** Dialogs: new task, comment-required move, ⌘K command palette, shortcuts, toasts. */

import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { api, PRIORITIES, type Task } from "./api.js";
import { Icon, PRIORITY_LABEL, PriorityGlyph, StatusGlyph } from "./icons.js";
import { ProjectTile } from "./paint.js";
import {
  board,
  commentRequest,
  currentProject,
  describe,
  dismissToast,
  laneLabel,
  loadBoard,
  newTaskLane,
  openProject,
  paletteOpen,
  projects,
  setCommentRequest,
  setNewTaskLane,
  setOpenTaskId,
  setPaletteOpen,
  setSelectedId,
  setShortcutsOpen,
  setSidebarCollapsed,
  setView,
  shortcutsOpen,
  sidebarCollapsed,
  slug,
  toast,
  toasts,
  toggleTheme,
  upsertTask,
} from "./state.js";
import { AutoTextarea, Dialog, Kbd, MenuItem, MOD, Popover } from "./ui.js";

// ─── new task ───────────────────────────────────────────────────────────────

export function NewTaskDialog(): JSX.Element {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [lane, setLane] = createSignal("backlog");
  const [priority, setPriority] = createSignal("none");
  const [after, setAfter] = createSignal<string[]>([]);
  const [more, setMore] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  createEffect(
    on(newTaskLane, (next) => {
      if (next === null) return;
      setLane(next === "todo" ? "todo" : "backlog");
      setTitle("");
      setBody("");
      setAfter([]);
      setPriority("none");
    }),
  );

  const close = (): void => void setNewTaskLane(null);

  async function submit(): Promise<void> {
    const target = slug();
    if (!target || title().trim().length === 0) return;
    setBusy(true);
    try {
      const created = await api.create(target, {
        title: title().trim(),
        body: body().trim() || undefined,
        status: lane(),
        priority: priority(),
        after: after().length > 0 ? after() : undefined,
      });
      await loadBoard(target);
      toast(`Created ${created.id}`, "success", { label: "Open", run: () => void setOpenTaskId(created.id) });
      if (more()) {
        setTitle("");
        setBody("");
        document.querySelector<HTMLInputElement>(".dialog-title-input")?.focus();
      } else close();
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  const depCandidates = (): Task[] => board.tasks.filter((task) => !["cancelled", "archived"].includes(task.status)).slice(0, 40);

  return (
    <Dialog open={newTaskLane() !== null} label="New task" onClose={close} width={640}>
      <header class="dialog-head">
        <span class="crumb-pill">
          <ProjectTile name={currentProject()?.name ?? "?"} size={14} />
          {currentProject()?.name ?? slug()}
        </span>
        <Icon.chevronRight size={12} />
        <span>New task</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close" onClick={close}>
          <Icon.close size={14} />
        </button>
      </header>
      <div class="dialog-body">
        <input
          class="dialog-title-input"
          placeholder="Task title"
          aria-label="Title"
          autofocus
          value={title()}
          onInput={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <AutoTextarea
          class="dialog-body-input"
          placeholder="Add a description… (markdown)"
          aria-label="Description"
          value={body()}
          maxHeight={260}
          onInput={(event) => setBody(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div class="prop-row">
        <Popover
          width={200}
          label="Status"
          trigger={(api) => (
            <button class="prop-chip" ref={api.ref} aria-expanded={api.open} onClick={api.toggle} aria-label="Status">
              <StatusGlyph status={lane()} />
              {laneLabel(lane())}
            </button>
          )}
        >
          {(close) => (
            <For each={["backlog", "todo"]}>
              {(status) => (
                <MenuItem role="option" icon={<StatusGlyph status={status} />} label={laneLabel(status)} checked={lane() === status} onSelect={() => { setLane(status); close(); }} />
              )}
            </For>
          )}
        </Popover>
        <Popover
          width={200}
          label="Priority"
          trigger={(api) => (
            <button class={`prop-chip${priority() === "none" ? " empty" : ""}`} ref={api.ref} aria-expanded={api.open} onClick={api.toggle} aria-label="Priority">
              <PriorityGlyph priority={priority()} />
              {priority() === "none" ? "Priority" : PRIORITY_LABEL[priority()]}
            </button>
          )}
        >
          {(close) => (
            <For each={[...PRIORITIES].reverse()}>
              {(option) => (
                <MenuItem role="option" icon={<PriorityGlyph priority={option} />} label={PRIORITY_LABEL[option]} checked={priority() === option} onSelect={() => { setPriority(option); close(); }} />
              )}
            </For>
          )}
        </Popover>
        <Popover
          width={320}
          label="Runs after"
          trigger={(api) => (
            <button class={`prop-chip${after().length === 0 ? " empty" : ""}`} ref={api.ref} aria-expanded={api.open} onClick={api.toggle} aria-label="Runs after">
              <Icon.link size={13} />
              {after().length === 0 ? "Runs after…" : `After ${after().join(", ")}`}
            </button>
          )}
        >
          {() => (
            <For each={depCandidates()} fallback={<div class="menu-section">No tasks yet.</div>}>
              {(task) => (
                <MenuItem
                  role="menuitemcheckbox"
                  icon={<StatusGlyph status={task.status} />}
                  label={
                    <>
                      <span class="mono muted" style={{ "margin-right": "6px" }}>
                        {task.id}
                      </span>
                      {task.title}
                    </>
                  }
                  checked={after().includes(task.id)}
                  onSelect={() => setAfter((current) => (current.includes(task.id) ? current.filter((id) => id !== task.id) : [...current, task.id]))}
                />
              )}
            </For>
          )}
        </Popover>
      </div>
      <footer class="dialog-foot">
        <label class="hint" style={{ cursor: "pointer" }}>
          <button class="switch" role="switch" aria-checked={more()} aria-label="Create more" onClick={() => setMore(!more())} />
          Create more
        </label>
        <span class="spacer" />
        <button class="btn" onClick={close}>
          Cancel
        </button>
        <button class="btn primary" disabled={busy() || title().trim().length === 0} onClick={() => void submit()}>
          Create task
          <Kbd keys={["↵"]} />
        </button>
      </footer>
    </Dialog>
  );
}

// ─── comment-required move ──────────────────────────────────────────────────

export function CommentDialog(): JSX.Element {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  createEffect(on(commentRequest, () => setText("")));
  const close = (): void => void setCommentRequest(null);

  async function submit(): Promise<void> {
    const request = commentRequest();
    const target = slug();
    if (!request || !target || text().trim().length === 0) return;
    setBusy(true);
    try {
      upsertTask(await api.move(target, request.task.id, request.to, text().trim()));
      await request.after?.();
      await loadBoard(target);
      toast(`Moved ${request.task.id} to ${laneLabel(request.to)}`, "success");
      close();
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={commentRequest() !== null} label="Comment required" onClose={close} width={520} class="modal">
      <header class="dialog-head">
        <span class="crumb-pill mono">{commentRequest()?.task.id}</span>
        <span>Needs a note</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Cancel" onClick={close}>
          <Icon.close size={14} />
        </button>
      </header>
      <div class="dialog-body">
        <div class="why prompt">
          <div>
            <span class="move">
              <StatusGlyph status={commentRequest()?.task.status ?? "backlog"} />
              {laneLabel(commentRequest()?.task.status ?? "")}
              <Icon.arrowRight size={12} />
              <StatusGlyph status={commentRequest()?.to ?? "backlog"} />
              {laneLabel(commentRequest()?.to ?? "")}
            </span>
            <div>This move needs a {commentRequest()?.hint ?? "note"} so whoever picks the task up next knows why.</div>
          </div>
        </div>
        <AutoTextarea
          autofocus
          value={text()}
          maxHeight={240}
          placeholder="e.g. The retry test still fails on CI — needs the fixture fixed first."
          aria-label="Comment"
          style={{ "min-height": "96px" }}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <footer class="dialog-foot">
        <span class="hint">
          <Kbd keys={[MOD, "↵"]} /> to move
        </span>
        <span class="spacer" />
        <button class="btn" onClick={close}>
          Cancel
        </button>
        <button class="btn primary" disabled={busy() || text().trim().length === 0} onClick={() => void submit()}>
          Move task
        </button>
      </footer>
    </Dialog>
  );
}

// ─── command palette ────────────────────────────────────────────────────────

interface Command {
  id: string;
  label: string;
  kind: string;
  icon: JSX.Element;
  mono?: string;
  run: () => void;
}

export function CommandPalette(): JSX.Element {
  const [needle, setNeedle] = createSignal("");
  const [active, setActive] = createSignal(0);
  createEffect(on(paletteOpen, (open) => open && (setNeedle(""), setActive(0))));
  const close = (): void => void setPaletteOpen(false);

  const commands = createMemo<Command[]>(() => {
    const list: Command[] = [];
    if (slug()) {
      list.push(
        { id: "new", label: "Create task", kind: "Action", icon: <Icon.plus size={14} />, run: () => setNewTaskLane("backlog") },
        { id: "board", label: "Go to board", kind: "View", icon: <Icon.board size={14} />, run: () => setView("board") },
        { id: "list", label: "Go to list", kind: "View", icon: <Icon.list size={14} />, run: () => setView("list") },
        { id: "review", label: "Review queue", kind: "View", icon: <Icon.review size={14} />, run: () => setView("list", "in_review") },
        { id: "blocked", label: "Blocked tasks", kind: "View", icon: <Icon.blocked size={14} />, run: () => setView("list", "blocked") },
      );
    }
    list.push(
      { id: "theme", label: "Toggle light / dark theme", kind: "Action", icon: <Icon.sun size={14} />, run: toggleTheme },
      { id: "sidebar", label: sidebarCollapsed() ? "Expand sidebar" : "Collapse sidebar", kind: "Action", icon: <Icon.sidebar size={14} />, run: () => setSidebarCollapsed(!sidebarCollapsed()) },
      { id: "keys", label: "Keyboard shortcuts", kind: "Help", icon: <Icon.keyboard size={14} />, run: () => setShortcutsOpen(true) },
    );
    for (const project of projects.items) {
      if (project.slug === slug()) continue;
      list.push({ id: `p:${project.slug}`, label: `Open ${project.name}`, kind: "Project", icon: <ProjectTile name={project.name} size={14} />, run: () => void openProject(project.slug) });
    }
    for (const task of board.tasks) {
      list.push({
        id: `t:${task.id}`,
        label: task.title,
        mono: task.id,
        kind: laneLabel(task.status),
        icon: <StatusGlyph status={task.status} />,
        run: () => {
          setSelectedId(task.id);
          setOpenTaskId(task.id);
        },
      });
    }
    return list;
  });

  const results = createMemo(() => {
    const text = needle().trim().toLowerCase();
    const all = commands();
    if (!text) return all.filter((command) => !command.id.startsWith("t:")).concat(all.filter((command) => command.id.startsWith("t:")).slice(0, 8));
    const scored = all
      .map((command) => {
        const hay = `${command.mono ?? ""} ${command.label}`.toLowerCase();
        const index = hay.indexOf(text);
        return { command, score: index === -1 ? (fuzzy(hay, text) ? 100 : -1) : index };
      })
      .filter((entry) => entry.score >= 0);
    // Fuzzy hits only when nothing matches as a substring.
    const exact = scored.filter((entry) => entry.score < 100);
    return (exact.length > 0 ? exact : scored)
      .sort((a, b) => a.score - b.score)
      .slice(0, 30)
      .map((entry) => entry.command);
  });

  const choose = (command: Command | undefined): void => {
    if (!command) return;
    close();
    command.run();
  };

  return (
    <Dialog open={paletteOpen()} label="Command palette" onClose={close} width={600} class="palette">
      <div class="palette-input">
        <Icon.search size={16} />
        <input
          autofocus
          placeholder="Search tasks, projects and actions…"
          aria-label="Command"
          value={needle()}
          onInput={(event) => {
            setNeedle(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(results().length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results()[active()]);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div class="palette-list" role="listbox">
        <For each={results()} fallback={<div class="list-empty">No results.</div>}>
          {(command, index) => (
            <button
              class="option"
              role="option"
              aria-selected={index() === active()}
              ref={(el) => createEffect(() => index() === active() && el.scrollIntoView({ block: "nearest" }))}
              onMouseMove={() => setActive(index())}
              onClick={() => choose(command)}
            >
              {command.icon}
              <Show when={command.mono}>
                <span class="mono">{command.mono}</span>
              </Show>
              <span class="label">{command.label}</span>
              <span class="kind">{command.kind}</span>
            </button>
          )}
        </For>
      </div>
      <div class="palette-foot">
        <span>
          <Kbd keys={["↑", "↓"]} /> navigate
        </span>
        <span>
          <Kbd keys={["↵"]} /> open
        </span>
        <span>
          <Kbd keys={["esc"]} /> close
        </span>
      </div>
    </Dialog>
  );
}

function fuzzy(hay: string, needle: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = hay.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

// ─── shortcuts ──────────────────────────────────────────────────────────────

export function ShortcutsDialog(): JSX.Element {
  const rows: Array<[string, string[]]> = [
    ["Command palette", [MOD, "K"]],
    ["New task", ["C"]],
    ["Search tasks", ["/"]],
    ["Next / previous task", ["J", "K"]],
    ["Open selected task", ["↵"]],
    ["Board / list", ["B", "L"]],
    ["Toggle sidebar", ["["]],
    ["Close panel", ["Esc"]],
    ["This help", ["?"]],
  ];
  return (
    <Dialog open={shortcutsOpen()} label="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)} width={420}>
      <header class="dialog-head">
        <Icon.keyboard size={14} />
        <span style={{ color: "var(--text)", "font-weight": 600 }}>Keyboard shortcuts</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close" onClick={() => setShortcutsOpen(false)}>
          <Icon.close size={14} />
        </button>
      </header>
      <div class="shortcuts">
        <For each={rows}>
          {([label, keys]) => (
            <>
              <span>{label}</span>
              <Kbd keys={keys} />
            </>
          )}
        </For>
      </div>
    </Dialog>
  );
}

// ─── toasts ─────────────────────────────────────────────────────────────────

export function Toasts(): JSX.Element {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={toasts()}>
        {(item) => (
          <div class={`toast ${item.kind}`}>
            <span class="toast-icon">
              {item.kind === "success" ? <Icon.check size={11} /> : item.kind === "error" ? <Icon.close size={10} /> : item.kind === "warning" ? "!" : "i"}
            </span>
            <span class="msg">{item.message}</span>
            <Show when={item.action}>
              <button
                class="btn"
                onClick={() => {
                  dismissToast(item.id);
                  void item.action!.run();
                }}
              >
                <Show when={item.action!.label === "Undo"}>
                  <Icon.undo size={13} />
                </Show>
                {item.action!.label}
              </button>
            </Show>
            <button class="icon-btn sm" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
              <Icon.close size={12} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
