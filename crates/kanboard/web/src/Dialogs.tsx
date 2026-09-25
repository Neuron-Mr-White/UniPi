/** Dialogs: new task, comment-required move, ⌘K command palette, shortcuts, toasts. */

import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { api, ApiError, PRIORITIES, type Settings } from "./api.js";
import { DepList } from "./dep-picker.js";
import { Icon, PRIORITY_LABEL, PriorityGlyph, StatusGlyph } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { ProjectTile } from "./paint.js";
import { offerToSchedule } from "./schedule.js";
import { filesFrom, namedFile, uploadAll } from "./attach.js";
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
  setSettingsOpen,
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
  /** Files picked/pasted before the task exists — uploaded right after creation. */
  const [pending, setPending] = createSignal<File[]>([]);
  let picker: HTMLInputElement | undefined;
  const addFiles = (files: File[]): void => {
    if (files.length > 0) setPending((current) => [...current, ...files.map(namedFile)]);
  };

  createEffect(
    on(newTaskLane, (next) => {
      if (next === null) return;
      setLane(next === "todo" ? "todo" : "backlog");
      setTitle("");
      setBody("");
      setAfter([]);
      setPriority("none");
      setPending([]);
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
        document.querySelector<HTMLInputElement>(".dialog-title-input")?.focus();
      } else close();
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  }


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
          onPaste={(event) => {
            const files = filesFrom(event);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
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
      <div
        class="prop-row"
        onDragOver={(event) => event.dataTransfer?.types.includes("Files") && event.preventDefault()}
        onDrop={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          addFiles(filesFrom(event));
        }}
      >
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
      if (request.to === "todo") offerToSchedule(request.task.id);
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
  const doneCount = (): number => board.tasks.filter((task) => task.status === "done").length;

  createEffect(
    on(summarizeOpen, (open) => {
      if (!open) return;
      setStep("config");
      setSummary("");
      setTaskIds([]);
      setNeedsAgent(false);
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
      const result = await api.summarize(target, instruction());
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

// ─── settings ───────────────────────────────────────────────────────────────

export function SettingsDialog(): JSX.Element {
  const [loaded, setLoaded] = createSignal<Settings | null>(null);
  const [model, setModel] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [instruction, setInstruction] = createSignal("");
  const [customInstruction, setCustomInstruction] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [modelsState, setModelsState] = createSignal<"loading" | "ok" | "error">("loading");
  const [modelsError, setModelsError] = createSignal("");
  const [modelList, setModelList] = createSignal<string[]>([]);

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
      setFilter("");
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
        })
        .catch((error) => toast(describe(error), "error"));
      void loadModels();
    }),
  );

  const close = (): void => void setSettingsOpen(false);

  /** "provider/id" → grouped by provider, filterable. */
  const grouped = createMemo((): Array<[string, string[]]> => {
    const needle = filter().trim().toLowerCase();
    const models = modelList().filter((entry) => !needle || entry.toLowerCase().includes(needle));
    const groups = new Map<string, string[]>();
    for (const entry of models) {
      const provider = entry.split("/")[0] ?? "other";
      groups.set(provider, [...(groups.get(provider) ?? []), entry]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await api.saveSettings({
        summaryModel: model().trim(),
        summaryInstruction: customInstruction() ? instruction() : "",
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
      <div class="dialog-body settings-form">
        <Show when={loaded()} fallback={<div class="skeleton" style={{ height: "120px" }} />}>
          <div class="settings-heading">Summaries</div>
          <div class="field">
            <span class="field-label">
              Model
              <span class="spacer" />
              <Show when={modelsState() !== "loading"}>
                <button class="link-btn" onClick={() => void loadModels(true)}>
                  Refresh
                </button>
              </Show>
            </span>
            <Show
              when={modelsState() === "loading"}
              fallback={
                <>
                  <Show when={modelList().length > 12}>
                    <input
                      class="input"
                      placeholder="Filter models…"
                      aria-label="Filter models"
                      value={filter()}
                      onInput={(event) => setFilter(event.currentTarget.value)}
                      ref={(el) => queueMicrotask(() => el.focus({ preventScroll: true }))}
                    />
                  </Show>
                  <select
                    class="input"
                    aria-label="Summary model"
                    value={model()}
                    onChange={(event) => setModel(event.currentTarget.value)}
                  >
                    <option value="">pi default</option>
                    <For each={grouped()}>
                      {([provider, models]) => (
                        <optgroup label={provider}>
                          <For each={models}>{(entry) => <option value={entry}>{entry}</option>}</For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                  <Show when={modelsState() === "error"}>
                    <span class="field-hint" role="alert">{modelsError()}</span>
                  </Show>
                </>
              }
            >
              <span class="field-hint">Loading your models…</span>
            </Show>
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
