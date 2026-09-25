/**
 * The board: tinted status columns, cards with the agent chip / dependency lock /
 * priority badge, and HTML5 drag & drop with an insert line, disallowed columns
 * faded, optimistic moves that roll back on refusal, and an undo toast.
 */

import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { api, canMove, needsComment, type Rules, type Task } from "./api.js";
import { offerToSchedule } from "./schedule.js";
import { Icon, StatusGlyph } from "./icons.js";
import { AgentChip, DepTag, LabelTags, PriorityTag } from "./paint.js";
import {
  board,
  describe,
  display,
  laneCount,
  laneLabel,
  laneLayout,
  laneTasks,
  loadBoard,
  rules,
  selectedId,
  setCommentRequest,
  setNewTaskLane,
  setOpenTaskId,
  setSelectedId,
  setSummarizeOpen,
  slug,
  toast,
  toggleLane,
  upsertTask,
  visibleLanes,
} from "./state.js";
import { MenuItem, Popover } from "./ui.js";

/** Lanes whose header shows a solid status pill (the "active" part of the flow). */
const PILL_LANES = new Set(["in_progress", "in_review", "blocked", "done"]);
const FINAL = new Set(["done", "cancelled", "archived"]);

const INFO: Record<string, (rules: Rules) => string> = {
  backlog: () => "Ideas and later work. Never run automatically. Drag to Todo when a task is ready.",
  todo: (rules) =>
    `Ready to run. Autowork and queued work pick the next task by priority, then the order in this column (drag to reorder). A task waits until every task it runs after reaches ${rules.chainGate === "done" ? "Done" : "In Review"} — the chain-gate setting.`,
  in_progress: (rules) =>
    `Being worked by an agent session. One task per session, at most ${rules.maxSessions ?? 2} sessions per project. The agent moves it to In Review when its turn ends.`,
  blocked: () => "The agent needs something from you. Read the reason on the card, reply with a comment, then drag it back to Todo.",
  in_review: () => "The agent finished. Check the activity, then drag to Done, or back to Todo with a note on what to change.",
  done: () => "Accepted by you. Summarize & archive, or archive without a summary, from the … menu.",
};

const EMPTY: Record<string, string> = {
  backlog: "Capture ideas here",
  todo: "Ready work lands here",
  in_progress: "No agent is working",
  in_review: "Nothing waiting for review",
  blocked: "Nothing blocked",
  done: "Nothing finished yet",
  cancelled: "Nothing cancelled",
  archived: "Archive is empty",
};

