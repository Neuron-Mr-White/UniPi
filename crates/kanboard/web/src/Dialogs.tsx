/** Dialogs: new task, comment-required move, ⌘K command palette, shortcuts, toasts. */

import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { api, ApiError, displayTitle, PRIORITIES, type Settings } from "./api.js";
import { DepList } from "./dep-picker.js";
import { Icon, PRIORITY_LABEL, PriorityGlyph, StatusGlyph } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { hue, ProjectTile } from "./paint.js";
import { LabelPicker } from "./label-picker.js";
import { offerToSchedule } from "./schedule.js";
import { filesFrom, namedFile, uploadAll } from "./attach.js";
import {
  board,
  boardSummarizeOpen,
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
  recreateFrom,
  setCommentRequest,
  setNewTaskLane,
  setOpenTaskId,
  setPaletteOpen,
  setRecreateFrom,
  setSelectedId,
  setSettingsOpen,
  setBoardSummarizeOpen,
  setShortcutsOpen,
  setSidebarCollapsed,
  setSummarizeOpen,
  setView,
  settingsOpen,
  shortcutsOpen,
  sidebarCollapsed,
  slug,
  summarizeOpen,
  toast,
  toasts,
  toggleTheme,
  upsertTask,
} from "./state.js";
import { Mention } from "./mention.js";
import { AutoTextarea, Dialog, Kbd, MenuItem, MOD, Popover } from "./ui.js";

// ─── new task ───────────────────────────────────────────────────────────────

