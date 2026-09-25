/**
 * Shared "runs after" task picker: autofocused search, status-sorted results,
 * keyboard nav, capped list. Used by the New-task dialog and the task panel.
 */

import { For, Show, createSignal, type JSX } from "solid-js";
import type { Task } from "./api.js";
import { Icon, StatusGlyph } from "./icons.js";
import { board } from "./state.js";

/** Display order for dependency candidates. */
const RANK: Record<string, number> = {
  todo: 0,
  in_progress: 1,
  blocked: 2,
  in_review: 3,
  backlog: 4,
  done: 5,
};

const MAX_SHOWN = 50;

/** Would adding `dep` to `self`'s deps close a cycle? Cheap client-side BFS. */
export function wouldCycle(selfId: string, depId: string): boolean {
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const stack = [depId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === selfId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of byId.get(current)?.deps ?? []) stack.push(next);
  }
  return false;
}

export function depCandidates(needle: string, exclude: Set<string>, selfId?: string): { shown: Task[]; more: number } {
  const text = needle.trim().toLowerCase();
  const pool = board.tasks
    .filter((task) => !exclude.has(task.id) && task.id !== selfId)
    .filter((task) => !["cancelled", "archived"].includes(task.status))
    .filter((task) => !selfId || !wouldCycle(selfId, task.id))
    .filter((task) => !text || task.id.toLowerCase().includes(text) || task.title.toLowerCase().includes(text))
    .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.id.localeCompare(b.id));
  return { shown: pool.slice(0, MAX_SHOWN), more: Math.max(0, pool.length - MAX_SHOWN) };
}

/** The list body (search + results) — drop into any Popover/menu. */
export function DepList(props: {
  selfId?: string;
  exclude?: string[];
  /** single-select: called once with the id; multi: toggles and stays open. */
  onPick: (id: string) => void;
  picked?: (id: string) => boolean;
  keepOpen?: boolean;
  close: () => void;
}): JSX.Element {
  const [needle, setNeedle] = createSignal("");
  const [active, setActive] = createSignal(0);

  const list = () => depCandidates(needle(), new Set(props.exclude ?? []), props.selfId);

  const pick = (task: Task): void => {
    props.onPick(task.id);
    if (!props.keepOpen) props.close();
  };

  const onKey = (event: KeyboardEvent): void => {
    const items = list().shown;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const item = items[active()];
      if (item) {
        event.preventDefault();
        pick(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.close();
    }
  };

  return (
    <div class="dep-picker">
      <div class="pop-search">
        <Icon.search size={14} />
        <input
          ref={(el) => queueMicrotask(() => el.focus({ preventScroll: true }))}
          placeholder="Search tasks (id or title)…"
          aria-label="Search tasks to depend on"
          value={needle()}
          onInput={(event) => {
            setNeedle(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div role="listbox" aria-label="Runs after">
        <For each={list().shown} fallback={<div class="menu-section">No matching tasks.</div>}>
          {(task, index) => (
            <button
              class={`dep-option${active() === index() ? " active" : ""}${props.picked?.(task.id) ? " picked" : ""}`}
              role="option"
              aria-selected={props.picked?.(task.id) ?? active() === index()}
              onMouseEnter={() => setActive(index())}
              onClick={() => pick(task)}
            >
              <StatusGlyph status={task.status} size={12} />
              <span class="mono muted dep-id">{task.id}</span>
              <span class="dep-title">{task.title}</span>
            </button>
          )}
        </For>
        <Show when={list().more > 0}>
          <div class="menu-section dep-more">{list().more} more — keep typing</div>
        </Show>
      </div>
    </div>
  );
}
