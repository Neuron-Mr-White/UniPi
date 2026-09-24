/**
 * Task detail drawer: editable title, markdown body with inline edit, activity
 * timeline + auto-growing composer; a properties rail (status limited to allowed
 * moves, priority, dependencies, labels, run block, file path).
 */

import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { api, canMove, needsComment, PRIORITIES, type Task } from "./api.js";
import { Icon, PRIORITY_LABEL, PriorityGlyph, StatusGlyph } from "./icons.js";
import { hasMarkup, relativeTime, renderMarkdown } from "./markdown.js";
import { filesFrom, insertAtCursor, uploadAll } from "./attach.js";
import { hue } from "./paint.js";
import { offerToSchedule } from "./schedule.js";
import {
  board,
  describe,
  elapsed,
  laneLabel,
  loadBoard,
  openTaskId,
  rules,
  setCommentRequest,
  setOpenTaskId,
  slug,
  toast,
  upsertTask,
} from "./state.js";
import { AutoTextarea, Avatar, Kbd, MenuItem, MenuLabel, MenuSeparator, MOD, Popover } from "./ui.js";

export function TaskPanel(): JSX.Element {
  const task = (): Task | undefined => board.tasks.find((candidate) => candidate.id === openTaskId());
  const close = (): void => {
    setOpenTaskId(null);
  };
  return (
    <Show when={task()}>
      {(current) => (
        <Portal>
          <div class="drawer-scrim" onClick={close} />
          <aside class="drawer panel" role="dialog" aria-label={`${current().id} details`}>
            <Drawer task={current()} onClose={close} />
          </aside>
        </Portal>
      )}
    </Show>
  );
}

