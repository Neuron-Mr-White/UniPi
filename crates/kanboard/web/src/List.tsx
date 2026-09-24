/** List view: grouped by status with sticky group headers and dense rows. */
import { For, Show, type JSX } from "solid-js";
import { Icon, PriorityGlyph, PRIORITY_LABEL, StatusGlyph } from "./icons.js";
import { relativeTime } from "./markdown.js";
import { AgentChip, DepTag, LabelTags } from "./paint.js";
import { board, laneTasks, scope, selectedId, setNewTaskLane, setOpenTaskId, setSelectedId, visibleLanes } from "./state.js";

export function ListView(): JSX.Element {
  const groups = () => visibleLanes().map((lane) => ({ lane, tasks: laneTasks(lane.id) }));
  const nonEmpty = () => groups().filter((group) => group.tasks.length > 0 || scope() !== "all");
  return (
    <div class="list" role="table" aria-label="Tasks">
      <For each={nonEmpty()}>
        {(group) => (
          <section style={{ "--lane": `var(--s-${group.lane.id})` }} data-lane={group.lane.id}>
            <div class="group-head" role="rowgroup">
              <StatusGlyph status={group.lane.id} />
              {group.lane.label}
              <span class="lane-count">{group.tasks.length}</span>
              <Show when={group.lane.id === "backlog" || group.lane.id === "todo"}>
                <button class="icon-btn sm" aria-label={`Add to ${group.lane.label}`} onClick={() => setNewTaskLane(group.lane.id)}>
                  <Icon.plus size={14} />
                </button>
              </Show>
            </div>
            <For each={group.tasks} fallback={<div class="list-empty">Nothing here.</div>}>
              {(task) => (
                <div
                  class={`row${selectedId() === task.id ? " selected" : ""}`}
                  role="row"
                  tabindex="0"
                  data-id={task.id}
                  aria-label={`${task.id} ${task.title}`}
                  onClick={() => {
                    setSelectedId(task.id);
                    setOpenTaskId(task.id);
                  }}
                  onFocus={() => setSelectedId(task.id)}
                  onKeyDown={(event) => event.key === "Enter" && setOpenTaskId(task.id)}
                >
                  <span title={PRIORITY_LABEL[task.priority]}>
                    <PriorityGlyph priority={task.priority} />
                  </span>
                  <span class="card-id">{task.id}</span>
                  <StatusGlyph status={task.status} />
                  <span class="row-title">{task.title}</span>
                  <span class="row-tags">
                    <AgentChip task={task} />
                    <DepTag task={task} />
                  </span>
                  <span class="row-tags">
                    <LabelTags labels={task.labels ?? []} max={2} />
                  </span>
                  <span class="row-time" title={task.updated}>
                    {relativeTime(task.updated).replace(" ago", "")}
                  </span>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
      <Show when={board.loaded && nonEmpty().length === 0}>
        <div class="list-empty">No tasks match.</div>
      </Show>
    </div>
  );
}