export function NewTaskDialog(): JSX.Element {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [lane, setLane] = createSignal("backlog");
  const [priority, setPriority] = createSignal("none");
  const [after, setAfter] = createSignal<string[]>([]);
  const [labels, setLabels] = createSignal<string[]>([]);
  const [more, setMore] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  /** Files picked/pasted before the task exists — uploaded right after creation. */
  const [pending, setPending] = createSignal<File[]>([]);
  /** UNI-61: explicit Close/Cancel on a dirty form asks before discarding. */
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  /** The lane the dialog opened with — changing it is a draft (UNI-61). */
  const [initialLane, setInitialLane] = createSignal("backlog");
  let picker: HTMLInputElement | undefined;
  let descriptionArea: HTMLTextAreaElement | undefined;

  /** A draft worth protecting: any content (even whitespace), choice,
   *  changed lane or pending upload. */
  const dirty = (): boolean =>
    title().length > 0 ||
    body().length > 0 ||
    after().length > 0 ||
    labels().length > 0 ||
    priority() !== "none" ||
    lane() !== initialLane() ||
    pending().length > 0;

  /** Guarded dismissal: backdrop/Esc never discard a draft (UNI-61). */
  const requestClose = (): void => {
    if (dirty()) {
      setConfirmDiscard(true);
      return;
    }
    close();
  };

  const close = (): void => {
    void setNewTaskLane(null);
    setRecreateFrom(null);
    setConfirmDiscard(false);
  };

  const toggleLabel = (label: string): void =>
    void setLabels((current) => (current.includes(label) ? current.filter((item) => item !== label) : [...current, label]));

  const createLabel = (raw: string): void => {
    const label = raw.trim().replace(/,/g, "");
    if (!label) return;
    if (!labels().includes(label)) setLabels((current) => [...current, label]);
  };

  const addFiles = (files: File[]): void => {
    if (files.length > 0) setPending((current) => [...current, ...files.map(namedFile)]);
  };
  /** Files dragged anywhere over the dialog (title, description, chips) attach. */
  const [dropOver, setDropOver] = createSignal(false);
  const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;
  const dropZone = {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDropOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDropOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !(event.currentTarget as Node).contains(next)) setDropOver(false);
    },
    onDrop: (event: DragEvent) => {
      setDropOver(false);
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      addFiles(filesFrom(event));
    },
  };

  createEffect(
    on(newTaskLane, (next) => {
      if (next === null) return;
      const source = recreateFrom();
      if (source) {
        // UNI-57 Recreate: creation fields only — title, body, priority,
        // labels, deps. No status history, comments, run or attachments;
        // creation mints a fresh id.
        setLane("todo");
        setTitle(source.title);
        setBody(source.body ?? "");
        setPriority(source.priority && source.priority !== "none" ? source.priority : "none");
        setAfter([...(source.deps ?? [])]);
        setLabels([...(source.labels ?? [])]);
      } else {
        setLane(next === "todo" ? "todo" : "backlog");
        setTitle("");
        setBody("");
        setAfter([]);
        setLabels([]);
        setPriority("none");
      }
      setPending([]);
      setDropOver(false);
      setConfirmDiscard(false);
      setInitialLane(lane());
    }),
  );

  async function submit(): Promise<void> {
    const target = slug();
    if (!target || (title().trim().length === 0 && body().trim().length === 0)) return;
    setBusy(true);
    try {
      const created = await api.create(target, {
        title: title().trim(),
        body: body().trim() || undefined,
        status: lane(),
        priority: priority(),
        after: after().length > 0 ? after() : undefined,
        labels: labels().length > 0 ? labels() : undefined,
      });
      if (pending().length > 0) {
        const uploaded = await uploadAll(created.id, pending());
        if (uploaded.length > 0) {
          const withFiles = [body().trim(), uploaded.map((item) => item.markdown).join("\n")].filter(Boolean).join("\n\n");
          await api.edit(target, created.id, { body: withFiles });
        }
        setPending([]);
      }
      await loadBoard(target);
      toast(`Created ${created.id}`, "success", { label: "Open", run: () => void setOpenTaskId(created.id) });
      if (more()) {
        setTitle("");
        setBody("");
        setLabels([]);
        document.querySelector<HTMLInputElement>(".dialog-title-input")?.focus();
      } else close();
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={newTaskLane() !== null} label="New task" onClose={requestClose} width={640} dismissable={false}>
      <div class={`new-task-drop${dropOver() ? " drop-over" : ""}`} {...dropZone}>
      <header class="dialog-head">
        <span class="crumb-pill">
          <ProjectTile name={currentProject()?.name ?? "?"} size={14} />
          {currentProject()?.name ?? slug()}
        </span>
        <Icon.chevronRight size={12} />
        <span>{recreateFrom() ? "Recreate task" : "New task"}</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close" onClick={requestClose}>
          <Icon.close size={14} />
        </button>
      </header>
      <Show when={recreateFrom()}>
        <div class="recreate-banner">
          <Icon.duplicate size={13} />
          <span>
            Recreating <b class="mono">{recreateFrom()!.id}</b> — creating makes a new task; comments, history and status stay behind.
          </span>
        </div>
      </Show>
      <Show when={confirmDiscard()}>
        <div class="discard-strip" role="alertdialog" aria-label="Discard draft?">
          <span>Discard this draft?</span>
          <span class="spacer" />
          <button class="btn" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          <button class="btn danger" onClick={close}>Discard</button>
        </div>
      </Show>
      <div class="dialog-body">
        <input
          class="dialog-title-input"
          placeholder="Title (optional)"
          aria-label="Title (optional)"
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
          onPaste={(event) => {
            const files = filesFrom(event);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
          areaRef={(el) => (descriptionArea = el)}
          class="dialog-body-input"
          placeholder="Add a description… (markdown, @ to mention a task)"
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
        <Mention area={() => descriptionArea} setValue={setBody} />
      </div>
      <Show when={pending().length > 0}>
        <div class="pending-files">
          <For each={pending()}>
            {(file, index) => (
              <span class="pending-file">
                <Icon.paperclip size={12} />
                <span>{file.name}</span>
                <button aria-label={`Remove ${file.name}`} onClick={() => setPending((current) => current.filter((_, at) => at !== index()))}>
                  <Icon.close size={10} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
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
          {(close) => (
            <DepList
              keepOpen
              picked={(id) => after().includes(id)}
              onPick={(id) => setAfter((current) => (current.includes(id) ? current.filter((picked) => picked !== id) : [...current, id]))}
              close={close}
            />
          )}
        </Popover>
        <Popover
          width={280}
          label="Labels"
          trigger={(api) => (
            <button class={`prop-chip${labels().length === 0 ? " empty" : ""}`} ref={api.ref} aria-expanded={api.open} onClick={api.toggle} aria-label="Labels">
              <span
                class="label-dot"
                style={{ width: "9px", height: "9px", "border-radius": "3px", background: labels().length > 0 ? hue(labels()[0]!) : "var(--faint)" }}
              />
              {labels().length === 0 ? "Labels" : labels().join(", ")}
            </button>
          )}
        >
          {(close) => <LabelPicker selected={labels()} onToggle={toggleLabel} onCreate={createLabel} close={close} />}
        </Popover>
        <button class="prop-chip empty" aria-label="Attach files" onClick={() => picker?.click()}>
          <Icon.paperclip size={13} />
          Attach
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <footer class="dialog-foot">
        <label class="hint" style={{ cursor: "pointer" }}>
          <button class="switch" role="switch" aria-checked={more()} aria-label="Create more" onClick={() => setMore(!more())} />
          Create more
        </label>
        <span class="spacer" />
        <button class="btn" onClick={requestClose}>
          Cancel
        </button>
        <button class="btn primary" disabled={busy() || (title().trim().length === 0 && body().trim().length === 0)} onClick={() => void submit()}>
          Create task
          <Kbd keys={["↵"]} />
        </button>
      </footer>
      <Show when={dropOver()}>
        <div class="drop-hint" aria-hidden="true">
          <Icon.paperclip size={16} />
          Drop to attach
        </div>
      </Show>
      </div>
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
    // Off-board callers (Dashboard inbox) move against their own project.
    const project = request?.slug ?? slug();
    if (!request || !project || text().trim().length === 0) return;
    setBusy(true);
    try {
      const moved = await api.move(project, request.task.id, request.to, text().trim());
      // Only the matching board takes the update (never a foreign task).
      if (slug() === project) upsertTask(moved);
      await request.after?.();
      if (slug() === project) await loadBoard(project);
      toast(`Moved ${request.task.id} to ${laneLabel(request.to)}`, "success");
      if (request.to === "todo" && slug() === project) offerToSchedule(request.task.id);
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
        label: displayTitle(task),
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

// ─── summarize & archive ────────────────────────────────────────────────────

/**
 * Two steps: pick the instruction and generate (the agent can take minutes),
 * then review/edit the markdown before it is saved and the done tasks archived.
 */
export function SummarizeDialog(): JSX.Element {
  const [step, setStep] = createSignal<"config" | "result">("config");
  const [instruction, setInstruction] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [taskIds, setTaskIds] = createSignal<string[]>([]);
  const [needsAgent, setNeedsAgent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [noteOpen, setNoteOpen] = createSignal(false);
  const [note, setNote] = createSignal("");
  const doneCount = (): number => board.tasks.filter((task) => task.status === "done").length;

  createEffect(
    on(summarizeOpen, (open) => {
      if (!open) return;
      setStep("config");
      setSummary("");
      setTaskIds([]);
      setNeedsAgent(false);
      setNoteOpen(false);
      setNote("");
      void api
        .settings()
        .then((settings) => setInstruction(settings.summaryInstruction))
        .catch((error) => toast(describe(error), "error"));
    }),
  );

  const close = (): void => {
    if (!busy()) setSummarizeOpen(false);
  };

  async function generate(): Promise<void> {
    const target = slug();
    if (!target || busy()) return;
    setBusy(true);
    setNeedsAgent(false);
    try {
      const result = await api.summarize(target, { instruction: instruction() });
      setSummary(result.summary);
      setTaskIds(result.taskIds);
      setEditing(false);
      setStep("result");
    } catch (error) {
      if (error instanceof ApiError && error.needsAgent) setNeedsAgent(true);
      else toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  /** Resummarize: feed the shown summary + the user's note back in. */
  async function resummarize(): Promise<void> {
    const target = slug();
    if (!target || busy()) return;
    setBusy(true);
    setNeedsAgent(false);
    try {
      const result = await api.summarize(target, {
        instruction: instruction(),
        previous: summary(),
        note: note(),
      });
      setSummary(result.summary);
      setTaskIds(result.taskIds);
      setEditing(false);
      setNote("");
      setNoteOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.needsAgent) setNeedsAgent(true);
      else toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveAndArchive(): Promise<void> {
    const target = slug();
    if (!target || busy()) return;
    setBusy(true);
    try {
      const result = await api.archiveSummary(target, { markdown: summary(), taskIds: taskIds() });
      toast(`Archived ${result.archived.length} task${result.archived.length === 1 ? "" : "s"} · summary saved`, "success", {
        label: "Copy path",
        run: () => void navigator.clipboard?.writeText(result.path),
      });
      await loadBoard(target);
      setSummarizeOpen(false);
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={summarizeOpen()} label="Summarize & archive" onClose={close} width={640} class="modal">
      <header class="dialog-head">
        <span class="crumb-pill">
          <StatusGlyph status="done" size={13} />
          Done
        </span>
        <span>Summarize & archive</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close" disabled={busy()} onClick={close}>
          <Icon.close size={14} />
        </button>
      </header>
      <div class="dialog-body">
        <Show when={step() === "config"} fallback={
          <>
            <Show when={editing()} fallback={<div class="summary-preview md" innerHTML={renderMarkdown(summary())} />}>
              <AutoTextarea
                class="dialog-body-input"
                aria-label="Summary (markdown)"
                value={summary()}
                maxHeight={260}
                style={{ "min-height": "140px" }}
                onInput={(event) => setSummary(event.currentTarget.value)}
              />
            </Show>
            <Show when={noteOpen()}>
              <div class="resummarize-note">
                <AutoTextarea
                  class="dialog-body-input"
                  aria-label="Note for the resummary"
                  placeholder="What should the summary do differently? (e.g. focus on blockers)"
                  value={note()}
                  maxHeight={140}
                  style={{ "min-height": "60px" }}
                  onInput={(event) => setNote(event.currentTarget.value)}
                />
                <div style={{ "margin-top": "8px" }}>
                  <button class="btn" disabled={busy()} onClick={() => void resummarize()}>
                    <Show when={busy()} fallback={<Icon.sparkle size={14} />}>
                      <span class="spinner" />
                    </Show>
                    {busy() ? "Resummarizing…" : "Resummarize"}
                  </button>
                </div>
              </div>
            </Show>
          </>
        }>
          <p class="hint" style={{ margin: "0 0 10px" }}>
            {doneCount()} done task{doneCount() === 1 ? "" : "s"} will be summarized by the configured agent, then archived.
          </p>
          <AutoTextarea
            class="dialog-body-input"
            aria-label="Summary instruction"
            value={instruction()}
            maxHeight={220}
            style={{ "min-height": "110px" }}
            onInput={(event) => setInstruction(event.currentTarget.value)}
          />
          <Show when={needsAgent()}>
            <div class="banner" role="alert" style={{ "margin-top": "10px" }}>
              <Icon.warn size={16} />
              <div>
                <strong>No agent configured.</strong> Set the command that writes the summary first.
                <div style={{ "margin-top": "8px" }}>
                  <button
                    class="btn"
                    onClick={() => {
                      setSummarizeOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    <Icon.gear size={14} />
                    Configure an agent first
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </Show>
      </div>
      <footer class="dialog-foot">
        <Show when={step() === "result"}>
          <button
            class="btn"
            aria-pressed={noteOpen()}
            aria-label="Resummarize with note"
            onClick={() => setNoteOpen(!noteOpen())}
          >
            Resummarize with note
          </button>
          <button class="btn" aria-pressed={editing()} onClick={() => setEditing(!editing())}>
            {editing() ? "Preview" : "Edit"}
          </button>
          <button
            class="btn"
            onClick={() =>
              void navigator.clipboard?.writeText(summary()).then(
                () => toast("Copied summary", "success"),
                () => toast("Couldn't copy the summary", "error"),
              )
            }
          >
            <Icon.copy size={14} />
            Copy
          </button>
          <button class="btn" disabled={busy()} onClick={() => void generate()}>
            Regenerate
          </button>
        </Show>
        <span class="spacer" />
        <Show
          when={step() === "result"}
          fallback={
            <button class="btn primary" disabled={busy() || doneCount() === 0} onClick={() => void generate()}>
              <Show when={busy()} fallback={<Icon.sparkle size={14} />}>
                <span class="spinner" />
              </Show>
              {busy() ? "Summarizing…" : "Generate summary"}
            </button>
          }
        >
          <button class="btn primary" disabled={busy() || summary().trim().length === 0} onClick={() => void saveAndArchive()}>
            Save & archive {taskIds().length} task{taskIds().length === 1 ? "" : "s"}
          </button>
        </Show>
      </footer>
    </Dialog>
  );
}

// ─── board summarize (no archive) ────────────────────────────────────────────

/**
 * Header "Summarize": runs the board scope over every live lane with an
 * optional user prompt. Result is markdown with Copy + resummarize-with-note
 * — nothing here archives tasks.
 */
export function BoardSummarizeDialog(): JSX.Element {
  const [promptText, setPromptText] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [generated, setGenerated] = createSignal(false);
  const [needsAgent, setNeedsAgent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [noteOpen, setNoteOpen] = createSignal(false);
  const [note, setNote] = createSignal("");

  createEffect(
    on(boardSummarizeOpen, (open) => {
      if (!open) return;
      setSummary("");
      setGenerated(false);
      setNeedsAgent(false);
      setNoteOpen(false);
      setNote("");
    }),
  );

  const close = (): void => {
    if (!busy()) setBoardSummarizeOpen(false);
  };

  async function run(previous?: string, runNote?: string): Promise<void> {
    const target = slug();
    if (!target || busy()) return;
    setBusy(true);
    setNeedsAgent(false);
    try {
      const result = await api.summarize(target, {
        scope: "board",
        instruction: promptText(),
        previous,
        note: runNote,
      });
      setSummary(result.summary);
      setGenerated(true);
      setNote("");
      setNoteOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.needsAgent) setNeedsAgent(true);
      else toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={boardSummarizeOpen()} label="Summarize board" onClose={close} width={640} class="modal">
      <header class="dialog-head">
        <span>Summarize board</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close" disabled={busy()} onClick={close}>
          <Icon.close size={14} />
        </button>
      </header>
      <div class="dialog-body">
        <Show when={!generated()} fallback={<div class="summary-preview md" innerHTML={renderMarkdown(summary())} />}>
          <p class="hint" style={{ margin: "0 0 10px" }}>
            The agent summarizes every lane on the board. An optional prompt steers it.
          </p>
          <AutoTextarea
            class="dialog-body-input"
            aria-label="Summary prompt"
            placeholder={
              "Optional: steer the summary\n\ne.g. Summarize only todo, in priority order\ne.g. Explain the relevance of the current todo tasks"
            }
            value={promptText()}
            maxHeight={160}
            style={{ "min-height": "80px" }}
            onInput={(event) => setPromptText(event.currentTarget.value)}
          />
          <Show when={needsAgent()}>
            <div class="banner" role="alert" style={{ "margin-top": "10px" }}>
              <Icon.warn size={16} />
              <div>
                <strong>No agent configured.</strong> Set the command that writes the summary first.
                <div style={{ "margin-top": "8px" }}>
                  <button
                    class="btn"
                    onClick={() => {
                      setBoardSummarizeOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    <Icon.gear size={14} />
                    Configure an agent first
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={generated() && noteOpen()}>
          <div class="resummarize-note">
            <AutoTextarea
              class="dialog-body-input"
              aria-label="Note for the resummary"
              placeholder="What should the summary do differently? (e.g. Summarize only todo, in priority order)"
              value={note()}
              maxHeight={140}
              style={{ "min-height": "60px" }}
              onInput={(event) => setNote(event.currentTarget.value)}
            />
            <div style={{ "margin-top": "8px" }}>
              <button class="btn" disabled={busy()} onClick={() => void run(summary(), note())}>
                <Show when={busy()} fallback={<Icon.sparkle size={14} />}>
                  <span class="spinner" />
                </Show>
                {busy() ? "Resummarizing…" : "Resummarize"}
              </button>
            </div>
          </div>
        </Show>
      </div>
      <footer class="dialog-foot">
        <Show when={generated()}>
          <button
            class="btn"
            aria-pressed={noteOpen()}
            aria-label="Resummarize with note"
            onClick={() => setNoteOpen(!noteOpen())}
          >
            Resummarize with note
          </button>
          <button
            class="btn"
            onClick={() =>
              void navigator.clipboard?.writeText(summary()).then(
                () => toast("Copied summary", "success"),
                () => toast("Couldn't copy the summary", "error"),
              )
            }
          >
            <Icon.copy size={14} />
            Copy
          </button>
        </Show>
        <span class="spacer" />
        <Show
          when={generated()}
          fallback={
            <button class="btn primary" disabled={busy()} onClick={() => void run()}>
              <Show when={busy()} fallback={<Icon.sparkle size={14} />}>
                <span class="spinner" />
              </Show>
              {busy() ? "Summarizing…" : "Generate summary"}
            </button>
          }
        >
          <button class="btn" disabled={busy()} onClick={close}>
            Done
          </button>
        </Show>
      </footer>
    </Dialog>
  );
}

// ─── settings ───────────────────────────────────────────────────────────────

/** One searchable combobox for the summary model: button shows the pick,
 *  opens a filterable list grouped by provider; "pi default" first. */
function ModelCombobox(props: {
  models: string[];
  state: "loading" | "ok" | "error";
  error: string;
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const [needle, setNeedle] = createSignal("");
  const [active, setActive] = createSignal(0);

  /** Provider-grouped entries; "pi default" is always row 0 of the flat list. */
  const entries = createMemo((): Array<{ value: string; label: string; provider?: string }> => {
    const n = needle().trim().toLowerCase();
    const flat: Array<{ value: string; label: string; provider?: string }> = [
      { value: "", label: "pi default" },
    ];
    const groups = new Map<string, string[]>();
    for (const entry of props.models) {
      if (n && !entry.toLowerCase().includes(n)) continue;
      const provider = entry.split("/")[0] ?? "other";
      groups.set(provider, [...(groups.get(provider) ?? []), entry]);
    }
    for (const provider of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      for (const entry of groups.get(provider)!) flat.push({ value: entry, label: entry, provider });
    }
    return flat;
  });

  return (
    <Popover
      width={360}
      label="Summary model"
      trigger={(p) => (
        <button class="input combo-trigger" ref={p.ref} aria-expanded={p.open} onClick={p.toggle} aria-label="Summary model">
          <span class={`combo-value${props.value ? "" : " dim"}`}>{props.value || "pi default"}</span>
          <Icon.chevronDown size={12} class="caret" />
        </button>
      )}
    >
      {(close) => (
        <div class="dep-picker">
          <div class="pop-search">
            <Icon.search size={14} />
            <input
              ref={(el) => queueMicrotask(() => el.focus({ preventScroll: true }))}
              placeholder="Type to filter models…"
              aria-label="Filter models"
              value={needle()}
              onInput={(event) => { setNeedle(event.currentTarget.value); setActive(0); }}
              onKeyDown={(event) => {
                const items = entries();
                if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
                else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                else if (event.key === "Enter") {
                  const item = items[active()];
                  if (item) { event.preventDefault(); props.onChange(item.value); close(); }
                } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
              }}
            />
          </div>
          <div role="listbox" aria-label="Summary models" class="combo-list">
            <Show when={props.state === "loading"}><div class="menu-section">Loading models…</div></Show>
            <Show when={props.state === "error"}><div class="menu-section" role="alert">{props.error}</div></Show>
            <For each={entries()}>
              {(entry, index) => (
                <>
                  <Show when={entry.provider && (index() === 0 || entries()[index() - 1]?.provider !== entry.provider)}>
                    <div class="menu-section">{entry.provider}</div>
                  </Show>
                  <button
                    class={`dep-option${active() === index() ? " active" : ""}`}
                    role="option"
                    aria-selected={props.value === entry.value}
                    onMouseEnter={() => setActive(index())}
                    onClick={() => { props.onChange(entry.value); close(); }}
                  >
                    <Show when={props.value === entry.value}><Icon.check size={12} /></Show>
                    <span class="dep-title">{entry.label}</span>
                  </button>
                </>
              )}
            </For>
            <div class="menu-section"><button class="link-btn" onClick={() => props.onRefresh()}>Refresh the model list</button></div>
          </div>
        </div>
      )}
    </Popover>
  );
}

type SettingsCat = "summaries" | "defaults" | "sessions" | "archive";
const SETTINGS_CATS: Array<[SettingsCat, string]> = [
  ["summaries", "Summaries"],
  ["defaults", "Task defaults"],
  ["sessions", "Sessions"],
  ["archive", "Archive"],
];

export function SettingsDialog(): JSX.Element {
  const [loaded, setLoaded] = createSignal<Settings | null>(null);
  const [model, setModel] = createSignal("");
  const [instruction, setInstruction] = createSignal("");
  const [customInstruction, setCustomInstruction] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [modelsState, setModelsState] = createSignal<"loading" | "ok" | "error">("loading");
  const [modelsError, setModelsError] = createSignal("");
  const [modelList, setModelList] = createSignal<string[]>([]);
  const [cat, setCat] = createSignal<SettingsCat>("summaries");
  const [blocking, setBlocking] = createSignal("avoid");
  const [maxSessions, setMaxSessions] = createSignal(2);
  const [turnAddLimit, setTurnAddLimit] = createSignal(20);
  const [chainGate, setChainGate] = createSignal("in_review");
  const [archiveDays, setArchiveDays] = createSignal(0);
  const [retentionDays, setRetentionDays] = createSignal(90);

  async function loadModels(refresh = false): Promise<void> {
    setModelsState("loading");
    try {
      const payload = await api.models(refresh);
      setModelList(payload.models);
      setModelsError("");
      setModelsState("ok");
    } catch (error) {
      setModelsError(describe(error));
      setModelsState("error");
    }
  }

  createEffect(
    on(settingsOpen, (open) => {
      if (!open) return;
      setLoaded(null);
      setCustomInstruction(false);
      setModelList([]);
      setModelsState("loading");
      void api
        .settings()
        .then((settings) => {
          setLoaded(settings);
          setModel(settings.summaryModel);
          setInstruction(settings.summaryInstruction);
          setCustomInstruction(settings.summaryInstruction !== settings.defaultSummaryInstruction);
          setCat("summaries");
          const limits = settings.sessions ?? settings.runner;
          setBlocking(settings.taskDefaults?.blocking ?? "avoid");
          setMaxSessions(limits?.maxSessions ?? 2);
          setTurnAddLimit(limits?.turnAddLimit ?? 20);
          setChainGate(limits?.chainGate ?? "in_review");
          setArchiveDays(settings.archive?.archiveAfterDays ?? 0);
          setRetentionDays(settings.archive?.retentionDays ?? 90);
        })
        .catch((error) => toast(describe(error), "error"));
      void loadModels();
    }),
  );

  const close = (): void => void setSettingsOpen(false);

  /** "provider/id" → grouped by provider, filterable. */
  async function save(): Promise<void> {
    setBusy(true);
    try {
      await api.saveSettings({
        summaryModel: model().trim(),
        summaryInstruction: customInstruction() ? instruction() : "",
        blocking: blocking(),
        maxSessions: maxSessions(),
        turnAddLimit: turnAddLimit(),
        chainGate: chainGate(),
        archiveAfterDays: archiveDays(),
        retentionDays: retentionDays(),
      });
      toast("Settings saved", "success");
      close();
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={settingsOpen()} label="Settings" onClose={close} width={520}>
      <header class="dialog-head">
        <Icon.gear size={14} />
        <span style={{ color: "var(--text)", "font-weight": 600 }}>Settings</span>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close" onClick={close}>
          <Icon.close size={14} />
        </button>
      </header>
      <div class="dialog-body settings-form settings-split">
        <nav class="settings-nav" aria-label="Settings categories">
          <For each={SETTINGS_CATS}>
            {([key, label]) => (
              <button class={`settings-nav-item${cat() === key ? " active" : ""}`} onClick={() => setCat(key)}>
                {label}
              </button>
            )}
          </For>
        </nav>
        <div class="settings-pane">
        <Show when={loaded()} fallback={<div class="skeleton" style={{ height: "120px" }} />}>
          <Show when={cat() === "summaries"}>
          <div class="settings-heading">Summaries</div>
          <div class="field">
            <span class="field-label">Model</span>
            <ModelCombobox
              models={modelList()}
              state={modelsState()}
              error={modelsError()}
              value={model()}
              onChange={setModel}
              onRefresh={() => void loadModels(true)}
            />
          </div>
          <div class="field">
            <span class="field-label">
              Instruction
              <span class="spacer" />
              <Show
                when={customInstruction()}
                fallback={
                  <button class="link-btn" onClick={() => setCustomInstruction(true)}>
                    Customize
                  </button>
                }
              >
                <button
                  class="link-btn"
                  onClick={() => {
                    setInstruction(loaded()?.defaultSummaryInstruction ?? "");
                    setCustomInstruction(false);
                  }}
                >
                  Reset to default
                </button>
              </Show>
            </span>
            <Show
              when={customInstruction()}
              fallback={<span class="field-hint">Default: changelog bullets in Conventional Commit style</span>}
            >
              <AutoTextarea
                class="dialog-body-input"
                aria-label="Summary instruction"
                value={instruction()}
                maxHeight={200}
                style={{ "min-height": "90px" }}
                onInput={(event) => setInstruction(event.currentTarget.value)}
              />
            </Show>
            <span class="field-hint">Plain-language style rules are always applied.</span>
          </div>
          </Show>

          <Show when={cat() === "defaults"}>
          <div class="settings-heading">Task defaults</div>
          <div class="field">
            <span class="field-label">Blocking</span>
            <select class="input" aria-label="Blocking" value={blocking()} onChange={(e) => setBlocking(e.currentTarget.value)}>
              <option value="avoid">Avoid — work autonomously, note assumptions</option>
              <option value="ask">Ask — block the task to ask the user</option>
            </select>
            <span class="field-hint">What the agent does when it is unsure how to go on.</span>
          </div>
          </Show>

          <Show when={cat() === "sessions"}>
          <div class="settings-heading">Sessions</div>
          <div class="field">
            <span class="field-label">Sessions at once</span>
            <input class="input" type="number" min="1" aria-label="Sessions at once" value={maxSessions()} onInput={(e) => setMaxSessions(Math.max(1, Number(e.currentTarget.value) || 1))} />
            <span class="field-hint">Distinct sessions holding in_progress tasks per project.</span>
          </div>
          <div class="field">
            <span class="field-label">New tasks per turn</span>
            <input class="input" type="number" min="0" aria-label="New tasks per turn" value={turnAddLimit()} onInput={(e) => setTurnAddLimit(Math.max(0, Number(e.currentTarget.value) || 0))} />
            <span class="field-hint">`add` calls an agent may make per turn — 0 = unlimited.</span>
          </div>
          <div class="field">
            <span class="field-label">Chain gate</span>
            <select class="input" aria-label="Chain gate" value={chainGate()} onChange={(e) => setChainGate(e.currentTarget.value)}>
              <option value="in_review">in_review</option>
              <option value="done">done</option>
            </select>
            <span class="field-hint">When a dependency counts as satisfied.</span>
          </div>
          </Show>

          <Show when={cat() === "archive"}>
          <div class="settings-heading">Archive</div>
          <div class="field">
            <span class="field-label">Auto-archive after (days)</span>
            <input class="input" type="number" min="0" aria-label="Auto-archive after days" value={archiveDays()} onInput={(e) => setArchiveDays(Math.max(0, Number(e.currentTarget.value) || 0))} />
            <span class="field-hint">Done/cancelled tasks leave the board — 0 = off.</span>
          </div>
          <div class="field">
            <span class="field-label">Cold storage after (days)</span>
            <input class="input" type="number" min="0" aria-label="Cold storage after days" value={retentionDays()} onInput={(e) => setRetentionDays(Math.max(0, Number(e.currentTarget.value) || 0))} />
            <span class="field-hint">Archived tasks move to cold storage — 0 = off.</span>
          </div>
          </Show>
        </Show>
        </div>
      </div>
      <footer class="dialog-foot">
        <span class="spacer" />
        <button class="btn" onClick={close}>
          Cancel
        </button>
        <button class="btn primary" disabled={busy() || !loaded()} onClick={() => void save()}>
          Save
        </button>
      </footer>
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
            <Show when={(item.count ?? 1) > 1}>
              <span class="toast-count" aria-label={`${item.count} times`}>×{item.count}</span>
            </Show>
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