function Drawer(props: { task: Task; onClose: () => void }): JSX.Element {
  const [title, setTitle] = createSignal(props.task.title);
  const [body, setBody] = createSignal(props.task.body ?? "");
  const [editing, setEditing] = createSignal(false);
  const [comment, setComment] = createSignal("");
  const [labelDraft, setLabelDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [uploading, setUploading] = createSignal(0);
  const [dropOver, setDropOver] = createSignal<"comment" | "body" | null>(null);
  let commentArea: HTMLTextAreaElement | undefined;
  let bodyArea: HTMLTextAreaElement | undefined;
  let filePicker: HTMLInputElement | undefined;

  /** Upload files and drop their markdown into the comment or the description draft. */
  async function attach(files: File[], into: "comment" | "body"): Promise<void> {
    if (files.length === 0) return;
    setUploading((count) => count + files.length);
    try {
      const done = await uploadAll(props.task.id, files);
      if (done.length === 0) return;
      const snippet = done.map((item) => item.markdown).join("\n");
      if (into === "body") setBody((current) => insertAtCursor(bodyArea, current, snippet));
      else setComment((current) => insertAtCursor(commentArea, current, snippet));
    } finally {
      setUploading((count) => Math.max(0, count - files.length));
    }
  }
  const dropHandlers = (into: "comment" | "body") => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDropOver(into);
    },
    onDragLeave: () => setDropOver(null),
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDropOver(null);
      void attach(filesFrom(event), into);
    },
    onPaste: (event: ClipboardEvent) => {
      const files = filesFrom(event);
      if (files.length === 0) return;
      event.preventDefault();
      void attach(files, into);
    },
  });

  // Reset drafts when a different task opens (not on every live refresh).
  createEffect(
    on(
      () => props.task.id,
      () => {
        setTitle(props.task.title);
        setBody(props.task.body ?? "");
        setEditing(false);
        setComment("");
      },
    ),
  );
  createEffect(
    on(
      () => props.task.title,
      (next) => {
        if (document.activeElement?.classList.contains("title-edit")) return;
        setTitle(next);
      },
    ),
  );

  const target = (): string => slug() ?? "";

  const run = async (work: () => Promise<unknown>, message?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      await loadBoard(target());
      if (message) toast(message, "success");
      return true;
    } catch (error) {
      toast(describe(error), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const moves = (): string[] => {
    const current = props.task;
    const explicit =
      Array.isArray(current.allowedMoves) && current.allowedMoves.length > 0 ? current.allowedMoves : rules.allowedMoves[current.status] ?? [];
    return explicit.filter((status) => status !== current.status && status !== "archived");
  };

  function moveTo(to: string): void {
    const current = props.task;
    const hint = needsComment(rules, current.status, to);
    if (hint) {
      setCommentRequest({ task: { ...current }, to, hint });
      return;
    }
    void run(async () => upsertTask(await api.move(target(), current.id, to)), `Moved ${current.id} to ${laneLabel(to)}`).then(
      (ok) => ok && to === "todo" && offerToSchedule(current.id),
    );
  }

  const saveTitle = (): void => {
    const next = title().trim();
    if (next && next !== props.task.title) void run(() => api.edit(target(), props.task.id, { title: next }));
    else setTitle(props.task.title);
  };

  const saveBody = async (): Promise<void> => {
    if (body() === (props.task.body ?? "")) {
      setEditing(false);
      return;
    }
    if (await run(() => api.edit(target(), props.task.id, { body: body() }), "Description saved")) setEditing(false);
  };

  const addComment = async (): Promise<void> => {
    const text = comment().trim();
    if (!text) return;
    if (await run(() => api.note(target(), props.task.id, text))) setComment("");
  };

  const addLabel = (): void => {
    const label = labelDraft().trim().replace(/,/g, "");
    setLabelDraft("");
    if (!label || (props.task.labels ?? []).includes(label)) return;
    void run(() => api.edit(target(), props.task.id, { labels: [...(props.task.labels ?? []), label] }));
  };

  const copy = (text: string, what: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => toast(`Copied ${what}`, "success"),
      () => toast(`Couldn't copy ${what}`, "error"),
    );
  };

  const depTask = (id: string): Task | undefined => board.tasks.find((candidate) => candidate.id === id);

  return (
    <>
      <header class="drawer-head panel-head">
        <span class="crumb-pill">
          <StatusGlyph status={props.task.status} />
          {props.task.id}
        </span>
        <Show when={props.task.run}>
          <span class="agent-chip">
            <span class="pulse" />
            agent · {props.task.run?.mode ?? "direct"} · {elapsed(props.task.run?.started)}
          </span>
        </Show>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Copy task id" title="Copy id" onClick={() => copy(props.task.id, "id")}>
          <Icon.copy />
        </button>
        <Popover
          width={220}
          align="end"
          label="Task actions"
          trigger={(api) => (
            <button class="icon-btn" ref={api.ref} aria-label="Task actions" aria-expanded={api.open} onClick={api.toggle}>
              <Icon.more />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Icon.duplicate size={14} />}
                label="Duplicate"
                onSelect={() => {
                  close();
                  void run(() => api.duplicate(target(), props.task.id), "Duplicated");
                }}
              />
              <MenuItem
                icon={<Icon.copy size={14} />}
                label="Copy file path"
                disabled={!props.task.path}
                onSelect={() => {
                  close();
                  copy(props.task.path ?? "", "path");
                }}
              />
              <Show when={props.task.status !== "archived" && canMove(rules, props.task, "archived")}>
                <MenuItem
                  icon={<Icon.archive size={14} />}
                  label="Archive"
                  onSelect={() => {
                    close();
                    moveTo("archived");
                  }}
                />
              </Show>
              <Show when={props.task.status !== "cancelled" && canMove(rules, props.task, "cancelled")}>
                <MenuSeparator />
                <MenuItem
                  icon={<Icon.close size={14} />}
                  label="Cancel task"
                  danger
                  onSelect={() => {
                    close();
                    moveTo("cancelled");
                  }}
                />
              </Show>
            </>
          )}
        </Popover>
        <button class="icon-btn" aria-label="Close details" title="Close  Esc" onClick={props.onClose}>
          <Icon.close />
        </button>
      </header>

      <div class="drawer-body">
        <div class="drawer-main">
          <AutoTextarea
            class="title-edit title-input"
            rows={1}
            value={title()}
            aria-label="Task title"
            onInput={(event) => setTitle(event.currentTarget.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setTitle(props.task.title);
                event.currentTarget.blur();
                event.stopPropagation();
              }
            }}
          />

          <div class="section" style={{ "margin-top": "10px" }}>
            <Show
              when={editing()}
              fallback={
                <div
                  class={`body-view${(props.task.body ?? "").trim() ? "" : " empty"}`}
                  role="button"
                  tabindex="0"
                  title="Click to edit"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("a")) return;
                    setBody(props.task.body ?? "");
                    setEditing(true);
                  }}
                  onKeyDown={(event) => event.key === "Enter" && setEditing(true)}
                  innerHTML={renderMarkdown(props.task.body) || "Add a description…"}
                />
              }
            >
              <div class={`body-editor${dropOver() === "body" ? " drop-over" : ""}`} {...dropHandlers("body")}>
                <AutoTextarea
                  value={body()}
                  areaRef={(el) => (bodyArea = el)}
                  maxHeight={480}
                  aria-label="Description (markdown)"
                  autofocus
                  onInput={(event) => setBody(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void saveBody();
                    }
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setEditing(false);
                    }
                  }}
                />
                <div class="editor-foot">
                  <button class="btn primary" disabled={busy()} onClick={() => void saveBody()}>
                    Save
                  </button>
                  <button class="btn" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <span class="hint">Markdown · paste or drop files · {MOD}+Enter to save</span>
                </div>
              </div>
            </Show>
          </div>

          <div class="section">
            <div class="section-head">
              Activity
              <span class="spacer" />
              <span class="muted num" style={{ "font-weight": 450 }}>
                {props.task.activity.length}
              </span>
            </div>
            <ul class="timeline">
              <For each={[...props.task.activity].reverse().slice(0, 40)}>
                {(entry) => (
                  <li>
                    <Avatar actor={entry.actor} />
                    <div>
                      <div class="who">
                        <strong>{entry.actor}</strong>
                        <time datetime={entry.at} title={entry.at}>
                          {relativeTime(entry.at)}
                        </time>
                      </div>
                      <Show
                        when={hasMarkup(entry.text)}
                        fallback={<div class={`what${entry.actor === "system" ? " system" : ""}`}>{entry.text}</div>}
                      >
                        <div class={`what md${entry.actor === "system" ? " system" : ""}`} innerHTML={renderMarkdown(entry.text)} />
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
            <div class={`composer${dropOver() === "comment" ? " drop-over" : ""}`} {...dropHandlers("comment")}>
              <AutoTextarea
                value={comment()}
                areaRef={(el) => (commentArea = el)}
                placeholder="Leave a note — paste or drop screenshots, logs, files…"
                aria-label="Add a comment"
                onInput={(event) => setComment(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void addComment();
                  }
                }}
              />
              <Show when={comment().includes("att:")}>
                <div class="composer-preview md" innerHTML={renderMarkdown(comment())} />
              </Show>
              <div class="composer-foot">
                <button class="icon-btn" aria-label="Attach files" title="Attach files (or paste / drop)" onClick={() => filePicker?.click()}>
                  <Icon.paperclip />
                </button>
                <input
                  ref={filePicker}
                  type="file"
                  multiple
                  hidden
                  aria-label="Choose files to attach"
                  onChange={(event) => {
                    const files = [...(event.currentTarget.files ?? [])];
                    event.currentTarget.value = "";
                    void attach(files, "comment");
                  }}
                />
                <Show when={uploading() > 0}>
                  <span class="uploading">
                    <span class="spinner" /> Uploading {uploading()}…
                  </span>
                </Show>
                <span class="hint">
                  <Kbd keys={[MOD, "↵"]} />
                </span>
                <span class="spacer" />
                <button class="btn primary" disabled={busy() || uploading() > 0 || comment().trim().length === 0} onClick={() => void addComment()}>
                  Comment
                </button>
              </div>
            </div>
          </div>
        </div>

        <aside class="drawer-side">
          <div class="prop">
            <span class="prop-label">Status</span>
            <Popover
              width={220}
              label="Change status"
              trigger={(api) => (
                <button class="prop-value" id="status" ref={api.ref} aria-expanded={api.open} disabled={busy() || !!props.task.run} onClick={api.toggle}>
                  <StatusGlyph status={props.task.status} />
                  {laneLabel(props.task.status)}
                  <Icon.chevronDown size={12} class="caret" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>Move to</MenuLabel>
                  <MenuItem role="option" icon={<StatusGlyph status={props.task.status} />} label={laneLabel(props.task.status)} checked onSelect={close} />
                  <For each={moves()}>
                    {(status) => (
                      <MenuItem
                        role="option"
                        icon={<StatusGlyph status={status} />}
                        label={laneLabel(status)}
                        hint={needsComment(rules, props.task.status, status) ? "needs note" : undefined}
                        checked={false}
                        onSelect={() => {
                          close();
                          moveTo(status);
                        }}
                      />
                    )}
                  </For>
                  <Show when={moves().length === 0}>
                    <div class="menu-section">No moves from {laneLabel(props.task.status)}.</div>
                  </Show>
                </>
              )}
            </Popover>
          </div>

          <div class="prop">
            <span class="prop-label">Priority</span>
            <Popover
              width={200}
              label="Change priority"
              trigger={(api) => (
                <button
                  class={`prop-value${props.task.priority === "none" ? " muted" : ""}`}
                  id="priority"
                  ref={api.ref}
                  aria-expanded={api.open}
                  disabled={busy()}
                  onClick={api.toggle}
                >
                  <PriorityGlyph priority={props.task.priority} />
                  {PRIORITY_LABEL[props.task.priority]}
                  <Icon.chevronDown size={12} class="caret" />
                </button>
              )}
            >
              {(close) => (
                <For each={[...PRIORITIES].reverse()}>
                  {(priority) => (
                    <MenuItem
                      role="option"
                      icon={<PriorityGlyph priority={priority} />}
                      label={PRIORITY_LABEL[priority]}
                      checked={props.task.priority === priority}
                      onSelect={() => {
                        close();
                        if (priority !== props.task.priority) void run(() => api.edit(target(), props.task.id, { priority }));
                      }}
                    />
                  )}
                </For>
              )}
            </Popover>
          </div>

          <div class="rail-sep" />
          <div class="rail-title">Runs after</div>
          <Show when={(props.task.lockedBy ?? []).length > 0}>
            <div class="lock-note">
              <Icon.lock size={12} />
              <span>
                Locked — {(props.task.lockedBy ?? []).join(", ")} {(props.task.lockedBy ?? []).length === 1 ? "is" : "are"} still in Backlog.
              </span>
              <button
                class="btn"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    for (const dep of props.task.lockedBy ?? []) await api.move(target(), dep, "todo");
                  }, `Scheduled ${(props.task.lockedBy ?? []).join(", ")}`)
                }
              >
                Move to Todo
              </button>
            </div>
          </Show>
          <div class="dep-list">
            <For each={props.task.deps}>
              {(dep) => (
                <div class="dep-item">
                  <StatusGlyph status={depTask(dep)?.status ?? "backlog"} />
                  <button class="dep-text" onClick={() => depTask(dep) && setOpenTaskId(dep)} title={depTask(dep)?.title}>
                    <span class="mono">{dep}</span>
                    {depTask(dep)?.title ?? "missing task"}
                  </button>
                  <button class="icon-btn sm" aria-label={`Remove dependency ${dep}`} onClick={() => void run(() => api.unlink(target(), props.task.id, dep))}>
                    <Icon.close size={12} />
                  </button>
                </div>
              )}
            </For>
            <DepPicker task={props.task} onPick={(id) => void run(() => api.link(target(), props.task.id, id), `Now runs after ${id}`)} />
          </div>

          <div class="rail-sep" />
          <div class="rail-title">Labels</div>
          <Show when={(props.task.labels ?? []).length > 0}>
            <div class="label-list">
              <For each={props.task.labels ?? []}>
                {(label) => (
                  <span class="tag label removable" style={{ "--label-hue": hue(label) }}>
                    <span>{label}</span>
                    <button
                      aria-label={`Remove label ${label}`}
                      onClick={() =>
                        void run(() => api.edit(target(), props.task.id, { labels: (props.task.labels ?? []).filter((item) => item !== label) }))
                      }
                    >
                      <Icon.close size={10} />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <input
            class="label-input"
            placeholder="+ Add label"
            aria-label="Add label"
            value={labelDraft()}
            onInput={(event) => setLabelDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addLabel();
              }
            }}
            onBlur={addLabel}
          />

          <Show when={props.task.run}>
            <div class="rail-sep" />
            <div class="run-card">
              <span class="agent-chip">
                <span class="pulse" />
                Agent running
              </span>
              <dl>
                <dt>mode</dt>
                <dd>{props.task.run?.mode ?? "direct"}</dd>
                <dt>session</dt>
                <dd>{props.task.run?.session ?? "—"}</dd>
                <dt>host</dt>
                <dd>{props.task.run?.host ?? "—"}</dd>
                <dt>pid</dt>
                <dd>{props.task.run?.pid ?? "—"}</dd>
                <dt>started</dt>
                <dd>{elapsed(props.task.run?.started) === "now" ? "just now" : `${elapsed(props.task.run?.started)} ago`}</dd>
              </dl>
            </div>
          </Show>

          <Show when={(props.task.attachments ?? []).length > 0}>
            <div class="rail-sep" />
            <div class="rail-title">Attachments · {(props.task.attachments ?? []).length}</div>
            <div class="att-rail">
              <For each={props.task.attachments ?? []}>
                {(item) => (
                  <a class={`att-rail-item att-${item.kind}`} href={`/api/files/${encodeURIComponent(slug() ?? "")}/${props.task.id}/${item.name}`} target="_blank" rel="noopener" title={`${item.original} · ${formatSize(item.size)}`}>
                    <Show when={item.kind === "image"} fallback={<span class="att-badge">{item.original.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"}</span>}>
                      <img src={`/api/files/${encodeURIComponent(slug() ?? "")}/${props.task.id}/${item.name}`} alt={item.original} loading="lazy" />
                    </Show>
                    <span class="att-rail-name">{item.original}</span>
                    <span class="att-rail-size">{formatSize(item.size)}</span>
                  </a>
                )}
              </For>
            </div>
          </Show>

          <div class="rail-sep" />
          <dl class="meta-lines">
            <dt>Created</dt>
            <dd title={props.task.created}>{relativeTime(props.task.created)}</dd>
            <dt>Updated</dt>
            <dd title={props.task.updated}>{relativeTime(props.task.updated)}</dd>
          </dl>
          <Show when={props.task.path}>
            <div class="path-box" title={props.task.path}>
              <span>{props.task.path}</span>
              <button class="icon-btn sm" aria-label="Copy file path" onClick={() => copy(props.task.path ?? "", "path")}>
                <Icon.copy size={12} />
              </button>
            </div>
          </Show>
        </aside>
      </div>
    </>
  );
}

