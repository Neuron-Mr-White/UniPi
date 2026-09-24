/**
 * Task detail panel, the comment prompt for moves that need one, and the
 * "New task" dialog.
 */

import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import { api, MUTED_LANES, PRIORITIES, canMove, needsComment, type Task } from "./api.js";
import { Icon } from "./icons.js";
import { renderMarkdown, relativeTime } from "./markdown.js";
import { board, dismissToast, loadBoard, openTaskId, rules, toast, toasts, upsertTask } from "./state.js";

export interface PanelProps {
  slug: string;
  onClose: () => void;
}

export function TaskPanel(props: PanelProps): JSX.Element {
  const task = (): Task | undefined => board.tasks.find((candidate) => candidate.id === openTaskId());
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [mode, setMode] = createSignal<"view" | "edit">("view");
  const [comment, setComment] = createSignal("");
  const [depQuery, setDepQuery] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    const current = task();
    if (!current) return;
    setTitle(current.title);
    setBody(current.body ?? "");
    setComment("");
  });

  const run = async (work: () => Promise<unknown>, message?: string): Promise<void> => {
    setBusy(true);
    try {
      await work();
      await loadBoard(props.slug);
      if (message) toast(message, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const statusOptions = (current: Task): string[] => {
    const allowed = rules.allowedMoves[current.status];
    const moves = Array.isArray(current.allowedMoves) && current.allowedMoves.length > 0 ? current.allowedMoves : allowed ?? [];
    return [current.status, ...moves];
  };

  const depCandidates = (current: Task): Task[] => {
    const needle = depQuery().trim().toLowerCase();
    return board.tasks
      .filter((candidate) => candidate.id !== current.id && !(current.deps ?? []).includes(candidate.id))
      .filter((candidate) => needle.length === 0 || candidate.id.toLowerCase().includes(needle) || candidate.title.toLowerCase().includes(needle))
      .slice(0, 6);
  };

  async function moveTo(current: Task, to: string): Promise<void> {
    const hint = needsComment(rules, current.status, to);
    if (hint && !window.confirm(`${to.replace("_", " ")} needs a comment (${hint}). Add one?`)) return;
    const note = hint ? window.prompt(`${hint}:`) ?? undefined : undefined;
    if (hint && note === undefined) return;
    await run(async () => upsertTask(await api.move(props.slug, current.id, to, note)), `${current.id} → ${to.replace("_", " ")}`);
  }

  return (
    <Show when={task()}>
      {(current) => (
        <>
          <div class="scrim" onClick={props.onClose} />
          <aside class="panel" role="dialog" aria-label={`${current().id} details`} onKeyDown={(event) => event.key === "Escape" && props.onClose()}>
            <header class="panel-head">
              <span class="mono muted">{current().id}</span>
              <span class={`dot ${current().status}`} aria-hidden="true" />
              <span class="meta">{current().status.replace("_", " ")}</span>
              <Show when={current().staleness && current().status === "in_progress" && current().staleness !== "running"}>
                <span class="chip stale">stale run</span>
              </Show>
              <span class="spacer" />
              <button class="ghost icon" aria-label="Close details" onClick={props.onClose}>
                <Icon.close size={16} />
              </button>
            </header>

            <div class="panel-body">
              <div class="panel-main">
                <input
                  class="title-input"
                  value={title()}
                  aria-label="Task title"
                  onInput={(event) => setTitle(event.currentTarget.value)}
                  onBlur={() => title().trim() && title() !== current().title && void run(() => api.edit(props.slug, current().id, { title: title().trim() }), "Title saved")}
                  onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                />

                <section>
                  <div class="row" style={{ "justify-content": "space-between", "margin-bottom": "8px" }}>
                    <h3 class="section-title" style={{ margin: 0 }}>Description</h3>
                    <div class="tabs" role="tablist">
                      <button role="tab" aria-selected={mode() === "view"} onClick={() => setMode("view")}>Preview</button>
                      <button role="tab" aria-selected={mode() === "edit"} onClick={() => setMode("edit")}>Edit</button>
                    </div>
                  </div>
                  <Show
                    when={mode() === "edit"}
                    fallback={
                      <div class="body-view" innerHTML={renderMarkdown(current().body) || '<p class="muted">No description.</p>'} />
                    }
                  >
                    <textarea
                      value={body()}
                      aria-label="Task body (markdown)"
                      onInput={(event) => setBody(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void run(() => api.edit(props.slug, current().id, { body: body() }), "Description saved");
                        }
                      }}
                    />
                    <div class="row" style={{ "margin-top": "8px" }}>
                      <button class="primary" disabled={busy()} onClick={() => void run(() => api.edit(props.slug, current().id, { body: body() }), "Description saved")}>
                        Save description
                      </button>
                      <span class="meta">⌘/Ctrl+Enter</span>
                    </div>
                  </Show>
                </section>

                <section>
                  <h3 class="section-title">Comment</h3>
                  <textarea
                    value={comment()}
                    placeholder="What changed, what you verified, what is blocked…"
                    aria-label="Add a comment"
                    onInput={(event) => setComment(event.currentTarget.value)}
                  />
                  <div class="row" style={{ "margin-top": "8px" }}>
                    <button
                      class="primary"
                      disabled={busy() || comment().trim().length === 0}
                      onClick={() => void run(async () => { await api.note(props.slug, current().id, comment().trim()); setComment(""); }, "Comment added")}
                    >
                      Add comment
                    </button>
                  </div>
                </section>

                <section>
                  <h3 class="section-title">Activity</h3>
                  <ul class="timeline">
                    <For each={[...current().activity].reverse().slice(0, 30)}>
                      {(entry) => (
                        <li>
                          <span class={`avatar ${entry.actor}`} aria-hidden="true">{entry.actor === "agent" ? "⌬" : entry.actor === "system" ? "⚙" : "◍"}</span>
                          <div>
                            <div class="row" style={{ gap: "6px" }}>
                              <strong style={{ "font-size": "12px" }}>{entry.actor}</strong>
                              <span class="meta">{relativeTime(entry.at)}</span>
                            </div>
                            <div class="dim" style={{ "white-space": "pre-wrap" }}>{entry.text}</div>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </div>

              <aside class="panel-side">
                <div class="field">
                  <label for="status">Status</label>
                  <div class="select-wrap">
                    <select
                      id="status"
                      value={current().status}
                      disabled={busy()}
                      onChange={(event) => void moveTo(current(), event.currentTarget.value)}
                    >
                      <For each={statusOptions(current())}>{(option) => <option value={option}>{option.replace("_", " ")}</option>}</For>
                    </select>
                    <Icon.chevron size={14} />
                  </div>
                </div>

                <div class="field">
                  <label for="priority">Priority</label>
                  <div class="select-wrap">
                    <select
                      id="priority"
                      value={current().priority}
                      disabled={busy()}
                      onChange={(event) => void run(() => api.edit(props.slug, current().id, { priority: event.currentTarget.value }), "Priority saved")}
                    >
                      <For each={PRIORITIES}>{(option) => <option value={option}>{option}</option>}</For>
                    </select>
                    <Icon.chevron size={14} />
                  </div>
                </div>

                <div class="field">
                  <label>Dependencies</label>
                  <ul class="stack" style={{ "list-style": "none", padding: 0, margin: "0 0 8px" }}>
                    <For each={current().deps}>
                      {(dep) => (
                        <li class="row">
                          <span class="mono">{dep}</span>
                          <button class="ghost icon" aria-label={`Remove dependency ${dep}`} onClick={() => void run(() => api.unlink(props.slug, current().id, dep), "Dependency removed")}>
                            <Icon.close size={12} />
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                  <input
                    placeholder="Search an id…"
                    value={depQuery()}
                    aria-label="Search tasks to depend on"
                    onInput={(event) => setDepQuery(event.currentTarget.value)}
                  />
                  <Show when={depQuery().trim().length > 0}>
                    <ul class="stack" style={{ "list-style": "none", padding: 0, margin: "8px 0 0" }}>
                      <For each={depCandidates(current())}>
                        {(candidate) => (
                          <li>
                            <button
                              class="ghost"
                              style={{ width: "100%", "text-align": "left" }}
                              onClick={() => void run(async () => { await api.link(props.slug, current().id, candidate.id); setDepQuery(""); }, `After ${candidate.id}`)}
                            >
                              <span class="mono">{candidate.id}</span> <span class="nowrap">{candidate.title}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>

                <div class="field row" style={{ gap: "8px", "align-items": "stretch" }}>
                  <Show when={!MUTED_LANES.has(current().status)}>
                    <button class="secondary grow" disabled={busy()} onClick={() => void run(() => api.duplicate(props.slug, current().id), "Duplicated")}>
                      Duplicate
                    </button>
                  </Show>
                  <Show when={canMove(rules, current(), "cancelled")}>
                    <button class="danger grow" disabled={busy()} onClick={() => void moveTo(current(), "cancelled")}>
                      Cancel task
                    </button>
                  </Show>
                </div>
                <Show when={current().path}>
                  <p class="meta mono" style={{ "word-break": "break-all" }}>{current().path}</p>
                </Show>
              </aside>
            </div>
          </aside>
        </>
      )}
    </Show>
  );
}

/** Shown when a drop needs a comment before the server will accept it. */
export function CommentModal(props: {
  request: { task: Task; to: string; hint: string } | null;
  slug: string;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (props.request) setText("");
  });

  async function submit(): Promise<void> {
    const request = props.request;
    if (!request) return;
    setBusy(true);
    try {
      upsertTask(await api.move(props.slug, request.task.id, request.to, text().trim()));
      if (request.to) await api.order(props.slug, request.task.id, { bottom: true });
      await loadBoard(props.slug);
      toast(`${request.task.id} → ${request.to.replace("_", " ")}`, "success");
      props.onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={props.request}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Comment required" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
        <div class="dialog" style={{ width: "min(520px, 96vw)" }}>
          <header class="dialog-head">
            <Icon.warn size={16} />
            <strong>Comment required</strong>
            <span class="spacer" />
            <button class="ghost icon" aria-label="Cancel" onClick={props.onClose}>
              <Icon.close size={14} />
            </button>
          </header>
          <div class="dialog-body">
            <p class="prompt">
              {props.request!.task.id} → {props.request!.to.replace("_", " ")}: {props.request!.hint}
            </p>
            <textarea
              autofocus
              value={text()}
              placeholder="This comment is what the next reader sees…"
              aria-label="Comment"
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
            <span class="meta spacer" style={{ "text-align": "left" }}>⌘/Ctrl+Enter</span>
            <button onClick={props.onClose}>Cancel</button>
            <button class="primary" disabled={busy() || text().trim().length === 0} onClick={() => void submit()}>
              Save &amp; move
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

/** "New task" dialog: title, body, lane, priority, optional dependency. */
export function NewTaskDialog(props: { slug: string; lane: string | null; onClose: () => void }): JSX.Element {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [lane, setLane] = createSignal("backlog");
  const [priority, setPriority] = createSignal("none");
  const [after, setAfter] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (props.lane) setLane(props.lane === "todo" ? "todo" : "backlog");
    setTitle("");
    setBody("");
    setAfter("");
    setPriority("none");
  });

  async function submit(): Promise<void> {
    if (title().trim().length === 0) return;
    setBusy(true);
    try {
      const created = await api.create(props.slug, {
        title: title().trim(),
        body: body().trim() || undefined,
        status: lane(),
        priority: priority(),
        after: after().trim() ? [after().trim()] : undefined,
      });
      await loadBoard(props.slug);
      toast(`${created.id} added`, "success");
      props.onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={props.lane !== null}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="New task" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
        <div class="dialog">
          <header class="dialog-head">
            <Icon.plus size={16} />
            <strong>New task</strong>
            <span class="spacer" />
            <button class="ghost icon" aria-label="Cancel" onClick={props.onClose}>
              <Icon.close size={14} />
            </button>
          </header>
          <div class="dialog-body">
            <div class="field">
              <label for="new-title">Title</label>
              <input id="new-title" autofocus value={title()} onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && void submit()} />
            </div>
            <div class="field">
              <label for="new-body">Description</label>
              <textarea id="new-body" value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
            </div>
            <div class="row" style={{ gap: "12px" }}>
              <div class="field grow" style={{ margin: 0 }}>
                <label for="new-lane">Lane</label>
                <div class="select-wrap">
                  <select id="new-lane" value={lane()} onChange={(event) => setLane(event.currentTarget.value)}>
                    <option value="backlog">Backlog</option>
                    <option value="todo">Todo</option>
                  </select>
                  <Icon.chevron size={14} />
                </div>
              </div>
              <div class="field grow" style={{ margin: 0 }}>
                <label for="new-priority">Priority</label>
                <select id="new-priority" value={priority()} onChange={(event) => setPriority(event.currentTarget.value)}>
                  <For each={PRIORITIES}>{(option) => <option value={option}>{option}</option>}</For>
                </select>
              </div>
              <div class="field grow" style={{ margin: 0 }}>
                <label for="new-after">After (id)</label>
                <input id="new-after" placeholder="optional" value={after()} onInput={(event) => setAfter(event.currentTarget.value)} />
              </div>
            </div>
          </div>
          <footer class="dialog-foot">
            <button onClick={props.onClose}>Cancel</button>
            <button class="primary" disabled={busy() || title().trim().length === 0} onClick={() => void submit()}>
              Add task
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

/** Toasts (bottom-right, dismissible). */
export function Toasts(): JSX.Element {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={toasts()}>
        {(item) => (
          <div class={`toast ${item.kind}`}>
            <span class="grow">{item.message}</span>
            <button class="ghost icon" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
              <Icon.close size={12} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