export function Board(): JSX.Element {
  const [dragging, setDragging] = createSignal<Task | null>(null);
  const [dropLane, setDropLane] = createSignal<string | null>(null);
  const [dropBefore, setDropBefore] = createSignal<string | null>(null);

  const reset = (): void => {
    setDragging(null);
    setDropLane(null);
    setDropBefore(null);
  };

  function onDragStart(event: DragEvent, task: Task): void {
    if (task.run) {
      event.preventDefault();
      toast(`${task.id} is running — the agent owns it until its turn ends`, "warning");
      return;
    }
    setDragging(task);
    event.dataTransfer?.setData("text/plain", task.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  const allows = (task: Task, laneId: string): boolean => canMove(rules, task, laneId);

  async function archiveLane(status: "done" | "in_review"): Promise<void> {
    const target = slug();
    if (!target) return;
    const count = laneCount(status);
    if (count === 0) return;
    try {
      const result = await api.archiveLane(target, status);
      toast(`Archived ${result.archived.length} task${result.archived.length === 1 ? "" : "s"}`, "success");
      await loadBoard(target);
    } catch (error) {
      toast(describe(error), "error");
    }
  }

  // While dragging, scroll the horizontal strip when the pointer hugs an edge,
  // and the hovered lane's card list vertically — speed grows toward the edge.
  const EDGE = 80;
  const MAX_STEP = 22;
  let pointer: { x: number; y: number } | null = null;
  createEffect(() => {
    if (!dragging()) {
      pointer = null;
      return;
    }
    const track = (event: DragEvent): void => {
      // Some browsers fire a final dragover with 0,0 — keep the last real point.
      if (event.clientX !== 0 || event.clientY !== 0) pointer = { x: event.clientX, y: event.clientY };
    };
    const step = (): void => {
      const at = pointer;
      if (at) {
        const wrap = document.querySelector<HTMLElement>(".board-wrap");
        if (wrap) {
          const box = wrap.getBoundingClientRect();
          const into = (edge: number): number => Math.max(0, (EDGE - edge) / EDGE);
          wrap.scrollLeft += (into(box.right - at.x) - into(at.x - box.left)) * MAX_STEP;
        }
        const lane = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>(".lane-body");
        if (lane && lane.scrollHeight > lane.clientHeight) {
          const box = lane.getBoundingClientRect();
          const into = (edge: number): number => Math.max(0, (EDGE - edge) / EDGE);
          lane.scrollTop += (into(box.bottom - at.y) - into(at.y - box.top)) * MAX_STEP;
        }
      }
      frame = requestAnimationFrame(step);
    };
    let frame = requestAnimationFrame(step);
    document.addEventListener("dragover", track);
    onCleanup(() => {
      document.removeEventListener("dragover", track);
      cancelAnimationFrame(frame);
    });
  });

  // Collapsed lanes shrink the wrap's width — keep the *source* lane's left
  // edge pinned on screen during the transition (and back on expand) so the
  // dragged card doesn't visually jump.
  createEffect(() => {
    dragging(); // subscribe both ways
    const wrap = document.querySelector<HTMLElement>(".board-wrap");
    const source = dragging()
      ? document.querySelector<HTMLElement>(`.lane[data-lane="${CSS.escape(dragging()!.status)}"]`)
      : null;
    const anchor = source ?? document.querySelector<HTMLElement>(".lane");
    if (!wrap || !anchor) return;
    const left0 = anchor.getBoundingClientRect().left;
    // Pin only while the width transition runs (~200ms); after that the
    // autoscroll owns scrollLeft.
    const stopAt = performance.now() + 400;
    let frame = 0;
    const step = (): void => {
      const delta = anchor.getBoundingClientRect().left - left0;
      if (Math.abs(delta) > 0.5) wrap.scrollLeft += delta;
      if (performance.now() < stopAt) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  /** Midpoint test → the card the dragged one would land before (null = end). */
  function dropTargetFor(event: DragEvent, laneId: string): string | null {
    const cards = [...document.querySelectorAll<HTMLElement>(`.lane[data-lane="${laneId}"] .card`)].filter(
      (node) => node.dataset.id !== dragging()?.id,
    );
    const index = cards.findIndex((node) => {
      const box = node.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    if (index === -1) return null;
    // Chains are drawn as one block: never insert between two members — snap to
    // the start of the block the pointer is in.
    let at = index;
    while (at > 0 && /^(middle|last)$/.test(cards[at]!.dataset.chain ?? "")) at -= 1;
    return cards[at]?.dataset.id ?? null;
  }

  async function commit(original: Task, toLane: string, beforeId: string | null): Promise<void> {
    const target = slug();
    if (!target) return;
    const siblings = board.tasks
      .filter((task) => task.status === original.status)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((task) => task.id);
    const previousNeighbour = siblings[siblings.indexOf(original.id) + 1] ?? null;
    try {
      if (original.status !== toLane) upsertTask(await api.move(target, original.id, toLane));
      if (beforeId) await api.order(target, original.id, { before: beforeId });
      else if (original.status !== toLane) await api.order(target, original.id, { bottom: true });
      await loadBoard(target);
      const moved = original.status !== toLane;
      if (moved && toLane === "todo") offerToSchedule(original.id);
      const reversible = !moved || (canMove(rules, { ...original, status: toLane, allowedMoves: undefined }, original.status) && !needsComment(rules, toLane, original.status));
      toast(
        moved ? `Moved ${original.id} to ${laneLabel(toLane)}` : `Reordered ${original.id}`,
        "success",
        reversible
          ? {
              label: "Undo",
              run: async () => {
                try {
                  if (moved) await api.move(target, original.id, original.status);
                  if (previousNeighbour) await api.order(target, original.id, { before: previousNeighbour });
                  else await api.order(target, original.id, { bottom: true });
                } catch (error) {
                  toast(describe(error), "error");
                } finally {
                  await loadBoard(target);
                }
              },
            }
          : undefined,
      );
    } catch (error) {
      upsertTask(original);
      await loadBoard(target);
      toast(describe(error), "error");
    }
  }

  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const task = dragging();
    const lane = dropLane();
    const before = dropBefore();
    reset();
    if (!task || !lane) return;
    if (lane === task.status) {
      const ids = laneTasks(lane).map((item) => item.id);
      const index = ids.indexOf(task.id);
      const unchanged = before === null ? index === ids.length - 1 : ids[index + 1] === before;
      if (unchanged) return;
    }
    if (lane !== task.status && !allows(task, lane)) {
      toast(`${task.id} can't move from ${laneLabel(task.status)} to ${laneLabel(lane)}`, "error");
      return;
    }
    // Snapshot first: Solid store proxies reflect later writes.
    const original: Task = { ...task, deps: [...(task.deps ?? [])], labels: [...(task.labels ?? [])] };
    const hint = lane !== task.status ? needsComment(rules, task.status, lane) : null;
    if (hint) {
      setCommentRequest({
        task: original,
        to: lane,
        hint,
        after: async () => {
          const target = slug();
          if (target && before) await api.order(target, original.id, { before });
        },
      });
      return;
    }
    upsertTask({ ...original, status: lane });
    await commit(original, lane, before);
  }

  return (
    <div class="board-wrap">
      <div class={`board${dragging() ? " is-dragging" : ""}`} role="list" aria-label="Board columns">
        <For each={visibleLanes()}>
          {(lane) => (
            <section
              class={`lane${dragging() && dragging()!.status !== lane.id && !allows(dragging()!, lane.id) ? " not-allowed collapsed" : ""}${
                dragging() && dropLane() === lane.id && dragging()!.status !== lane.id ? (allows(dragging()!, lane.id) ? " drop-ok" : " drop-bad") : ""
              }`}
              role="listitem"
              aria-label={`${lane.label}, ${laneCount(lane.id)} tasks`}
              data-lane={lane.id}
              onDragOver={(event) => {
                if (!dragging()) return;
                event.preventDefault();
                setDropLane(lane.id);
                setDropBefore(dropTargetFor(event, lane.id));
              }}
              onDragLeave={(event) => {
                if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setDropLane(null);
              }}
              onDrop={(event) => void onDrop(event)}
            >
              <header class="lane-head">
                <span class={`lane-name${PILL_LANES.has(lane.id) ? " pill" : " plain"}`}>
                  <StatusGlyph status={lane.id} size={13} />
                  {lane.label}
                </span>
                <span class="lane-count">{laneCount(lane.id)}</span>
                <LaneInfo lane={lane.id} />
                <span class="spacer" />
                <Show when={lane.id === "done" && laneCount("done") > 0}>
                  <button
                    class="lane-summarize"
                    aria-label="Summarize & archive"
                    title="Summarize & archive"
                    onClick={() => setSummarizeOpen(true)}
                  >
                    <Icon.sparkle size={12} />
                    Summarize
                  </button>
                </Show>
                <Popover
                  width={232}
                  align="end"
                  label={`${lane.label} options`}
                  trigger={(api) => (
                    <button class="icon-btn sm" ref={api.ref} aria-expanded={api.open} aria-label={`${lane.label} options`} onClick={api.toggle}>
                      <Icon.more size={14} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <Show when={lane.id === "done"}>
                        <MenuItem
                          icon={<Icon.sparkle size={14} />}
                          label="Summarize & archive…"
                          disabled={laneCount("done") === 0}
                          onSelect={() => {
                            close();
                            setSummarizeOpen(true);
                          }}
                        />
                        <MenuItem
                          icon={<Icon.archive size={14} />}
                          label={`Archive all (${laneCount("done")}) without summary`}
                          disabled={laneCount("done") === 0}
                          onSelect={() => {
                            close();
                            void archiveLane("done");
                          }}
                        />
                      </Show>
                      <Show when={lane.id === "in_review"}>
                        <MenuItem
                          icon={<Icon.archive size={14} />}
                          label={`Archive all (${laneCount("in_review")})`}
                          disabled={laneCount("in_review") === 0}
                          onSelect={() => {
                            close();
                            void archiveLane("in_review");
                          }}
                        />
                      </Show>
                      <MenuItem
                        icon={<Icon.close size={14} />}
                        label="Hide column"
                        onSelect={() => {
                          close();
                          toggleLane(lane.id);
                        }}
                      />
                    </>
                  )}
                </Popover>
                <Show when={lane.id === "backlog" || lane.id === "todo"}>
                  <button class="icon-btn sm" aria-label={`Add to ${lane.label}`} title={`Add to ${lane.label}`} onClick={() => setNewTaskLane(lane.id)}>
                    <Icon.plus size={14} />
                  </button>
                </Show>
              </header>

              <div class="lane-body">
                <For each={laneLayout(lane.id)}>
                  {(item) => (
                    <>
                      <Show when={dropLane() === lane.id && dropBefore() === item.task.id && dragging() && dragging()!.id !== item.task.id && allows(dragging()!, lane.id)}>
                        <div class="drop-line" />
                      </Show>
                      <Card
                        task={item.task}
                        chain={item.chain}
                        parents={item.parents}
                        dragging={dragging()?.id === item.task.id}
                        onDragStart={(event) => onDragStart(event, item.task)}
                        onDragEnd={reset}
                      />
                    </>
                  )}
                </For>
                <Show when={dragging() && dropLane() === lane.id && dropBefore() === null && allows(dragging()!, lane.id)}>
                  <div class="drop-line" />
                </Show>

                <Show when={board.loading && !board.loaded}>
                  <div class="skeleton" />
                  <div class="skeleton" style={{ height: "64px" }} />
                </Show>
                <Show when={board.loaded && laneTasks(lane.id).length === 0 && !dragging()}>
                  <div class="lane-empty">
                    <StatusGlyph status={lane.id} size={18} />
                    {EMPTY[lane.id] ?? "Nothing here"}
                  </div>
                </Show>
                <Show when={lane.id === "backlog" || lane.id === "todo"}>
                  <button class="lane-add" onClick={() => setNewTaskLane(lane.id)}>
                    <Icon.plus size={14} />
                    Add task
                  </button>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

function Card(props: {
  task: Task;
  chain: "single" | "first" | "middle" | "last";
  parents: string[];
  dragging: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
}): JSX.Element {
  const task = () => props.task;
  const excerpt = (): string => (task().body ?? "").replace(/[#>*_`[\]]/g, " ").replace(/\s+/g, " ").trim();
  return (
    <article
      class={`card${props.dragging ? " dragging" : ""}${FINAL.has(task().status) ? " final" : ""}${task().status === "cancelled" ? " cancelled" : ""}${
        selectedId() === task().id ? " selected" : ""
      }${task().run ? " running" : ""}${props.chain !== "single" ? ` chained chain-${props.chain}` : ""}${
        (task().lockedBy ?? []).length > 0 ? " locked" : ""
      }`}
      data-id={task().id}
      data-chain={props.chain}
      draggable={task().run ? "false" : "true"}
      tabindex="0"
      role="button"
      aria-label={`${task().id} ${task().title}`}
      onDragStart={(event) => props.onDragStart(event)}
      onDragEnd={() => props.onDragEnd()}
      onClick={() => {
        setSelectedId(task().id);
        setOpenTaskId(task().id);
      }}
      onFocus={() => setSelectedId(task().id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpenTaskId(task().id);
        }
      }}
    >
      <div class="card-top">
        <span class="card-id">{task().id}</span>
        <span class="spacer" />
        <AgentChip task={task()} />
        <Show when={task().status === "in_progress" && task().staleness && task().staleness !== "running"}>
          <span class="tag stale">stale</span>
        </Show>
      </div>
      <div class="card-title title">{task().title}</div>
      <Show when={task().status === "blocked" && task().blockedReason?.text}>
        <div class="card-blocked" title={task().blockedReason?.text}>
          {task().blockedReason!.text}
        </div>
      </Show>
      <Show when={display.excerpt && excerpt()}>
        <div class="card-excerpt">{excerpt()}</div>
      </Show>
      <div class="card-meta">
        <PriorityTag priority={task().priority} />
        <DepTag task={task()} drawnParents={props.parents} />
        <LabelTags labels={task().labels ?? []} max={2} />
      </div>
    </article>
  );
}

/** ⓘ popover explaining what a lane is for (live chain gate / limits). */
function LaneInfo(props: { lane: string }): JSX.Element {
  const text = INFO[props.lane];
  if (!text) return <></>;
  return (
    <Popover
      width={260}
      align="end"
      label={`About ${laneLabel(props.lane)}`}
      trigger={(api) => (
        <button
          class={`icon-btn sm lane-info${api.open ? " on" : ""}`}
          ref={api.ref}
          aria-expanded={api.open}
          aria-label={`About ${laneLabel(props.lane)}`}
          onClick={api.toggle}
        >
          <Icon.info size={13} />
        </button>
      )}
    >
      {() => <div class="lane-info-pop">{text(rules)}</div>}
    </Popover>
  );
}