function DepPicker(props: { task: Task; onPick: (id: string) => void }): JSX.Element {
  const [needle, setNeedle] = createSignal("");
  const candidates = (): Task[] => {
    const text = needle().trim().toLowerCase();
    return board.tasks
      .filter((candidate) => candidate.id !== props.task.id && !(props.task.deps ?? []).includes(candidate.id))
      .filter((candidate) => !["cancelled", "archived"].includes(candidate.status))
      .filter((candidate) => !text || candidate.id.toLowerCase().includes(text) || candidate.title.toLowerCase().includes(text))
      .slice(0, 8);
  };
  return (
    <Popover
      width={300}
      label="Add dependency"
      trigger={(api) => (
        <button class="rail-add" ref={api.ref} aria-expanded={api.open} onClick={api.toggle}>
          <Icon.plus size={13} />
          Add dependency
        </button>
      )}
    >
      {(close) => (
        <>
          <div class="pop-search">
            <Icon.search size={14} />
            <input placeholder="Runs after…" aria-label="Search tasks to depend on" value={needle()} onInput={(event) => setNeedle(event.currentTarget.value)} />
          </div>
          <For each={candidates()} fallback={<div class="menu-section">No matching tasks.</div>}>
            {(candidate) => (
              <MenuItem
                role="option"
                icon={<StatusGlyph status={candidate.status} />}
                label={
                  <>
                    <span class="mono muted" style={{ "margin-right": "6px" }}>
                      {candidate.id}
                    </span>
                    {candidate.title}
                  </>
                }
                onSelect={() => {
                  close();
                  setNeedle("");
                  props.onPick(candidate.id);
                }}
              />
            )}
          </For>
        </>
      )}
    </Popover>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
