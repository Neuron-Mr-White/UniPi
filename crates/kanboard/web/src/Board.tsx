/**
 * The board: fixed-width lanes at the left edge, a themed horizontal scroll, and
 * HTML5 drag & drop with an explicit drop indicator, allowed-target highlighting
 * and optimistic updates that roll back on refusal.
 */

import { For, Show, createSignal, type JSX } from "solid-js";
import { api, canMove, LANES, MUTED_LANES, needsComment, type Task } from "./api.js";
import { Icon, PriorityIcon } from "./icons.js";
import { board, laneCount, loadBoard, rules, showArchive, toast, upsertTask, visibleTasks } from "./state.js";

const visibleLanes = (): readonly { id: string; label: string }[] =>
  showArchive() ? LANES : LANES.filter((lane) => lane.id !== "archived");

export interface BoardProps {
  slug: string;
  onOpenTask: (id: string) => void;
  onNeedsComment: (task: Task, to: string, hint: string) => void;
  onNewTask: (lane: string) => void;
}

export function Board(props: BoardProps): JSX.Element {
  const [dragging, setDragging] = createSignal<Task | null>(null);
  const [dropLane, setDropLane] = createSignal<string | null>(null);
  const [dropBefore, setDropBefore] = createSignal<string | null>(null);

  const reset = (): void => {
    setDragging(null);
    setDropLane(null);
    setDropBefore(null);
  };

  function onDragStart(event: DragEvent, task: Task): void {
    if (task.status === "in_progress") {
      event.preventDefault();
      toast(`${task.id} is running — the runner owns it until the turn ends`, "warning");
      return;
    }
    setDragging(task);
    event.dataTransfer?.setData("text/plain", task.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function laneAllows(task: Task, laneId: string): boolean {
    return canMove(rules, task, laneId);
  }

  /** Midpoint test gives the insertion line between two cards. */
  function dropTargetFor(event: DragEvent): string | null {
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>(".card");
    if (!card || card.dataset.id === dragging()?.id) return null;
    const box = card.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? card.dataset.id! : (card.nextElementSibling as HTMLElement | null)?.dataset?.id ?? null;
  }

  async function applyDrop(task: Task, toLane: string, beforeId: string | null): Promise<void> {
    const snapshot = { ...task, deps: [...(task.deps ?? [])], labels: [...(task.labels ?? [])] };
    try {
      if (task.status !== toLane) {
        const updated = await api.move(props.slug, task.id, toLane);
        upsertTask(updated);
        toast(`${task.id} → ${toLane.replace("_", " ")}`, "success");
      }
      if (beforeId) await api.order(props.slug, task.id, { before: beforeId });
      else if (task.status !== toLane) await api.order(props.slug, task.id, { bottom: true });
      await loadBoard(props.slug);
    } catch (error) {
      upsertTask(snapshot);
      await loadBoard(props.slug);
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const task = dragging();
    const lane = dropLane();
    const before = dropBefore();
    reset();
    if (!task || !lane) return;
    if (lane === task.status && before === null) return;

    if (lane !== task.status && !laneAllows(task, lane)) {
      toast(`${task.id} cannot move from ${task.status} to ${lane}`, "error");
      return;
    }
    const hint = lane !== task.status ? needsComment(rules, task.status, lane) : null;
    if (hint) {
      props.onNeedsComment(task, lane, hint);
      return;
    }
    // Optimistic: move the card now, roll back if the server refuses.
    upsertTask({ ...task, status: lane });
    await applyDrop(task, lane, before);
  }

  return (
    <div class="board-wrap">
      <div class="board" role="list" aria-label="Board lanes">
        <For each={visibleLanes()}>
          {(lane) => (
            <section
              class={`lane${MUTED_LANES.has(lane.id) ? " muted-lane" : ""}${
                dragging() && dropLane() === lane.id
                  ? laneAllows(dragging()!, lane.id)
                    ? " drop-ok"
                    : " drop-bad"
                  : ""
              }`}
              role="listitem"
              aria-label={`${lane.label}, ${laneCount(lane.id)} tasks`}
              data-lane={lane.id}
              onDragOver={(event) => {
                if (!dragging()) return;
                event.preventDefault();
                setDropLane(lane.id);
                setDropBefore(dropTargetFor(event));
              }}
              onDragLeave={(event) => {
                if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setDropLane(null);
              }}
              onDrop={(event) => void onDrop(event)}
            >
              <header class="lane-head">
                <span class={`dot ${lane.id}`} aria-hidden="true" />
                <h2>{lane.label}</h2>
                <span class="count">{laneCount(lane.id)}</span>
                <Show when={lane.id === "backlog" || lane.id === "todo"}>
                  <button class="ghost icon add" title={`Add to ${lane.label}`} aria-label={`Add to ${lane.label}`} onClick={() => props.onNewTask(lane.id)}>
                    <Icon.plus size={14} />
                  </button>
                </Show>
              </header>
              <div class="lane-body">
                <For each={visibleTasks(lane.id)}>
                  {(task) => (
                    <>
                      <Show when={dropBefore() === task.id && dropLane() === lane.id}>
                        <div class="drop-line" />
                      </Show>
                      <article
                        class={`card${task.status === "in_progress" ? " running" : ""}${task.status === "blocked" ? " blocked" : ""}${
                          MUTED_LANES.has(task.status) ? " done" : ""
                        }${dragging()?.id === task.id ? " dragging" : ""}`}
                        data-id={task.id}
                        draggable={task.status !== "in_progress" ? "true" : "false"}
                        tabindex="0"
                        role="button"
                        aria-label={`${task.id} ${task.title}`}
                        onDragStart={(event) => onDragStart(event, task)}
                        onDragEnd={reset}
                        onClick={() => props.onOpenTask(task.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            props.onOpenTask(task.id);
                          }
                        }}
                      >
                        <span class="id">{task.id}</span>
                        <span class="title">{task.title}</span>
                        <span class="meta">
                          <Show when={task.priority && task.priority !== "none"}>
                            <span class={`chip prio-${task.priority}`}>
                              <PriorityIcon priority={task.priority} />
                              {task.priority}
                            </span>
                          </Show>
                          <Show when={(task.deps ?? []).length > 0}>
                            <span class={`chip${(task.waitingFor ?? []).length > 0 ? " waiting" : ""}`}>
                              <Icon.link size={11} />
                              {(task.waitingFor ?? []).length > 0
                                ? `waiting on ${task.waitingFor!.join(", ")}`
                                : `after ${task.deps.join(", ")}`}
                            </span>
                          </Show>
                          <Show when={task.run}>
                            <span class="pill" title={`session ${task.run?.session} · ${task.run?.mode}`}>
                              <span class="pulse" aria-hidden="true" />
                              {task.run?.session ?? "running"} · {task.run?.mode ?? "direct"}
                            </span>
                          </Show>
                          <Show when={task.status === "in_progress" && task.staleness && task.staleness !== "running"}>
                            <span class="chip stale">stale run</span>
                          </Show>
                          <Show when={(task.labels ?? []).length > 0}>
                            <span class="labels">
                              <For each={task.labels.slice(0, 3)}>{(label) => <span class="label-tag">{label}</span>}</For>
                            </span>
                          </Show>
                        </span>
                      </article>
                    </>
                  )}
                </For>
                <Show when={dropBefore() === null && dropLane() === lane.id && dragging()}>
                  <div class="drop-line" />
                </Show>
                <Show when={!board.loading && visibleTasks(lane.id).length === 0}>
                  <p class="meta" style={{ padding: "8px 4px" }}>
                    {lane.id === "backlog" ? "Nothing captured yet." : "Empty."}
                  </p>
                </Show>
                <Show when={lane.id === "backlog" || lane.id === "todo"}>
                  <button class="ghost" style={{ "justify-content": "flex-start", color: "var(--muted)" }} onClick={() => props.onNewTask(lane.id)}>
                    <Icon.plus size={13} /> Add
                  </button>
                </Show>
                <Show when={board.loading && visibleTasks(lane.id).length === 0}>
                  <div class="skeleton" />
                  <div class="skeleton" />
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
